import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ModuleService } from '../ModuleService'

const createMockDevice = (vendorId: number, productId: number): USBDevice =>
  ({ vendorId, productId } as USBDevice)

// Typed `any` so mock methods (mockResolvedValue) type-check cleanly.
const createMockUsb = (): any => {
  return {
    connect: vi.fn(),
    send: vi.fn(),
    read: vi.fn(),
    close: vi.fn(),
  }
}

beforeEach(() => {
  // vitest's node environment has no navigator.usb; provide a stub.
  Object.assign(globalThis, {
    navigator: {
      usb: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        getDevices: vi.fn(),
      },
    },
  })
})

describe('ModuleService.detectState', () => {
  it('detects original DJI state', () => {
    const service = new ModuleService(createMockUsb())
    expect(service.detectState(createMockDevice(0x2ca3, 0x4006))).toBe('original')
  })

  it('detects modified Quectel state', () => {
    const service = new ModuleService(createMockUsb())
    expect(service.detectState(createMockDevice(0x2c7c, 0x0125))).toBe('modified')
  })

  it('returns unknown for unexpected VID/PID', () => {
    const service = new ModuleService(createMockUsb())
    expect(service.detectState(createMockDevice(0x1234, 0x5678))).toBe('unknown')
  })
})

describe('ModuleService.applyConfig', () => {
  it('sends modify command and waits for OK', async () => {
    const usb = createMockUsb()
    usb.read.mockResolvedValue('OK')
    const service = new ModuleService(usb)
    const device = createMockDevice(0x2ca3, 0x4006)

    const rebootPromise = service.applyConfig(device, 'modified')

    // Simulate disconnect + reconnect with new VID/PID.
    // The reconnect poll fires every 500ms, so give the command flow
    // time to reach waitForReconnect, then arm getDevices.
    await new Promise((r) => setTimeout(r, 10))
    Object.assign(navigator.usb, {
      getDevices: vi.fn().mockResolvedValue([createMockDevice(0x2c7c, 0x0125)]),
    })

    await rebootPromise

    expect(usb.connect).toHaveBeenCalledWith(device)
    expect(usb.send).toHaveBeenCalledWith('AT+QCFG="usbcfg",0x2C7C,0x0125,1,1,1,1,1,0,0')
    expect(usb.send).toHaveBeenCalledWith('AT+CFUN=1,1')
    expect(usb.close).toHaveBeenCalled()
  })

  it('sends restore command and waits for OK', async () => {
    const usb = createMockUsb()
    usb.read.mockResolvedValue('OK')
    const service = new ModuleService(usb)
    const device = createMockDevice(0x2c7c, 0x0125)

    const rebootPromise = service.applyConfig(device, 'original')

    await new Promise((r) => setTimeout(r, 10))
    Object.assign(navigator.usb, {
      getDevices: vi.fn().mockResolvedValue([createMockDevice(0x2ca3, 0x4006)]),
    })

    await rebootPromise

    expect(usb.connect).toHaveBeenCalledWith(device)
    expect(usb.send).toHaveBeenCalledWith('AT+QCFG="usbcfg",0x2CA3,0x4006,1,1,1,1,1,0,0')
    expect(usb.send).toHaveBeenCalledWith('AT+CFUN=1,1')
    expect(usb.close).toHaveBeenCalled()
  })

  it('throws a localized rejection when the module does not answer OK', async () => {
    const usb = createMockUsb()
    usb.read.mockResolvedValue('ERROR')
    const service = new ModuleService(usb)
    const device = createMockDevice(0x2ca3, 0x4006)

    await expect(service.applyConfig(device, 'modified')).rejects.toThrow('Module rejected command')

    expect(usb.close).toHaveBeenCalled()
  })
})
