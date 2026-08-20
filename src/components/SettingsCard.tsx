import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Antenna, LayoutGrid, MessageSquare, Network, Phone, Plane, Terminal, Usb, X } from 'lucide-react'
import type { UsbnetMode, FuncMode, NwScanMode, SetUsbnetModeResult } from '../types'
import type { ModuleService } from '../services/ModuleService'
import { saveLocalCall, nowStamp } from '../utils/callHistory'
import { ModuleComputerIllustration } from './icons'
import { ModeSelect } from './ModeSelect'
import { FuncModeSelect } from './FuncModeSelect'
import { NwScanModeSelect } from './NwScanModeSelect'
import { ModeSwitchDialog } from './ModeSwitchDialog'
import { UsbFunctionDialog } from './UsbFunctionDialog'
import { DeviceTelemetry } from './DeviceTelemetry'
import { SmsView } from './SmsView'
import { TerminalView } from './TerminalView'
import { PhoneView } from './PhoneView'
import { CallDialog } from './CallDialog'

interface Props {
  device: USBDevice
  /** 是否为原始设备标识：是则在卡片上方展示「可修改标识」横幅。 */
  isOriginal: boolean
  moduleService: ModuleService
  /** 用户切换设备标识时，走 App 原有的整屏免责声明 → 修改流程。 */
  onRequestIdentityChange: (operation: 'modify' | 'restore') => void
  onDeviceRefreshed: (freshDevice: USBDevice) => void
  /** 发起手动重连；成功返回选中的设备，用户取消/失败则抛错。 */
  onReconnect: () => Promise<USBDevice>
  /** 连接成功后图标正在做飞天过渡时置 true，隐藏本卡片自有的图标（由浮层替代）。 */
  iconHidden?: boolean
}

type QueryState = 'loading' | 'ready' | 'error'

/** 语音服务状态：检查中 / VoLTE 未启用 / ADB 未开 / USB 音频未开 / 已就绪 / 出错。 */
type DriverState = 'checking' | 'noSim' | 'noVolte' | 'adbOff' | 'audioOff' | 'loaded' | 'error'

export function SettingsCard({
  device,
  isOriginal,
  moduleService,
  onRequestIdentityChange,
  onDeviceRefreshed,
  onReconnect,
  iconHidden = false,
}: Props) {
  const [mode, setMode] = useState<UsbnetMode | null>(null)
  const [queryState, setQueryState] = useState<QueryState>('loading')
  const [switching, setSwitching] = useState<UsbnetMode | null>(null)
  const [funcMode, setFuncMode] = useState<FuncMode | null>(null)
  const [funcQueryState, setFuncQueryState] = useState<QueryState>('loading')
  const [funcError, setFuncError] = useState(false)
  const [nwScanMode, setNwScanMode] = useState<NwScanMode | null>(null)
  const [nwScanQueryState, setNwScanQueryState] = useState<QueryState>('loading')
  const [nwScanError, setNwScanError] = useState(false)
  // 功能模式切换后射频状态改变，递增以触发运行状态重新查询。
  const [telemetryVersion, setTelemetryVersion] = useState(0)
  // 当前选项卡：概览（运行状态/设备信息/模式设置）、短信或终端。
  const [activeTab, setActiveTab] = useState<'overview' | 'phone' | 'sms' | 'terminal'>(
    'overview',
  )
  // 「USB 功能」对话框开关。
  const [usbFunctionOpen, setUsbFunctionOpen] = useState(false)
  // 原始标识横幅是否已被用户关闭。
  const [bannerDismissed, setBannerDismissed] = useState(false)
  // 原始标识横幅是否正在播放「收起」动画（收起结束后才真正从 DOM 移除）。
  const [bannerClosing, setBannerClosing] = useState(false)
  // 系统通知权限：'granted' | 'denied' | 'default' | null(尚未检测)。
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | null>(null)
  // 通知授权横幅是否已被用户关闭。
  const [notifBannerDismissed, setNotifBannerDismissed] = useState(false)
  // 通知授权横幅是否正在播放「收起」动画。
  const [notifBannerClosing, setNotifBannerClosing] = useState(false)
  // 入场是否已完成（图标飞行 + 卡片展示完毕）：完成后横幅才展开、卡片平滑下移腾位。
  const [entered, setEntered] = useState(false)
  // 通话状态（全局，任意 Tab 都能弹通话对话框）。
  const [callNumber, setCallNumber] = useState<string | null>(null)
  const [callMode, setCallMode] = useState<'dial' | 'incoming'>('dial')
  // 语音服务状态（全局检查，供 PhoneView 置灰拨号 + 来电轮询门槛）。
  const [driverState, setDriverState] = useState<DriverState>('checking')
  const [driverError, setDriverError] = useState<string | null>(null)
  const [driverDismissed, setDriverDismissed] = useState(false)
  // 通话记录版本号：通话结束递增，通知 PhoneView 刷新记录。
  const [callLogVersion, setCallLogVersion] = useState(0)

  // Tab 滑动指示条：记录激活按钮的位置与宽度，用于定位下划线。
  const overviewTabRef = useRef<HTMLButtonElement>(null)
  const phoneTabRef = useRef<HTMLButtonElement>(null)
  const smsTabRef = useRef<HTMLButtonElement>(null)
  const terminalTabRef = useRef<HTMLButtonElement>(null)
  const [indicator, setIndicator] = useState({ left: 0, width: 0 })

  // 按优先级短路检查：VoLTE → ADB → USB 音频。驱动加载不在此判定（首次通话时 setup 的
  // prepare 会自动加载）。
  const refreshDriver = useCallback(async () => {
    setDriverState('checking')
    setDriverError(null)
    try {
      const simReady = await moduleService.querySimReady(device)
      if (!simReady) {
        setDriverState('noSim')
        return
      }
      const volteOk = await moduleService.queryVolteCapable(device)
      if (!volteOk) {
        setDriverState('noVolte')
        return
      }
      const cfg = await moduleService.queryUsbConfig(device)
      if (!cfg.adb) {
        setDriverState('adbOff')
        return
      }
      if (!cfg.audio) {
        setDriverState('audioOff')
        return
      }
      setDriverState('loaded')
    } catch (err) {
      setDriverState('error')
      setDriverError(err instanceof Error ? err.message : String(err))
    }
  }, [device, moduleService])

  useEffect(() => {
    refreshDriver()
  }, [refreshDriver])

  // 图标飞行结束（iconHidden 由 true → false）后，延迟 0.5s 再展开横幅（entered）。
  // 入场动画与横幅展开解耦：卡片先完整展示，随后横幅平滑腾位 + 渐显。
  useEffect(() => {
    if (iconHidden) return
    const t = setTimeout(() => setEntered(true), 500)
    return () => clearTimeout(t)
  }, [iconHidden])

  // 检测系统通知权限（挂载时），决定是否显示「开启通知」横幅。
  useEffect(() => {
    if (typeof Notification === 'undefined') return
    setNotifPermission(Notification.permission)
  }, [])

  // 用户点击「授权」→ 在用户手势里请求权限（Chrome 才允许弹授权框）。
  const handleRequestNotification = useCallback(async () => {
    if (typeof Notification === 'undefined') return
    try {
      const p = await Notification.requestPermission()
      // 授权成功：先播收起动画（保持 notifPermission=default 让横幅仍渲染），
      // 动画结束后再更新权限值移除横幅，避免条件渲染直接消失。
      if (p === 'granted') {
        setNotifBannerClosing(true)
        setTimeout(() => {
          setNotifPermission('granted')
          setNotifBannerDismissed(true)
          setNotifBannerClosing(false)
        }, 200)
        return
      }
      setNotifPermission(p)
    } catch {
      // 请求失败忽略。
    }
  }, [])

  // 关闭修改标识横幅：先播收起动画，结束后真正移除。
  const closeBanner = useCallback(() => {
    setBannerClosing(true)
    setTimeout(() => {
      setBannerDismissed(true)
      setBannerClosing(false)
    }, 200)
  }, [])

  // 关闭通知授权横幅：先播收起动画，结束后真正移除。
  const closeNotifBanner = useCallback(() => {
    setNotifBannerClosing(true)
    setTimeout(() => {
      setNotifBannerDismissed(true)
      setNotifBannerClosing(false)
    }, 200)
  }, [])

  // 发送来电通知（tag 去重）。权限已通过横幅按钮在用户手势里授权，这里只检查 granted。
  // 点击通知聚焦页面（来电对话框是全局弹出的，无需切 Tab）。
  const notifyIncoming = useCallback((number: string) => {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') return
    try {
      const n = new Notification(`来电 · ${number || '未知号码'}`, {
        body: '有新的来电',
        tag: 'cellularswitch-incoming-call',
      })
      n.onclick = () => {
        window.focus()
        n.close()
      }
    } catch {
      // 非 secure context 或 Notification 不可用时忽略。
    }
  }, [])

  // 发送短信通知（按短信 index 去重）。点击通知跳转到短信 Tab。
  const notifySms = useCallback(
    (msg: { index: number; address: string; text: string }) => {
      if (typeof Notification === 'undefined') return
      if (Notification.permission !== 'granted') return
      try {
        const n = new Notification(`短信 · ${msg.address || '未知号码'}`, {
          body: msg.text,
          tag: `cellularswitch-sms-${msg.index}`,
        })
        n.onclick = () => {
          window.focus()
          setActiveTab('sms')
          n.close()
        }
      } catch {
        // 非 secure context 或 Notification 不可用时忽略。
      }
    },
    [],
  )

  // 检测新短信（全局：任意 Tab 都轮询）。用「已知 index 集合」diff 出新增的 incoming 短信，
  // 通知后并入已知集合，避免重复通知。
  const knownSmsIndexes = useRef<Set<number>>(new Set())
  const smsPollStarted = useRef(false)
  useEffect(() => {
    if (!device) return
    // 首次轮询只建立基线（记录当前全部短信为「已知」），不通知历史短信。
    const id = setInterval(async () => {
      try {
        const msgs = await moduleService.listSms(device)
        const incoming = msgs.filter((m) => m.direction === 'incoming')
        if (!smsPollStarted.current) {
          smsPollStarted.current = true
          incoming.forEach((m) => knownSmsIndexes.current.add(m.index))
          return
        }
        for (const m of incoming) {
          if (knownSmsIndexes.current.has(m.index)) continue
          knownSmsIndexes.current.add(m.index)
          notifySms({ index: m.index, address: m.address, text: m.text })
        }
      } catch {
        // 轮询失败忽略。
      }
    }, 5000)
    return () => clearInterval(id)
  }, [device, moduleService, notifySms])

  // 检测呼入（仅「语音服务已就绪」时轮询 CLCC，检测呼入振铃 status=4）。全局：任意 Tab 都检测。
  const incomingNotified = useRef(false)
  useEffect(() => {
    if (callNumber !== null || driverState !== 'loaded') return
    incomingNotified.current = false
    const id = setInterval(async () => {
      try {
        const calls = await moduleService.queryCurrentCalls(device)
        const incoming = calls.find((c) => c.direction === 'incoming' && c.status === 4)
        if (incoming && !incomingNotified.current) {
          incomingNotified.current = true
          const num = incoming.number || '未知号码'
          notifyIncoming(num)
          setCallMode('incoming')
          setCallNumber(num)
        }
      } catch {
        // 轮询失败忽略。
      }
    }, 2000)
    return () => clearInterval(id)
  }, [callNumber, driverState, device, moduleService, notifyIncoming])

  // 呼入接通后记录通话历史（received）。
  const handleIncomingConnected = useCallback(() => {
    saveLocalCall({
      id: Date.now(),
      number: callNumber ?? '',
      type: 'received',
      timestamp: nowStamp(),
    })
  }, [callNumber])

  // 呼入未接记录通话历史（missed）。
  const handleIncomingMissed = useCallback(() => {
    saveLocalCall({
      id: Date.now(),
      number: callNumber ?? '',
      type: 'missed',
      timestamp: nowStamp(),
    })
  }, [callNumber])

  // 通话结束：关闭对话框 + 递增版本号通知 PhoneView 刷新记录。
  const handleCallClose = useCallback(() => {
    setCallNumber(null)
    setCallLogVersion((v) => v + 1)
  }, [])

  // 拨号（来自 PhoneView 的 onDial 回调）：打开通话对话框（拨出模式）。
  const handleDial = useCallback((number: string) => {
    setCallMode('dial')
    setCallNumber(number)
  }, [])

  const measureIndicator = useCallback(() => {
    const el =
      activeTab === 'overview'
        ? overviewTabRef.current
        : activeTab === 'phone'
          ? phoneTabRef.current
          : activeTab === 'sms'
            ? smsTabRef.current
            : terminalTabRef.current
    if (el) setIndicator({ left: el.offsetLeft, width: el.offsetWidth })
  }, [activeTab])

  // 首次挂载：绘制前量一次，避免指示条从零宽度跳变。
  useLayoutEffect(() => {
    measureIndicator()
    // activeTab 变化由下方 useEffect 处理（绘制后更新，保留过渡）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // activeTab 变化：绘制后再更新位置，浏览器先画出旧位置再过渡到新位置。
  useEffect(() => {
    measureIndicator()
  }, [measureIndicator])

  // 窗口尺寸变化（字体缩放 / 响应式）时重新测量。
  useEffect(() => {
    window.addEventListener('resize', measureIndicator)
    return () => window.removeEventListener('resize', measureIndicator)
  }, [measureIndicator])

  const loadMode = useCallback(async () => {
    setQueryState('loading')
    try {
      const m = await moduleService.queryUsbnetMode(device)
      setMode(m)
      setQueryState('ready')
    } catch {
      setMode(null)
      setQueryState('error')
    }
  }, [device, moduleService])

  useEffect(() => {
    loadMode()
  }, [loadMode])

  const loadFuncMode = useCallback(async () => {
    setFuncQueryState('loading')
    try {
      const m = await moduleService.queryFuncMode(device)
      setFuncMode(m)
      setFuncQueryState('ready')
    } catch {
      setFuncMode(null)
      setFuncQueryState('error')
    }
  }, [device, moduleService])

  useEffect(() => {
    loadFuncMode()
  }, [loadFuncMode])

  const handleFuncSelect = async (target: FuncMode) => {
    if (target === funcMode) return
    setFuncError(false)
    try {
      await moduleService.setFuncMode(device, target)
      setFuncMode(target)
      setTelemetryVersion((v) => v + 1)
    } catch {
      setFuncError(true)
    }
  }

  const loadNwScanMode = useCallback(async () => {
    setNwScanQueryState('loading')
    try {
      const m = await moduleService.queryNwScanMode(device)
      setNwScanMode(m)
      setNwScanQueryState('ready')
    } catch {
      setNwScanMode(null)
      setNwScanQueryState('error')
    }
  }, [device, moduleService])

  useEffect(() => {
    loadNwScanMode()
  }, [loadNwScanMode])

  const handleNwScanSelect = async (target: NwScanMode) => {
    if (target === nwScanMode) return
    setNwScanError(false)
    try {
      await moduleService.setNwScanMode(device, target)
      setNwScanMode(target)
      // 网络制式变化会触发重新注册，刷新运行状态。
      setTelemetryVersion((v) => v + 1)
    } catch {
      setNwScanError(true)
    }
  }

  const handleSelect = (target: UsbnetMode) => {
    if (target === mode) return
    setSwitching(target)
  }

  // 用 useCallback 稳定引用，避免每次渲染使 ModeSwitchDialog 的 effect 重跑
  // （其 deps 含 onSuccess/onClose，内联箭头会导致 setUsbnetMode 被重复调用）。
  const handleSwitchSuccess = useCallback(
    (result: SetUsbnetModeResult) => {
      // 无论自动重连还是手动重连成功：关闭对话框并刷新设备，
      // SettingsCard 随 device 变化重新查询模式。
      setSwitching(null)
      if (result.reconnected && result.device) {
        onDeviceRefreshed(result.device)
      }
    },
    [onDeviceRefreshed],
  )
  const handleSwitchClose = useCallback(() => setSwitching(null), [])

  return (
    <div className="w-full flex flex-col items-center px-6">
      <ModuleComputerIllustration className={`w-48 h-36 mb-6 ${iconHidden ? 'opacity-0' : ''}`} />

      {isOriginal && !bannerDismissed && (
        <div
          className={`w-full max-w-3xl overflow-hidden transition-all ease-out ${
            bannerClosing ? 'duration-200' : 'duration-500'
          } ${entered && !bannerClosing ? 'mb-4 max-h-24 opacity-100' : 'max-h-0 opacity-0'}`}
        >
          <div className="flex items-center gap-3 rounded-xl border border-brand/20 bg-brand/5 px-4 py-3">
            <p className="flex-1 text-sm leading-relaxed text-brand">
              模块当前为原始设备标识，可修改为标准 Quectel 标识
            </p>
            <button
              onClick={() => onRequestIdentityChange('modify')}
              className="shrink-0 px-4 py-1.5 rounded-lg bg-brand text-white text-sm font-medium hover:bg-blue-600 transition-colors"
            >
              修改
            </button>
            <button
              onClick={closeBanner}
              aria-label="关闭提示"
              className="shrink-0 p-1 rounded-md text-brand/60 hover:bg-brand/10 hover:text-brand transition-colors"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
      )}

      {notifPermission === 'default' && !notifBannerDismissed && (
        <div
          className={`w-full max-w-3xl overflow-hidden transition-all ease-out ${
            notifBannerClosing ? 'duration-200' : 'duration-500'
          } ${entered && !notifBannerClosing ? 'mb-4 max-h-24 opacity-100' : 'max-h-0 opacity-0'}`}
        >
          <div className="flex items-center gap-3 rounded-xl border border-amber-300/40 bg-amber-50 px-4 py-3">
            <p className="flex-1 text-sm leading-relaxed text-amber-800">
              开启通知权限，来电和短信到达时发送提醒
            </p>
            <button
              onClick={handleRequestNotification}
              className="shrink-0 px-4 py-1.5 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors"
            >
              授权
            </button>
            <button
              onClick={closeNotifBanner}
              aria-label="关闭提示"
              className="shrink-0 p-1 rounded-md text-amber-500 hover:bg-amber-100 hover:text-amber-700 transition-colors"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
      )}

      <div
        className={`w-full max-w-3xl rounded-2xl bg-white shadow-sm transition-opacity duration-500 ${
          iconHidden ? 'opacity-0' : 'opacity-100'
        }`}
      >
        <div className="px-6 pt-5 border-b border-gray-100">
          <h1 className="text-lg font-semibold text-gray-900">
            {device.productName || '模块设置'}
          </h1>
          <div className="relative mt-3 flex gap-1">
            <button
              ref={overviewTabRef}
              type="button"
              onClick={() => setActiveTab('overview')}
              className={`flex items-center gap-2 px-3 py-2 text-sm font-medium transition-colors ${
                activeTab === 'overview' ? 'text-brand' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <LayoutGrid className="size-4" />
              概览
            </button>
            <button
              ref={phoneTabRef}
              type="button"
              onClick={() => setActiveTab('phone')}
              className={`flex items-center gap-2 px-3 py-2 text-sm font-medium transition-colors ${
                activeTab === 'phone' ? 'text-brand' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <Phone className="size-4" />
              电话
            </button>
            <button
              ref={smsTabRef}
              type="button"
              onClick={() => setActiveTab('sms')}
              className={`flex items-center gap-2 px-3 py-2 text-sm font-medium transition-colors ${
                activeTab === 'sms' ? 'text-brand' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <MessageSquare className="size-4" />
              短信
            </button>
            <button
              ref={terminalTabRef}
              type="button"
              onClick={() => setActiveTab('terminal')}
              className={`flex items-center gap-2 px-3 py-2 text-sm font-medium transition-colors ${
                activeTab === 'terminal' ? 'text-brand' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <Terminal className="size-4" />
              终端
            </button>
            <span
              aria-hidden="true"
              className="absolute -bottom-px h-0.5 rounded-full bg-brand transition-[left,width] duration-200 ease-out"
              style={{ left: indicator.left, width: indicator.width }}
            />
          </div>
        </div>

        {activeTab === 'overview' ? (
          <div className="flex h-[28rem] flex-col">
            <DeviceTelemetry
              device={device}
              moduleService={moduleService}
              refreshKey={telemetryVersion}
            />

            <ul className="divide-y divide-gray-100">
              <li className="px-6 h-16 flex items-center justify-between">
                <div className="flex items-center gap-5">
                  <Network className="h-5 w-5 shrink-0 text-gray-500" />
                  <div className="flex flex-col">
                    <span className="text-sm text-gray-900 leading-tight">工作模式</span>
                    <span className="text-xs text-gray-400 mt-0.5">切换模式需重启模块</span>
                  </div>
                </div>
                {queryState === 'loading' && (
                  <span className="text-sm text-gray-400">读取中…</span>
                )}
                {queryState === 'error' && (
                  <button
                    onClick={loadMode}
                    className="text-sm text-gray-400 hover:text-gray-600"
                  >
                    读取失败 · 重试
                  </button>
                )}
                {queryState === 'ready' && mode && (
                  <ModeSelect value={mode} onSelect={handleSelect} />
                )}
              </li>

              <li className="px-6 h-16 flex items-center justify-between">
                <div className="flex items-center gap-5">
                  <Plane className="h-5 w-5 shrink-0 text-gray-500" />
                  <div className="flex flex-col">
                    <span className="text-sm text-gray-900 leading-tight">功能模式</span>
                    {funcError ? (
                      <span className="text-xs mt-0.5 text-red-500">设置失败，请重试</span>
                    ) : (
                      <span className="text-xs text-gray-400 mt-0.5">模块功能级别、射频开关</span>
                    )}
                  </div>
                </div>
                {funcQueryState === 'loading' && (
                  <span className="text-sm text-gray-400">读取中…</span>
                )}
                {funcQueryState === 'error' && (
                  <button
                    onClick={loadFuncMode}
                    className="text-sm text-gray-400 hover:text-gray-600"
                  >
                    读取失败 · 重试
                  </button>
                )}
                {funcQueryState === 'ready' && funcMode !== null && (
                  <FuncModeSelect value={funcMode} onSelect={handleFuncSelect} />
                )}
              </li>

              <li className="px-6 h-16 flex items-center justify-between">
                <div className="flex items-center gap-5">
                  <Antenna className="h-5 w-5 shrink-0 text-gray-500" />
                  <div className="flex flex-col">
                    <span className="text-sm text-gray-900 leading-tight">网络制式</span>
                    {nwScanError ? (
                      <span className="text-xs mt-0.5 text-red-500">设置失败，请重试</span>
                    ) : (
                      <span className="text-xs text-gray-400 mt-0.5">切换制式需重新注册网络</span>
                    )}
                  </div>
                </div>
                {nwScanQueryState === 'loading' && (
                  <span className="text-sm text-gray-400">读取中…</span>
                )}
                {nwScanQueryState === 'error' && (
                  <button
                    onClick={loadNwScanMode}
                    className="text-sm text-gray-400 hover:text-gray-600"
                  >
                    读取失败 · 重试
                  </button>
                )}
                {nwScanQueryState === 'ready' && nwScanMode !== null && (
                  <NwScanModeSelect value={nwScanMode} onSelect={handleNwScanSelect} />
                )}
              </li>

              <li>
                {/* 底部两个角与卡片圆角对齐；不能给卡片加 overflow-hidden，那会裁掉工作模式下拉菜单。 */}
                <button
                  onClick={() => setUsbFunctionOpen(true)}
                  className="w-full px-6 h-16 flex items-center justify-between text-left rounded-b-2xl hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-5">
                    <Usb className="h-5 w-5 shrink-0 text-gray-500" />
                    <div className="flex flex-col">
                      <span className="text-sm text-gray-900 leading-tight">USB 功能</span>
                      <span className="text-xs text-gray-400 mt-0.5">
                        设备标识、USB 接口
                      </span>
                    </div>
                  </div>
                  <span className="text-xl text-gray-400 leading-none">›</span>
                </button>
              </li>
            </ul>
          </div>
        ) : (
          <>
            {/* 电话视图常驻挂载（非 phone 时 CSS 隐藏），保证来电轮询在任意 Tab 都运行。 */}
            <div className={activeTab === 'phone' ? '' : 'hidden'}>
              <PhoneView
                driverState={driverState}
                driverError={driverError}
                driverDismissed={driverDismissed}
                onDismissDriver={() => setDriverDismissed(true)}
                onDial={handleDial}
                callLogVersion={callLogVersion}
                isInCall={callNumber !== null}
                onRetryDriver={refreshDriver}
                active={activeTab === 'phone'}
              />
            </div>
            {activeTab === 'sms' && <SmsView device={device} moduleService={moduleService} />}
            {activeTab === 'terminal' && (
              <TerminalView device={device} moduleService={moduleService} />
            )}
          </>
        )}
      </div>

      <CallDialog
        open={callNumber !== null}
        mode={callMode}
        number={callNumber ?? ''}
        device={device}
        moduleService={moduleService}
        onClose={handleCallClose}
        onConnected={handleIncomingConnected}
        onMissed={handleIncomingMissed}
      />

      <ModeSwitchDialog
        open={switching !== null}
        device={device}
        target={switching ?? 'qmi'}
        moduleService={moduleService}
        onSuccess={handleSwitchSuccess}
        onClose={handleSwitchClose}
        onReconnect={onReconnect}
      />

      <UsbFunctionDialog
        open={usbFunctionOpen}
        device={device}
        moduleService={moduleService}
        onRequestIdentityChange={onRequestIdentityChange}
        onDeviceRefreshed={onDeviceRefreshed}
        onReconnect={onReconnect}
        onClose={() => setUsbFunctionOpen(false)}
      />
    </div>
  )
}
