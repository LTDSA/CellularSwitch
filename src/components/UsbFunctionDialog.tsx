import { useCallback, useEffect, useRef, useState } from 'react'
import type { UsbConfig } from '../types'
import type { ModuleService } from '../services/ModuleService'
import { ORIGINAL_VID, ORIGINAL_PID } from '../constants'
import { UsbIdentitySelect, type UsbIdentity } from './UsbIdentitySelect'
import { Dialog } from './Dialog'
import { mapErrorMessage } from '../utils/mapErrorMessage'
import { isUserCancellation } from '../utils/isUserCancellation'

interface Props {
  open: boolean
  device: USBDevice
  moduleService: ModuleService
  /** 用户切换设备标识时，走 App 原有的整屏免责声明 → 修改流程。 */
  onRequestIdentityChange: (operation: 'modify' | 'restore') => void
  onDeviceRefreshed: (freshDevice: USBDevice) => void
  /** 发起手动重连；成功返回选中的设备，用户取消/失败则抛错。 */
  onReconnect: () => Promise<USBDevice>
  onClose: () => void
}

type LoadState = 'loading' | 'ready' | 'error'
type Phase = 'idle' | 'running' | 'success' | 'error'
type Step = 'sending' | 'waiting-reboot' | 'reconnecting'
type ErrorSource = 'apply' | 'reconnect'

const stepMeta: Record<Step, string> = {
  sending: '正在发送 AT 指令',
  'waiting-reboot': '正在等待模块重启',
  reconnecting: '等待设备重启',
}

// 设备标识切换：先等本对话框退场动画结束，再打开整屏免责声明对话框，
// 避免两个模态过渡叠加（「先关再开」）。
const IDENTITY_CHANGE_DELAY_MS = 180

type UsbFlagKey = 'diag' | 'nmea' | 'at' | 'modem' | 'net' | 'adb' | 'audio'

const FLAG_ROWS: {
  key: UsbFlagKey
  label: string
  description: string
  dangerText?: string
  locked?: boolean
}[] = [
  {
    key: 'diag',
    label: '诊断接口',
    description: 'Qualcomm 诊断口（DIAG）',
  },
  {
    key: 'nmea',
    label: 'NMEA 接口',
    description: 'GNSS 定位数据输出口',
  },
  {
    key: 'at',
    label: 'AT 接口',
    description: 'AT 指令口，',
    dangerText: '关闭后将无法再连接模块',
  },
  {
    key: 'modem',
    label: 'Modem 接口',
    description: 'Modem 数据口（PPP / 拨号）',
  },
  {
    key: 'net',
    label: '网络接口',
    description: '数据网络接口（上网 / 数据）',
  },
  {
    key: 'adb',
    label: 'ADB',
    description: '需解除工厂锁后才可开启',
    locked: true,
  },
  {
    key: 'audio',
    label: 'USB 音频',
    description: '需解除工厂锁后才可开启',
    locked: true,
  },
]

/** Tailwind Plus 风格滑动开关（role=switch）。轨道用 p-0.5 内边距包住滑块，两侧留白对称。 */
function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full p-0.5 transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-2 ${
        checked ? 'bg-brand' : 'bg-gray-200'
      } ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none inline-block size-5 rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
          checked ? 'translate-x-5' : ''
        }`}
      />
    </button>
  )
}

/**
 * 「USB 功能」对话框：按 usbcfg 字段逐项查看/编辑设备标识与 7 个功能位。
 * 开关先在本地改（draft），点「应用」一次性写 usbcfg 并重启一次；
 * ADB/USB 音频受工厂锁保护，未检测到解锁时置灰；设备标识切换走原有整屏流程。
 */
export function UsbFunctionDialog({
  open,
  device,
  moduleService,
  onRequestIdentityChange,
  onDeviceRefreshed,
  onReconnect,
  onClose,
}: Props) {
  const [config, setConfig] = useState<UsbConfig | null>(null)
  const [draft, setDraft] = useState<UsbConfig | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  // 默认按锁定处理（置灰），仅当检测到明确「未锁定」才放开。
  const [adbLocked, setAdbLocked] = useState(true)

  const [phase, setPhase] = useState<Phase>('idle')
  const [step, setStep] = useState<Step>('sending')
  const [error, setError] = useState('')
  const [diagnostics, setDiagnostics] = useState('')
  const [errorSource, setErrorSource] = useState<ErrorSource>('apply')
  const applyStartedRef = useRef(false)

  // 并行读取 usbcfg 与工厂锁状态。
  const load = useCallback(async () => {
    setLoadState('loading')
    setConfig(null)
    setDraft(null)
    setAdbLocked(true)
    try {
      const c = await moduleService.queryUsbConfig(device)
      setConfig(c)
      setDraft(c)
      setLoadState('ready')
    } catch {
      setLoadState('error')
    }
    // 锁状态独立于配置查询，任一失败都不影响另一项。
    try {
      setAdbLocked(await moduleService.queryAdbLock(device))
    } catch {
      setAdbLocked(true)
    }
  }, [device, moduleService])

  useEffect(() => {
    if (!open) return
    // 每次打开从初始态开始：清空应用进度，重新读取配置。
    applyStartedRef.current = false
    setPhase('idle')
    setStep('sending')
    setError('')
    setDiagnostics('')
    setErrorSource('apply')
    load()
  }, [open, load])

  const identity: UsbIdentity =
    config && config.vid === ORIGINAL_VID && config.pid === ORIGINAL_PID
      ? 'original'
      : 'modified'

  const handleIdentitySelect = (target: UsbIdentity) => {
    if (target === identity) return
    const operation = target === 'modified' ? 'modify' : 'restore'
    // 先关闭本对话框，等退场动画结束后再交由 App 走整屏免责声明 → 修改流程。
    onClose()
    setTimeout(() => onRequestIdentityChange(operation), IDENTITY_CHANGE_DELAY_MS)
  }

  const setFlag = (key: UsbFlagKey, value: boolean) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d))
  }

  const dirty =
    config !== null &&
    draft !== null &&
    FLAG_ROWS.some((r) => config[r.key] !== draft[r.key])

  const startApply = useCallback(async () => {
    if (!draft || applyStartedRef.current) return
    applyStartedRef.current = true
    setPhase('running')
    setStep('sending')
    setError('')
    try {
      const result = await moduleService.setUsbConfig(device, draft, (s) => setStep(s))
      if (result.reconnected && result.device) {
        // 自动重连成功：父组件刷新设备并卸载本对话框。
        onDeviceRefreshed(result.device)
        onClose()
      } else {
        setPhase('success')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      const d = (err as { diagnostics?: unknown } | null)?.diagnostics
      setDiagnostics(typeof d === 'string' ? d : '')
      setErrorSource('apply')
      setPhase('error')
    }
  }, [draft, device, moduleService, onDeviceRefreshed, onClose])

  // 手动重新连接（应用成功后模块无 USB 序列号、浏览器无法自动重连时）。
  const handleReconnect = async () => {
    try {
      const freshDevice = await onReconnect()
      onDeviceRefreshed(freshDevice)
      onClose()
    } catch (err) {
      if (isUserCancellation(err)) {
        setPhase('success')
      } else {
        setError(err instanceof Error ? err.message : String(err))
        const d = (err as { diagnostics?: unknown } | null)?.diagnostics
        setDiagnostics(typeof d === 'string' ? d : '')
        setErrorSource('reconnect')
        setPhase('error')
      }
    }
  }

  return (
    <Dialog open={open} cardClassName="max-w-lg rounded-2xl bg-white shadow-xl">
      {phase === 'idle' ? (
        <>
          <div className="px-6 pt-5 pb-1">
            <h2 className="text-lg font-semibold text-gray-900">USB 功能</h2>
          </div>

          {loadState === 'loading' && (
            <div className="flex min-h-[32rem] items-center justify-center px-6 text-sm text-gray-400">
              读取中…
            </div>
          )}
          {loadState === 'error' && (
            <div className="flex min-h-[32rem] items-center justify-center px-6">
              <button
                onClick={load}
                className="text-sm text-gray-400 hover:text-gray-600"
              >
                读取失败 · 重试
              </button>
            </div>
          )}
          {loadState === 'ready' && draft && (
            <ul className="thin-scrollbar max-h-[calc(100vh_-_8rem)] overflow-y-auto divide-y divide-gray-100">
              <li className="px-6 py-3.5 flex items-center justify-between gap-4">
                <div className="flex flex-col min-w-0">
                  <span className="text-sm text-gray-900 leading-tight">设备标识</span>
                  <span className="text-xs text-gray-400 mt-0.5">
                    USB 厂商标识与产品标识（VID / PID）
                  </span>
                </div>
                <UsbIdentitySelect value={identity} onSelect={handleIdentitySelect} />
              </li>

              {FLAG_ROWS.map((row) => (
                <li key={row.key} className="px-6 py-3.5 flex items-center justify-between gap-4">
                  <div className="flex flex-col min-w-0">
                    <span className="text-sm text-gray-900 leading-tight">{row.label}</span>
                    <span className="text-xs text-gray-400 mt-0.5">
                      {row.description}
                      {row.dangerText && (
                        <span className="text-red-500">{row.dangerText}</span>
                      )}
                    </span>
                  </div>
                  <Toggle
                    checked={draft[row.key]}
                    disabled={row.locked ? adbLocked : false}
                    onChange={(v) => setFlag(row.key, v)}
                  />
                </li>
              ))}
            </ul>
          )}

          <div className="flex justify-end gap-2 px-6 py-4">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-gray-600 hover:bg-gray-100 transition-colors"
            >
              取消
            </button>
            <button
              onClick={startApply}
              disabled={!dirty}
              className="px-4 py-2 rounded-lg bg-brand text-white hover:bg-blue-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              应用
            </button>
          </div>
        </>
      ) : phase === 'running' ? (
        <div className="flex flex-col items-center py-10 px-6 text-center">
          <div className="mb-4 h-16 w-16 animate-spin rounded-full border-4 border-gray-200 border-t-brand" />
          <h2 className="text-lg font-semibold text-gray-900 mb-1">正在应用 USB 功能配置</h2>
          <p className="text-sm text-gray-600 opacity-50">{stepMeta[step]}</p>
        </div>
      ) : phase === 'success' ? (
        <div className="px-6 py-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-2">应用成功</h2>
          <p className="text-sm text-gray-600 mb-5 leading-relaxed">
            指令已发送并确认，请等待模块重启完成后，点击「重新连接」。
          </p>
          <div className="flex justify-end">
            <button
              onClick={handleReconnect}
              className="px-4 py-2 rounded-lg bg-brand text-white hover:bg-blue-600 transition-colors"
            >
              重新连接
            </button>
          </div>
        </div>
      ) : (
        <div className="px-6 py-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-2">
            {errorSource === 'reconnect' ? '重新连接失败' : '应用失败'}
          </h2>
          <p className="text-sm text-gray-600 mb-5 leading-relaxed">
            {mapErrorMessage(error)}
          </p>
          {diagnostics && (
            <details className="mb-5 w-full text-left">
              <summary className="cursor-pointer select-none text-xs text-gray-400 hover:text-gray-600">
                诊断信息（点击展开）
              </summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg bg-gray-100 p-3 text-[10px] leading-tight text-gray-700">
                {diagnostics}
              </pre>
            </details>
          )}
          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-gray-600 hover:bg-gray-100 transition-colors"
            >
              关闭
            </button>
            {errorSource === 'reconnect' && (
              <button
                onClick={handleReconnect}
                className="px-4 py-2 rounded-lg bg-brand text-white hover:bg-blue-600 transition-colors"
              >
                重试
              </button>
            )}
          </div>
        </div>
      )}
    </Dialog>
  )
}
