import type { UsbService } from './UsbService'
import {
  ORIGINAL_PID,
  ORIGINAL_VID,
  MODIFIED_PID,
  MODIFIED_VID,
  AT_MODIFY,
  AT_RESTORE,
  AT_CFUN,
  AT_CFUN_QUERY,
  AT_USBNET_QUERY,
  AT_USBNET_QMI,
  AT_USBNET_ECM,
  AT_USBNET_MBIM,
  AT_USBNET_RNDIS,
  AT_QNWINFO,
  AT_CREG,
  AT_CGSN,
  AT_QCCID,
  AT_CIMI,
  AT_CNUM,
  AT_CSQ,
  AT_CPIN,
  AT_CMGF_PDU,
  AT_CMGL_PDU,
  RECONNECT_WAIT_MS,
  MODE_RECONNECT_WAIT_MS,
} from '../constants'
import type {
  ModuleMode,
  UsbnetMode,
  FuncMode,
  SetUsbnetModeResult,
  RunningStatus,
  DeviceInfo,
  Telemetry,
  SignalInfo,
  SmsMessage,
  SmsStatus,
} from '../types'
import { parsePdu, type ConcatInfo } from '../utils/pdu'

const USBNET_COMMANDS: Record<UsbnetMode, string> = {
  qmi: AT_USBNET_QMI,
  ecm: AT_USBNET_ECM,
  mbim: AT_USBNET_MBIM,
  rndis: AT_USBNET_RNDIS,
}

// 功能模式（AT+CFUN）设置命令。省略 <rst>（=0），切换后不触发复位/重枚举。
const FUNC_MODE_COMMANDS: Record<FuncMode, string> = {
  0: 'AT+CFUN=0',
  1: 'AT+CFUN=1',
  4: 'AT+CFUN=4',
}

/** 一条已解析的短信（含长短信分段信息，用于重组）。 */
interface SmsPart extends SmsMessage {
  concat: ConcatInfo | null
}

export class ModuleService {
  private diagnostics: string[] = []
  // 操作串行化队列：同一 AT 口同一时刻只允许一条操作链（见 runExclusive）。
  private opQueue: Promise<unknown> = Promise.resolve()

  private log(line: string): void {
    this.diagnostics.push(line)
    console.log(`[ModuleService] ${line}`)
  }

  private hex(v: unknown): string {
    return typeof v === 'number' ? `0x${v.toString(16)}` : String(v ?? '?')
  }

  constructor(private usb: UsbService) {}

  /** 仅对瞬时性传输错误重试（模块 USB 会话间歇性掉线）；指令被拒绝等确定性错误不重试。 */
  private isTransient(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err)
    return /not connected|timed out|timeout|transfer/i.test(msg)
  }

  /** 操作级重试：默认 2 次，覆盖模块会话间歇性掉线导致的「Device not connected」。 */
  private async withRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
    let lastErr: unknown
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await fn()
      } catch (err) {
        lastErr = err
        if (!this.isTransient(err)) throw err
        this.log(
          `attempt ${attempt}/${attempts} failed, retrying: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
    throw lastErr
  }

  /**
   * 操作串行化：同一 AT 口同一时刻只允许一条操作链。
   *
   * SettingsCard 挂载时工作模式查询与运行状态/设备信息查询会同时发起，
   * 而 UsbService.connect/send/read 共享 inEndpoint 状态、不并发安全——两条链
   * 并发收发会在同一 IN 端点上互相串读（各自读到对方的应答）。用 promise 链
   * 让每个公开操作排队执行；前序操作失败不阻塞后续操作。
   */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opQueue.then(fn, fn)
    this.opQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  detectState(device: USBDevice): ModuleMode {
    if (device.vendorId === ORIGINAL_VID && device.productId === ORIGINAL_PID) {
      return 'original'
    }
    if (device.vendorId === MODIFIED_VID && device.productId === MODIFIED_PID) {
      return 'modified'
    }
    return 'unknown'
  }

  /**
   * 执行修改/恢复。
   * 返回 { detected }：指令成功后尽力检测模块是否以新 VID/PID 重新枚举。
   * 即使检测不到也视为成功（指令已写入 NVRAM 并触发重启）。
   */
  async applyConfig(
    device: USBDevice,
    target: 'original' | 'modified',
  ): Promise<{ detected: boolean }> {
    this.diagnostics = []
    const command = target === 'original' ? AT_RESTORE : AT_MODIFY
    const expectedVid = target === 'original' ? ORIGINAL_VID : MODIFIED_VID
    const expectedPid = target === 'original' ? ORIGINAL_PID : MODIFIED_PID

    try {
      // 指令 + 校验放在 withRetry 内：模块会话会间歇性掉线（传输报
      // 「Device not connected」），自动重试一次即可恢复。
      // CFUN 只在指令确认成功之后发送，因此重试绝不会把指令重复发到
      // 「已写入并重启」这种不可逆阶段。
      return await this.runExclusive(async () => {
        await this.withRetry(async () => {
          await this.usb.connect(device)
          await this.usb.send(command)
          const response = await this.usb.read()
          this.log(`usbcfg response: ${JSON.stringify(response)}`)
          if (!response.includes('OK')) {
            throw new Error(`Module rejected command: ${response}`)
          }
        })
        // CFUN 后模块随即软重启（中断 10~30 秒）。此刻再 read() 必然挂起，
        // withTimeout 超时后底层 transferIn 无法取消，会留下 in-flight 传输。
        // 因此 CFUN 后不读取，直接进入重连检测。也不调用 close()：重启会让
        // 旧会话自然消亡，而 close() 在此模块上不稳定（见 UsbService.connect）。
        await this.usb.send(AT_CFUN)

        const detected = await this.waitForReconnect(
          device,
          expectedVid,
          expectedPid,
          RECONNECT_WAIT_MS,
        )
        return { detected }
      })
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      ;(e as { diagnostics?: string }).diagnostics = this.diagnostics.join('\n')
      throw e
    }
  }

  /** 查询当前 usbnet 工作模式：0=QMI，1=ECM，2=MBIM，3=RNDIS。失败抛带 diagnostics 的错误。 */
  async queryUsbnetMode(device: USBDevice): Promise<UsbnetMode> {
    this.diagnostics = []
    try {
      // 查询保持会话打开（不 close），失败时自动重试一次。
      // 掉线一次是模块间歇性问题，不是设备状态错误，无需用户手动点「重试」。
      // 放入 runExclusive：与运行状态/设备信息查询串行，避免同口并发串读。
      return await this.runExclusive(async () => {
        return await this.withRetry(async () => {
          await this.usb.connect(device)
          await this.usb.send(AT_USBNET_QUERY)
          const response = await this.usb.read()
          this.log(`usbnet query response: ${JSON.stringify(response)}`)
          const match = response.match(/"usbnet",(\d+)/)
          if (!match) {
            throw new Error(`无法解析当前工作模式: ${response}`)
          }
          const value = Number(match[1])
          if (value === 0) return 'qmi'
          if (value === 1) return 'ecm'
          if (value === 2) return 'mbim'
          if (value === 3) return 'rndis'
          throw new Error(`未知的 usbnet 模式: ${value}`)
        })
      })
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      ;(e as { diagnostics?: string }).diagnostics = this.diagnostics.join('\n')
      throw e
    }
  }

  /**
   * 查询当前功能模式（AT+CFUN?）。0=最小功能，1=全功能，4=飞行模式。
   * 与其它只读查询一致：connect 幂等、会话保持打开、失败自动重试一次。
   */
  async queryFuncMode(device: USBDevice): Promise<FuncMode> {
    this.diagnostics = []
    try {
      return await this.runExclusive(async () => {
        return await this.withRetry(async () => {
          await this.usb.connect(device)
          await this.usb.send(AT_CFUN_QUERY)
          const response = await this.usb.read()
          this.log(`cfun query response: ${JSON.stringify(response)}`)
          const match = response.match(/\+CFUN:\s*(\d+)/)
          if (!match) {
            throw new Error(`无法解析当前功能模式: ${response}`)
          }
          const value = Number(match[1])
          if (value === 0 || value === 1 || value === 4) return value
          throw new Error(`未知的功能模式: ${value}`)
        })
      })
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      ;(e as { diagnostics?: string }).diagnostics = this.diagnostics.join('\n')
      throw e
    }
  }

  /**
   * 设置功能模式（AT+CFUN=<n>，0/1/4）。省略 <rst>（=0），模块不重启、不重枚举，
   * 因此无需像 usbnet 切换那样等待重连；确认 OK 即生效。
   */
  async setFuncMode(device: USBDevice, target: FuncMode): Promise<void> {
    this.diagnostics = []
    try {
      await this.runExclusive(async () => {
        await this.withRetry(async () => {
          await this.usb.connect(device)
          await this.usb.send(FUNC_MODE_COMMANDS[target])
          const response = await this.usb.read()
          this.log(`cfun set response: ${JSON.stringify(response)}`)
          if (!response.includes('OK')) {
            throw new Error(`Module rejected command: ${response}`)
          }
        })
      })
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      ;(e as { diagnostics?: string }).diagnostics = this.diagnostics.join('\n')
      throw e
    }
  }

  /** 发送一条只读 AT 指令并等待应答；read() 累积到 OK/ERROR 为止。 */
  private async sendAndRead(command: string): Promise<string> {
    await this.usb.send(command)
    return await this.usb.read()
  }

  // AT+CREG? 的状态值 → 注册状态文案。
  private static readonly REGISTRATION_STATES: Record<number, string> = {
    0: '未注册',
    1: '已注册（本地网络）',
    2: '正在搜索',
    3: '注册被拒绝',
    4: '未知',
    5: '已注册（漫游）',
  }

  // 取首个 15 位数字串作为 IMEI/IMSI（回显文本里混有命令回显与换行）。
  private static digits(raw: string): string | undefined {
    return raw.match(/\d{15}/)?.[0]
  }

  /**
   * 解析运行状态。AT+QNWINFO 例：+QNWINFO: "LTE","460 11",LTE BAND 1,100
   * → 网络模式/频段/信道；AT+CREG? 例：+CREG: 0,1。查询不到时用「—」占位。
   */
  private parseRunningStatus(
    qnw: string,
    creg: string,
    csq: string,
    cpin: string,
  ): RunningStatus {
    const qnwMatch = qnw.match(
      /\+QNWINFO:\s*"([^"]+)"\s*,\s*"([^"]*)"\s*,\s*([^,]+)\s*,\s*(\d+)/,
    )
    const networkMode = qnwMatch?.[1] ?? '—'
    const band = (qnwMatch?.[3] ?? '—').replace(/["']/g, '').trim()
    const channel = qnwMatch?.[4] ?? '—'

    // +CREG: <n>,<stat>（部分固件只回 <stat>）。
    const statMatch =
      creg.match(/\+CREG:\s*\d+\s*,\s*(\d+)/) ?? creg.match(/\+CREG:\s*(\d+)/)
    const stat = statMatch ? Number(statMatch[1]) : undefined
    const registration =
      stat !== undefined
        ? (ModuleService.REGISTRATION_STATES[stat] ?? `未知（${stat}）`)
        : '—'

    return {
      networkMode,
      band,
      channel,
      registration,
      signal: this.parseSignal(csq, cpin),
    }
  }

  /** 解析信号强度：AT+CSQ 的 rssi(0-31) 映射 0-4 档；SIM 未就绪或 rssi=99 时无档位。 */
  private parseSignal(csq: string, cpin: string): SignalInfo {
    // SIM 未就绪：+CPIN? 非 READY（无卡通常回 +CME ERROR: SIM not inserted / NOT INSERTED）。
    const simReady = /\+CPIN:\s*READY/i.test(cpin)

    // +CSQ: <rssi>,<ber>；rssi=99 表示无法测量。
    const rssi = Number(csq.match(/\+CSQ:\s*(\d+)/)?.[1])
    const measurable = simReady && Number.isFinite(rssi) && rssi !== 99
    let bars: number | null = null
    if (measurable) {
      if (rssi === 0) bars = 0
      else if (rssi <= 9) bars = 1
      else if (rssi <= 14) bars = 2
      else if (rssi <= 19) bars = 3
      else bars = 4
    }
    // 3GPP TS 27.007：+CSQ 的 RSSI 0 → -113 dBm，每 +1 → +2 dBm（31 → -51 dBm）。
    const dbm = measurable ? -113 + rssi * 2 : null
    return { bars, simReady, dbm }
  }

  /** 解析设备信息：IMEI/IMSI 取数字串，ICCID 来自 +QCCID:，本机号码来自 +CNUM 引号内。 */
  private parseDeviceInfo(
    imeiRaw: string,
    iccidRaw: string,
    imsiRaw: string,
    numRaw: string,
  ): DeviceInfo {
    const iccid = iccidRaw.match(/\+QCCID:\s*([\w]+)/)?.[1] ?? '—'
    const numMatch = numRaw.match(/\+CNUM:\s*[^,]*,\s*"([^"]*)"/)
    return {
      imei: ModuleService.digits(imeiRaw) ?? '—',
      iccid,
      imsi: ModuleService.digits(imsiRaw) ?? '—',
      phoneNumber: numMatch?.[1] || '—',
    }
  }

  /**
   * 只读取运行状态（网络/频段/信道/注册/信号），不含设备信息。
   * 用于定时静默刷新——设备信息（IMEI/ICCID/IMSI/号码）静态不变，
   * 只查这 4 条运行状态指令即可，省一半轮询开销。
   */
  async getRunningStatus(device: USBDevice): Promise<RunningStatus> {
    this.diagnostics = []
    try {
      return await this.runExclusive(async () => {
        return await this.withRetry(async () => {
          await this.usb.connect(device)
          const qnw = await this.sendAndRead(AT_QNWINFO)
          const creg = await this.sendAndRead(AT_CREG)
          const csq = await this.sendAndRead(AT_CSQ)
          const cpin = await this.sendAndRead(AT_CPIN)
          return this.parseRunningStatus(qnw, creg, csq, cpin)
        })
      })
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      ;(e as { diagnostics?: string }).diagnostics = this.diagnostics.join('\n')
      throw e
    }
  }

  /**
   * 一次性读取运行状态 + 设备信息。
   * 只读指令按顺序逐条收发（同一 AT 口不能并发读写）；connect() 幂等，
   * 连接一次后复用会话，失败时整体重试一次（覆盖会话间歇性掉线）。
   * 与查询 usbnet 相同：正常流程不调用 close()。查询不到/被拒的字段以
   * 占位符「—」表示，不会让整块查询失败。
   */
  async getTelemetry(device: USBDevice): Promise<Telemetry> {
    this.diagnostics = []
    try {
      // 放入 runExclusive：与工作模式查询串行，避免同一 AT 口并发收发互相串读。
      return await this.runExclusive(async () => {
        return await this.withRetry(async () => {
          await this.usb.connect(device)
          const qnw = await this.sendAndRead(AT_QNWINFO)
          const creg = await this.sendAndRead(AT_CREG)
          const imei = await this.sendAndRead(AT_CGSN)
          const iccid = await this.sendAndRead(AT_QCCID)
          const imsi = await this.sendAndRead(AT_CIMI)
          const num = await this.sendAndRead(AT_CNUM)
          const csq = await this.sendAndRead(AT_CSQ)
          const cpin = await this.sendAndRead(AT_CPIN)
          return {
            running: this.parseRunningStatus(qnw, creg, csq, cpin),
            deviceInfo: this.parseDeviceInfo(imei, iccid, imsi, num),
          }
        })
      })
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      ;(e as { diagnostics?: string }).diagnostics = this.diagnostics.join('\n')
      throw e
    }
  }

  // --- 短信（3GPP TS 27.005，PDU 模式读取以解析 UDH 重组长短信）---

  // PDU 模式（CMGF=0）是否已对当前设备配置。按设备对象身份缓存：
  // 同一会话内只配置一次；设备重枚举会拿到新对象、模块回到文本模式，需重新配置。
  private pduModeDevice: USBDevice | null = null

  /** 确保当前设备处于短信 PDU 模式（幂等，按设备对象缓存）。 */
  private async ensurePduMode(device: USBDevice): Promise<void> {
    if (this.pduModeDevice === device) return
    const cmgf = await this.sendAndRead(AT_CMGF_PDU)
    if (!/OK/.test(cmgf)) {
      throw new Error('无法配置短信 PDU 模式')
    }
    this.pduModeDevice = device
  }

  /**
   * 列出全部短信（AT+CMGL=4，PDU 模式）。只读、幂等，失败可自动重试一次。
   * 解析每条 PDU 并重组长短信：按「方向 + 号码 + 引用号」分组、按段号排序拼接。
   */
  async listSms(device: USBDevice): Promise<SmsMessage[]> {
    this.diagnostics = []
    try {
      return await this.runExclusive(async () => {
        return await this.withRetry(async () => {
          await this.usb.connect(device)
          await this.ensurePduMode(device)
          const raw = await this.sendAndRead(AT_CMGL_PDU)
          this.log(`cmgl response: ${JSON.stringify(raw)}`)
          return this.parsePduList(raw)
        })
      })
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      ;(e as { diagnostics?: string }).diagnostics = this.diagnostics.join('\n')
      throw e
    }
  }

  // PDU 模式下 AT+CMGL=4 的 stat 数值 → 状态文案。
  private static readonly PDU_STATUS: Record<number, SmsStatus> = {
    0: 'REC UNREAD',
    1: 'REC READ',
    2: 'STO UNSENT',
    3: 'STO SENT',
  }

  /** 解析 AT+CMGL（PDU 模式）响应为短信数组，含长短信重组。 */
  private parsePduList(raw: string): SmsMessage[] {
    const parts: SmsPart[] = []
    // 以 +CMGL: 切分记录：首段是命令回显，丢弃；每段首行是记录头，其余行是 PDU hex。
    const records = raw.split(/\+CMGL:/).slice(1)
    for (const rec of records) {
      const lines = rec.split(/\r?\n/).map((l) => l.trim())
      const header = lines[0] ?? ''
      const headerMatch = header.match(/^(\d+)\s*,\s*(\d+)/)
      if (!headerMatch) continue
      const index = Number(headerMatch[1])
      const status = ModuleService.PDU_STATUS[Number(headerMatch[2])]
      if (!status) continue
      const pduHex = lines
        .slice(1)
        .filter((l) => l.length > 0 && !/^(OK|ERROR)/.test(l))
        .join('')
        .replace(/\s+/g, '')
      if (!pduHex) continue
      const parsed = parsePdu(pduHex)
      if (!parsed) continue
      parts.push({
        index,
        status,
        address: parsed.address,
        direction: parsed.direction,
        timestamp: parsed.timestamp,
        text: parsed.text,
        concat: parsed.concat,
      })
    }
    return this.reassembleParts(parts)
  }

  /** 重组长短信：按「方向 + 号码 + 引用号」分组，段内按段号排序、正文拼接。 */
  private reassembleParts(parts: SmsPart[]): SmsMessage[] {
    const result: SmsMessage[] = []
    const groups = new Map<string, SmsPart[]>()
    for (const p of parts) {
      if (p.concat && p.concat.total > 1) {
        const key = `${p.direction} ${p.address} ${p.concat.ref}`
        const arr = groups.get(key) ?? []
        arr.push(p)
        groups.set(key, arr)
      } else {
        result.push({
          index: p.index,
          status: p.status,
          address: p.address,
          direction: p.direction,
          timestamp: p.timestamp,
          text: p.text,
        })
      }
    }
    for (const arr of groups.values()) {
      arr.sort((a, b) => (a.concat?.seq ?? 0) - (b.concat?.seq ?? 0))
      const first = arr[0]
      result.push({
        index: Math.min(...arr.map((m) => m.index)),
        status: first.status,
        address: first.address,
        direction: first.direction,
        timestamp: first.timestamp,
        text: arr.map((m) => m.text).join(''),
      })
    }
    return result
  }

  /**
   * 切换工作模式（QMI/ECM/MBIM/RNDIS）。发送 usbnet 指令 → 确认 OK → 软重启 → 等待重连。
   * usbnet 不变更 VID/PID，Chrome 保留授权，因此能真正检测到重连；
   * 重连成功后返回重新枚举的新设备对象（旧对象已失效）。
   */
  async setUsbnetMode(
    device: USBDevice,
    target: UsbnetMode,
    onProgress?: (step: 'sending' | 'waiting-reboot' | 'reconnecting') => void,
    timeoutMs: number = MODE_RECONNECT_WAIT_MS,
  ): Promise<SetUsbnetModeResult> {
    this.diagnostics = []
    const command = USBNET_COMMANDS[target]

    try {
      // 放入 runExclusive：切换过程中模块重启，期间的其他查询不应在同一
      // AT 口上并发（它们会排队等到本操作结束）。
      return await this.runExclusive(async () => {
        // 指令 + 校验放在 withRetry 内（自动重试一次，覆盖会话间歇性掉线）。
        // CFUN 在确认 OK 之后才发送，重试不会把指令重复发到不可逆阶段。
        await this.withRetry(async () => {
          onProgress?.('sending')
          await this.usb.connect(device)
          await this.usb.send(command)
          const response = await this.usb.read()
          this.log(`usbnet response: ${JSON.stringify(response)}`)
          if (!response.includes('OK')) {
            throw new Error(`Module rejected command: ${response}`)
          }
        })
        onProgress?.('waiting-reboot')
        // 与 applyConfig 同理：CFUN 后模块立即软重启，read() 必然挂起并留下
        // 无法取消的 in-flight 传输。不调用 close()：重启后旧会话自然消亡，
        // 由 waitForDevice 等待重枚举后的新设备对象。
        await this.usb.send(AT_CFUN)

        onProgress?.('reconnecting')
        // 尽力自动重连。切换本身在指令确认 OK 时已经成功；重连只为刷新显示。
        // 此模块未暴露 USB 序列号，WebUSB 授权不持久（见 UsbService 注释），
        // getDevices() 重启后返回空，自动重连通常失败——这是浏览器的权限模型
        // 限制，不是切换失败，因此超时返回 reconnected:false，由 UI 引导用户
        // 手动重新连接。
        const fresh = await this.waitForDevice(
          device,
          device.vendorId,
          device.productId,
          timeoutMs,
        )
        if (fresh) {
          this.log(
            `reconnected to fresh device (VID ${this.hex(fresh.vendorId)} PID ${this.hex(fresh.productId)})`,
          )
          return { reconnected: true, device: fresh }
        }
        this.log(
          'reconnect wait: auto-reconnect unavailable (module likely has no USB serial number)',
        )
        return { reconnected: false, device: null }
      })
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      ;(e as { diagnostics?: string }).diagnostics = this.diagnostics.join('\n')
      throw e
    }
  }

  /**
   * 尽力检测模块以给定 VID/PID 重新枚举；超时返回 null。
   *
   * 两个关键点（否则会出现「对话框提前关闭 + 重启后显示旧模式」）：
   * - 只在「真重枚举」后算重连：CFUN 后模块不是瞬间断电，前一秒仍是
   *   连着的旧会话（旧模式）。旧会话 = 同一设备对象且从未观察到断开；
   *   只有观察到设备消失过（disconnect 事件 / 轮询里不见），或拿到的是
   *   新对象（重枚举 = 新 GUID = 新 wrapper，getDevices 按 GUID 缓存对象），
   *   才说明模块真的重启了。
   * - 返回前做「AT 就绪探测」：重枚举 ≠ AT 口已可用。用 failFast + 短超时
   *   connect()，模块仍在启动时会快速失败，下一轮轮询再试；AT 能应答了
   *   才算重连成功，保证调用方随后的查询一次就拿到新状态。
   */
  private waitForDevice(
    device: USBDevice,
    expectedVid: number,
    expectedPid: number,
    timeoutMs: number,
  ): Promise<USBDevice | null> {
    return new Promise((resolve) => {
      const start = Date.now()
      let finished = false
      // 是否观察到设备消失过（模块已开始重启）。
      let observedDisconnect = false
      // 是否正在做 AT 就绪探测（避免多路并发探测）。
      let verifying = false

      const done = (found: USBDevice | null) => {
        if (finished) return
        finished = true
        cleanup()
        resolve(found)
      }

      const verify = async (candidate: USBDevice) => {
        if (verifying || finished) return
        verifying = true
        try {
          await this.usb.connect(candidate, {
            probeSendTimeoutMs: 800,
            probeReadTimeoutMs: 800,
            failFast: true,
          })
          this.log('reconnect: AT ready on fresh session')
          done(candidate)
        } catch (err) {
          this.log(
            `reconnect: AT not ready yet, keep waiting (${
              err instanceof Error ? err.message : String(err)
            })`,
          )
          verifying = false
        }
      }

      const onConnectDevice = (candidate: USBDevice) => {
        this.log(
          `reconnect candidate: VID ${this.hex(candidate.vendorId)} PID ${this.hex(
            candidate.productId,
          )}`,
        )
        if (
          candidate.vendorId === expectedVid &&
          candidate.productId === expectedPid
        ) {
          // connect 事件 = 设备重枚举，旧会话必然已消失。
          this.log('reconnect matched via connect event')
          observedDisconnect = true
          verify(candidate)
        }
      }

      const onConnectEvent = (event: { device: USBDevice }) =>
        onConnectDevice(event.device)

      // 同时用 addEventListener 与 onconnect 属性注册，覆盖浏览器实现差异。
      navigator.usb?.addEventListener?.(
        'connect',
        onConnectEvent as unknown as EventListener,
      )
      if (navigator.usb) {
        ;(navigator.usb as unknown as { onconnect?: unknown }).onconnect =
          onConnectEvent as unknown as EventListener
      }

      const cleanup = () => {
        navigator.usb?.removeEventListener?.(
          'connect',
          onConnectEvent as unknown as EventListener,
        )
        if (navigator.usb) {
          ;(navigator.usb as unknown as { onconnect?: unknown }).onconnect = null
        }
        clearInterval(interval)
      }

      const interval = setInterval(async () => {
        if (Date.now() - start > timeoutMs) {
          this.log('reconnect wait: timed out, device not detected')
          done(null)
          return
        }
        try {
          const devices = await navigator.usb.getDevices()
          this.log(`reconnect poll: ${devices.length} authorized device(s)`)
          const matched = devices.find(
            (d) => d.vendorId === expectedVid && d.productId === expectedPid,
          )
          if (!matched) {
            observedDisconnect = true
            this.log('reconnect: device absent (reboot in progress)')
            return
          }
          // 区分「重启前仍连着的旧会话」与「重枚举后的新会话」：
          // 旧会话 = 同一对象且从未观察到断开；新会话 = 对象已变化，或观察到过断开。
          const reenumerated = observedDisconnect || matched !== device
          if (!reenumerated) {
            this.log('reconnect: still the pre-reboot session, keep waiting')
            return
          }
          verify(matched)
        } catch (err) {
          this.log(
            `reconnect poll error: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      }, 1000)
    })
  }

  /** 尽力检测模块以新 VID/PID 重新枚举；永不 reject，超时返回 false。 */
  private async waitForReconnect(
    device: USBDevice,
    expectedVid: number,
    expectedPid: number,
    timeoutMs: number,
  ): Promise<boolean> {
    const fresh = await this.waitForDevice(
      device,
      expectedVid,
      expectedPid,
      timeoutMs,
    )
    return fresh !== null
  }
}
