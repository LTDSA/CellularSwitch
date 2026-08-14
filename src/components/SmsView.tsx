import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Check, CircleAlert, Copy, KeyRound, Loader2, MessageSquare } from 'lucide-react'
import type { SmsMessage } from '../types'
import type { ModuleService } from '../services/ModuleService'
import { SMS_REFRESH_MS } from '../constants'
import { extractOtp } from '../utils/extractOtp'
import { extractSender } from '../utils/extractSender'

interface Props {
  device: USBDevice
  moduleService: ModuleService
}

interface Conversation {
  address: string
  messages: SmsMessage[]
  latest: SmsMessage
}

interface OtpEntry {
  message: SmsMessage
  code: string
  /** 匹配到的发送方名称（如「哔哩哔哩」）；未匹配时回退为号码。 */
  sender: string
}

/** 右侧选中的内容：验证码聚合，或某个具体会话。 */
type Selection = { type: 'otp' } | { type: 'conversation'; address: string }

/** 模块时间戳格式 yy/MM/dd,HH:mm:ss±zz → 简洁的 MM/dd HH:mm。 */
function formatSmsTime(raw: string): string {
  const m = raw.match(/(\d{2})\/(\d{2})\/(\d{2}),(\d{2}):(\d{2})/)
  if (!m) return raw
  return `${m[2]}/${m[3]} ${m[4]}:${m[5]}`
}

/**
 * 短信视图：左会话列表、右对话详情（仿 iPad 左右分栏）。仅接收，不支持发送。
 * 仅在「短信」选项卡挂载时运行轮询；卸载即停止（概览 tab 的遥测轮询不共存）。
 * 收到含验证码的短信时，在会话列表顶部聚合为一条「验证码」，点击后在右侧查看并复制。
 */
export function SmsView({ device, moduleService }: Props) {
  const [messages, setMessages] = useState<SmsMessage[]>([])
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [selection, setSelection] = useState<Selection | null>(null)
  const [copiedCode, setCopiedCode] = useState<string | null>(null)

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoadState('loading')
      try {
        const msgs = await moduleService.listSms(device)
        setMessages(msgs)
        setLoadState('ready')
      } catch {
        // 静默轮询失败保留旧数据，不闪「读取中/失败」。
        if (!silent) setLoadState('error')
      }
    },
    [device, moduleService],
  )

  useEffect(() => {
    load()
    const id = setInterval(() => load(true), SMS_REFRESH_MS)
    return () => clearInterval(id)
  }, [load])

  // 按对方号码聚合成会话，会话内按存储位置（≈时间）升序，会话间按最新消息降序。
  const conversations = useMemo<Conversation[]>(() => {
    const map = new Map<string, SmsMessage[]>()
    for (const m of messages) {
      const arr = map.get(m.address) ?? []
      arr.push(m)
      map.set(m.address, arr)
    }
    return [...map.entries()]
      .map(([address, msgs]) => {
        msgs.sort((a, b) => a.index - b.index)
        return { address, messages: msgs, latest: msgs[msgs.length - 1] }
      })
      .sort((a, b) => b.latest.index - a.latest.index)
  }, [messages])

  // 从收到的短信中抽取验证码，聚合为一条置顶「会话」，最新的排在前面。
  const otpEntries = useMemo<OtpEntry[]>(() => {
    const entries: OtpEntry[] = []
    for (const m of messages) {
      if (m.direction !== 'incoming') continue
      const code = extractOtp(m.text)
      if (code) {
        entries.push({ message: m, code, sender: extractSender(m.text) ?? m.address })
      }
    }
    return entries.sort((a, b) => b.message.index - a.message.index)
  }, [messages])

  const copyCode = useCallback(async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
      setCopiedCode(code)
      setTimeout(() => setCopiedCode((c) => (c === code ? null : c)), 1500)
    } catch {
      // 剪贴板不可用（如非安全上下文）时静默失败，验证码仍可见可手动复制。
    }
  }, [])

  const selected =
    selection?.type === 'conversation'
      ? conversations.find((c) => c.address === selection.address)
      : undefined

  return (
    <div className="flex h-[28rem]">
      {/* 左：会话列表（含置顶的「验证码」聚合项） */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-gray-100">
        <div className="flex-1 overflow-y-auto">
          {loadState === 'loading' && (
            <ListHint
              icon={<Loader2 className="size-8 animate-spin text-gray-300" />}
              text="读取中…"
            />
          )}
          {loadState === 'error' && (
            <ListHint
              icon={<CircleAlert className="size-8 text-gray-300" />}
              text="读取失败 · 重试"
              onClick={() => load()}
            />
          )}
          {loadState === 'ready' && conversations.length === 0 && (
            <ListHint
              icon={<MessageSquare className="size-8 text-gray-300" />}
              text="暂无短信"
            />
          )}
          {loadState === 'ready' && (
            <ul className="divide-y divide-gray-100">
              {otpEntries.length > 0 && (
                <li>
                  <button
                    type="button"
                    onClick={() => setSelection({ type: 'otp' })}
                    className={`w-full px-4 py-3 text-left transition-colors ${
                      selection?.type === 'otp' ? 'bg-brand/5' : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-gray-900">
                        <KeyRound className="h-3.5 w-3.5 shrink-0 text-gray-500" />
                        <span className="truncate">验证码</span>
                      </span>
                      <span className="shrink-0 text-xs text-gray-400">
                        {formatSmsTime(otpEntries[0].message.timestamp)}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-gray-500">
                      {otpEntries.length} 条验证码
                    </p>
                  </button>
                </li>
              )}

              {conversations.map((c) => {
                const active =
                  selection?.type === 'conversation' && selection.address === c.address
                return (
                  <li key={c.address}>
                    <button
                      type="button"
                      onClick={() => setSelection({ type: 'conversation', address: c.address })}
                      className={`w-full px-4 py-3 text-left transition-colors ${
                        active ? 'bg-brand/5' : 'hover:bg-gray-50'
                      }`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-medium text-gray-900">
                          {c.address}
                        </span>
                        <span className="shrink-0 text-xs text-gray-400">
                          {formatSmsTime(c.latest.timestamp)}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-gray-500">
                        {c.latest.direction === 'outgoing' ? '我：' : ''}
                        {c.latest.text}
                      </p>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* 右：验证码聚合 / 对话详情 / 空白 */}
      <section className="flex flex-1 flex-col">
        {selection?.type === 'otp' ? (
          <OtpThread entries={otpEntries} copiedCode={copiedCode} onCopy={copyCode} />
        ) : selected ? (
          <Thread conversation={selected} />
        ) : (
          <EmptyState />
        )}
      </section>
    </div>
  )
}

/** 右侧验证码聚合：逐条列出「号码 + 验证码 + 时间」，点击即可复制。 */
function OtpThread({
  entries,
  copiedCode,
  onCopy,
}: {
  entries: OtpEntry[]
  copiedCode: string | null
  onCopy: (code: string) => void
}) {
  return (
    <>
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <span className="text-sm font-medium text-gray-900">验证码</span>
        <span className="text-xs text-gray-400">{entries.length} 条</span>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {entries.map((e) => {
          const copied = copiedCode === e.code
          return (
            <div
              key={e.message.index}
              className="flex items-center justify-between gap-3 rounded-xl bg-gray-50 px-3 py-2"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-xs text-gray-500">{e.sender}</span>
                <span className="font-mono text-lg font-semibold tracking-wider text-gray-900">
                  {e.code}
                </span>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span className="text-[10px] text-gray-400">
                  {formatSmsTime(e.message.timestamp)}
                </span>
                <button
                  type="button"
                  onClick={() => onCopy(e.code)}
                  aria-label={`复制验证码 ${e.code}`}
                  className={`flex items-center gap-1 text-xs transition-colors ${
                    copied ? 'text-green-600' : 'text-gray-400 hover:text-gray-600'
                  }`}
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? '已复制' : '复制'}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="text-center">
        <MessageSquare className="mx-auto size-10 text-gray-300" />
        <p className="mt-2 text-sm text-gray-400">选择会话以查看详情</p>
      </div>
    </div>
  )
}

/** 左侧会话列表的空/加载/失败占位：居中显示图标 + 文案（可选点击重试）。 */
function ListHint({
  icon,
  text,
  onClick,
}: {
  icon: ReactNode
  text: string
  onClick?: () => void
}) {
  const content = (
    <>
      {icon}
      <p className="mt-2 text-sm text-gray-400">{text}</p>
    </>
  )
  const classes =
    'flex min-h-full w-full flex-col items-center justify-center p-4 text-center'
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={`${classes} transition-opacity hover:opacity-70`}
    >
      {content}
    </button>
  ) : (
    <div className={classes}>{content}</div>
  )
}

function MessageBubble({ message }: { message: SmsMessage }) {
  const incoming = message.direction === 'incoming'
  return (
    <div className={`flex ${incoming ? 'justify-start' : 'justify-end'}`}>
      <div
        className={`max-w-[75%] rounded-2xl px-3 text-sm ${
          incoming
            ? 'rounded-bl-none pt-2 pb-1 bg-gray-100 text-gray-900'
            : 'py-2 bg-brand text-white'
        }`}
      >
        <p className="whitespace-pre-wrap break-words">{message.text}</p>
        <p
          className={`text-right text-[10px] ${
            incoming ? 'text-gray-400' : 'text-white/70'
          }`}
        >
          {formatSmsTime(message.timestamp)}
        </p>
      </div>
    </div>
  )
}

function Thread({ conversation }: { conversation: Conversation }) {
  return (
    <>
      <div className="border-b border-gray-100 px-4 py-3">
        <span className="text-sm font-medium text-gray-900">
          {conversation.address}
        </span>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {conversation.messages.map((m) => (
          <MessageBubble key={m.index} message={m} />
        ))}
      </div>
    </>
  )
}
