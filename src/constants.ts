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
export const AT_USBNET_MBIM = 'AT+QCFG="usbnet",2'
// 模式切换后的尽力自动重连窗口。此模块（EG25-G）未暴露 USB 序列号，WebUSB
// 授权只存临时 GUID（见 Chromium usb_chooser_context.cc），重启后 getDevices()
// 返回空、无法自动重连——此窗口只是给「有序列号的模块」留个尝试机会并给用户
// 一个重启缓冲；超时由 UI 引导手动重新连接，不算切换失败。
export const MODE_RECONNECT_WAIT_MS = 12_000

// 运行状态 / 设备信息查询（均为只读指令，不改配置、不触发重启）。
export const AT_QNWINFO = 'AT+QNWINFO' // 网络模式 + 频段 + 信道（+QNWINFO: "LTE","460 11",LTE BAND 1,100）
export const AT_CREG = 'AT+CREG?' // 注册状态（+CREG: 0,1）
export const AT_CGSN = 'AT+CGSN' // IMEI
export const AT_QCCID = 'AT+QCCID' // ICCID（+QCCID: 8986…）
export const AT_CIMI = 'AT+CIMI' // IMSI
export const AT_CNUM = 'AT+CNUM' // 本机号码（+CNUM: 1,"138…",129,7,4）
export const AT_CSQ = 'AT+CSQ' // 信号强度（+CSQ: <rssi>,<ber>）
export const AT_CPIN = 'AT+CPIN?' // SIM 卡状态（+CPIN: READY / NOT INSERTED）

// 连接探测中 open/selectConfiguration/claimInterface 这类原生调用的超时。
// Windows 上接口未绑定 WinUSB 驱动时，claimInterface 可能永久挂起（见
// Chromium usb_device_handle_win.cc），加超时让探测快速失败而非卡死——
// 否则挂起的原生调用在页面刷新时残留，触发浏览器崩溃。
export const CONNECT_STEP_TIMEOUT_MS = 2_000
