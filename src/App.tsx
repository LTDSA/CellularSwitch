import { useCallback, useEffect, useState } from 'react'
import type { AppState } from './types'
import { UsbService } from './services/UsbService'
import { ModuleService } from './services/ModuleService'
import { IdleScreen } from './components/IdleScreen'
import { ConnectedScreen } from './components/ConnectedScreen'
import { ProcessingScreen } from './components/ProcessingScreen'
import { ResultScreen } from './components/ResultScreen'
import { DisclaimerDialog } from './components/DisclaimerDialog'
import { UnsupportedIllustration } from './components/icons'

const usbService = new UsbService()
const moduleService = new ModuleService(usbService)

function mapErrorMessage(raw: string): string {
  if (/timeout|Timed out/.test(raw)) return '读取设备响应超时，请重新插拔模块后重试'
  if (/未能定位|No suitable/.test(raw)) return '未能定位 AT 命令接口，请确认模块已正确插入后重试'
  if (/reconnect/.test(raw)) return '模块未在预期时间内恢复，请重新插拔后检查状态'
  if (/rejected|ERROR/.test(raw)) return '模块拒绝执行指令，请确认模块型号后重试'
  if (/transfer|failed/.test(raw)) return 'USB 通信失败，请重新插拔模块后重试'
  return raw
}

function App() {
  const [state, setState] = useState<AppState>(
    UsbService.isSupported() ? { type: 'idle' } : { type: 'unsupported' },
  )
  const [pendingOperation, setPendingOperation] = useState<'modify' | 'restore' | null>(null)

  const handleConnect = useCallback(async () => {
    try {
      const device = await usbService.requestDevice()
      const mode = moduleService.detectState(device)
      if (mode === 'original') {
        setState({ type: 'connected-original', device })
      } else if (mode === 'modified') {
        setState({ type: 'connected-modified', device })
      } else {
        setState({ type: 'error', message: '未识别到支持的 4G 模块', recoverable: true })
      }
    } catch (err) {
      const isCancel =
        (err instanceof DOMException && err.name === 'NotFoundError') ||
        (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'NotFoundError')
      const message = err instanceof Error ? err.message : String(err)
      if (isCancel || message.includes('cancel') || message.includes('NotFound')) {
        // 用户关闭了设备选择框：保持未连接时的初始状态。
        setState({ type: 'idle' })
      } else {
        const diagnostics = (err as { diagnostics?: string })?.diagnostics
        setState({
          type: 'error',
          message: `连接失败：${mapErrorMessage(message)}`,
          recoverable: true,
          diagnostics,
        })
      }
    }
  }, [])

  const handleAction = useCallback((operation: 'modify' | 'restore') => {
    setPendingOperation(operation)
  }, [])

  const handleConfirm = useCallback(async () => {
    if (!pendingOperation) return
    const operation = pendingOperation
    setPendingOperation(null)

    const device =
      state.type === 'connected-original' || state.type === 'connected-modified'
        ? state.device
        : null
    if (!device) return

    setState({ type: 'processing', operation, step: 'sending' })

    try {
      setState({ type: 'processing', operation, step: 'sending' })
      await moduleService.applyConfig(
        device,
        operation === 'modify' ? 'modified' : 'original',
      )
      setState({ type: 'success', operation })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const diagnostics = (err as { diagnostics?: string })?.diagnostics
      setState({
        type: 'error',
        message: mapErrorMessage(message),
        recoverable: true,
        diagnostics,
      })
    }
  }, [pendingOperation, state])

  useEffect(() => {
    if (state.type !== 'processing') return
    if (state.step === 'sending') {
      const timer = setTimeout(() => {
        setState({ ...state, step: 'waiting-reboot' })
      }, 800)
      return () => clearTimeout(timer)
    }
    if (state.step === 'waiting-reboot') {
      const timer = setTimeout(() => {
        setState({ ...state, step: 'verifying' })
      }, 2500)
      return () => clearTimeout(timer)
    }
  }, [state])

  const reset = useCallback(() => {
    setPendingOperation(null)
    setState({ type: 'idle' })
  }, [])

  if (state.type === 'unsupported') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-6">
        <UnsupportedIllustration className="w-64 h-48 mb-8" />
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">浏览器不支持 WebUSB</h1>
        <p className="text-gray-600 opacity-50 max-w-xs text-center">
          请使用桌面版 Chrome 或 Edge 访问本页面
        </p>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6">
      {state.type === 'idle' && <IdleScreen onConnect={handleConnect} />}

      {state.type === 'connected-original' && (
        <ConnectedScreen mode="original" onAction={() => handleAction('modify')} />
      )}

      {state.type === 'connected-modified' && (
        <ConnectedScreen mode="modified" onAction={() => handleAction('restore')} />
      )}

      {state.type === 'processing' && (
        <ProcessingScreen operation={state.operation} step={state.step} />
      )}

      {state.type === 'success' && (
        <ResultScreen
          success
          operation={state.operation}
          message={
            state.operation === 'modify'
              ? '模块已切换为标准 Quectel 设备标识，可点「重新连接」确认新状态'
              : '模块已恢复为原始设备标识，可点「重新连接」确认新状态'
          }
          onReset={reset}
        />
      )}

      {state.type === 'error' && (
        <ResultScreen
          success={false}
          operation={pendingOperation ?? 'modify'}
          message={state.message}
          onReset={reset}
          diagnostics={state.diagnostics}
        />
      )}

      {pendingOperation && (
        <DisclaimerDialog
          onConfirm={handleConfirm}
          onCancel={() => setPendingOperation(null)}
        />
      )}
    </div>
  )
}

export default App
