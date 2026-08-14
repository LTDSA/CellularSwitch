import { describe, it, expect } from 'vitest'
import { extractOtp } from '../extractOtp'

describe('extractOtp', () => {
  it('抽取关键词之后的验证码', () => {
    expect(extractOtp('您的验证码是 123456，5 分钟内有效')).toBe('123456')
    expect(extractOtp('验证码：8888')).toBe('8888')
  })

  it('抽取关键词之前的验证码', () => {
    expect(extractOtp('【XX】654321，此为您的验证码')).toBe('654321')
  })

  it('识别英文关键词', () => {
    expect(extractOtp('Your verification code is 123456')).toBe('123456')
    expect(extractOtp('Your OTP is 123456')).toBe('123456')
    expect(extractOtp('Code: 4321')).toBe('4321')
  })

  it('关键词前后都有数字时，优先取关键词之后的（避开订单号等）', () => {
    expect(extractOtp('订单号 20240814，验证码 123456')).toBe('123456')
  })

  it('整串长数字（如 11 位手机号）不会被误截为验证码', () => {
    expect(extractOtp('验证码已发送至 13800138000')).toBeNull()
  })

  it('无关键词时返回 null', () => {
    expect(extractOtp('您的订单 123456 已发货')).toBeNull()
  })

  it('有关键词但无 4–8 位数字时返回 null', () => {
    expect(extractOtp('验证码已发送，请查收')).toBeNull()
  })

  it('空正文返回 null', () => {
    expect(extractOtp('')).toBeNull()
  })
})
