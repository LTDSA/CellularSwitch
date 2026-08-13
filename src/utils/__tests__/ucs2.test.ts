import { describe, it, expect } from 'vitest'
import { encodeUcs2Hex, decodeUcs2Hex } from '../ucs2'

describe('ucs2 encode', () => {
  it('encodes ASCII as 4-hex-char units', () => {
    expect(encodeUcs2Hex('A')).toBe('0041')
    expect(encodeUcs2Hex('OK')).toBe('004F004B')
  })

  it('encodes BMP Chinese (你=U+4F60, 好=U+597D)', () => {
    expect(encodeUcs2Hex('你好')).toBe('4F60597D')
  })

  it('encodes a surrogate pair (emoji) as two UTF-16 units', () => {
    // 😀 = U+1F600 → 代理对 D83D DE00。
    expect(encodeUcs2Hex('😀')).toBe('D83DDE00')
  })
})

describe('ucs2 decode', () => {
  it('decodes 4-hex-char units back to the string', () => {
    expect(decodeUcs2Hex('0041')).toBe('A')
    expect(decodeUcs2Hex('4F60597D')).toBe('你好')
  })

  it('round-trips mixed ASCII + Chinese', () => {
    const s = 'OK 你好'
    expect(decodeUcs2Hex(encodeUcs2Hex(s))).toBe(s)
  })

  it('round-trips an emoji via its surrogate pair', () => {
    expect(decodeUcs2Hex('D83DDE00')).toBe('😀')
  })

  it('ignores whitespace and newlines in the hex', () => {
    expect(decodeUcs2Hex('4F60\r\n597D')).toBe('你好')
  })
})
