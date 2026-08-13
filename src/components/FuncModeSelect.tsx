import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import type { FuncMode } from '../types'

interface Props {
  value: FuncMode
  onSelect: (mode: FuncMode) => void
}

const MODES: { value: FuncMode; label: string; description: string }[] = [
  { value: 1, label: '全功能模式', description: '开启射频' },
  { value: 4, label: '飞行模式', description: '关闭射频' },
  { value: 0, label: '最小功能模式', description: '关闭射频与 SIM' },
]

/**
 * 功能模式下拉（Tailwind Plus 风格，非原生 select）。
 * 结构对齐 ModeSelect：触发器按钮 + 浮动菜单，选项含名称与简要说明，
 * 选中项带勾选图标；
 * 支持外部点击/Esc 关闭、↑↓ 导航、Enter/Space 选中、
 * 视口底部空间不足时向上弹出。
 */
export function FuncModeSelect({ value, onSelect }: Props) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [direction, setDirection] = useState<'down' | 'up'>('down')
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const selectedIndex = MODES.findIndex((m) => m.value === value)
  const wasOpenRef = useRef(false)

  const select = (mode: FuncMode) => {
    setOpen(false)
    onSelect(mode)
  }

  // 打开时聚焦当前选中项（没有则聚焦第一项）；从打开转关闭时把焦点还给触发器。
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

  // 打开时按下方剩余空间决定向上/向下弹出，避免菜单被视口底部遮挡。
  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    const menu = menuRef.current
    if (!trigger || !menu) return
    const triggerRect = trigger.getBoundingClientRect()
    const menuHeight = menu.getBoundingClientRect().height
    const spaceBelow = window.innerHeight - triggerRect.bottom
    const spaceAbove = triggerRect.top
    const margin = 8
    setDirection(
      spaceBelow < menuHeight + margin && spaceAbove > spaceBelow ? 'up' : 'down',
    )
  }, [open])

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
        <ChevronDown
          className={`size-4 shrink-0 text-gray-400 transition-transform ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          className={`absolute right-0 z-10 w-64 rounded-xl bg-white p-1.5 shadow-lg ring-1 ring-black/5 ${
            direction === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
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
                  <span className="block text-xs text-gray-500">{m.description}</span>
                </span>
                {isSelected && <Check className="size-4 shrink-0 text-brand" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
