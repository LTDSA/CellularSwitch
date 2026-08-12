import type { UsbService } from './UsbService'
import {
  ORIGINAL_PID,
  ORIGINAL_VID,
  MODIFIED_PID,
  MODIFIED_VID,
  AT_MODIFY,
  AT_RESTORE,
  AT_CFUN,
  AT_USBNET_QUERY,
  AT_USBNET_QMI,
  AT_USBNET_ECM,
  RECONNECT_WAIT_MS,
  MODE_RECONNECT_WAIT_MS,
} from '../constants'
import type { ModuleMode, UsbnetMode, SetUsbnetModeResult } from '../types'

export class ModuleService {
  private diagnostics: string[] = []

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
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      ;(e as { diagnostics?: string }).diagnostics = this.diagnostics.join('\n')
      throw e
    }
  }

  /** 查询当前 usbnet 工作模式：0=QMI，1=ECM。失败抛带 diagnostics 的错误。 */
  async queryUsbnetMode(device: USBDevice): Promise<UsbnetMode> {
    this.diagnostics = []
    try {
      // 查询保持会话打开（不 close），失败时自动重试一次。
      // 掉线一次是模块间歇性问题，不是设备状态错误，无需用户手动点「重试」。
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
        throw new Error(`未知的 usbnet 模式: ${value}`)
      })
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      ;(e as { diagnostics?: string }).diagnostics = this.diagnostics.join('\n')
      throw e
    }
  }

  /**
   * 切换工作模式（QMI/ECM）。发送 usbnet 指令 → 确认 OK → 软重启 → 等待重连。
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
    const command = target === 'qmi' ? AT_USBNET_QMI : AT_USBNET_ECM

    try {
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
