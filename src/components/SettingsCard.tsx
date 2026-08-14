import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Antenna, LayoutGrid, MessageSquare, Network, Plane, Usb, X } from 'lucide-react'
import type { UsbnetMode, FuncMode, NwScanMode, SetUsbnetModeResult } from '../types'
import type { ModuleService } from '../services/ModuleService'
import { ModuleComputerIllustration } from './icons'
import { ModeSelect } from './ModeSelect'
import { FuncModeSelect } from './FuncModeSelect'
import { NwScanModeSelect } from './NwScanModeSelect'
import { ModeSwitchDialog } from './ModeSwitchDialog'
import { UsbFunctionDialog } from './UsbFunctionDialog'
import { DeviceTelemetry } from './DeviceTelemetry'
import { SmsView } from './SmsView'

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
}

type QueryState = 'loading' | 'ready' | 'error'

export function SettingsCard({
  device,
  isOriginal,
  moduleService,
  onRequestIdentityChange,
  onDeviceRefreshed,
  onReconnect,
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
  // 当前选项卡：概览（运行状态/设备信息/模式设置）或 短信。
  const [activeTab, setActiveTab] = useState<'overview' | 'sms'>('overview')
  // 「USB 功能」对话框开关。
  const [usbFunctionOpen, setUsbFunctionOpen] = useState(false)
  // 原始标识横幅是否已被用户关闭。
  const [bannerDismissed, setBannerDismissed] = useState(false)

  // Tab 滑动指示条：记录激活按钮的位置与宽度，用于定位下划线。
  const overviewTabRef = useRef<HTMLButtonElement>(null)
  const smsTabRef = useRef<HTMLButtonElement>(null)
  const [indicator, setIndicator] = useState({ left: 0, width: 0 })

  const measureIndicator = useCallback(() => {
    const el = activeTab === 'overview' ? overviewTabRef.current : smsTabRef.current
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
      <ModuleComputerIllustration className="w-64 h-48 mb-8" />

      {isOriginal && !bannerDismissed && (
        <div className="w-full max-w-3xl mb-4 flex items-center gap-3 rounded-xl border border-brand/20 bg-brand/5 px-4 py-3">
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
            onClick={() => setBannerDismissed(true)}
            aria-label="关闭提示"
            className="shrink-0 p-1 rounded-md text-brand/60 hover:bg-brand/10 hover:text-brand transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      <div className="w-full max-w-3xl rounded-2xl bg-white shadow-sm">
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
          <SmsView device={device} moduleService={moduleService} />
        )}
      </div>

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
