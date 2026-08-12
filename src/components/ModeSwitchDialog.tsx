import { useEffect, useRef, useState } from 'react'
import type { UsbnetMode, SetUsbnetModeResult } from '../types'
import type { ModuleService } from '../services/ModuleService'
import { mapErrorMessage } from '../utils/mapErrorMessage'
import { isUserCancellation } from '../utils/isUserCancellation'

interface Props {
  device: USBDevice
  target: UsbnetMode
  moduleService: ModuleService
  onSuccess: (result: SetUsbnetModeResult) => void
  onClose: () => void
  /** 发起手动重连；成功返回选中的设备，用户取消/失败则抛错。 */
  onReconnect: () => Promise<USBDevice>
}

type Phase = 'running' | 'success' | 'error'
type Step = 'sending' | 'waiting-reboot' | 'reconnecting'
type ErrorSource = 'switch' | 'reconnect'

// 圆形进度条不显示明确进度，只有阶段文案。
const stepMeta: Record<Step, string> = {
  sending: '正在发送 AT 指令',
  'waiting-reboot': '正在等待模块重启',
  reconnecting: '等待设备重启',
}

export function ModeSwitchDialog({
  device,
  target,
  moduleService,
  onSuccess,
  onClose,
  onReconnect,
}: Props) {
  const [phase, setPhase] = useState<Phase>('running')
  const [step, setStep] = useState<Step>('sending')
  const [error, setError] = useState('')
  const [diagnostics, setDiagnostics] = useState('')
  const [errorSource, setErrorSource] = useState<ErrorSource>('switch')
  // 切换只应执行一次：对话框存活期间 device 等 prop 一旦变化
  // （如手动重连成功刷新了设备对象），effect 会重跑并再次下发
  // AT+CFUN=1,1，导致模块反复重启。用 ref 挡住重复触发。
  const switchStartedRef = useRef(false)

  useEffect(() => {
    if (switchStartedRef.current) return
    switchStartedRef.current = true
    let cancelled = false
    moduleService
      .setUsbnetMode(device, target, (s) => {
        if (!cancelled) setStep(s)
      })
      .then((result) => {
        if (cancelled) return
        if (result.reconnected && result.device) {
          // 自动重连成功：父组件收到后刷新设备并卸载本对话框。
          onSuccess(result)
        } else {
          // 切换本身已成功，但浏览器无法自动重连（模块无 USB 序列号），
          // 显示成功提示并引导手动重新连接。
          setPhase('success')
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        const d = (err as { diagnostics?: unknown } | null)?.diagnostics
        setDiagnostics(typeof d === 'string' ? d : '')
        setErrorSource('switch')
        setPhase('error')
      })
    return () => {
      cancelled = true
    }
  }, [device, target, moduleService, onSuccess])

  // 手动重新连接：期间不切换界面，对话框保持「切换成功」显示，
  // 直到用户真正选中设备并连接成功才卸载（浏览器弹出的选择框本身
  // 就是等待中的反馈）。requestDevice 要求瞬时用户激活，onReconnect
  // 内部在点击事件里同步调用，因此这里直接 await 即可；用户取消则
  // 停留在成功界面可再次点击。
  const handleReconnect = async () => {
    try {
      const freshDevice = await onReconnect()
      // 连接成功：交给父组件刷新设备并卸载本对话框。
      onSuccess({ reconnected: true, device: freshDevice })
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

  const modeName = target === 'qmi' ? 'QMI' : 'ECM'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-6">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        {phase === 'running' && (
          <div className="flex flex-col items-center py-4 text-center">
            <div className="mb-4 h-16 w-16 animate-spin rounded-full border-4 border-gray-200 border-t-brand" />
            <h2 className="text-lg font-semibold text-gray-900 mb-1">
              正在切换至 {modeName} 模式
            </h2>
            <p className="text-sm text-gray-600 opacity-50">{stepMeta[step]}</p>
          </div>
        )}

        {phase === 'success' && (
          <>
            <h2 className="text-lg font-semibold text-gray-900 mb-2">切换成功</h2>
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
          </>
        )}

        {phase === 'error' && (
          <>
            <h2 className="text-lg font-semibold text-gray-900 mb-2">
              {errorSource === 'reconnect' ? '重新连接失败' : '切换失败'}
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
          </>
        )}
      </div>
    </div>
  )
}
