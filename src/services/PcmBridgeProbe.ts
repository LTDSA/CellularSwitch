// 【一次性探针（spike）】验证 Chrome 能否抢占 QDC507 的 USB interface 1（ttyGS0），
// 并做一小段裸 PCM bulk 传输，判断「浏览器 raw PCM 通话桥」是否可行。
//
// 结论只用于决定后续是否实现完整功能；真机验证后可删除本文件与 PhoneView 里的临时按钮。
// 注意：本文件不参与业务逻辑，故意自包含（不复用 UsbService 的私有方法）。

const TARGET_INTERFACE = 1 // 参考实现里 raw PCM 在 USB interface 1
const STEP_TIMEOUT_MS = 2_000
const IN_LENGTH = 512 // 读一小段（够判断是否有字节在流）
const OUT_SILENCE_BYTES = 160 // 8kHz mono S16 的 10ms 静音

export interface PcmProbeResult {
  /** claim interface 1 是否成功（整条链路能否走通的第一个闸门）。 */
  claimOk: boolean
  /** bulk IN 读到的字节数（>0 表示有 PCM 字节流入）。 */
  inBytes: number
  /** bulk OUT 的结果状态。 */
  outStatus: string
  /** 完整诊断日志（含接口枚举、端点、每一步结果）。 */
  lines: string[]
}

export class PcmBridgeProbe {
  private lines: string[] = []

  private log(line: string): void {
    this.lines.push(line)
    console.log(`[PcmBridgeProbe] ${line}`)
  }

  private hex(v: unknown): string {
    return typeof v === 'number' ? `0x${v.toString(16)}` : String(v ?? '?')
  }

  private hexBytes(u8: Uint8Array, max = 32): string {
    return Array.from(u8)
      .slice(0, max)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')
      .concat(u8.length > max ? ` …(+${u8.length - max}B)` : '')
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

  async run(device: USBDevice): Promise<PcmProbeResult> {
    this.lines = []
    let claimOk = false
    let inBytes = 0
    let outStatus = '未执行'

    try {
      // 1. 幂等打开 + 配置（沿用 UsbService 的会话复用思路，不主动 close）。
      await this.withTimeout(device.open(), STEP_TIMEOUT_MS)
      this.log(`设备已打开 opened=${device.opened}`)
      if (device.configuration === null) {
        await this.withTimeout(device.selectConfiguration(1), STEP_TIMEOUT_MS)
        this.log('已 selectConfiguration(1)')
      }

      // 2. 枚举所有接口（定位 ttyGS0 到底在哪个 interfaceNumber）。
      this.log(`VID ${this.hex(device.vendorId)}  PID ${this.hex(device.productId)}`)
      const interfaces = device.configuration!.interfaces
      this.log(`接口总数：${interfaces.length}`)
      for (const intf of interfaces) {
        const alt = intf.alternate
        this.log(
          `iface ${intf.interfaceNumber}: class ${this.hex(alt.interfaceClass)} ` +
            `subclass ${this.hex(alt.interfaceSubclass)} protocol ${this.hex(alt.interfaceProtocol)} ` +
            `EPS=[${alt.endpoints
              .map((e) => `${e.direction}${e.endpointNumber}:${e.type ?? '?'}`)
              .join(', ')}]`,
        )
      }

      // 3. 抢占 interface 1（核心闸门）。
      const target = interfaces.find((i) => i.interfaceNumber === TARGET_INTERFACE)
      if (!target) {
        this.log(`未找到 interfaceNumber=${TARGET_INTERFACE}（见上方枚举，真机上可能编号不同）`)
        return this.result(claimOk, inBytes, outStatus)
      }
      try {
        await this.withTimeout(device.claimInterface(TARGET_INTERFACE), STEP_TIMEOUT_MS)
        claimOk = true
        this.log(`claim interface ${TARGET_INTERFACE} OK`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.log(`claim interface ${TARGET_INTERFACE} 失败：${msg}`)
        this.log(
          '若提示「already claimed / 无权限」，说明该串口已被系统 CDC-ACM 驱动占用，' +
            'WebUSB 无法接管，raw PCM 桥此路不通。',
        )
        return this.result(claimOk, inBytes, outStatus)
      }

      // 4. 定位 bulk 端点。
      const alt = target.alternate
      const outEp = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk')
      const inEp = alt.endpoints.find((e) => e.direction === 'in' && e.type === 'bulk')
      if (!outEp || !inEp) {
        this.log(`interface ${TARGET_INTERFACE} 缺少 bulk 端点：out=${!!outEp} in=${!!inEp}`)
        return this.result(claimOk, inBytes, outStatus)
      }
      this.log(`bulk 端点：OUT${outEp.endpointNumber} / IN${inEp.endpointNumber}`)

      // 5. bulk OUT：写 10ms 静音（验证 uplink 方向是否能发出）。
      try {
        const out = await this.withTimeout(
          device.transferOut(outEp.endpointNumber, new Uint8Array(OUT_SILENCE_BYTES)),
          STEP_TIMEOUT_MS,
        )
        outStatus = out.status
        this.log(`bulk OUT ${outEp.endpointNumber}（${OUT_SILENCE_BYTES}B 静音）→ ${out.status}`)
      } catch (err) {
        outStatus = `error: ${err instanceof Error ? err.message : String(err)}`
        this.log(`bulk OUT 失败：${outStatus}`)
      }

      // 6. bulk IN：读一小段（验证 downlink 方向是否有字节流入）。
      try {
        const result = await this.withTimeout(
          device.transferIn(inEp.endpointNumber, IN_LENGTH),
          STEP_TIMEOUT_MS,
        )
        if (result.status !== 'ok') {
          this.log(`bulk IN ${inEp.endpointNumber} → ${result.status}`)
        } else {
          const dv = result.data
          const bytes = dv
            ? new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)
            : new Uint8Array(0)
          inBytes = bytes.byteLength
          this.log(
            `bulk IN ${inEp.endpointNumber} 读到 ${bytes.byteLength}B：${this.hexBytes(bytes)}`,
          )
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.log(`bulk IN 失败：${msg}`)
      }
    } catch (err) {
      this.log(`探针异常：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      try {
        await device.releaseInterface(TARGET_INTERFACE)
        this.log(`已释放 interface ${TARGET_INTERFACE}`)
      } catch {
        // 未 claim 成功时释放会抛错，忽略。
      }
    }

    return this.result(claimOk, inBytes, outStatus)
  }

  private result(claimOk: boolean, inBytes: number, outStatus: string): PcmProbeResult {
    return { claimOk, inBytes, outStatus, lines: this.lines }
  }

  /**
   * 持续读取 interface 1 的 bulk IN，统计总字节数与非零字节数。
   * 用于真通话联调：helper 后台把 hw:0,4 下行 PCM 写到 ttyGS0，通话中调用本方法
   * 验证浏览器能否持续读到非零 PCM（下行语音在流）。单次读超时（暂无数据）不算失败。
   */
  async streamIn(
    device: USBDevice,
    durationMs: number,
  ): Promise<{ totalBytes: number; nonZeroBytes: number; lines: string[] }> {
    const lines: string[] = []
    let totalBytes = 0
    let nonZeroBytes = 0
    let claimOk = false
    const log = (line: string) => {
      lines.push(line)
      console.log(`[PcmBridgeProbe] ${line}`)
    }
    try {
      await this.withTimeout(device.open(), STEP_TIMEOUT_MS)
      if (device.configuration === null) {
        await this.withTimeout(device.selectConfiguration(1), STEP_TIMEOUT_MS)
      }
      const interfaces = device.configuration?.interfaces
      if (!interfaces) {
        log('无 configuration')
        return { totalBytes, nonZeroBytes, lines }
      }
      const target = interfaces.find((i) => i.interfaceNumber === TARGET_INTERFACE)
      if (!target) {
        log(`未找到 interface ${TARGET_INTERFACE}（ttyGS0）`)
        return { totalBytes, nonZeroBytes, lines }
      }
      await this.withTimeout(device.claimInterface(TARGET_INTERFACE), STEP_TIMEOUT_MS)
      claimOk = true
      log(`claim interface ${TARGET_INTERFACE} OK`)
      const inEp = target.alternate.endpoints.find(
        (e) => e.direction === 'in' && e.type === 'bulk',
      )
      if (!inEp) {
        log(`interface ${TARGET_INTERFACE} 缺少 bulk IN 端点`)
        return { totalBytes, nonZeroBytes, lines }
      }
      log(`bulk IN 端点 IN${inEp.endpointNumber}，持续读 ${durationMs}ms`)
      const start = Date.now()
      let firstSample: Uint8Array | null = null
      while (Date.now() - start < durationMs) {
        try {
          const result = await this.withTimeout(
            device.transferIn(inEp.endpointNumber, 512),
            1_000,
          )
          if (result.status === 'ok' && result.data) {
            const u8 = new Uint8Array(
              result.data.buffer,
              result.data.byteOffset,
              result.data.byteLength,
            )
            totalBytes += u8.byteLength
            for (const b of u8) if (b !== 0) nonZeroBytes++
            if (!firstSample && u8.byteLength > 0) firstSample = u8
          }
        } catch {
          // 单次超时（暂无数据），继续读到总时长为止。
        }
      }
      log(`累计 ${totalBytes}B，非零 ${nonZeroBytes}B`)
      if (firstSample) {
        log(`首包 ${firstSample.byteLength}B：${this.hexBytes(firstSample)}`)
      }
    } catch (err) {
      log(`持续读取异常：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (claimOk) {
        try {
          await device.releaseInterface(TARGET_INTERFACE)
          log(`已释放 interface ${TARGET_INTERFACE}`)
        } catch {
          // 忽略释放失败。
        }
      }
    }
    return { totalBytes, nonZeroBytes, lines }
  }
}
