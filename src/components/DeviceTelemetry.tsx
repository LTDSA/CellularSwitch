import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  Eye,
  EyeOff,
  SignalHigh,
  SignalMedium,
  SignalLow,
  SignalZero,
  Smartphone,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ModuleService } from '../services/ModuleService'
import type { Telemetry, SignalInfo } from '../types'
import { TELEMETRY_REFRESH_MS } from '../constants'

interface Props {
  device: USBDevice
  moduleService: ModuleService
  /** 递增时强制重新查询（如功能模式切换后射频状态改变）。 */
  refreshKey?: number
}

type TelemetryState =
  | { type: 'loading' }
  | { type: 'ready'; data: Telemetry }
  | { type: 'error' }

interface Field {
  label: string
  value: string
}

// 脱敏：仅显示首 4 位与末 4 位，中间用圆点掩码；占位符「—」与过短的值不脱敏。
function maskSensitive(value: string): string {
  if (value === '—' || value.length <= 8) return value
  return `${value.slice(0, 4)}${'•'.repeat(value.length - 8)}${value.slice(-4)}`
}

/**
 * 信号强度图标，按档位红/橙/绿着色：
 * - 0-1 格 → 红（弱）
 * - 2 格 → 橙（中）
 * - 3-4 格 → 绿（强）
 * 由调用方保证只在 SIM 就绪时渲染；此处仅处理 CSQ 不可测（无档位）的情况。
 */
function SignalIndicator({ signal }: { signal: SignalInfo }) {
  if (signal.bars === null) {
    return <SignalZero className="h-4 w-4 text-gray-300" />
  }
  if (signal.bars === 0) {
    return <SignalZero className="h-4 w-4 text-red-500" />
  }
  if (signal.bars === 1) {
    return <SignalLow className="h-4 w-4 text-red-500" />
  }
  if (signal.bars === 2) {
    return <SignalMedium className="h-4 w-4 text-orange-500" />
  }
  return <SignalHigh className="h-4 w-4 text-green-600" />
}

/**
 * 运行状态 / 设备信息两栏分栏，挂在工作模式上方。
 * 两条数据来自同一批只读 AT 查询，因此共用同一个 loading/error 状态，
 * 任一条查不到时该字段以「—」占位，不会让整块查询失败。
 * 「运行状态」标题右侧有信号强度图标；「设备信息」默认脱敏（仅显示首末四位），
 * 点标题右侧的眼睛按钮切换显示完整信息。
 */
export function DeviceTelemetry({ device, moduleService, refreshKey = 0 }: Props) {
  const [state, setState] = useState<TelemetryState>({ type: 'loading' })
  // 设备信息默认脱敏，点击眼睛按钮后显示完整信息。
  const [revealed, setRevealed] = useState(false)

  const load = useCallback(async () => {
    setState({ type: 'loading' })
    try {
      const data = await moduleService.getTelemetry(device)
      setState({ type: 'ready', data })
    } catch {
      setState({ type: 'error' })
    }
  }, [device, moduleService])

  // 静默刷新运行状态：只拉运行状态相关指令，保留已加载的设备信息。
  const refreshRunning = useCallback(async () => {
    try {
      const running = await moduleService.getRunningStatus(device)
      setState((prev) =>
        prev.type === 'ready'
          ? { type: 'ready', data: { ...prev.data, running } }
          : prev,
      )
    } catch {
      // 静默失败：保留旧数据。
    }
  }, [device, moduleService])

  // 首次挂载 / 设备变化：全量加载（运行状态 + 设备信息），显示「读取中」。
  useEffect(() => {
    load()
  }, [load])

  // 功能模式切换（refreshKey 递增）：静默刷新运行状态，不闪「读取中」。
  useEffect(() => {
    if (refreshKey === 0) return
    refreshRunning()
  }, [refreshKey, refreshRunning])

  // 运行状态定时刷新：静默（不闪「读取中」），失败保留旧数据。
  useEffect(() => {
    const id = setInterval(refreshRunning, TELEMETRY_REFRESH_MS)
    return () => clearInterval(id)
  }, [refreshRunning])

  const runningFields = (data: Telemetry): Field[] => [
    { label: '网络模式', value: data.running.networkMode },
    { label: '频段', value: data.running.band },
    { label: '信道', value: data.running.channel },
    { label: '注册状态', value: data.running.registration },
  ]
  const deviceFields = (data: Telemetry): Field[] => [
    { label: 'IMEI', value: data.deviceInfo.imei },
    { label: 'ICCID', value: data.deviceInfo.iccid },
    { label: 'IMSI', value: data.deviceInfo.imsi },
    { label: '本机号码', value: data.deviceInfo.phoneNumber },
  ]

  // 信号图标只在数据就绪后才有值可指示。
  const runningSignal: SignalInfo | undefined =
    state.type === 'ready' ? state.data.running.signal : undefined

  return (
    <div className="grid grid-cols-2 divide-x divide-gray-100 border-b border-gray-100">
      <Column
        title="运行状态"
        icon={Activity}
        state={state}
        onRetry={load}
        fields={runningFields}
        signal={runningSignal}
      />
      <Column
        title="设备信息"
        icon={Smartphone}
        state={state}
        onRetry={load}
        fields={deviceFields}
        revealButton={{
          revealed,
          onToggle: () => setRevealed((v) => !v),
        }}
      />
    </div>
  )
}

function Column({
  title,
  state,
  onRetry,
  fields,
  revealButton,
  signal,
  icon: Icon,
}: {
  title: string
  state: TelemetryState
  onRetry: () => void
  fields: (data: Telemetry) => Field[]
  /** 传入时：标题右侧显示眼睛按钮，未显示时字段值脱敏。仅「设备信息」列使用。 */
  revealButton?: { revealed: boolean; onToggle: () => void }
  /** 传入时：标题右侧显示信号强度图标。仅「运行状态」列使用。 */
  signal?: SignalInfo
  /** 标题左侧的图标。 */
  icon?: LucideIcon
}) {
  // 信号图标悬停提示：直接显示精确 dBm（仅 SIM 就绪时渲染图标）。
  const signalLabel = signal
    ? signal.dbm === null
      ? '信号不可用'
      : `${signal.dbm} dBm`
    : undefined

  return (
    <div className="px-6 py-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
          {Icon && <Icon className="h-4 w-4 shrink-0 text-gray-500" />}
          {title}
        </h2>
        <div className="flex items-center gap-3">
          {/* 未插卡时不显示信号图标（无信号可指示）。 */}
          {signal && signal.simReady && (
            <span title={signalLabel} className="flex items-center">
              <SignalIndicator signal={signal} />
            </span>
          )}
          {revealButton && (
            <button
              type="button"
              onClick={revealButton.onToggle}
              aria-label={revealButton.revealed ? '隐藏完整信息' : '显示完整信息'}
              className="text-gray-400 hover:text-gray-600 transition-colors"
            >
              {revealButton.revealed ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          )}
        </div>
      </div>
      {state.type === 'loading' && <p className="text-sm text-gray-400">读取中…</p>}
      {state.type === 'error' && (
        <button
          onClick={onRetry}
          className="text-sm text-gray-400 hover:text-gray-600"
        >
          读取失败 · 重试
        </button>
      )}
      {state.type === 'ready' && (
        <dl className="space-y-2">
          {fields(state.data).map((f) => (
            <div
              key={f.label}
              className="flex items-center justify-between gap-3 text-sm"
            >
              <dt className="shrink-0 text-gray-500">{f.label}</dt>
              <dd className="min-w-0 truncate text-right text-gray-900">
                {revealButton && !revealButton.revealed
                  ? maskSensitive(f.value)
                  : f.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
