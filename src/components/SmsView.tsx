import { useCallback, useEffect, useMemo, useState } from 'react'
import { MessageSquare } from 'lucide-react'
import type { SmsMessage } from '../types'
import type { ModuleService } from '../services/ModuleService'
import { SMS_REFRESH_MS } from '../constants'

interface Props {
  device: USBDevice
  moduleService: ModuleService
}

interface Conversation {
  address: string
  messages: SmsMessage[]
  latest: SmsMessage
}

/** 模块时间戳格式 yy/MM/dd,HH:mm:ss±zz → 简洁的 MM/dd HH:mm。 */
function formatSmsTime(raw: string): string {
  const m = raw.match(/(\d{2})\/(\d{2})\/(\d{2}),(\d{2}):(\d{2})/)
  if (!m) return raw
  return `${m[2]}/${m[3]} ${m[4]}:${m[5]}`
}

/**
 * 短信视图：左会话列表、右对话详情（仿 iPad 左右分栏）。仅接收，不支持发送。
 * 仅在「短信」选项卡挂载时运行轮询；卸载即停止（概览 tab 的遥测轮询不共存）。
 */
export function SmsView({ device, moduleService }: Props) {
  const [messages, setMessages] = useState<SmsMessage[]>([])
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null)

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

  const selected = conversations.find((c) => c.address === selectedAddress)

  return (
    <div className="flex h-[28rem]">
      {/* 左：会话列表 */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-gray-100">
        <div className="flex-1 overflow-y-auto">
          {loadState === 'loading' && (
            <p className="p-4 text-sm text-gray-400">读取中…</p>
          )}
          {loadState === 'error' && (
            <button
              onClick={() => load()}
              className="p-4 text-sm text-gray-400 hover:text-gray-600"
            >
              读取失败 · 重试
            </button>
          )}
          {loadState === 'ready' && conversations.length === 0 && (
            <p className="p-4 text-sm text-gray-400">暂无短信</p>
          )}
          {loadState === 'ready' && (
            <ul className="divide-y divide-gray-100">
              {conversations.map((c) => {
                const active = c.address === selectedAddress
                return (
                  <li key={c.address}>
                    <button
                      type="button"
                      onClick={() => setSelectedAddress(c.address)}
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

      {/* 右：对话详情 / 空白 */}
      <section className="flex flex-1 flex-col">
        {selected ? <Thread conversation={selected} /> : <EmptyState />}
      </section>
    </div>
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
