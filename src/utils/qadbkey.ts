import { md5 } from './md5'

/**
 * 工厂锁（QADBKEY）解锁密钥派生。
 *
 * 参照 CellDock 的 QADBKeyDeriver.swift：解锁密钥 = 标准 Unix MD5-crypt，
 * 密码固定为 "SH_adb_quectel"，盐为模块返回的 8 位挑战值，取最终
 * crypt base64 输出的前 15 位。
 *
 * 挑战值非法（非 8 位数字）时返回 null。
 */

const PASSWORD = 'SH_adb_quectel'
const MAGIC = '$1$'
const CRYPT_ALPHABET = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** 密码/盐均为 ASCII，逐字节编码即可（无需 TextEncoder）。 */
function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrays) {
    out.set(a, off)
    off += a.length
  }
  return out
}

/** 3 字节（24 位）→ count 个 crypt base64 字符（每次取低 6 位）。 */
function cryptBase64(high: number, middle: number, low: number, count: number): string {
  let value = ((high << 16) | (middle << 8) | low) >>> 0
  let out = ''
  for (let i = 0; i < count; i++) {
    out += CRYPT_ALPHABET[value & 0x3f]
    value >>>= 6
  }
  return out
}

/** 标准 Unix md5crypt（逐行对应 CellDock 的 QADBKeyDeriver.md5Crypt）。 */
function md5Crypt(password: Uint8Array, salt: Uint8Array): string {
  let initial = concat(password, asciiBytes(MAGIC), salt)

  const alternate = md5(concat(password, salt, password))
  let remaining = password.length
  while (remaining > 0) {
    const count = Math.min(remaining, alternate.length)
    initial = concat(initial, alternate.subarray(0, count))
    remaining -= count
  }

  let bitLength = password.length
  while (bitLength > 0) {
    initial = concat(initial, Uint8Array.of(bitLength & 1 ? 0 : password[0]))
    bitLength >>= 1
  }

  let digest = md5(initial)
  for (let round = 0; round < 1000; round++) {
    const parts: Uint8Array[] = []
    parts.push(round & 1 ? password : digest)
    if (round % 3 !== 0) parts.push(salt)
    if (round % 7 !== 0) parts.push(password)
    parts.push(round & 1 ? digest : password)
    digest = md5(concat(...parts))
  }

  let encoded = ''
  encoded += cryptBase64(digest[0], digest[6], digest[12], 4)
  encoded += cryptBase64(digest[1], digest[7], digest[13], 4)
  encoded += cryptBase64(digest[2], digest[8], digest[14], 4)
  encoded += cryptBase64(digest[3], digest[9], digest[15], 4)
  encoded += cryptBase64(digest[4], digest[10], digest[5], 4)
  encoded += cryptBase64(0, 0, digest[11], 2)
  return encoded
}

export function deriveQadbKey(challenge: string): string | null {
  if (!/^\d{8}$/.test(challenge)) return null
  const hash = md5Crypt(asciiBytes(PASSWORD), asciiBytes(challenge))
  return hash.length >= 15 ? hash.slice(0, 15) : null
}
