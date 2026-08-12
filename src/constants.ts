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

// 工作模式查询/切换（usbnet）。0=QMI，1=ECM；与 wlzh/dji-4g-vohive-mac 脚本一致。
export const AT_USBNET_QUERY = 'AT+QCFG="usbnet"'
export const AT_USBNET_QMI = 'AT+QCFG="usbnet",0'
export const AT_USBNET_ECM = 'AT+QCFG="usbnet",1'
// 模式切换后的尽力自动重连窗口。此模块（EG25-G）未暴露 USB 序列号，WebUSB
// 授权只存临时 GUID（见 Chromium usb_chooser_context.cc），重启后 getDevices()
// 返回空、无法自动重连——此窗口只是给「有序列号的模块」留个尝试机会并给用户
// 一个重启缓冲；超时由 UI 引导手动重新连接，不算切换失败。
export const MODE_RECONNECT_WAIT_MS = 12_000
