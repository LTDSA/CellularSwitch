import { useCallback, useEffect, useState } from 'react'
import type { AppState } from './types'
import { UsbService } from './services/UsbService'
import { ModuleService } from './services/ModuleService'
import { IdleScreen } from './components/IdleScreen'
import { SettingsCard } from './components/SettingsCard'
import { ProcessingScreen } from './components/ProcessingScreen'
import { ResultScreen } from './components/ResultScreen'
import { DisclaimerDialog } from './components/DisclaimerDialog'
import { UnsupportedIllustration } from './components/icons'
import { mapErrorMessage } from './utils/mapErrorMessage'
import { isUserCancellation } from './utils/isUserCancellation'

const usbService = new UsbService()
const moduleService = new ModuleService(usbService)

function App() {
  const [state, setState] = useState<AppState>(
    UsbService.isSupported() ? { type: 'idle' } : { type: 'unsupported' },
  )
  const [pendingOperation, setPendingOperation] = useState<'modify' | 'restore' | null>(null)

  // 页面卸载（刷新 / 关闭 / 导航离开）时主动关闭 USB 会话。设备处于异常
  // 状态（如 Windows 下接口挂起）时，浏览器自动清理残留的 pending 传输 /
  // 接口声明可能触发崩溃；卸载前主动 close() 尽力终止这些请求。
  useEffect(() => {
    const handlePageHide = () => {
      usbService.close()
    }
    window.addEventListener('pagehide', handlePageHide)
    return () => window.removeEventListener('pagehide', handlePageHide)
  }, [])

  // 打开设备选择框并识别设备；用户取消或未识别时抛错，由调用方决定 UI。
  // 供初始连接与「重新连接」复用：只负责拿到设备，不直接改 App 状态。
  const connectDevice = useCallback(async (): Promise<USBDevice> => {
    const device = await usbService.requestDevice()
    const mode = moduleService.detectState(device)
    if (mode === 'unknown') throw new Error('未识别到支持的 4G 模块')
    return device
  }, [])

  const handleConnect = useCallback(async () => {
    try {
      const device = await connectDevice()
      const mode = moduleService.detectState(device)
      if (mode === 'original') {
        setState({ type: 'connected-original', device })
      } else {
        setState({ type: 'connected-modified', device })
      }
    } catch (err) {
      if (isUserCancellation(err)) {
        // 用户关闭了设备选择框：保持未连接时的初始状态。
        setState({ type: 'idle' })
      } else {
        const message = err instanceof Error ? err.message : String(err)
        const diagnostics = (err as { diagnostics?: string })?.diagnostics
        setState({
          type: 'error',
          message: `连接失败：${mapErrorMessage(message)}`,
          recoverable: true,
          diagnostics,
        })
      }
    }
  }, [connectDevice])

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

  const handleDeviceRefreshed = useCallback((freshDevice: USBDevice) => {
    // 重连/重枚举后按新设备实际 VID/PID 判定身份，保留原始/标准状态，
    // 避免原始标识模块在工作模式切换、USB 功能应用后错误地变成「已修改」。
    const mode = moduleService.detectState(freshDevice)
    setState(
      mode === 'original'
        ? { type: 'connected-original', device: freshDevice }
        : { type: 'connected-modified', device: freshDevice },
    )
  }, [])

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

      {(state.type === 'connected-original' || state.type === 'connected-modified') && (
        <SettingsCard
          device={state.device}
          isOriginal={state.type === 'connected-original'}
          moduleService={moduleService}
          onRequestIdentityChange={(op) => handleAction(op)}
          onDeviceRefreshed={handleDeviceRefreshed}
          onReconnect={connectDevice}
        />
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

      <DisclaimerDialog
        open={pendingOperation !== null}
        onConfirm={handleConfirm}
        onCancel={() => setPendingOperation(null)}
      />
    </div>
  )
}

export default App
