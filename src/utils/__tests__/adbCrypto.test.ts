import { describe, it, expect, vi } from 'vitest'
import {
  encodeDerLength,
  encodeDerInteger,
  buildRsaPublicKeyDer,
  prefixAdbPublicKey,
  signToken,
  exportAdbPublicKey,
} from '../adbCrypto'

/** 判断 bytes 是否包含子序列（用于 DER 结构断言）。 */
function containsSubsequence(haystack: Uint8Array, needle: number[]): boolean {
  const h = Array.from(haystack)
  outer: for (let i = 0; i <= h.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (h[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}

// 注入可控的 fake Web Crypto（仅 subtle 的 sign/exportKey），避免依赖测试环境的
// 真实 crypto：单测聚焦 adbCrypto 对 subtle 的调用契约与 JWK→DER 转换，而非加密正确性。
function setFakeSubtle(overrides: { sign?: unknown; exportKey?: unknown }): void {
  ;(globalThis as { crypto?: unknown }).crypto = {
    subtle: {
      sign: overrides.sign,
      exportKey: overrides.exportKey,
    },
  }
}

describe('adbCrypto.encodeDerLength', () => {
  it('uses short form for lengths < 0x80', () => {
    expect(Array.from(encodeDerLength(0x7f))).toEqual([0x7f])
    expect(Array.from(encodeDerLength(0))).toEqual([0])
  })

  it('uses long form with a leading length byte for lengths >= 0x80', () => {
    expect(Array.from(encodeDerLength(0x80))).toEqual([0x81, 0x80])
    expect(Array.from(encodeDerLength(0x0100))).toEqual([0x82, 0x01, 0x00])
  })
})

describe('adbCrypto.encodeDerInteger', () => {
  it('emits tag 0x02 + length + value', () => {
    expect(Array.from(encodeDerInteger(new Uint8Array([0x01, 0x23])))).toEqual([
      0x02, 0x02, 0x01, 0x23,
    ])
  })

  it('strips leading zero and re-pads when the high bit is set (keep positive)', () => {
    // [0x00, 0x80] → 去前导 0 → 0x80 高位为 1 → 补 0x00 保持正数。
    expect(Array.from(encodeDerInteger(new Uint8Array([0x00, 0x80])))).toEqual([
      0x02, 0x02, 0x00, 0x80,
    ])
  })
})

describe('adbCrypto.buildRsaPublicKeyDer / prefixAdbPublicKey', () => {
  it('wraps two integers in a SEQUENCE and prefixes a 4-byte BE length', () => {
    const der = buildRsaPublicKeyDer(
      new Uint8Array([0x01, 0x23]),
      new Uint8Array([0x01, 0x00, 0x01]),
    )
    expect(der[0]).toBe(0x30) // SEQUENCE
    expect(containsSubsequence(der, [0x02, 0x03, 0x01, 0x00, 0x01])).toBe(true) // exponent

    const wire = prefixAdbPublicKey(der)
    const len = new DataView(wire.buffer).getUint32(0, false)
    expect(len).toBe(der.length)
    expect(wire.length).toBe(4 + der.length)
  })
})

describe('adbCrypto.signToken', () => {
  it('signs with algorithm name only (hash bound to the key) and returns the signature bytes', async () => {
    const sign = vi.fn().mockResolvedValue(new Uint8Array(256).buffer)
    setFakeSubtle({ sign })
    const key = {} as CryptoKey
    const token = new Uint8Array([1, 2, 3, 4, 5])

    const sig = await signToken(key, token)

    expect(sign).toHaveBeenCalledWith('RSASSA-PKCS1-v1_5', key, token)
    expect(sig).toBeInstanceOf(Uint8Array)
    expect(sig.length).toBe(256)
  })
})

describe('adbCrypto.exportAdbPublicKey', () => {
  it('builds the ADB wire public key from JWK n/e (4-byte BE length + DER)', async () => {
    // n='ASM' → 0x01 0x23；e='AQAB' → 0x01 0x00 0x01（65537）。
    const exportKey = vi.fn().mockResolvedValue({ n: 'ASM', e: 'AQAB' })
    setFakeSubtle({ exportKey })
    const key = {} as CryptoKey

    const wire = await exportAdbPublicKey(key)

    expect(exportKey).toHaveBeenCalledWith('jwk', key)
    const len = new DataView(wire.buffer).getUint32(0, false)
    expect(len).toBe(wire.length - 4)
    const der = wire.slice(4)
    expect(der[0]).toBe(0x30) // SEQUENCE
    expect(containsSubsequence(der, [0x02, 0x03, 0x01, 0x00, 0x01])).toBe(true) // exponent 65537
    expect(containsSubsequence(der, [0x02, 0x02, 0x01, 0x23])).toBe(true) // modulus
  })
})
