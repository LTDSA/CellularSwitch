import {
  READ_TIMEOUT_MS,
  ORIGINAL_VID,
  MODIFIED_VID,
  CONNECT_STEP_TIMEOUT_MS,
} from '../constants'

export class UsbService {
  private device: USBDevice | null = null
  private outEndpoint = 0
  private inEndpoint = 0
  private diagnostics: string[] = []

  private log(line: string): void {
    this.diagnostics.push(line)
    console.log(`[UsbService] ${line}`)
  }

  private hex(v: unknown): string {
    return typeof v === 'number' ? `0x${v.toString(16)}` : String(v ?? '?')
  }

  private hexBytes(u8: Uint8Array): string {
    return Array.from(u8)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')
  }

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'usb' in navigator
  }

  async requestDevice(): Promise<USBDevice> {
    if (!UsbService.isSupported()) {
      throw new Error('WebUSB is not supported')
    }
    return navigator.usb.requestDevice({
      filters: [{ vendorId: ORIGINAL_VID }, { vendorId: MODIFIED_VID }],
    })
  }

  /**
   * 建立会话并定位 AT 接口。设计要点：
   *
   * - 刻意不主动 close()：此模块上 device.close() 不稳定（常抛「An operation that
   *   changes the device state is in progress」），且失败的 close() 会污染缓存的
   *   设备对象，导致后续所有操作报「Device not connected」。因此查询/切换流程保持
   *   会话打开，靠 open()/claimInterface() 的幂等性（已打开/已 claim 直接 resolve）
   *   复用会话；页面关闭或模块重启时由 Chrome 自动清理旧会话。
   * - 自愈：模块的 USB 会话会间歇性掉线（传输报「Device not connected」），open()
   *   每次都能重建句柄。这里依次尝试「传入对象 + getDevices() 中本模块的授权对象」，
   *   取第一个能成功 open 的（open 失败说明对象已失效，重枚举后的新对象通常可用）。
   */
  async connect(
    device: USBDevice,
    opts?: {
      probeSendTimeoutMs?: number
      probeReadTimeoutMs?: number
      failFast?: boolean
    },
  ): Promise<void> {
    this.diagnostics = []
    device = await this.acquireUsable(device)
    this.device = device
    if (device.configuration === null) {
      // 原生调用也加超时：Windows 无驱动时可能挂起，超时快速失败而非卡死。
      try {
        await this.withTimeout(
          device.selectConfiguration(1),
          CONNECT_STEP_TIMEOUT_MS,
        )
      } catch (err) {
        throw this.fail(
          `无法配置设备接口（${
            err instanceof Error ? err.message : String(err)
          }），请确认已安装 WinUSB 驱动`,
        )
      }
    }

    // --- 诊断日志：输出设备与接口描述符 ---
    this.log(`VID ${this.hex(device.vendorId)}  PID ${this.hex(device.productId)}`)
    const interfaceList = device.configuration!.interfaces.map((intf) => ({
      interfaceNumber: intf.interfaceNumber,
      class: this.hex(intf.alternate.interfaceClass),
      subclass: this.hex(intf.alternate.interfaceSubclass),
      protocol: this.hex(intf.alternate.interfaceProtocol),
      endpoints: intf.alternate.endpoints.map(
        (e) => `${e.direction}${e.endpointNumber}:${e.type ?? '?'}`,
      ),
    }))
    this.log(`interfaces: ${JSON.stringify(interfaceList)}`)
    // ------------------------------------------------------------------------

    // 候选：class=0xFF 且有 OUT/IN 端点。
    // 该模块 AT 口 class=0xFF 但 subclass/protocol 可能为 0x0。
    const candidates = device.configuration!.interfaces.filter((intf) => {
      const alt = intf.alternate
      return (
        alt.interfaceClass === 0xff &&
        alt.endpoints.some((e) => e.direction === 'out') &&
        alt.endpoints.some((e) => e.direction === 'in')
      )
    })

    if (candidates.length === 0) {
      this.log('no vendor-specific bulk candidates; will throw')
      throw this.fail('未能定位 AT 命令接口，请确认模块已正确插入后重试')
    }

    // 参考 CdricZhang/dji-cellular-as-modem 的研究笔记：
    // 该模块（DJI 私有布局）的 AT 通道在接口 3（EP 0x04 OUT / 0x86 IN），
    // 接口 0 是 DIAG、接口 4 是网络/QMI。按 3 → 2 → 1 → 0 → 4 的优先级探测，
    // 非 AT 接口的 OUT 会 NAK，但 send() 已加 2s 超时，不会永久挂起。
    candidates.sort((a, b) => {
      const priority = (n: number): number =>
        n === 3 ? 0 : n === 2 ? 1 : n === 1 ? 2 : n === 0 ? 3 : 4
      return priority(a.interfaceNumber) - priority(b.interfaceNumber)
    })

    for (const iface of candidates) {
      const alt = iface.alternate
      const outEps = alt.endpoints.filter((e) => e.direction === 'out')
      // 优先 bulk IN；没有则回退到任意 IN。AT 响应走 bulk，不走 interrupt。
      const bulkInEps = alt.endpoints.filter(
        (e) => e.direction === 'in' && e.type === 'bulk',
      )
      const inEps = bulkInEps.length
        ? bulkInEps
        : alt.endpoints.filter((e) => e.direction === 'in')

      this.log(`=== probing iface ${iface.interfaceNumber} ===`)
      try {
        // Windows 上接口未绑定 WinUSB 驱动时 claimInterface 会永久挂起；
        // 加超时使其快速失败。超时后底层 claim 仍在飞（无法取消），继续
        // 探测下一接口会累积 orphan 请求，刷新页面时更易触发崩溃，故立即失败。
        await this.withTimeout(
          device.claimInterface(iface.interfaceNumber),
          CONNECT_STEP_TIMEOUT_MS,
        )
        this.log(`iface ${iface.interfaceNumber} claim OK`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.log(`iface ${iface.interfaceNumber} claim failed: ${msg}`)
        if (/timeout/i.test(msg)) {
          // 尽力关闭以终止底层挂起的 claim，减少刷新时的残留请求。
          await this.close()
          throw this.fail('设备接口无响应，请确认已安装 WinUSB 驱动后重试')
        }
        continue
      }
      this.outEndpoint = outEps[0]?.endpointNumber ?? 0

      let found = false
      for (const inEp of inEps) {
        this.inEndpoint = inEp.endpointNumber
        try {
          // 重连就绪探测（failFast）用短超时，让启动中的模块快速失败；
          // 正常连接沿用默认超时。
          await this.send('AT', opts?.probeSendTimeoutMs ?? 2000)
          this.log(
            `iface ${iface.interfaceNumber} sent AT on OUT${this.outEndpoint}`,
          )
          // 累加式读取：模块会把回显(AT\r)和 OK 分两个 USB 传输发送，
          // 必须等到出现 OK/ERROR 为止（read() 内部累加）。
          const response = await this.read(opts?.probeReadTimeoutMs ?? 1500)
          this.log(
            `iface ${iface.interfaceNumber} IN${inEp.endpointNumber} probe: ${JSON.stringify(response)}`,
          )
          if (/OK|ERROR/.test(response)) {
            this.log(
              `AT port found: iface ${iface.interfaceNumber}, IN${inEp.endpointNumber}, OUT${this.outEndpoint}`,
            )
            found = true
            break
          }
          this.log(
            `iface ${iface.interfaceNumber} IN${inEp.endpointNumber}: non-AT response, skipping`,
          )
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          this.log(
            `iface ${iface.interfaceNumber} IN${inEp.endpointNumber} probe failed: ${msg}`,
          )
          // failFast：不逐个接口慢试，第一个接口探测失败即视为「未就绪」，
          // 由调用方（重连就绪探测）稍后重试。同一模块 AT 口位置不变，安全。
          if (opts?.failFast) throw err
          break
        }
      }

      if (found) return

      // 探测失败时释放该接口（失败不影响继续探测其他接口）。
      try {
        await device.releaseInterface(iface.interfaceNumber)
        this.log(`iface ${iface.interfaceNumber} released`)
      } catch (err) {
        this.log(
          `iface ${iface.interfaceNumber} release failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }

    this.log('no interface confirmed as AT port')
    throw this.fail('未能定位 AT 命令接口，请确认模块已正确插入后重试')
  }

  async send(command: string, timeoutMs = 2000): Promise<void> {
    // AT 指令以 CRLF 结尾。
    return this.sendRaw(command + '\r\n', timeoutMs)
  }

  /** 原样发送数据（不追加 CRLF）。用于短信正文——以 \x1A（Ctrl+Z）结尾。 */
  async sendRaw(data: string, timeoutMs = 2000): Promise<void> {
    if (!this.device) throw new Error('Device not connected')
    const encoder = new TextEncoder()
    // 用 withTimeout 包裹：某些非 AT 接口的 OUT 端点会无限 NAK，
    // 不加超时会导致 transferOut 永久挂起。
    const result = await this.withTimeout(
      this.device.transferOut(this.outEndpoint, encoder.encode(data)),
      timeoutMs,
    )
    if (result.status !== 'ok') {
      throw new Error(`Transfer out failed: ${result.status}`)
    }
  }

  async read(timeoutMs = READ_TIMEOUT_MS): Promise<string> {
    return this.readUntil((buffer) => /OK|ERROR/.test(buffer), timeoutMs)
  }

  /** 累加式读取，直到 matcher(buffer) 为真；超时抛错。 */
  async readUntil(
    matcher: (buffer: string) => boolean,
    timeoutMs = READ_TIMEOUT_MS,
  ): Promise<string> {
    if (!this.device) throw new Error('Device not connected')
    const decoder = new TextDecoder()
    let buffer = ''
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      const result = await this.withTimeout(
        this.device.transferIn(this.inEndpoint, 512),
        remaining,
      )
      if (result.status !== 'ok') {
        throw new Error(`Transfer in failed: ${result.status}`)
      }
      const dv = result.data
      const bytes = dv
        ? new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)
        : new Uint8Array(0)
      const decoded = dv ? decoder.decode(dv) : ''
      buffer += decoded
      this.log(
        `read IN${this.inEndpoint} (${bytes.byteLength} B): ${this.hexBytes(bytes)} | text: ${JSON.stringify(decoded)}`,
      )
      if (matcher(buffer)) {
        return buffer.trim()
      }
    }

    throw new Error('Timed out waiting for device response')
  }

  /** 候选设备对象：传入对象 + getDevices() 中本模块的授权对象，按序去重。 */
  private async deviceCandidates(device: USBDevice): Promise<USBDevice[]> {
    const isOurs = (d: USBDevice) =>
      d.vendorId === ORIGINAL_VID || d.vendorId === MODIFIED_VID
    const list: USBDevice[] = [device]
    try {
      const devices = await navigator.usb.getDevices()
      for (const d of devices) {
        if (isOurs(d) && !list.includes(d)) list.push(d)
      }
    } catch {
      // getDevices 失败（无授权/不支持）时只用传入对象。
    }
    return list
  }

  /** 依次尝试候选对象，返回第一个成功 open 的；全部失败则抛错。 */
  private async acquireUsable(device: USBDevice): Promise<USBDevice> {
    for (const candidate of await this.deviceCandidates(device)) {
      try {
        await this.withTimeout(candidate.open(), CONNECT_STEP_TIMEOUT_MS)
        return candidate
      } catch (err) {
        this.log(
          `open failed (session may be stale): ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
    throw this.fail('无法建立设备会话，请拔出模块后重新插入再试')
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

  /**
   * 尽力收尾（应用卸载时调用）。此模块上 close() 可能失败并污染对象，
   * 因此调用方不应依赖它；正常查询/切换流程刻意不调用，保持会话打开。
   */
  async close(): Promise<void> {
    if (!this.device) return
    try {
      await this.device.close()
    } catch {
      // 会话已失效或模块正在重启，忽略。
    }
    this.device = null
  }

  private fail(message: string): Error {
    const err = new Error(message)
    ;(err as { diagnostics?: string }).diagnostics = this.diagnostics.join('\n')
    return err
  }
}
