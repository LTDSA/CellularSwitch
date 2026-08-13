/**
 * UCS2 十六进制编解码，用于短信（AT+CSCS="UCS2"）的号码与正文。
 *
 * 按 UTF-16 码元（charCodeAt）而非码点处理：BMP 字符（中文/ASCII）各占一个
 * 码元（4 位十六进制）；扩展平面字符（如 emoji）拆成代理对的两个码元，
 * 与 UCS2 的 16-bit 单位语义一致。
 */

/** 将字符串编码为 UCS2 十六进制（每个 UTF-16 码元 4 位十六进制，大写）。 */
export function encodeUcs2Hex(str: string): string {
  let out = ''
  for (let i = 0; i < str.length; i++) {
    out += str.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase()
  }
  return out
}

/** 将 UCS2 十六进制解码为字符串（每 4 位十六进制一个 UTF-16 码元，忽略空白）。 */
export function decodeUcs2Hex(hex: string): string {
  const clean = hex.replace(/\s+/g, '')
  let out = ''
  for (let i = 0; i + 4 <= clean.length; i += 4) {
    out += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16))
  }
  return out
}
