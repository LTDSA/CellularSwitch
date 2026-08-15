// ADB RSA 鉴权：生成/持久化 2048-bit RSA 密钥、用 SHA-1 签名鉴权 token、
// 导出 ADB 线上的 RSAPublicKey（4 字节大端长度前缀 + DER SEQUENCE{modulus,exponent}）。
//
// 注意：Chrome 对 Web Crypto 的 SHA-1 签名已弃用（可能打印告警，未来可能受限）。
// 若 sign 抛错，ADB 鉴权会失败——真机需实测确认浏览器支持。

import { concatBytes } from './adbProtocol'

const KEY_STORAGE = 'cellularswitch:adbkey'

// RSASSA-PKCS1-v1_5 的 hash 绑定在 generateKey/importKey 阶段（sign 时只传算法名）。
const RSA_ALGO = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' } as const

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** DER 长度编码（短形式 / 长形式）。 */
export function encodeDerLength(len: number): Uint8Array {
  if (len < 0x80) return new Uint8Array([len])
  const bytes: number[] = []
  let v = len
  while (v > 0) {
    bytes.unshift(v & 0xff)
    v >>>= 8
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes])
}

/** DER INTEGER：去掉前导 0，最高位为 1 时补 0x00 保持正数。 */
export function encodeDerInteger(bytes: Uint8Array): Uint8Array {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) start++
  let value = bytes.slice(start)
  if (value[0] & 0x80) {
    value = concatBytes([new Uint8Array([0]), value])
  }
  return concatBytes([new Uint8Array([0x02]), encodeDerLength(value.length), value])
}

/** 构造 RSAPublicKey DER：SEQUENCE { INTEGER modulus, INTEGER exponent }。 */
export function buildRsaPublicKeyDer(modulus: Uint8Array, exponent: Uint8Array): Uint8Array {
  const seq = concatBytes([encodeDerInteger(modulus), encodeDerInteger(exponent)])
  return concatBytes([new Uint8Array([0x30]), encodeDerLength(seq.length), seq])
}

/** ADB 线上公钥格式：4 字节大端长度前缀 + DER。 */
export function prefixAdbPublicKey(der: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4 + der.length)
  new DataView(out.buffer).setUint32(0, der.length, false)
  out.set(der, 4)
  return out
}

interface StoredKey {
  privateKey: JsonWebKey
  publicKey: JsonWebKey
}

/**
 * 取得 RSA 密钥对：优先从 localStorage 恢复（避免每次连接都在设备端重新授权），
 * 无则生成新密钥并持久化。持久化失败（隐私模式）则用临时密钥。
 */
export async function getOrCreateKeyPair(): Promise<CryptoKeyPair> {
  try {
    const raw = localStorage.getItem(KEY_STORAGE)
    if (raw) {
      const { privateKey, publicKey } = JSON.parse(raw) as StoredKey
      return {
        privateKey: await globalThis.crypto.subtle.importKey('jwk', privateKey, RSA_ALGO, true, ['sign']),
        publicKey: await globalThis.crypto.subtle.importKey('jwk', publicKey, RSA_ALGO, true, ['verify']),
      }
    }
  } catch {
    // 读取/导入失败（损坏或不可用）时回退为生成新密钥。
  }

  const pair = await globalThis.crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-1',
    },
    true,
    ['sign', 'verify'],
  )
  try {
    const privateKey = await globalThis.crypto.subtle.exportKey('jwk', pair.privateKey)
    const publicKey = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey)
    localStorage.setItem(KEY_STORAGE, JSON.stringify({ privateKey, publicKey }))
  } catch {
    // 持久化失败（隐私模式）则本次会话用临时密钥，模块会重新弹出授权。
  }
  return pair
}

/** 用私钥对 ADB 鉴权 token（20 字节）做 RSA-SHA1 签名。 */
export async function signToken(
  privateKey: CryptoKey,
  token: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const sig = await globalThis.crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, token)
  return new Uint8Array(sig)
}

/** 导出 ADB 线上格式的 RSA 公钥（4 字节长度前缀 + DER）。 */
export async function exportAdbPublicKey(publicKey: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', publicKey)
  if (!jwk.n || !jwk.e) throw new Error('RSA 公钥 JWK 缺少 n/e')
  const der = buildRsaPublicKeyDer(base64UrlToBytes(jwk.n), base64UrlToBytes(jwk.e))
  return prefixAdbPublicKey(der)
}
