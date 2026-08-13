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

export type UsbnetMode = 'qmi' | 'ecm' | 'mbim' | 'rndis'

/** 功能模式（AT+CFUN，设置电话功能级别）：0=最小功能，1=全功能，4=飞行模式。 */
export type FuncMode = 0 | 1 | 4

/**
 * usbnet 模式切换的结果。切换指令确认 OK 时即已成功；
 * reconnected 只表示「浏览器是否在重启后自动重连上了（用于刷新显示）」。
 * 此模块未暴露 USB 序列号，WebUSB 授权不持久，通常 reconnected=false。
 */
export type SetUsbnetModeResult =
  | { reconnected: true; device: USBDevice }
  | { reconnected: false; device: null }

/** 信号强度指示：由 AT+CSQ / AT+CPIN? 解析而来。 */
export interface SignalInfo {
  /** 信号档位 0-4；SIM 未就绪或 CSQ 不可用（rssi=99）时为 null。 */
  bars: number | null
  /** 精确信号强度（dBm），由 +CSQ 的 RSSI 换算；不可用（rssi=99 / SIM 未就绪）时为 null。 */
  dbm: number | null
  /** SIM 卡是否就绪（AT+CPIN? 返回 READY）。 */
  simReady: boolean
}

/** 运行状态：由 AT+QNWINFO / AT+CREG? 解析而来；查询不到时字段值为占位符「—」。 */
export interface RunningStatus {
  /** 网络模式（如 LTE / WCDMA / GSM）。 */
  networkMode: string
  /** 频段（如 LTE BAND 1）。 */
  band: string
  /** 信道（如 100）。 */
  channel: string
  /** 注册状态（如 已注册（本地网络））。 */
  registration: string
  /** 信号强度（AT+CSQ + AT+CPIN?），供标题右侧图标指示。 */
  signal: SignalInfo
}

/** 设备信息：由 AT+CGSN / AT+QCCID / AT+CIMI / AT+CNUM 解析而来。 */
export interface DeviceInfo {
  imei: string
  iccid: string
  imsi: string
  /** 本机号码；SIM 未分配号码时为占位符「—」。 */
  phoneNumber: string
}

/** 运行状态 + 设备信息，一次查询两条都拿到。 */
export interface Telemetry {
  running: RunningStatus
  deviceInfo: DeviceInfo
}
