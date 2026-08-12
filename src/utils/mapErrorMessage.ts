export function mapErrorMessage(raw: string): string {
  if (/timeout|Timed out/.test(raw)) return '读取设备响应超时，请重新插拔模块后重试'
  if (/未能定位|No suitable/.test(raw)) return '未能定位 AT 命令接口，请确认模块已正确插入后重试'
  if (/reconnect/.test(raw)) return '模块未在预期时间内恢复，请重新插拔后检查状态'
  if (/rejected|ERROR/.test(raw)) return '模块拒绝执行指令，请确认模块型号后重试'
  if (/transfer|failed/.test(raw)) return 'USB 通信失败，请重新插拔模块后重试'
  return raw
}
