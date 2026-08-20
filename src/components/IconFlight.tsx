import { useLayoutEffect, useRef, useState } from 'react'
import { ModuleComputerIllustration } from './icons'

interface Props {
  /** 连接前 IdleScreen 图标的旧位置（getBoundingClientRect）。 */
  from: DOMRect
  /** 飞行结束（图标已到 SettingsCard 顶部位置）后回调，用于清除浮层。 */
  onDone: () => void
}

const DURATION_MS = 450
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

/**
 * 连接成功后的图标飞行动画（FLIP）：一个 position:fixed 的 SVG 从旧位置（IdleScreen）
 * 平滑位移+缩放到新位置（SettingsCard 顶部），飞完触发 onDone。
 * 挂载时先按旧 rect 定位，下一帧测新位置并 transition 过去，实现跨屏连续过渡。
 */
export function IconFlight({ from, onDone }: Props) {
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const doneTimer = useRef<number | null>(null)

  useLayoutEffect(() => {
    // 测 SettingsCard 图标（当前屏里唯一的 data-module-icon）的新位置。
    const el = document.querySelector<HTMLElement>('[data-module-icon]')
    if (!el) {
      onDone()
      return
    }
    const r = el.getBoundingClientRect()
    setRect({ x: r.left, y: r.top, w: r.width, h: r.height })
    // 飞行结束（transition 时长 + 余量）后清除浮层。
    doneTimer.current = window.setTimeout(onDone, DURATION_MS + 30)
    return () => {
      if (doneTimer.current !== null) window.clearTimeout(doneTimer.current)
    }
  }, [onDone])

  // 目标 rect 未测出前，先停在旧位置（与 IdleScreen 图标完全重合）。
  const target = rect ?? { x: from.left, y: from.top, w: from.width, h: from.height }
  const flying = rect !== null

  const scaleX = target.w / from.width
  const scaleY = target.h / from.height

  return (
    <div
      className="pointer-events-none fixed inset-0 z-50"
      style={{ top: 0, left: 0 }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: from.width,
          height: from.height,
          transformOrigin: 'top left',
          transition: flying
            ? `transform ${DURATION_MS}ms ${EASE}, opacity ${DURATION_MS}ms ease`
            : 'none',
          transform: `translate(${target.x}px, ${target.y}px) scale(${scaleX}, ${scaleY})`,
          opacity: flying ? 1 : 0.999,
        }}
      >
        <ModuleComputerIllustration className="w-full h-full" />
      </div>
    </div>
  )
}