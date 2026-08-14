/**
 * RFC 1321 MD5，手写实现。
 *
 * Web Crypto（SubtleCrypto）不提供 MD5（被归类为不安全的哈希，见 MDN
 * https://developer.mozilla.org/docs/Web/API/SubtleCrypto/digest），
 * 而工厂锁（QADBKEY）解锁密钥基于 Unix md5crypt，其底层正是 MD5，
 * 因此这里自行实现，避免引入额外依赖。
 *
 * 输入为字节序列，返回 16 字节摘要。
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5,
  9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10,
  15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]

const K = new Uint32Array(64)
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0
}

function rotl(x: number, c: number): number {
  return ((x << c) | (x >>> (32 - c))) >>> 0
}

export function md5(input: Uint8Array): Uint8Array {
  const n = input.length
  const bitLenLow = (n * 8) >>> 0
  const bitLenHigh = Math.floor((n * 8) / 0x100000000) >>> 0

  // 填充：0x80 + 若干 0x00，使 (长度 + 8) 是 64 的倍数，末尾补 8 字节小端位长。
  const padZeros = (56 - ((n + 1) % 64) + 64) % 64
  const total = n + 1 + padZeros + 8
  const data = new Uint8Array(total)
  data.set(input)
  data[n] = 0x80
  const lenOff = total - 8
  data[lenOff] = bitLenLow & 0xff
  data[lenOff + 1] = (bitLenLow >>> 8) & 0xff
  data[lenOff + 2] = (bitLenLow >>> 16) & 0xff
  data[lenOff + 3] = (bitLenLow >>> 24) & 0xff
  data[lenOff + 4] = bitLenHigh & 0xff
  data[lenOff + 5] = (bitLenHigh >>> 8) & 0xff
  data[lenOff + 6] = (bitLenHigh >>> 16) & 0xff
  data[lenOff + 7] = (bitLenHigh >>> 24) & 0xff

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  const M = new Uint32Array(16)
  for (let off = 0; off < total; off += 64) {
    for (let j = 0; j < 16; j++) {
      const p = off + j * 4
      M[j] = (data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24)) >>> 0
    }

    let A = a0
    let B = b0
    let C = c0
    let D = d0

    for (let i = 0; i < 64; i++) {
      let F: number
      let g: number
      if (i < 16) {
        F = (B & C) | (~B & D)
        g = i
      } else if (i < 32) {
        F = (D & B) | (~D & C)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        F = B ^ C ^ D
        g = (3 * i + 5) % 16
      } else {
        F = C ^ (B | ~D)
        g = (7 * i) % 16
      }
      const sum = (F + A + K[i] + M[g]) >>> 0
      A = D
      D = C
      C = B
      B = (B + rotl(sum, S[i])) >>> 0
    }

    a0 = (a0 + A) >>> 0
    b0 = (b0 + B) >>> 0
    c0 = (c0 + C) >>> 0
    d0 = (d0 + D) >>> 0
  }

  const words = [a0, b0, c0, d0]
  const out = new Uint8Array(16)
  for (let w = 0; w < 4; w++) {
    out[w * 4] = words[w] & 0xff
    out[w * 4 + 1] = (words[w] >>> 8) & 0xff
    out[w * 4 + 2] = (words[w] >>> 16) & 0xff
    out[w * 4 + 3] = (words[w] >>> 24) & 0xff
  }
  return out
}
