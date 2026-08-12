import { READ_TIMEOUT_MS } from '../constants'

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
      filters: [{ vendorId: 0x2ca3 }, { vendorId: 0x2c7c }],
    })
  }

  async connect(device: USBDevice): Promise<void> {
    this.device = device
    this.diagnostics = []
    await device.open()
    if (device.configuration === null) {
      await device.selectConfiguration(1)
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
        await device.claimInterface(iface.interfaceNumber)
        this.log(`iface ${iface.interfaceNumber} claim OK`)
      } catch (err) {
        this.log(
          `iface ${iface.interfaceNumber} claim failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        continue
      }
      this.outEndpoint = outEps[0]?.endpointNumber ?? 0

      let found = false
      for (const inEp of inEps) {
        this.inEndpoint = inEp.endpointNumber
        try {
          await this.send('AT')
          this.log(
            `iface ${iface.interfaceNumber} sent AT on OUT${this.outEndpoint}`,
          )
          // 累加式读取：模块会把回显(AT\r)和 OK 分两个 USB 传输发送，
          // 必须等到出现 OK/ERROR 为止（read() 内部累加）。
          const response = await this.read(1500)
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
          break
        }
      }

      if (found) return

      // 用 releaseInterface（而非 close()）收尾：v1 已验证它即使有
      // pending transfer 也只会 reject 而不会挂起；close() 则会挂起。
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
    if (!this.device) throw new Error('Device not connected')
    const encoder = new TextEncoder()
    // 用 withTimeout 包裹：某些非 AT 接口的 OUT 端点会无限 NAK，
    // 不加超时会导致 transferOut 永久挂起。
    const result = await this.withTimeout(
      this.device.transferOut(
        this.outEndpoint,
        encoder.encode(command + '\r\n'),
      ),
      timeoutMs,
    )
    if (result.status !== 'ok') {
      throw new Error(`Transfer out failed: ${result.status}`)
    }
  }

  async read(timeoutMs = READ_TIMEOUT_MS): Promise<string> {
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
      if (/OK|ERROR/.test(buffer)) {
        return buffer.trim()
      }
    }

    throw new Error('Timed out waiting for device response')
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

  async close(): Promise<void> {
    if (!this.device) return
    try {
      for (const iface of this.device.configuration?.interfaces || []) {
        await this.device.releaseInterface(iface.interfaceNumber)
      }
    } catch {
      // ignore release errors on disconnect
    }
    await this.device.close()
    this.device = null
  }

  private fail(message: string): Error {
    const err = new Error(message)
    ;(err as { diagnostics?: string }).diagnostics = this.diagnostics.join('\n')
    return err
  }
}
