/**
 * 从短信正文中抽取验证码（一次性数字码）。
 *
 * 参考系统级「验证码自动填充」的识别约定（iOS oneTimeCode 与 Android SMS Retriever
 * 均依赖「关键词 + 4–8 位纯数字」），先匹配关键词，再就近抽取数字码，避免把
 * 电话号码、订单号、时间戳等误判为验证码：
 * 1. 命中关键词后，优先取关键词之后的第一个 4–8 位数字串；
 * 2. 若关键词之后没有，则取关键词之前最靠近它的一个数字串。
 *
 * 数字串用「前后都不是数字」的边界约束，保证整串长度恰为 4–8 位——
 * 这样 11 位手机号、连续的长数字串不会被截成「验证码」。未命中关键词返回 null。
 */

/** 前后均非数字的 4–8 位数字串（带全局标志，可一次取全所有匹配）。 */
const OTP_DIGITS_GLOBAL = /(?<!\d)\d{4,8}(?!\d)/g

/** 验证码关键词：中文常见叫法 + 英文常用叫法（code / OTP / passcode 等）。 */
const KEYWORD =
  /验证码|校验码|动态码|确认码|安全码|验证\s*code|verification\s*code|one[\s-]?time\s*(?:code|password)|passcode|\botp\b|\bcode\b/i

function digitRuns(s: string): string[] {
  return s.match(OTP_DIGITS_GLOBAL) ?? []
}

export function extractOtp(text: string): string | null {
  if (!text) return null
  const m = text.match(KEYWORD)
  if (!m) return null

  const idx = m.index ?? 0
  const afterRuns = digitRuns(text.slice(idx + m[0].length))
  if (afterRuns.length > 0) return afterRuns[0]

  const beforeRuns = digitRuns(text.slice(0, idx))
  return beforeRuns.length > 0 ? beforeRuns[beforeRuns.length - 1] : null
}
