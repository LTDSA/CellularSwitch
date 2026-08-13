import { CircleCheck, CircleAlert } from 'lucide-react'

interface Props {
  success: boolean
  operation: 'modify' | 'restore'
  message: string
  onReset: () => void
  diagnostics?: string
}

export function ResultScreen({
  success,
  operation,
  message,
  onReset,
  diagnostics,
}: Props) {
  const title = success
    ? operation === 'modify'
      ? '修改成功'
      : '恢复成功'
    : '操作失败'

  return (
    <div className="flex flex-col items-center text-center px-6">
      {success ? (
        <CircleCheck className="w-32 h-32 mb-8 text-green-500 fill-green-100" />
      ) : (
        <CircleAlert className="w-32 h-32 mb-8 text-orange-500 fill-orange-100" />
      )}
      <h1 className="text-2xl font-semibold text-gray-900 mb-2">{title}</h1>
      <p className="text-gray-600 opacity-50 mb-8 max-w-xs">{message}</p>
      {diagnostics && (
        <details className="mb-8 w-full max-w-md text-left">
          <summary className="cursor-pointer select-none text-xs text-gray-400 hover:text-gray-600">
            诊断信息（点击展开）
          </summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg bg-gray-100 p-3 text-[10px] leading-tight text-gray-700">
            {diagnostics}
          </pre>
        </details>
      )}
      <button
        onClick={onReset}
        className="px-8 py-3 rounded-xl bg-brand text-white font-medium hover:bg-blue-600 transition-colors"
      >
        重新连接
      </button>
    </div>
  )
}
