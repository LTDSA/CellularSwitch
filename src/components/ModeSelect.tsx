import { useEffect, useRef, useState } from 'react'
import type { UsbnetMode } from '../types'
import { ChevronDownIcon, SmallCheckIcon } from './icons'

interface Props {
  value: UsbnetMode
  onSelect: (mode: UsbnetMode) => void
}

const MODES: { value: UsbnetMode; label: string; description: string }[] = [
  { value: 'qmi', label: 'QMI 模式', description: '供 VoHive 平台使用' },
  { value: 'ecm', label: 'ECM 模式', description: '作为 4G 上网卡供 Mac 使用' },
]

/**
 * 工作模式下拉（Tailwind Plus 风格，非原生 select）。
 * 触发器按钮 + 浮动菜单；选项含名称与一行说明；选中项带勾选图标。
 * 支持：点击外部/Esc 关闭、↑↓ 键导航、Enter/Space 选中。
 */
export function ModeSelect({ value, onSelect }: Props) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const selectedIndex = MODES.findIndex((m) => m.value === value)
  const wasOpenRef = useRef(false)

  const select = (mode: UsbnetMode) => {
    setOpen(false)
    onSelect(mode)
  }

  // 打开时聚焦当前选中项（没有则聚焦第一项）；从打开转关闭时把焦点还给触发器（挂载时不做，避免抢焦点）。
  useEffect(() => {
    if (open) {
      const focusIndex = selectedIndex >= 0 ? selectedIndex : 0
      setActiveIndex(focusIndex)
      itemRefs.current[focusIndex]?.focus()
    } else if (wasOpenRef.current) {
      triggerRef.current?.focus()
    }
    wasOpenRef.current = open
  }, [open, selectedIndex])

  // 点击外部或 Esc 关闭菜单。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActiveIndex((i) => {
          const next = (i + 1) % MODES.length
          itemRefs.current[next]?.focus()
          return next
        })
        break
      case 'ArrowUp':
        e.preventDefault()
        setActiveIndex((i) => {
          const next = (i - 1 + MODES.length) % MODES.length
          itemRefs.current[next]?.focus()
          return next
        })
        break
      case 'Enter':
      case ' ':
        // 阻止默认按钮激活，避免与菜单内焦点项的 onClick 重复触发。
        e.preventDefault()
        select(MODES[activeIndex].value)
        break
    }
  }

  const selected = MODES[selectedIndex]

  return (
    <div ref={rootRef} className="relative" onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-sm text-gray-900 ring-1 ring-inset ring-gray-200 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-brand/30"
      >
        <span className="min-w-0">{selected?.label}</span>
        <ChevronDownIcon
          className={`size-4 shrink-0 text-gray-400 transition-transform ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-10 mt-1 w-64 rounded-xl bg-white p-1.5 shadow-lg ring-1 ring-black/5"
        >
          {MODES.map((m, i) => {
            const isSelected = m.value === value
            return (
              <button
                key={m.value}
                ref={(el) => {
                  itemRefs.current[i] = el
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => select(m.value)}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition-colors ${
                  i === activeIndex ? 'bg-gray-50' : ''
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-gray-900">
                    {m.label}
                  </span>
                  <span className="block truncate text-xs text-gray-500">
                    {m.description}
                  </span>
                </span>
                {isSelected && (
                  <SmallCheckIcon className="size-4 shrink-0 text-brand" />
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
