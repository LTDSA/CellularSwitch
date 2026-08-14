/**
 * 从短信正文中提取发送方名称。
 *
 * 验证码短信通常在开头用方括号标注发送方，如「【哔哩哔哩】」「[Google]」。
 * 这里匹配正文开头（允许前导空白）的第一处 `【…】` 或 `[…]`，返回括号内的名称。
 * 未命中时返回 null，调用方据此回退到号码显示。
 */
export function extractSender(text: string): string | null {
  if (!text) return null
  const m = text.match(/^\s*[【[]([^【】[\]]{1,32})[】\]]/)
  return m ? m[1].trim() : null
}
