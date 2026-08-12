import { ModuleComputerIllustration } from './icons'

interface Props {
  onConnect: () => void
}

export function IdleScreen({ onConnect }: Props) {
  return (
    <div className="flex flex-col items-center text-center px-6">
      <ModuleComputerIllustration className="w-64 h-48 mb-8" />
      <h1 className="text-2xl font-semibold text-gray-900 mb-2">
        将 4G 模块插入电脑
      </h1>
      <p className="text-gray-600 opacity-50 mb-8 max-w-xs">
        通过 USB 修改或恢复模块的设备标识
      </p>
      <button
        onClick={onConnect}
        className="px-8 py-3 rounded-xl bg-brand text-white font-medium hover:bg-blue-600 transition-colors"
      >
        连接
      </button>
    </div>
  )
}
