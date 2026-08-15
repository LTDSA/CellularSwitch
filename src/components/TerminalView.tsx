import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Bug, CircleAlert, Loader2, Radio, SquareTerminal } from 'lucide-react'
import type { ModuleService } from '../services/ModuleService'
import { AdbService, type AdbStream } from '../services/AdbService'
import { mapErrorMessage } from '../utils/mapErrorMessage'

interface Props {
  device: USBDevice
  moduleService: ModuleService
}

type TerminalKind = 'at' | 'adb'

const decoder = new TextDecoder()

/** 去掉 AT 响应首行的命令回显（模块默认回显开启；ATE0 时无回显则不匹配、原样返回）。 */
function stripEcho(response: string, command: string): string {
  const lines = response.split(/\r\n|\n|\r/)
  if (lines.length && lines[0].trim().toLowerCase() === command.trim().toLowerCase()) {
    lines.shift()
  }
  return lines.join('\n').replace(/^\s+/, '')
}

/**
 * 把交互 shell 输出拆成「已确认正文」与「末尾提示符」。
 * 设备在等待输入时输出的最后一段是提示符（如 `/ # `，无尾随换行），
 * 故取最后一个换行符之后的文本作提示符，之前作正文。
 */
function splitPrompt(transcript: string): { body: string; prompt: string } {
  const idx = transcript.lastIndexOf('\n')
  if (idx === -1) return { body: '', prompt: transcript }
  return { body: transcript.slice(0, idx + 1), prompt: transcript.slice(idx + 1) }
}

/**
 * 「终端」视图：仿短信的两栏布局。左列表两项「AT 终端」「ADB 终端」，
 * 右侧展示对应终端；ADB 未开启时点击 ADB 项显示提示。
 */
export function TerminalView({ device, moduleService }: Props) {
  const [active, setActive] = useState<TerminalKind>('at')

  return (
    <div className="flex h-[28rem]">
      {/* 左：终端类型列表 */}
      <aside className="flex w-44 shrink-0 flex-col border-r border-gray-100">
        <ul className="divide-y divide-gray-100">
          <NavItem
            icon={<Radio className="size-4 shrink-0 text-gray-500" />}
            label="AT 终端"
            active={active === 'at'}
            onClick={() => setActive('at')}
          />
          <NavItem
            icon={<Bug className="size-4 shrink-0 text-gray-500" />}
            label="ADB 终端"
            active={active === 'adb'}
            onClick={() => setActive('adb')}
          />
        </ul>
        <p className="mt-auto px-4 pb-3 text-center text-xs leading-relaxed text-gray-400">
          发送指令前请确保您知道自己在做什么
        </p>
      </aside>

      {/* 右：对应终端 */}
      <section className="flex flex-1 flex-col">
        {active === 'at' ? (
          <AtTerminal device={device} moduleService={moduleService} />
        ) : (
          <AdbTerminal device={device} moduleService={moduleService} />
        )}
      </section>
    </div>
  )
}

function NavItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: ReactNode
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`w-full px-4 py-3 text-left transition-colors ${
          active ? 'bg-brand/5' : 'hover:bg-gray-50'
        }`}
      >
        <span className="flex items-center gap-2 text-sm font-medium text-gray-900">
          {icon}
          {label}
        </span>
      </button>
    </li>
  )
}

/** 终端外框：标题栏 + 中部内容 + 底部输入行。 */
function TerminalFrame({
  title,
  right,
  children,
  input,
}: {
  title: string
  right?: ReactNode
  children: ReactNode
  input?: ReactNode
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <span className="text-sm font-medium text-gray-900">{title}</span>
        {right}
      </div>
      {children}
      {input}
    </div>
  )
}

function ShellInput({
  value,
  onChange,
  onSubmit,
  disabled,
  busy,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  disabled?: boolean
  busy?: boolean
  placeholder: string
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !disabled && !busy) {
      e.preventDefault()
      onSubmit()
    }
  }
  return (
    <div className="flex items-center gap-2 border-t border-gray-100 px-4 py-3">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled || busy}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="flex-1 rounded-lg bg-gray-100 px-3 py-2 font-mono text-sm text-gray-900 outline-none placeholder:text-gray-400 disabled:opacity-50"
      />
      <button
        type="button"
        onClick={onSubmit}
        disabled={disabled || busy || !value.trim()}
        className="px-3 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-blue-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy ? '…' : '发送'}
      </button>
    </div>
  )
}

// --- AT 终端 ---

type AtEntry = { kind: 'cmd' | 'out' | 'err'; text: string }

function AtTerminal({ device, moduleService }: Props) {
  const [entries, setEntries] = useState<AtEntry[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const send = useCallback(async () => {
    const cmd = input.trim()
    if (!cmd || busy) return
    setInput('')
    setBusy(true)
    setEntries((e) => [...e, { kind: 'cmd', text: cmd }])
    try {
      const raw = await moduleService.sendAtCommand(device, cmd)
      setEntries((e) => [...e, { kind: 'out', text: stripEcho(raw, cmd) }])
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const diagnostics = (err as { diagnostics?: string })?.diagnostics
      setEntries((e) => [
        ...e,
        { kind: 'err', text: mapErrorMessage(message) },
        ...(typeof diagnostics === 'string' && diagnostics
          ? [{ kind: 'err' as const, text: diagnostics }]
          : []),
      ])
    } finally {
      setBusy(false)
    }
  }, [input, busy, device, moduleService])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries])

  return (
    <TerminalFrame
      title="AT 终端"
      input={
        <ShellInput
          value={input}
          onChange={setInput}
          onSubmit={send}
          busy={busy}
          placeholder="输入 AT 指令，例如 AT+CSQ"
        />
      }
    >
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed"
      >
        {entries.length === 0 && (
          <p className="text-gray-400">输入 AT 指令并按回车，例如 AT+CSQ</p>
        )}
        {entries.map((e, i) => (
          <div key={i} className={e.kind === 'err' ? 'text-red-500' : 'text-gray-700'}>
            {e.kind === 'cmd' ? (
              <span className="font-semibold text-brand">&gt; {e.text}</span>
            ) : (
              <pre className="whitespace-pre-wrap break-words">{e.text}</pre>
            )}
          </div>
        ))}
      </div>
    </TerminalFrame>
  )
}

// --- ADB 终端 ---

type AdbState = 'checking' | 'disabled' | 'connecting' | 'ready' | 'error'

function AdbTerminal({ device, moduleService }: Props) {
  const adbRef = useRef<AdbService | null>(null)
  const streamRef = useRef<AdbStream | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // 命令历史（本地维护，最近的在末尾）与浏览位置；-1 表示正在输入新行。
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef(-1)
  const draftRef = useRef('')
  const [state, setState] = useState<AdbState>('checking')
  const [error, setError] = useState('')
  const [diagnostics, setDiagnostics] = useState('')
  const [transcript, setTranscript] = useState('')
  const [input, setInput] = useState('')
  const [retryKey, setRetryKey] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  const getAdb = () => {
    if (!adbRef.current) adbRef.current = new AdbService()
    return adbRef.current
  }

  useEffect(() => {
    let cancelled = false
    const adb = getAdb()
    setState('checking')
    setError('')
    setDiagnostics('')
    setTranscript('')
    setInput('')

    ;(async () => {
      let preamble = ''
      try {
        const cfg = await moduleService.queryUsbConfig(device)
        if (cancelled) return
        if (!cfg.adb) {
          setState('disabled')
          return
        }
        preamble +=
          `USB 配置: VID=0x${cfg.vid.toString(16).padStart(4, '0')} ` +
          `PID=0x${cfg.pid.toString(16).padStart(4, '0')} ` +
          `diag=${+cfg.diag} nmea=${+cfg.nmea} at=${+cfg.at} modem=${+cfg.modem} ` +
          `net=${+cfg.net} adb=${+cfg.adb} audio=${+cfg.audio}\n`

        setState('connecting')

        // 连接失败时把模块身份 / 工厂锁状态一并呈现，便于定位 adbd 是否就绪。
        try {
          const identity = await moduleService.sendAtCommand(device, 'ATI')
          preamble += `ATI: ${identity.trim().replace(/[\r\n]+/g, ' | ')}\n`
        } catch (e) {
          preamble += `ATI: 查询失败（${e instanceof Error ? e.message : String(e)}）\n`
        }
        if (cancelled) return

        try {
          const unlock = await moduleService.ensureFactoryUnlocked(device)
          preamble += `工厂锁: ${unlock}\n`
        } catch (e) {
          preamble += `工厂锁: 查询失败（${e instanceof Error ? e.message : String(e)}）\n`
        }
        if (cancelled) return

        await adb.connect(device)
        if (cancelled) return

        const stream = await adb.openShell({
          onData: (chunk) => {
            if (!cancelled) setTranscript((t) => t + decoder.decode(chunk))
          },
          onClose: () => {
            streamRef.current = null
            if (!cancelled) {
              setTranscript((t) => (t ? `${t}\n[会话已关闭]\n` : '[会话已关闭]\n'))
            }
          },
        })
        if (cancelled) {
          void stream.close()
          return
        }
        streamRef.current = stream
        setState('ready')
        // 进入就绪态后聚焦输入框，光标落在提示符后。
        requestAnimationFrame(() => inputRef.current?.focus())
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        const diag = (err as { diagnostics?: string })?.diagnostics ?? ''
        setDiagnostics(preamble ? `${preamble}${diag}` : diag)
        setState('error')
      }
    })()

    return () => {
      cancelled = true
      streamRef.current = null
      void adb.close()
    }
  }, [device, moduleService, retryKey])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [transcript])

  // 交互 shell 逐字回显由设备侧完成（shell 回显），本地只需下发输入 + \n，
  // 不手动回显，避免与设备回显重复。
  const submit = useCallback(() => {
    const stream = streamRef.current
    if (!stream) return
    if (input.trim()) {
      historyRef.current.push(input)
    }
    historyIndexRef.current = -1
    draftRef.current = ''
    setInput('')
    void stream.write(`${input}\n`).catch((err) => {
      setTranscript(
        (t) => `${t}[发送失败] ${err instanceof Error ? err.message : String(err)}\n`,
      )
    })
  }, [input])

  // Ctrl+C：向 shell 发送 SIGINT（0x03）中断当前命令，并清空输入行。
  const sendInterrupt = useCallback(() => {
    const stream = streamRef.current
    if (!stream) return
    setInput('')
    void stream.write('\x03').catch((err) => {
      setTranscript(
        (t) => `${t}[发送失败] ${err instanceof Error ? err.message : String(err)}\n`,
      )
    })
  }, [])

  // 设值并把光标放到指定位置（等待 React 提交到 DOM 后再设置选区）。
  const setInputWithCursor = useCallback((value: string, cursor: number) => {
    setInput(value)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (el) el.setSelectionRange(cursor, cursor)
    })
  }, [])

  // 上下键浏览历史：↑ 向旧命令、↓ 向新命令，越界则回到暂存的未提交草稿。
  const recallHistory = useCallback(
    (dir: 'up' | 'down') => {
      const history = historyRef.current
      if (history.length === 0) return
      if (dir === 'up') {
        if (historyIndexRef.current === -1) {
          draftRef.current = input
          historyIndexRef.current = history.length - 1
        } else if (historyIndexRef.current > 0) {
          historyIndexRef.current -= 1
        } else {
          return // 已到最旧一条
        }
        const cmd = history[historyIndexRef.current]
        setInputWithCursor(cmd, cmd.length)
      } else {
        if (historyIndexRef.current === -1) return
        if (historyIndexRef.current < history.length - 1) {
          historyIndexRef.current += 1
          const cmd = history[historyIndexRef.current]
          setInputWithCursor(cmd, cmd.length)
        } else {
          historyIndexRef.current = -1
          const draft = draftRef.current
          draftRef.current = ''
          setInputWithCursor(draft, draft.length)
        }
      }
    },
    [input, setInputWithCursor],
  )

  // 行内编辑：Ctrl+A 行首、Ctrl+E 行尾、Ctrl+U 删到行首、Ctrl+K 删到行尾。
  const editLine = useCallback(
    (op: 'home' | 'end' | 'killBefore' | 'killAfter') => {
      const el = inputRef.current
      if (!el) return
      const value = el.value
      const start = el.selectionStart ?? value.length
      const end = el.selectionEnd ?? value.length
      if (op === 'home') {
        el.setSelectionRange(0, 0)
        return
      }
      if (op === 'end') {
        el.setSelectionRange(value.length, value.length)
        return
      }
      if (op === 'killBefore') {
        setInputWithCursor(value.slice(end), 0)
        return
      }
      setInputWithCursor(value.slice(0, start), start)
    },
    [setInputWithCursor],
  )

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (state !== 'ready') return
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      recallHistory('up')
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      recallHistory('down')
      return
    }
    // 仅 Ctrl（不含 Alt/Cmd）的组合键；Cmd/Ctrl 系统快捷键不受影响。
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.code === 'KeyC') {
        e.preventDefault()
        sendInterrupt()
        return
      }
      if (e.code === 'KeyA') {
        e.preventDefault()
        editLine('home')
        return
      }
      if (e.code === 'KeyE') {
        e.preventDefault()
        editLine('end')
        return
      }
      if (e.code === 'KeyU') {
        e.preventDefault()
        editLine('killBefore')
        return
      }
      if (e.code === 'KeyK') {
        e.preventDefault()
        editLine('killAfter')
        return
      }
      if (e.code === 'KeyL') {
        e.preventDefault()
        setTranscript('')
        return
      }
    }
  }

  const retry = () => setRetryKey((k) => k + 1)

  if (state === 'checking') return <AdbHint spinner text="读取 ADB 状态…" />
  if (state === 'disabled') {
    return (
      <AdbHint
        icon={<CircleAlert className="size-8 text-gray-300" />}
        text="ADB 未开启"
        sub="请在「USB 功能 → 进阶选项」开启 ADB 并应用（需重启模块），然后重新连接设备。"
      />
    )
  }
  if (state === 'connecting') return <AdbHint spinner text="正在连接 ADB…" />
  if (state === 'error') {
    return (
      <AdbHint
        icon={<CircleAlert className="size-8 text-gray-300" />}
        text={mapErrorMessage(error) || 'ADB 连接失败'}
        sub={diagnostics}
        action={<RetryButton onClick={retry} label="重试" />}
      />
    )
  }

  const { body, prompt } = splitPrompt(transcript)

  return (
    <TerminalFrame
      title="ADB 终端"
      right={<span className="text-xs text-green-600">已连接</span>}
    >
      <div
        ref={scrollRef}
        onClick={() => inputRef.current?.focus()}
        className="flex-1 overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed text-gray-700"
      >
        <pre className="whitespace-pre-wrap break-words">{body}</pre>
        <div className="flex items-baseline">
          <span className="shrink-0 whitespace-pre">{prompt}</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoFocus
            className="min-w-0 flex-1 bg-transparent outline-none"
          />
        </div>
      </div>
    </TerminalFrame>
  )
}

function RetryButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-3 py-1.5 rounded-lg bg-brand text-white text-sm font-medium hover:bg-blue-600 transition-colors"
    >
      {label}
    </button>
  )
}

/** ADB 右侧占位：加载 / 未开启 / 连接中 / 失败 / 已关闭。 */
function AdbHint({
  icon,
  spinner,
  text,
  sub,
  action,
}: {
  icon?: ReactNode
  spinner?: boolean
  text: string
  sub?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="flex max-w-xs flex-col items-center text-center px-6">
        {spinner ? (
          <Loader2 className="size-8 animate-spin text-gray-300" />
        ) : (
          icon ?? <SquareTerminal className="size-8 text-gray-300" />
        )}
        <p className="mt-2 text-sm text-gray-500">{text}</p>
        {sub && <p className="mt-1 text-xs text-gray-400 leading-relaxed break-words">{sub}</p>}
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  )
}
