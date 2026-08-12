/**
 * 判断是否为用户主动关闭设备选择框。
 * WebUSB 在用户取消选择时抛 NotFoundError；部分浏览器/旧实现可能只带
 * message 关键词，这里一并兜底。
 */
export function isUserCancellation(err: unknown): boolean {
  const isDom = err instanceof DOMException && err.name === 'NotFoundError'
  const name =
    err !== null && typeof err === 'object'
      ? (err as { name?: unknown }).name
      : undefined
  const msg = err instanceof Error ? err.message : String(err)
  return isDom || name === 'NotFoundError' || msg.includes('cancel') || msg.includes('NotFound')
}
