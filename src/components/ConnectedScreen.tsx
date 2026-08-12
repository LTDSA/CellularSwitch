import { ModuleComputerIllustration } from './icons'

interface Props {
  mode: 'original' | 'modified'
  onAction: () => void
}

export function ConnectedScreen({ mode, onAction }: Props) {
  const isOriginal = mode === 'original'
  return (
    <div className="flex flex-col items-center text-center px-6">
      <ModuleComputerIllustration className="w-64 h-48 mb-8" />
      <h1 className="text-2xl font-semibold text-gray-900 mb-2">
        {isOriginal ? '检测到原始 4G 模块' : '检测到已修改模块'}
      </h1>
      <p className="text-gray-600 opacity-50 mb-8 max-w-xs">
        {isOriginal
          ? '模块当前为原始设备标识，点击下方按钮切换为标准 Quectel 标识'
          : '模块当前已为标准 Quectel 设备标识，点击下方按钮恢复为原始标识'}
      </p>
      <button
        onClick={onAction}
        className="px-8 py-3 rounded-xl bg-brand text-white font-medium hover:bg-blue-600 transition-colors"
      >
        {isOriginal ? '修改' : '恢复'}
      </button>
    </div>
  )
}
