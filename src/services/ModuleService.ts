import type { UsbService } from './UsbService'
import {
  ORIGINAL_PID,
  ORIGINAL_VID,
  MODIFIED_PID,
  MODIFIED_VID,
  AT_MODIFY,
  AT_RESTORE,
  AT_CFUN,
  RECONNECT_WAIT_MS,
} from '../constants'
import type { ModuleMode } from '../types'

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
      try {
        await this.usb.connect(device)
        await this.usb.send(command)
        const response = await this.usb.read()
        this.log(`usbcfg response: ${JSON.stringify(response)}`)
        if (!response.includes('OK')) {
          throw new Error(`Module rejected command: ${response}`)
        }
        await this.usb.send(AT_CFUN)
        try {
          const cfun = await this.usb.read()
          this.log(`cfun response: ${JSON.stringify(cfun)}`)
        } catch (err) {
          // 模块可能在 CFUN 后立即重启，未收到响应属正常。
          this.log(
            `cfun read skipped (module rebooting): ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      } finally {
        await this.usb.close()
      }

      const detected = await this.waitForReconnect(
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

  /** 尽力检测模块以新 VID/PID 重新枚举；永不 reject，超时返回 false。 */
  private waitForReconnect(
    expectedVid: number,
    expectedPid: number,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const start = Date.now()
      let finished = false

      const onConnectDevice = (device: {
        vendorId?: number
        productId?: number
      }) => {
        this.log(
          `reconnect candidate: VID ${this.hex(device.vendorId)} PID ${this.hex(
            device.productId,
          )}`,
        )
        if (device.vendorId === expectedVid && device.productId === expectedPid) {
          this.log('reconnect matched')
          done(true)
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

      const done = (value: boolean) => {
        if (finished) return
        finished = true
        cleanup()
        resolve(value)
      }

      const interval = setInterval(async () => {
        if (Date.now() - start > timeoutMs) {
          this.log('reconnect wait: timed out, device not detected')
          done(false)
          return
        }
        try {
          const devices = await navigator.usb.getDevices()
          this.log(`reconnect poll: ${devices.length} authorized device(s)`)
          const found = devices.find(
            (d) => d.vendorId === expectedVid && d.productId === expectedPid,
          )
          if (found) {
            this.log('reconnect matched via getDevices')
            done(true)
          }
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
}
