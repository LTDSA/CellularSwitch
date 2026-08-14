import { useEffect, useState, type ReactNode } from 'react'

interface DialogProps {
  open: boolean
  /** 卡片额外类名（宽度/圆角/背景/内边距等），叠加在过渡类之后。 */
  cardClassName?: string
  children: ReactNode
}

const DURATION_MS = 100
const EXIT_DELAY_MS = DURATION_MS + 50

/**
 * 通用对话框容器：半透明遮罩 + 居中卡片，带 0.1s 弹出/关闭过渡。
 *
 * 通过 `open` 控制显隐；关闭时会先播放退场动画再卸载，因此父组件需
 * 保持本组件挂载（不要用 `&&` 条件渲染，改用 `open` 属性），否则退场
 * 动画会被立即卸载吞掉。
 */
export function Dialog({ open, cardClassName = '', children }: DialogProps) {
  const [mounted, setMounted] = useState(open)
  const [visible, setVisible] = useState(false)

  // 打开：先挂载到 DOM（此时 visible 仍为 false，显示初始态）；
  // 关闭：先播退场动画，再卸载。
  useEffect(() => {
    if (open) {
      setMounted(true)
    } else {
      setVisible(false)
      const timer = setTimeout(() => setMounted(false), EXIT_DELAY_MS)
      return () => clearTimeout(timer)
    }
  }, [open])

  // 挂载后再延迟到下一帧置为可见。若在 setMounted 的同帧内直接切 visible，
  // 浏览器来不及绘制初始态（opacity-0 / scale-95），CSS 过渡会被跳过，
  // 表现为「直接出现」。双 rAF 保证中间至少绘制一帧初始态后再过渡。
  useEffect(() => {
    if (!open || !mounted) return
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setVisible(true))
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [open, mounted])

  if (!mounted) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-6">
      <div
        aria-hidden="true"
        className={`absolute inset-0 bg-black/40 transition-opacity duration-100 ${
          visible ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <div
        className={`relative w-full ${cardClassName} transition-[opacity,transform] duration-100 ease-out ${
          visible ? 'scale-100 opacity-100' : 'scale-95 opacity-0'
        }`}
      >
        {children}
      </div>
    </div>
  )
}
