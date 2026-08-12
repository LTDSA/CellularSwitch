interface Props {
  onConfirm: () => void
  onCancel: () => void
}

export function DisclaimerDialog({ onConfirm, onCancel }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-6">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">免责声明</h2>
        <p className="text-sm text-gray-600 mb-6 leading-relaxed">
          修改 USB 设备标识可能会导致模块保修失效、工作异常或无法被官方软件识别。
          本工具按「原样」提供，作者不对任何设备损坏、数据丢失或其他后果承担责任。
          请确认您已了解相关风险并自愿继续。
        </p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-gray-600 hover:bg-gray-100 transition-colors"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded-lg bg-brand text-white hover:bg-blue-600 transition-colors"
          >
            确认
          </button>
        </div>
      </div>
    </div>
  )
}
