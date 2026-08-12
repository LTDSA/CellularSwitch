export type AppState =
  | { type: 'unsupported' }
  | { type: 'idle' }
  | { type: 'connected-original'; device: USBDevice }
  | { type: 'connected-modified'; device: USBDevice }
  | {
      type: 'processing'
      operation: 'modify' | 'restore'
      step: ProcessingStep
    }
  | { type: 'success'; operation: 'modify' | 'restore' }
  | { type: 'error'; message: string; recoverable: boolean; diagnostics?: string }

export type ProcessingStep =
  | 'sending'
  | 'waiting-reboot'
  | 'verifying'

export type ModuleMode = 'original' | 'modified' | 'unknown'

export type UsbnetMode = 'qmi' | 'ecm'

/**
 * usbnet 模式切换的结果。切换指令确认 OK 时即已成功；
 * reconnected 只表示「浏览器是否在重启后自动重连上了（用于刷新显示）」。
 * 此模块未暴露 USB 序列号，WebUSB 授权不持久，通常 reconnected=false。
 */
export type SetUsbnetModeResult =
  | { reconnected: true; device: USBDevice }
  | { reconnected: false; device: null }
