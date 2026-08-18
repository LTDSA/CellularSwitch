import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Delete,
  History,
  Loader2,
  MoreVertical,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  X,
} from 'lucide-react'
import type { CallRecord } from '../types'
import { deleteLocalCall, loadLocalCallHistory, saveLocalCall, nowStamp } from '../utils/callHistory'

interface Props {
  /** 语音服务状态（由父组件 SettingsCard 全局检查，供置灰拨号 + 展示提示）。 */
  driverState: DriverState
  driverError: string | null
  driverDismissed: boolean
  onDismissDriver: () => void
  /** 拨号回调：父组件据此打开通话对话框（拨出模式）。 */
  onDial: (number: string) => void
  /** 通话记录版本号：变化时重新加载通话记录。 */
  callLogVersion: number
  /** 是否正在通话中（用于键盘输入在通话时不响应）。 */
  isInCall: boolean
  /** 重试驱动状态检查。 */
  onRetryDriver: () => void
  /** 是否当前处于电话 Tab（用于键盘输入仅在电话 Tab 时响应）。 */
  active: boolean
}

const TYPE_ICON: Record<CallRecord['type'], typeof PhoneOutgoing> = {
  dialed: PhoneOutgoing,
  received: PhoneIncoming,
  missed: PhoneMissed,
}

const TYPE_LABEL: Record<CallRecord['type'], string> = {
  dialed: '拨出',
  received: '已接',
  missed: '未接',
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#']

/** 语音服务状态（与 SettingsCard 一致）。 */
type DriverState = 'checking' | 'noVolte' | 'adbOff' | 'audioOff' | 'loaded' | 'error'

/**
 * 电话视图：左通话记录、右拨号键盘。
 * 通话记录存 localStorage；拨号经 onDial 交给父组件（SettingsCard）打开通话对话框。
 */
export function PhoneView({
  driverState,
  driverError,
  driverDismissed,
  onDismissDriver,
  onDial,
  callLogVersion,
  isInCall,
  onRetryDriver,
  active,
}: Props) {
  const [records, setRecords] = useState<CallRecord[]>([])
  const [loadState, setLoadState] = useState<'loading' | 'ready'>('loading')
  const [number, setNumber] = useState('')
  // 当前展开菜单的通话记录 key（`${type}-${id}-${number}`），null 表示无菜单展开。
  const [menuRecordKey, setMenuRecordKey] = useState<string | null>(null)

  // 通话记录统一存 localStorage（模块 DC/MC/RC 电话本只读，CPBW 删除返回 CME ERROR 3，
  // 且「模块优先」会导致删除后被重新读回），故只读本地。
  const load = useCallback((silent = false) => {
    if (!silent) setLoadState('loading')
    setRecords(loadLocalCallHistory())
    setLoadState('ready')
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // 通话记录版本号变化（通话结束）时刷新记录。
  useEffect(() => {
    load(true)
  }, [callLogVersion, load])

  const press = (key: string) => setNumber((n) => n + key)
  const backspace = () => setNumber((n) => n.slice(0, -1))

  const handleDial = () => {
    // VoLTE 未启用时禁止拨号（兜底：屏幕按钮已置灰，此处拦截键盘 Enter 等其他入口）。
    if (driverState === 'noVolte') return
    const target = number.trim()
    if (!target) return
    // 本地记录拨出。
    saveLocalCall({ id: Date.now(), number: target, type: 'dialed', timestamp: nowStamp() })
    setNumber('')
    load(true)
    onDial(target)
  }

  // 回拨：把号码填充到拨号键盘，不直接拨号。
  const handleCallback = (r: CallRecord) => {
    setMenuRecordKey(null)
    setNumber(r.number)
  }

  // 删除一条通话记录：UI 移除 + 本地删除（记录统一存 localStorage，模块电话本只读）。
  const handleDeleteRecord = (r: CallRecord) => {
    setMenuRecordKey(null)
    setRecords((prev) =>
      prev.filter((c) => !(c.id === r.id && c.type === r.type && c.number === r.number)),
    )
    deleteLocalCall(r.id)
  }

  // 点击菜单外部或 Esc 关闭通话记录菜单。
  useEffect(() => {
    if (menuRecordKey === null) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement
      if (
        target.closest('[role="menu"]') ||
        target.closest('[aria-label="通话记录操作"]')
      ) {
        return
      }
      setMenuRecordKey(null)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuRecordKey(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuRecordKey])

  // 电脑键盘直接输入拨号（仅在电话 Tab 且无通话时响应）：数字/*/#/+ 追加，Backspace 退格，Enter 拨号。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!active || isInCall) return
      if (/^[0-9*#+]$/.test(e.key)) {
        press(e.key)
      } else if (e.key === 'Backspace') {
        e.preventDefault()
        backspace()
      } else if (e.key === 'Enter' && number.trim()) {
        handleDial()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  return (
    <div className="flex h-[28rem]">
      {/* 左：通话记录 */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-gray-100">
        {driverState !== 'checking' && !(driverState === 'loaded' && driverDismissed) && (
          <div
            className={`border-b border-gray-100 px-3 py-2.5 ${
              driverState === 'error'
                ? 'bg-red-50'
                : driverState === 'loaded'
                  ? 'bg-green-50'
                  : 'bg-amber-50'
            }`}
          >
            {driverState === 'noVolte' && (
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                <p className="text-xs leading-relaxed text-amber-700">
                  未启用 VoLTE，无法进行通话
                </p>
              </div>
            )}
            {driverState === 'adbOff' && (
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                <p className="text-xs leading-relaxed text-amber-700">
                  未启用 ADB，无法加载语音驱动
                </p>
              </div>
            )}
            {driverState === 'audioOff' && (
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                <p className="text-xs leading-relaxed text-amber-700">
                  未启用 USB 音频，通话可能静音
                </p>
              </div>
            )}
            {driverState === 'loaded' && (
              <div className="flex min-h-[22px] items-center gap-2">
                <Check className="size-4 shrink-0 text-green-500" />
                <p className="flex-1 text-xs leading-relaxed text-green-700">语音服务已就绪</p>
                <button
                  type="button"
                  onClick={onDismissDriver}
                  aria-label="关闭提示"
                  className="shrink-0 rounded-md p-1 text-green-500 transition-colors hover:bg-green-100 hover:text-green-700"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            )}
            {driverState === 'error' && (
              <div className="flex flex-col gap-2">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-500" />
                  <p className="line-clamp-2 break-all text-xs leading-relaxed text-red-600">
                    {driverError ?? '驱动状态异常'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onRetryDriver}
                  className="rounded-md bg-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-300"
                >
                  重试
                </button>
              </div>
            )}
          </div>
        )}
        <div className="thin-scrollbar flex-1 overflow-y-auto">
          {loadState === 'loading' && (
            <div className="flex min-h-full items-center justify-center">
              <Loader2 className="size-8 animate-spin text-gray-300" />
            </div>
          )}
          {loadState === 'ready' && records.length === 0 && (
            <div className="flex min-h-full flex-col items-center justify-center p-4 text-center">
              <History className="size-8 text-gray-300" />
              <p className="mt-2 text-sm text-gray-400">暂无通话记录</p>
            </div>
          )}
          {loadState === 'ready' && (
            <ul className="divide-y divide-gray-100">
              {records.map((r) => {
                const Icon = TYPE_ICON[r.type]
                const key = `${r.type}-${r.id}-${r.number}`
                return (
                  <li key={key}>
                    <div className="flex items-center gap-3 px-4 py-3">
                      <Icon
                        className={`size-4 shrink-0 ${
                          r.type === 'missed' ? 'text-red-500' : 'text-gray-400'
                        }`}
                      />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span
                          className={`truncate text-sm font-medium ${
                            r.type === 'missed' ? 'text-red-600' : 'text-gray-900'
                          }`}
                        >
                          {r.number}
                        </span>
                        <span
                          className={`text-xs ${
                            r.type === 'missed' ? 'text-red-500' : 'text-gray-400'
                          }`}
                        >
                          {TYPE_LABEL[r.type]}
                          {r.timestamp ? ` · ${r.timestamp}` : ''}
                        </span>
                      </div>
                      <div className="relative shrink-0">
                        <button
                          type="button"
                          onClick={() => setMenuRecordKey((k) => (k === key ? null : key))}
                          aria-label="通话记录操作"
                          className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                        >
                          <MoreVertical className="size-4" />
                        </button>

                        {menuRecordKey === key && (
                          <div
                            role="menu"
                            className="absolute right-0 top-full z-10 mt-1 w-32 rounded-xl bg-white p-1.5 shadow-lg ring-1 ring-black/5"
                          >
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => handleCallback(r)}
                              disabled={driverState === 'noVolte'}
                              className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm font-medium text-gray-900 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-300"
                            >
                              回拨
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => handleDeleteRecord(r)}
                              className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm font-medium text-red-600 transition-colors hover:bg-red-50"
                            >
                              删除
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* 右：拨号键盘 */}
      <section className="flex flex-1 flex-col">
        <div className="flex items-center justify-center border-b border-gray-100 px-4 py-4">
          <span className="truncate font-mono text-2xl font-medium tracking-wider text-gray-900">
            {number || <span className="text-gray-300">输入号码</span>}
          </span>
          {number && (
            <button
              type="button"
              onClick={backspace}
              aria-label="退格"
              className="ml-2 shrink-0 rounded-md p-1 text-gray-400 transition-colors hover:text-gray-600"
            >
              <Delete className="size-5" />
            </button>
          )}
        </div>

        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-4">
          <div className="grid w-full max-w-xs grid-cols-3 gap-2">
            {KEYS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => press(k)}
                className="h-14 rounded-xl bg-gray-50 text-xl font-medium text-gray-900 transition-colors hover:bg-gray-100 active:bg-gray-200"
              >
                {k}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={handleDial}
            disabled={!number.trim() || driverState === 'noVolte'}
            aria-label="拨号"
            className="mt-2 flex h-14 w-14 items-center justify-center rounded-full bg-green-500 text-white transition-colors hover:bg-green-600 disabled:opacity-40"
          >
            <Phone className="size-6" />
          </button>
        </div>
      </section>
    </div>
  )
}
