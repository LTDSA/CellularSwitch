import { ProgressRing } from './icons'
import type { ProcessingStep } from '../types'

interface Props {
  operation: 'modify' | 'restore'
  step: ProcessingStep
}

const stepText: Record<ProcessingStep, string> = {
  sending: '正在发送 AT 指令',
  'waiting-reboot': '正在等待模块重启',
  verifying: '正在验证新的设备标识',
}

export function ProcessingScreen({ operation, step }: Props) {
  return (
    <div className="flex flex-col items-center text-center px-6">
      <ProgressRing className="w-32 h-32 mb-8" />
      <h1 className="text-2xl font-semibold text-gray-900 mb-2">
        {operation === 'modify' ? '正在修改设备标识' : '正在恢复设备标识'}
      </h1>
      <p className="text-gray-600 opacity-50">{stepText[step]}</p>
    </div>
  )
}
