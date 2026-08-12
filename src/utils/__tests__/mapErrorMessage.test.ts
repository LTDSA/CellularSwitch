import { describe, it, expect } from 'vitest'
import { mapErrorMessage } from '../mapErrorMessage'

describe('mapErrorMessage', () => {
  it('maps timeout errors to a localized message', () => {
    expect(mapErrorMessage('Timed out waiting for device response')).toBe(
      '读取设备响应超时，请重新插拔模块后重试',
    )
  })

  it('maps AT port location errors', () => {
    expect(mapErrorMessage('未能定位 AT 命令接口')).toBe(
      '未能定位 AT 命令接口，请确认模块已正确插入后重试',
    )
  })

  it('maps reconnect timeouts', () => {
    expect(mapErrorMessage('reconnect timed out, module did not recover')).toBe(
      '模块未在预期时间内恢复，请重新插拔后检查状态',
    )
  })

  it('maps rejected commands', () => {
    expect(mapErrorMessage('Module rejected command: ERROR')).toBe(
      '模块拒绝执行指令，请确认模块型号后重试',
    )
  })

  it('passes through unknown messages', () => {
    expect(mapErrorMessage('未知的 usbnet 模式: 5')).toBe('未知的 usbnet 模式: 5')
  })
})
