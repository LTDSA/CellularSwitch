export const ORIGINAL_VID = 0x2ca3
export const ORIGINAL_PID = 0x4006
export const MODIFIED_VID = 0x2c7c
export const MODIFIED_PID = 0x0125

// 参考 wlzh/dji-4g-vohive-mac 与 CdricZhang/dji-cellular-as-modem：
// usbcfg 需 8 个参数（VID,PID + 5 个 USB 功能标志 + 2 个调试标志）。
export const AT_MODIFY = 'AT+QCFG="usbcfg",0x2C7C,0x0125,1,1,1,1,1,0,0'
export const AT_RESTORE = 'AT+QCFG="usbcfg",0x2CA3,0x4006,1,1,1,1,1,0,0'
// usbcfg 后需软重启使新 USB 身份生效。
export const AT_CFUN = 'AT+CFUN=1,1'

// 指令成功后的尽力重连检测窗口。Chrome 在 VID/PID 变更后不保留权限，
// connect 事件也不触发，检测实际无法成功；此值仅为给模块留出重启时间。
export const RECONNECT_WAIT_MS = 8_000
export const READ_TIMEOUT_MS = 5_000
