import type { CallRecord } from '../types'

// 本地通话记录兜底：模块 CPBS/CPBR 查询不可靠（Quectel 固件上可能 CME ERROR），
// 因此把本应用发起的拨出记录落在 localStorage，模块查询失败时作为展示回退。

const KEY = 'cellularswitch:callHistory'

/** 本地记录的时间戳（模块记录时间戳字段可能为空）。 */
export function nowStamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 读取本地通话记录（时间降序）。localStorage 不可用时返回空数组。 */
export function loadLocalCallHistory(): CallRecord[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as CallRecord[]) : []
  } catch {
    return []
  }
}

/** 追加一条拨出记录到本地（最新在前，保留最近 100 条）。失败静默忽略。 */
export function saveLocalCall(call: CallRecord): void {
  try {
    const list = loadLocalCallHistory().filter(
      (c) => !(c.number === call.number && c.type === call.type),
    )
    list.unshift(call)
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 100)))
  } catch {
    // localStorage 不可用（隐私模式等）时静默失败，通话仍可正常进行。
  }
}

/** 按 id 删除一条本地通话记录。失败静默忽略。 */
export function deleteLocalCall(id: number): void {
  try {
    const list = loadLocalCallHistory().filter((c) => c.id !== id)
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    // localStorage 不可用时静默失败。
  }
}
