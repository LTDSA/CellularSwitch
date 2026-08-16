// ADB over WebUSB 传输层：定位并占用 ADB 接口（与 AT 口不同的接口/端点，
// 不与 UsbService/ModuleService 的 AT 会话冲突），完成 CNXN + AUTH 握手，
// 打开并流转 `shell:` 流。
//
// 参考 Android adb 协议：adb_protocol.h / transport。鉴权为 RSA(SHA-1) 签名
// 挑战 token（见 utils/adbCrypto）。真机需实测模块 ADB 端点与浏览器 SHA-1 支持。

import {
  ADB_HEADER_SIZE,
  ADB_VERSION,
  ADB_MAX_PAYLOAD,
  A_CNXN,
  A_OPEN,
  A_OKAY,
  A_CLSE,
  A_WRTE,
  A_AUTH,
  AUTH_TOKEN,
  AUTH_SIGNATURE,
  AUTH_RSAPUBLICKEY,
  ADB_INTERFACE_CLASS,
  ADB_INTERFACE_SUBCLASS,
  ADB_INTERFACE_PROTOCOL,
  parseHeader,
  packHeader,
  checksum,
  concatBytes,
  type AdbHeader,
} from '../utils/adbProtocol'
import { getOrCreateKeyPair, signToken, exportAdbPublicKey } from '../utils/adbCrypto'
import {
  SYNC_CHUNK_CAPACITY,
  checkedShellCommand,
  parseCheckedShellOutput,
  parseSyncHeader,
  shellToken,
  syncHeader,
  syncPacket,
} from '../utils/adbSync'

// ADB 读超时：握手/流转阶段的单次 transferIn 上限。空闲时超时由流转循环吞掉并继续。
const ADB_READ_TIMEOUT_MS = 5_000
// open/selectConfiguration/claimInterface 这类原生调用的超时（同 UsbService 风格）。
const ADB_STEP_TIMEOUT_MS = 2_000
// 一次性 shell 命令的输出上限（对齐参考实现 1 MiB）。
const MAX_SHELL_OUTPUT = 1_048_576

export interface AdbShellCallbacks {
  onData: (chunk: Uint8Array) => void
  onClose: () => void
}

/** 交互 shell 流句柄：write() 下发输入，close() 关闭流。 */
export interface AdbStream {
  write(data: Uint8Array<ArrayBuffer> | string): Promise<void>
  close(): Promise<void>
}

const encoder = new TextEncoder()

export class AdbService {
  private device: USBDevice | null = null
  private interfaceNumber: number | null = null
  private outEndpoint = 0
  private inEndpoint = 0
  private diagnostics: string[] = []
  // 未读完的 IN 数据（transferIn 可能一次带回头部+负载，故缓冲）。
  private pending = new Uint8Array(0)

  // 流 ID 分配器（每次 openShell 一个本地流）。
  private localIdCounter = 0
  // 会话代号：connect() 递增，close() 再递增，使旧的读循环失效退出。
  private generation = 0

  // 交互 shell 流的本地/远端 ID 与回调（同一时刻仅一条 shell 流）。
  private activeLocalId = 0
  private activeRemoteId = 0
  private activeCallbacks: AdbShellCallbacks | null = null
  private pumpRunning = false
  // OUT 端点单写者队列：pump 的 OKAY ACK 与用户 write 可能并发，串行避免 OUT 竞争。
  private writeChain: Promise<void> = Promise.resolve()

  private log(line: string): void {
    this.diagnostics.push(line)
    console.log(`[AdbService] ${line}`)
  }

  private fail(message: string): Error {
    const err = new Error(message)
    ;(err as { diagnostics?: string }).diagnostics = this.diagnostics.join('\n')
    return err
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), ms)
      promise.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (err) => {
          clearTimeout(timer)
          reject(err)
        },
      )
    })
  }

  private isTimeout(err: unknown): boolean {
    return err instanceof Error && /timeout/i.test(err.message)
  }

  /** 定位 ADB 接口（class 0xFF + subclass 0x42 + protocol 0x01）。 */
  private findAdbInterface(device: USBDevice): USBInterface | undefined {
    return device.configuration?.interfaces.find((intf) => {
      const alt = intf.alternate
      return (
        alt.interfaceClass === ADB_INTERFACE_CLASS &&
        alt.interfaceSubclass === ADB_INTERFACE_SUBCLASS &&
        alt.interfaceProtocol === ADB_INTERFACE_PROTOCOL
      )
    })
  }

  /** 转储当前配置的接口/备用设置/端点，便于真机排障（端点号/方向是否正确）。 */
  private dumpInterfaces(device: USBDevice): void {
    const config = device.configuration
    if (!config) {
      this.log('USB configuration: null')
      return
    }
    this.log(
      `USB configValue=${config.configurationValue} ifaceCount=${config.interfaces.length}`,
    )
    for (const intf of config.interfaces) {
      for (const alt of intf.alternates) {
        const eps = alt.endpoints
          .map((e) => `EP${e.endpointNumber}(${e.direction}/${e.type})`)
          .join(',')
        this.log(
          `iface ${intf.interfaceNumber} alt ${alt.alternateSetting} ` +
            `class=0x${alt.interfaceClass.toString(16)} ` +
            `subclass=0x${alt.interfaceSubclass.toString(16)} ` +
            `protocol=0x${alt.interfaceProtocol.toString(16)} ` +
            `eps=[${eps || 'none'}]`,
        )
      }
    }
  }

  /**
   * 建立 ADB 会话：open 设备、占用 ADB 接口，随后完成 CNXN + AUTH 握手。
   * 失败抛带 diagnostics 的错误。
   */
  async connect(device: USBDevice): Promise<void> {
    this.diagnostics = []
    this.generation++
    this.pending = new Uint8Array(0)
    this.device = device

    try {
      await this.withTimeout(device.open(), ADB_STEP_TIMEOUT_MS)
      if (device.configuration === null) {
        await this.withTimeout(device.selectConfiguration(1), ADB_STEP_TIMEOUT_MS)
      }

      this.dumpInterfaces(device)

      const iface = this.findAdbInterface(device)
      if (!iface) {
        throw this.fail('未找到 ADB 接口，请先在「USB 功能 → 进阶选项」开启 ADB 并应用重启')
      }
      this.log(`ADB iface ${iface.interfaceNumber} found`)
      await this.withTimeout(device.claimInterface(iface.interfaceNumber), ADB_STEP_TIMEOUT_MS)
      this.interfaceNumber = iface.interfaceNumber

      const alt = iface.alternate
      const outEp = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk')
      const inEp = alt.endpoints.find((e) => e.direction === 'in' && e.type === 'bulk')
      if (!outEp || !inEp) {
        throw this.fail('ADB 接口缺少 bulk 端点')
      }
      this.outEndpoint = outEp.endpointNumber
      this.inEndpoint = inEp.endpointNumber
      this.log(`ADB endpoints OUT${this.outEndpoint} IN${this.inEndpoint}`)

      // 对齐参考实现（qdc507_adb_probe.c 的 mavo_voice_clear_stalls / ClearPipeStallBothEnds）：
      // 握手前清除 OUT/IN 端点的 STALL。模块在旧会话被占用或上次握手失败后可能把
      // ADB bulk 端点停在 HALT 态，不清除则设备侧收不到 CNXN 或回不了响应。
      await this.clearEndpointStalls()

      await this.handshake()
    } catch (err) {
      if (err instanceof Error && (err as { diagnostics?: string }).diagnostics) throw err
      const e = err instanceof Error ? err : new Error(String(err))
      throw this.fail(`ADB 连接失败：${e.message}`)
    }
  }

  /** 清除 OUT/IN 端点的 STALL（等价 ClearPipeStallBothEnds）。尽力而为，失败不阻断。 */
  private async clearEndpointStalls(): Promise<void> {
    if (!this.device) return
    for (const [direction, endpoint] of [
      ['out', this.outEndpoint],
      ['in', this.inEndpoint],
    ] as const) {
      if (!endpoint) continue
      try {
        await this.withTimeout(
          this.device.clearHalt(direction, endpoint),
          ADB_STEP_TIMEOUT_MS,
        )
        this.log(`ADB clearHalt ${direction} EP${endpoint} ok`)
      } catch (err) {
        this.log(
          `ADB clearHalt ${direction} EP${endpoint} skipped: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  /** CNXN + AUTH 握手，直到收到设备的 CNXN（连接建立）。 */
  private async handshake(): Promise<void> {
    const { privateKey, publicKey } = await getOrCreateKeyPair()
    await this.send(A_CNXN, ADB_VERSION, ADB_MAX_PAYLOAD, encoder.encode('host::CellularSwitch\0'))
    while (true) {
      const { header, data } = await this.recvMessage()
      this.log(
        `adb recv cmd=0x${header.command.toString(16)} arg0=${header.arg0} ` +
          `arg1=${header.arg1} len=${data.length}`,
      )
      if (header.command === A_CNXN) {
        this.log(`ADB connected (device: ${new TextDecoder().decode(data.slice(0, 64))})`)
        return
      }
      if (header.command === A_AUTH) {
        if (header.arg0 === AUTH_TOKEN) {
          const sig = await signToken(privateKey, data)
          await this.send(A_AUTH, AUTH_SIGNATURE, 0, sig)
          this.log(`ADB auth: sent signature (${sig.length} bytes)`)
        } else if (header.arg0 === AUTH_RSAPUBLICKEY) {
          const pub = await exportAdbPublicKey(publicKey)
          await this.send(A_AUTH, AUTH_RSAPUBLICKEY, 0, pub)
          this.log(`ADB auth: sent public key (${pub.length} bytes)`)
        } else {
          throw new Error(`未知的 ADB 鉴权类型: ${header.arg0}`)
        }
      }
      // 其它消息忽略（握手阶段正常只会出现 CNXN / AUTH）。
    }
  }

  /**
   * 打开一条持久交互 shell 流（`shell:`，空命令 → 设备进入交互 shell，显示 `/ # ` 提示符）。
   * 返回流句柄：write() 下发输入（A_WRTE），close() 关闭流。后台单条读循环持续
   * 收 WRTE 并回 OKAY（ADB 流控 ACK），直到 CLSE 或读写失败。
   */
  async openShell(callbacks: AdbShellCallbacks): Promise<AdbStream> {
    if (this.pumpRunning) throw new Error('已存在 shell 流')
    const localId = ++this.localIdCounter
    await this.send(A_OPEN, localId, 0, encoder.encode('shell:\0'))

    // 等 A_OKAY（流打开）：arg0 = 远端（设备）流 ID，arg1 = 本地（host）流 ID。
    let remoteId = 0
    while (true) {
      const { header } = await this.recvMessage()
      if (header.command === A_OKAY && header.arg1 === localId) {
        remoteId = header.arg0
        break
      }
      if (header.command === A_CLSE && header.arg1 === localId) {
        throw new Error('adbd 拒绝打开 shell 流')
      }
      // 其它消息忽略。
    }

    this.activeLocalId = localId
    this.activeRemoteId = remoteId
    this.activeCallbacks = callbacks
    this.pumpRunning = true
    void this.pump(localId, remoteId, callbacks)

    return {
      write: (data) => this.writeStream(localId, remoteId, data),
      close: () => this.closeShell(),
    }
  }

  /** 向已打开的 shell 流写入输入。只发不读，ACK 交给 pump。 */
  private async writeStream(
    localId: number,
    remoteId: number,
    data: Uint8Array<ArrayBuffer> | string,
  ): Promise<void> {
    if (!this.pumpRunning || this.activeLocalId !== localId) {
      throw new Error('shell 流已关闭')
    }
    const bytes = typeof data === 'string' ? encoder.encode(data) : data
    await this.send(A_WRTE, localId, remoteId, bytes)
  }

  /**
   * 持续读循环：设备 WRTE → 回调 onData 并回 OKAY（流控 ACK）；
   * 设备 CLSE → 回 CLSE 并结束。空闲（等待用户输入）是常态，故用阻塞读（不设短超时）。
   */
  private async pump(
    localId: number,
    remoteId: number,
    callbacks: AdbShellCallbacks,
  ): Promise<void> {
    const gen = this.generation
    try {
      while (this.generation === gen && this.activeLocalId === localId) {
        const { header, data } = await this.recvMessage(true)
        if (header.command === A_WRTE && header.arg1 === localId) {
          callbacks.onData(data)
          await this.send(A_OKAY, localId, remoteId)
        } else if (header.command === A_CLSE && header.arg1 === localId) {
          await this.send(A_CLSE, localId, remoteId)
          this.finishShell(localId)
          return
        }
        // OKAY（我们下发命令的 ACK）及其它消息忽略。
      }
    } catch {
      // 读失败（接口释放/掉线）：结束流（若尚未被 close 结束）。
      this.finishShell(localId)
    }
  }

  /** 结束 shell 流并通知关闭（幂等，只触发一次 onClose）。 */
  private finishShell(localId: number): void {
    if (!localId || this.activeLocalId !== localId) return
    const cb = this.activeCallbacks
    this.activeLocalId = 0
    this.activeRemoteId = 0
    this.activeCallbacks = null
    this.pumpRunning = false
    cb?.onClose()
  }

  /** 关闭 shell 流：发 CLSE 并本地结束（设备回 CLSE 时 pump 已退出）。 */
  async closeShell(): Promise<void> {
    const localId = this.activeLocalId
    if (!localId) return
    try {
      await this.send(A_CLSE, localId, this.activeRemoteId)
    } catch {
      // 忽略。
    }
    this.finishShell(localId)
  }

  /** 完全释放 ADB 接口（不关闭设备，避免影响 AT 会话）。 */
  async close(): Promise<void> {
    this.generation++
    const localId = this.activeLocalId
    if (localId) {
      try {
        await this.send(A_CLSE, localId, this.activeRemoteId)
      } catch {
        // 会话已失效，忽略。
      }
    }
    this.finishShell(localId)
    this.pumpRunning = false
    if (this.device && this.interfaceNumber !== null) {
      try {
        await this.device.releaseInterface(this.interfaceNumber)
      } catch {
        // 会话已失效，忽略。
      }
    }
    this.interfaceNumber = null
    this.outEndpoint = 0
    this.inEndpoint = 0
    this.pending = new Uint8Array(0)
    this.device = null
  }

  // --- 一次性 shell / sync 推送 ---

  /**
   * 打开一条 ADB 服务流（destination 形如 "shell:" / "shell:<cmd>" / "sync:"，
   * 自动补结尾 NUL）。返回 { localId, remoteId } 供一次性读写。
   * 用阻塞读等待 A_OKAY：无内部超时，由调用方（runCommand/push 的 withTimeout）兜底。
   */
  private async openService(destination: string): Promise<{ localId: number; remoteId: number }> {
    const localId = ++this.localIdCounter
    await this.send(A_OPEN, localId, 0, encoder.encode(`${destination}\0`))
    while (true) {
      const { header } = await this.recvMessage(true)
      if (header.command === A_OKAY && header.arg1 === localId) {
        return { localId, remoteId: header.arg0 }
      }
      if (header.command === A_CLSE && header.arg1 === localId) {
        throw new Error('adbd 拒绝打开服务')
      }
      // 其它消息忽略。
    }
  }

  /**
   * 执行一条一次性 shell 命令并返回 { output, status }。
   * 命令被包成子 shell + 退出码标记（checkedShellCommand），从回显反解退出状态。
   * 静默期（如 insmod 耗时数秒）由阻塞读 + 整体 withTimeout 容忍。
   */
  async runCommand(
    command: string,
    timeoutMs = 20_000,
  ): Promise<{ output: string; status: number }> {
    return this.withTimeout(this.runCommandInner(command), timeoutMs)
  }

  private async runCommandInner(
    command: string,
  ): Promise<{ output: string; status: number }> {
    const token = shellToken()
    const wrapped = checkedShellCommand(command, token)
    const { localId, remoteId } = await this.openService(`shell:${wrapped}`)
    let output = new Uint8Array(0)
    try {
      while (true) {
        const { header, data } = await this.recvMessage(true)
        if (header.command === A_WRTE && header.arg1 === localId) {
          output = concatBytes([output, data])
          if (output.length > MAX_SHELL_OUTPUT) throw new Error('模块 shell 输出过大')
          await this.send(A_OKAY, localId, remoteId)
        } else if (header.command === A_CLSE && header.arg1 === localId) {
          // 无论正常/异常关闭都回 A_CLSE，关闭本地流——否则 adbd 侧的 shell 服务流
          // 长期累积到上限，长时间连接后会「拒绝打开服务」。
          await this.send(A_CLSE, localId, remoteId).catch(() => {})
          break
        }
      }
    } catch (err) {
      await this.send(A_CLSE, localId, remoteId).catch(() => {})
      throw err
    }
    return parseCheckedShellOutput(new TextDecoder().decode(output), token)
  }

  /**
   * 通过 ADB sync 协议推送一个文件到模块（SEND → DATA 分块 → DONE → 读 OKAY/FAIL）。
   * mode 为「S_IFREG | 权限位」的十进制（如 0o100644 = 33188）。
   */
  async push(
    data: Uint8Array<ArrayBuffer>,
    remotePath: string,
    mode: number,
    modifiedAt = Math.floor(Date.now() / 1000),
  ): Promise<void> {
    return this.withTimeout(this.pushInner(data, remotePath, mode, modifiedAt), 30_000)
  }

  private async pushInner(
    data: Uint8Array<ArrayBuffer>,
    remotePath: string,
    mode: number,
    modifiedAt: number,
  ): Promise<void> {
    if (!remotePath || remotePath.includes(',') || remotePath.includes('\0')) {
      throw new Error('ADB push 目标路径无效')
    }
    const { localId, remoteId } = await this.openService('sync:')
    try {
      await this.writeSyncFrame(
        syncPacket('SEND', encoder.encode(`${remotePath},${mode}`)),
        localId,
        remoteId,
      )
      for (let offset = 0; offset < data.length; offset += SYNC_CHUNK_CAPACITY) {
        const chunk = data.slice(offset, Math.min(offset + SYNC_CHUNK_CAPACITY, data.length))
        await this.writeSyncFrame(syncPacket('DATA', chunk), localId, remoteId)
      }
      await this.writeSyncFrame(syncHeader('DONE', modifiedAt), localId, remoteId)

      // 读 8 字节 sync 响应（OKAY/FAIL）。
      let response = new Uint8Array(0)
      while (response.length < 8) {
        const { header, data: payload } = await this.recvMessage(true)
        if (header.command === A_WRTE && header.arg1 === localId) {
          response = concatBytes([response, payload])
          await this.send(A_OKAY, localId, remoteId)
        } else if (header.command === A_CLSE && header.arg1 === localId) {
          throw new Error('模块提前关闭 sync 流')
        }
      }
      const { identifier, value } = parseSyncHeader(response)
      if (identifier === 'FAIL') {
        const length = value
        if (length > MAX_SHELL_OUTPUT) throw new Error('模块 sync 失败消息过大')
        while (response.length < 8 + length) {
          const { header, data: payload } = await this.recvMessage(true)
          if (header.command === A_WRTE && header.arg1 === localId) {
            response = concatBytes([response, payload])
            await this.send(A_OKAY, localId, remoteId)
          } else if (header.command === A_CLSE && header.arg1 === localId) {
            break
          }
        }
        const detail = new TextDecoder().decode(response.slice(8, 8 + length))
        throw new Error(`模块拒绝文件传输：${detail}`)
      }
      if (identifier !== 'OKAY' || value !== 0) {
        throw new Error('模块 sync 返回无效状态')
      }
      await this.send(A_CLSE, localId, remoteId).catch(() => {})
    } catch (err) {
      await this.send(A_CLSE, localId, remoteId).catch(() => {})
      throw err
    }
  }

  /** 发送一条 sync 帧并等待设备 transport 层 OKAY（流控 ACK）。 */
  private async writeSyncFrame(
    frame: Uint8Array<ArrayBuffer>,
    localId: number,
    remoteId: number,
  ): Promise<void> {
    await this.send(A_WRTE, localId, remoteId, frame)
    while (true) {
      const { header } = await this.recvMessage(true)
      if (header.command === A_OKAY && header.arg0 === remoteId && header.arg1 === localId) {
        return
      }
      if (header.command === A_CLSE && header.arg1 === localId) {
        throw new Error('模块提前关闭 sync 流')
      }
      // 其它消息忽略。
    }
  }

  // --- 底层收发 ---

  private send(
    command: number,
    arg0: number,
    arg1: number,
    data: Uint8Array<ArrayBuffer> = new Uint8Array(0),
  ): Promise<void> {
    // 串行写 OUT 端点：pump 的 ACK 与用户 write 可能并发，单写者队列避免 OUT 竞争。
    return this.enqueueWrite(async () => {
      if (!this.device) throw new Error('Device not connected')
      // 关键：24 字节头与 payload 必须分两次 transferOut，不能拼成一个 buffer 一次发出。
      // 实测 QDC507 的 adbd 只对「分包写入」作出响应——把 header+payload 拼成一条 bulk OUT
      // 后（如 CNXN 的 45 字节），EP10-IN 一直无数据（adbd 不回应）。对齐参考实现
      // qdc507_adb_probe.c 的 adb_send：先写 sizeof(header)，再单独写 payload。
      const header = packHeader(command, arg0, arg1, data.length, checksum(data))
      await this.writeBytes(header)
      if (data.length > 0) await this.writeBytes(data)
      this.log(
        `adb send cmd=0x${command.toString(16)} arg0=${arg0} arg1=${arg1} len=${data.length}`,
      )
    })
  }

  /** OUT 端点写队列：串行执行 fn（前一个失败不阻塞后续）。 */
  private enqueueWrite(fn: () => Promise<void>): Promise<void> {
    const run = this.writeChain.then(fn)
    this.writeChain = run.catch(() => {})
    return run
  }

  private async writeBytes(data: Uint8Array<ArrayBuffer>): Promise<void> {
    if (!this.device) throw new Error('Device not connected')
    const result = await this.withTimeout(
      this.device.transferOut(this.outEndpoint, data),
      ADB_READ_TIMEOUT_MS,
    )
    if (result.status !== 'ok') {
      throw new Error(`Transfer out failed: ${result.status}`)
    }
  }

  private async readChunk(blocking = false): Promise<Uint8Array> {
    if (!this.device) throw new Error('Device not connected')
    let result: USBInTransferResult
    try {
      const transfer = this.device.transferIn(this.inEndpoint, 512)
      result = blocking
        ? await transfer
        : await this.withTimeout(transfer, ADB_READ_TIMEOUT_MS)
    } catch (err) {
      if (!blocking && this.isTimeout(err)) {
        this.log(
          `ADB read timeout: EP${this.inEndpoint} ${ADB_READ_TIMEOUT_MS}ms 内无数据（adbd 未回应）`,
        )
      }
      throw err
    }
    if (result.status !== 'ok') {
      this.log(
        `ADB read EP${this.inEndpoint} status=${result.status}（端点可能 HALT/NAK，需 clearHalt）`,
      )
      throw new Error(`Transfer in failed: ${result.status}`)
    }
    const dv = result.data
    return dv ? new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength) : new Uint8Array(0)
  }

  /** 从缓冲 + IN 端点读满 n 字节。 */
  private async readExact(n: number, blocking = false): Promise<Uint8Array<ArrayBuffer>> {
    while (this.pending.length < n) {
      this.pending = concatBytes([this.pending, await this.readChunk(blocking)])
    }
    const out = this.pending.slice(0, n)
    this.pending = this.pending.slice(n)
    return out
  }

  /** 读一条完整消息（24 字节头 + dataLength 字节负载）。 */
  private async recvMessage(
    blocking = false,
  ): Promise<{ header: AdbHeader; data: Uint8Array<ArrayBuffer> }> {
    const headerBytes = await this.readExact(ADB_HEADER_SIZE, blocking)
    const header = parseHeader(headerBytes)
    if ((header.magic ^ 0xffffffff) !== header.command) {
      throw new Error('ADB 消息头 magic 校验失败')
    }
    const data = await this.readExact(header.dataLength, blocking)
    return { header, data }
  }
}
