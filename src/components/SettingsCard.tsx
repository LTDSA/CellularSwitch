import { useCallback, useEffect, useState } from 'react'
import { LayoutGrid, MessageSquare } from 'lucide-react'
import type { UsbnetMode, FuncMode, NwScanMode, SetUsbnetModeResult } from '../types'
import type { ModuleService } from '../services/ModuleService'
import { ModuleComputerIllustration } from './icons'
import { ModeSelect } from './ModeSelect'
import { FuncModeSelect } from './FuncModeSelect'
import { NwScanModeSelect } from './NwScanModeSelect'
import { ModeSwitchDialog } from './ModeSwitchDialog'
import { DeviceTelemetry } from './DeviceTelemetry'
import { SmsView } from './SmsView'

interface Props {
  device: USBDevice
  moduleService: ModuleService
  onRestore: () => void
  onDeviceRefreshed: (freshDevice: USBDevice) => void
  /** 发起手动重连；成功返回选中的设备，用户取消/失败则抛错。 */
  onReconnect: () => Promise<USBDevice>
}

type QueryState = 'loading' | 'ready' | 'error'

export function SettingsCard({
  device,
  moduleService,
  onRestore,
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

      <div className="w-full max-w-3xl rounded-2xl bg-white shadow-sm">
        <div className="px-6 pt-5 border-b border-gray-100">
          <h1 className="text-lg font-semibold text-gray-900">
            {device.productName || '模块设置'}
          </h1>
          <div className="mt-3 flex gap-1">
            <button
              type="button"
              onClick={() => setActiveTab('overview')}
              className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                activeTab === 'overview'
                  ? 'border-brand text-brand'
                  : 'border-transparent text-gray-500 hover:border-gray-200 hover:text-gray-700'
              }`}
            >
              <LayoutGrid className="size-4" />
              概览
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('sms')}
              className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                activeTab === 'sms'
                  ? 'border-brand text-brand'
                  : 'border-transparent text-gray-500 hover:border-gray-200 hover:text-gray-700'
              }`}
            >
              <MessageSquare className="size-4" />
              短信
            </button>
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
                <div className="flex flex-col">
                  <span className="text-sm text-gray-900 leading-tight">工作模式</span>
                  <span className="text-xs text-gray-400 mt-0.5">切换模式需重启模块</span>
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
                <div className="flex flex-col">
                  <span className="text-sm text-gray-900 leading-tight">功能模式</span>
                  {funcError && (
                    <span className="text-xs mt-0.5 text-red-500">设置失败，请重试</span>
                  )}
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
                <div className="flex flex-col">
                  <span className="text-sm text-gray-900 leading-tight">网络制式</span>
                  {nwScanError ? (
                    <span className="text-xs mt-0.5 text-red-500">设置失败，请重试</span>
                  ) : (
                    <span className="text-xs text-gray-400 mt-0.5">切换模式需重新注册网络</span>
                  )}
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
                  onClick={onRestore}
                  className="w-full px-6 h-16 flex items-center justify-between rounded-b-2xl hover:bg-gray-50 transition-colors"
                >
                  <span className="text-sm text-red-500">恢复设备标识</span>
                  <span className="text-xl text-gray-400 leading-none">›</span>
                </button>
              </li>
            </ul>
          </div>
        ) : (
          <SmsView device={device} moduleService={moduleService} />
        )}
      </div>

      {switching && (
        <ModeSwitchDialog
          device={device}
          target={switching}
          moduleService={moduleService}
          onSuccess={handleSwitchSuccess}
          onClose={handleSwitchClose}
          onReconnect={onReconnect}
        />
      )}
    </div>
  )
}
