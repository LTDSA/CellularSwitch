import { describe, it, expect } from 'vitest'
import { extractSender } from '../extractSender'

describe('extractSender', () => {
  it('提取全角方括号发送方', () => {
    expect(extractSender('【哔哩哔哩】您的验证码是 123456')).toBe('哔哩哔哩')
    expect(extractSender('【中国移动】验证码 8888')).toBe('中国移动')
  })

  it('提取半角方括号发送方', () => {
    expect(extractSender('[Google] Your code is 123456')).toBe('Google')
  })

  it('忽略前导空白', () => {
    expect(extractSender('  【B站】验证码 4321')).toBe('B站')
  })

  it('发送方名称内不含换行/收尾空格', () => {
    expect(extractSender('【12306 】验证码 654321')).toBe('12306')
  })

  it('正文无方括号时返回 null', () => {
    expect(extractSender('您的验证码是 123456')).toBeNull()
  })

  it('空正文返回 null', () => {
    expect(extractSender('')).toBeNull()
  })
})
