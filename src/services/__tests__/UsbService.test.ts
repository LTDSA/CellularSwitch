import { describe, expect, it, vi } from 'vitest'
import { UsbService } from '../UsbService'

function makeDevice(closeImpl: () => Promise<void>): USBDevice {
  return {
    configuration: { interfaces: [] },
    close: closeImpl,
  } as unknown as USBDevice
}

/**
 * 构造一个可被 connect() 完整探测通过的假 USBDevice：
 * 接口 3 为 class 0xFF 的 bulk 接口（OUT4 / IN6），transferIn 返回「OK」。
 */
function makeFakeDevice(vendorId: number, productId: number): USBDevice {
  const iface = {
    interfaceNumber: 3,
    alternate: {
      interfaceClass: 0xff,
      interfaceSubclass: 0,
      interfaceProtocol: 0,
      endpoints: [
        { direction: 'out', endpointNumber: 4, type: 'bulk' },
        { direction: 'in', endpointNumber: 6, type: 'bulk' },
      ],
    },
  }
  return {
    vendorId,
    productId,
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    releaseInterface: vi.fn().mockResolvedValue(undefined),
    claimInterface: vi.fn().mockResolvedValue(undefined),
    selectConfiguration: vi.fn().mockResolvedValue(undefined),
    transferOut: vi.fn().mockResolvedValue({ status: 'ok' }),
    transferIn: vi.fn().mockResolvedValue({
      status: 'ok',
      data: new TextEncoder().encode('\r\nOK\r\n'),
    }),
    configuration: { interfaces: [iface] },
  } as unknown as USBDevice
}

function deviceOf(usb: UsbService): { device: USBDevice | null } {
  return usb as unknown as { device: USBDevice | null }
}

describe('UsbService.close', () => {
  it('模块重启时有 in-flight 传输，device.close() 抛「操作进行中」也不应使调用方失败', async () => {
    const usb = new UsbService()
    deviceOf(usb).device = makeDevice(() =>
      Promise.reject(
        new DOMException(
          'An operation that changes the device state is in progress',
          'InvalidStateError',
        ),
      ),
    )
    await expect(usb.close()).resolves.toBeUndefined()
    expect(deviceOf(usb).device).toBeNull()
  })

  it('close() 因设备已断开而失败时同样被忽略', async () => {
    const usb = new UsbService()
    deviceOf(usb).device = makeDevice(() =>
      Promise.reject(new Error('device disconnected')),
    )
    await expect(usb.close()).resolves.toBeUndefined()
    expect(deviceOf(usb).device).toBeNull()
  })
})

describe('UsbService.connect', () => {
  it('传入的设备对象失效时（open 失败），改用 getDevices() 取回的新对象并打开', async () => {
    const stale = makeFakeDevice(0x2c7c, 0x0125)
    ;(stale.open as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('session dead'),
    )
    const current = makeFakeDevice(0x2c7c, 0x0125)
    Object.assign(globalThis, {
      navigator: { usb: { getDevices: vi.fn().mockResolvedValue([current]) } },
    })

    const usb = new UsbService()
    await usb.connect(stale)

    // 自愈：先尝试传入对象（失败），再尝试 getDevices 返回的对象。
    expect(stale.open).toHaveBeenCalledTimes(1)
    expect(current.open).toHaveBeenCalledTimes(1)
    expect(deviceOf(usb).device).toBe(current)
  })

  it('传入的设备对象正常时直接复用（open() 幂等），getDevices 仅作后备', async () => {
    const device = makeFakeDevice(0x2c7c, 0x0125)
    Object.assign(globalThis, {
      navigator: {
        usb: { getDevices: vi.fn().mockResolvedValue([device]) },
      },
    })

    const usb = new UsbService()
    await usb.connect(device)

    expect(deviceOf(usb).device).toBe(device)
    // 同对象不重复加入候选（去重），只 open 一次。
    expect(device.open).toHaveBeenCalledTimes(1)
  })
})
