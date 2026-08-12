import { ModuleComputerIllustration } from './icons'

interface Props {
  onAction: () => void
}

export function ConnectedScreen({ onAction }: Props) {
  return (
    <div className="flex flex-col items-center text-center px-6">
      <ModuleComputerIllustration className="w-64 h-48 mb-8" />
      <h1 className="text-2xl font-semibold text-gray-900 mb-2">检测到原始 4G 模块</h1>
      <p className="text-gray-600 opacity-50 mb-8 max-w-xs">
        模块当前为原始设备标识，点击下方按钮切换为标准 Quectel 标识
      </p>
      <button
        onClick={onAction}
        className="px-8 py-3 rounded-xl bg-brand text-white font-medium hover:bg-blue-600 transition-colors"
      >
        修改
      </button>
    </div>
  )
}
