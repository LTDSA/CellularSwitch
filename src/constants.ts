export const ORIGINAL_VID = 0x2ca3
export const ORIGINAL_PID = 0x4006
export const MODIFIED_VID = 0x2c7c
export const MODIFIED_PID = 0x0125

// 参考 wlzh/dji-4g-vohive-mac 与 CdricZhang/dji-cellular-as-modem：
// usbcfg 需 9 个参数（VID,PID + 7 个 USB 功能标志：diag,nmea,at,modem,net,adb,audio）。
export const AT_MODIFY = 'AT+QCFG="usbcfg",0x2C7C,0x0125,1,1,1,1,1,0,0'
export const AT_RESTORE = 'AT+QCFG="usbcfg",0x2CA3,0x4006,1,1,1,1,1,0,0'

// USB 功能（AT+QCFG="usbcfg"）查询。写命令由当前 VID/PID + 7 个功能位动态拼出。
export const AT_USBCFG_QUERY = 'AT+QCFG="usbcfg"'
// 工厂锁（QADBKEY）挑战查询：返回 +QADBKEY: <8位数字> 表示锁仍启用（ADB/USB 音频不可改）。
export const AT_QADBKEY_QUERY = 'AT+QADBKEY?'
// usbcfg 后需软重启使新 USB 身份生效。
export const AT_CFUN = 'AT+CFUN=1,1'

// 功能模式（AT+CFUN）查询。设置命令见 ModuleService 的 FUNC_MODE_COMMANDS。
// 与上方重启用 AT_CFUN（<rst>=1）不同，这里省略 <rst>（=0），切换后不触发复位。
export const AT_CFUN_QUERY = 'AT+CFUN?'

// 网络制式（AT+QCFG="nwscanmode"）查询/切换。0=自动，1=仅 GSM，2=仅 WCDMA，3=仅 LTE。
// <effect>=1 表示立即生效（无需重启）；切换后模块会重新注册网络。
export const AT_NWSCANMODE_QUERY = 'AT+QCFG="nwscanmode"'
export const AT_NWSCANMODE_AUTO = 'AT+QCFG="nwscanmode",0,1'
export const AT_NWSCANMODE_GSM = 'AT+QCFG="nwscanmode",1,1'
export const AT_NWSCANMODE_WCDMA = 'AT+QCFG="nwscanmode",2,1'
export const AT_NWSCANMODE_LTE = 'AT+QCFG="nwscanmode",3,1'

// 指令成功后的尽力重连检测窗口。Chrome 在 VID/PID 变更后不保留权限，
// connect 事件也不触发，检测实际无法成功；此值仅为给模块留出重启时间。
export const RECONNECT_WAIT_MS = 8_000
export const READ_TIMEOUT_MS = 5_000

// 运行状态定时刷新间隔（静默刷新，不闪「读取中」）。
export const TELEMETRY_REFRESH_MS = 5_000

// 工作模式查询/切换（usbnet）。0=QMI，1=ECM；与 wlzh/dji-4g-vohive-mac 脚本一致。
export const AT_USBNET_QUERY = 'AT+QCFG="usbnet"'
export const AT_USBNET_QMI = 'AT+QCFG="usbnet",0'
export const AT_USBNET_ECM = 'AT+QCFG="usbnet",1'
export const AT_USBNET_MBIM = 'AT+QCFG="usbnet",2'
export const AT_USBNET_RNDIS = 'AT+QCFG="usbnet",3'
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

// 短信（3GPP TS 27.005）：PDU 模式读取，以便解析 UDH 重组长短信
// （文本模式 AT+CMGL 不含分段信息，长短信会被拆成多条且顺序无保证）。
export const AT_CMGF_PDU = 'AT+CMGF=0' // 短信 PDU 模式
export const AT_CMGL_PDU = 'AT+CMGL=4' // PDU 模式列出全部短信（4=ALL）
// 短信轮询间隔（仅「短信」选项卡挂载时运行）。
export const SMS_REFRESH_MS = 5_000

// 连接探测中 open/selectConfiguration/claimInterface 这类原生调用的超时。
// Windows 上接口未绑定 WinUSB 驱动时，claimInterface 可能永久挂起（见
// Chromium usb_device_handle_win.cc），加超时让探测快速失败而非卡死——
// 否则挂起的原生调用在页面刷新时残留，触发浏览器崩溃。
export const CONNECT_STEP_TIMEOUT_MS = 2_000
