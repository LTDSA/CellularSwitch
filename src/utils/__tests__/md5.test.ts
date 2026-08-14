import { describe, it, expect } from 'vitest'
import { md5 } from '../md5'

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('md5', () => {
  it('空串摘要（RFC 1321 标准向量）', () => {
    expect(hex(md5(new Uint8Array(0)))).toBe('d41d8cd98f00b204e9800998ecf8427e')
  })

  it('"abc" 摘要（RFC 1321 标准向量）', () => {
    expect(hex(md5(utf8('abc')))).toBe('900150983cd24fb0d6963f7d28e17f72')
  })

  it('"The quick brown fox jumps over the lazy dog" 摘要', () => {
    expect(hex(md5(utf8('The quick brown fox jumps over the lazy dog')))).toBe(
      '9e107d9d372bb6826bd81d3542a419d6',
    )
  })

  it('跨 64 字节块边界（长输入）', () => {
    expect(hex(md5(utf8('a'.repeat(64))))).toBe('014842d480b571495a4a0363793f7367')
    expect(hex(md5(utf8('a'.repeat(65))))).toBe('c743a45e0d2e6a95cb859adae0248435')
  })
})
