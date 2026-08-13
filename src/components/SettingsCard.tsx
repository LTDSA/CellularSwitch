import { useCallback, useEffect, useState } from 'react'
import type { UsbnetMode, SetUsbnetModeResult } from '../types'
import type { ModuleService } from '../services/ModuleService'
import { ModuleComputerIllustration } from './icons'
import { ModeSelect } from './ModeSelect'
import { ModeSwitchDialog } from './ModeSwitchDialog'
import { DeviceTelemetry } from './DeviceTelemetry'

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

      <div className="w-full max-w-xl rounded-2xl bg-white shadow-sm">
        <div className="px-6 pt-5 pb-4 border-b border-gray-100">
          <h1 className="text-lg font-semibold text-gray-900">模块设置</h1>
          <p className="text-sm text-gray-600 opacity-50 mt-1">
            当前为标准 Quectel 设备标识
          </p>
        </div>

        <DeviceTelemetry device={device} moduleService={moduleService} />

        <ul className="divide-y divide-gray-100">
          <li className="px-6 h-16 flex items-center justify-between">
            <div className="flex flex-col">
              <span className="text-sm text-gray-900 leading-tight">工作模式</span>
              <span className="text-xs text-gray-400 mt-0.5">切换模式后模块将重启</span>
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
