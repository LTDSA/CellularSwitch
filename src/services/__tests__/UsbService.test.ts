import { describe, it, expect, beforeEach, vi } from 'vitest'
import { UsbService } from '../UsbService'

describe('UsbService', () => {
  const mockConfiguration = {
    interfaces: [
      {
        interfaceNumber: 0,
        alternate: {
          interfaceClass: 0xff,
          interfaceSubclass: 0xff,
          interfaceProtocol: 0xff,
          endpoints: [
            { endpointNumber: 1, direction: 'out' },
            { endpointNumber: 2, direction: 'in' },
          ],
        },
      },
    ],
  }

  // Typed `any` so mock methods type-check cleanly.
  const mockDevice: any = {
    open: vi.fn(),
    selectConfiguration: vi.fn(),
    claimInterface: vi.fn(),
    releaseInterface: vi.fn(),
    close: vi.fn(),
    transferOut: vi.fn(),
    transferIn: vi.fn(),
    configuration: mockConfiguration,
  }

  const okResponse = () => ({
    status: 'ok',
    data: new DataView(new TextEncoder().encode('OK\r\n').buffer),
  })

  const mockAtProbe = () => {
    mockDevice.transferOut.mockResolvedValue({ status: 'ok' })
    mockDevice.transferIn.mockResolvedValue(okResponse())
  }

  beforeEach(() => {
    vi.resetAllMocks()
    mockDevice.configuration = mockConfiguration
    Object.assign(globalThis, {
      navigator: { usb: { requestDevice: vi.fn(), getDevices: vi.fn() } },
    })
  })

  it('reports WebUSB support correctly', () => {
    expect(UsbService.isSupported()).toBe(true)
    Object.assign(globalThis, { navigator: {} })
    expect(UsbService.isSupported()).toBe(false)
  })

  it('requests a device with filters', async () => {
    const requestDevice = vi.fn().mockResolvedValue(mockDevice)
    Object.assign(globalThis, { navigator: { usb: { requestDevice } } })

    const service = new UsbService()
    const device = await service.requestDevice()

    expect(requestDevice).toHaveBeenCalledWith({
      filters: [{ vendorId: 0x2ca3 }, { vendorId: 0x2c7c }],
    })
    expect(device).toBe(mockDevice)
  })

  it('connects, selects config, claims, and probes for the AT port', async () => {
    mockDevice.configuration = null
    mockDevice.selectConfiguration.mockImplementation(async () => {
      mockDevice.configuration = mockConfiguration
    })
    mockAtProbe()

    const service = new UsbService()
    await service.connect(mockDevice)

    expect(mockDevice.open).toHaveBeenCalled()
    expect(mockDevice.selectConfiguration).toHaveBeenCalledWith(1)
    expect(mockDevice.claimInterface).toHaveBeenCalledWith(0)
    expect(mockDevice.transferOut).toHaveBeenCalledWith(1, new TextEncoder().encode('AT\r\n'))
  })

  it('throws a localized error when no interface confirms as the AT port', async () => {
    mockDevice.transferOut.mockResolvedValue({ status: 'ok' })
    mockDevice.transferIn.mockRejectedValue(new Error('stall'))

    const service = new UsbService()
    await expect(service.connect(mockDevice)).rejects.toThrow(/未能定位 AT 命令接口/)
  })

  it('sends a command as UTF-8 with CRLF', async () => {
    mockAtProbe()
    const service = new UsbService()
    await service.connect(mockDevice)
    mockDevice.transferOut.mockClear()

    await service.send('AT+QCFG="usbcfg"')

    const expected = new TextEncoder().encode('AT+QCFG="usbcfg"\r\n')
    expect(mockDevice.transferOut).toHaveBeenCalledWith(1, expected)
  })

  it('reads a response string', async () => {
    mockAtProbe()
    const service = new UsbService()
    await service.connect(mockDevice)
    mockDevice.transferIn.mockClear()
    mockDevice.transferIn.mockResolvedValue(okResponse())

    const response = await service.read(1000)

    expect(response).toContain('OK')
  })
})
