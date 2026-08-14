import { describe, it, expect } from 'vitest'
import { deriveQadbKey } from '../qadbkey'

describe('deriveQadbKey', () => {
  it('与 CellDock 的测试向量一致', () => {
    // 来自 /celldock-for-mac/Tests/SelfTests/main.swift 的 QADBKeyDeriver 向量。
    expect(deriveQadbKey('42790187')).toBe('cQfD.paNjDkltja')
    expect(deriveQadbKey('17115309')).toBe('uWwxCQMVOz9IcTW')
    expect(deriveQadbKey('33000465')).toBe('dhbXHZ/9doGNS4T')
  })

  it('非 8 位数字的挑战值返回 null', () => {
    expect(deriveQadbKey('')).toBeNull()
    expect(deriveQadbKey('1234567')).toBeNull()
    expect(deriveQadbKey('123456789')).toBeNull()
    expect(deriveQadbKey('12345678x')).toBeNull()
    expect(deriveQadbKey(' 12345678')).toBeNull()
  })
})
