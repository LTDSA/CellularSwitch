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

/** 网络制式（AT+QCFG="nwscanmode"）：0=自动，1=仅 GSM，2=仅 WCDMA，3=仅 LTE。 */
export type NwScanMode = 0 | 1 | 2 | 3

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

/** 短信状态（AT+CMGL 文本模式的 <stat> 字段）。 */
export type SmsStatus = 'REC UNREAD' | 'REC READ' | 'STO UNSENT' | 'STO SENT'

/**
 * USB 功能配置（AT+QCFG="usbcfg"）：VID/PID + 7 个功能位。
 * 字段顺序对应 Quectel 手册：vid,pid,diag,nmea,at,modem,rmnet(net),adb,uac(audio)。
 */
export interface UsbConfig {
  vid: number
  pid: number
  diag: boolean // 诊断接口
  nmea: boolean // NMEA 接口
  at: boolean // AT 接口
  modem: boolean // Modem 接口
  net: boolean // 网络接口（rmnet）
  adb: boolean // ADB
  audio: boolean // USB 音频（UAC）
}

/** 一条短信，由 AT+CMGL 文本模式响应解析而来。 */
export interface SmsMessage {
  /** 存储区位置号（AT+CMGR/CMGD 用）。 */
  index: number
  status: SmsStatus
  /** 对方号码（UCS2 解码后，如 +8613800138000）。 */
  address: string
  /** 收发方向：收件=incoming，发件=outgoing。 */
  direction: 'incoming' | 'outgoing'
  /** 时间戳字符串（模块原始格式，如 26/08/13,10:00:00+32）。 */
  timestamp: string
  /** 正文（UCS2 解码后）。 */
  text: string
}
