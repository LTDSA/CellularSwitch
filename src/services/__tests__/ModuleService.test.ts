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
    // 新架构：正常查询/切换流程刻意不调用 close()（保持会话打开，见 UsbService）。
    expect(usb.close).not.toHaveBeenCalled()
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
    // 新架构：正常查询/切换流程刻意不调用 close()（保持会话打开，见 UsbService）。
    expect(usb.close).not.toHaveBeenCalled()
  })

  it('throws a localized rejection when the module does not answer OK', async () => {
    const usb = createMockUsb()
    usb.read.mockResolvedValue('ERROR')
    const service = new ModuleService(usb)
    const device = createMockDevice(0x2ca3, 0x4006)

    await expect(service.applyConfig(device, 'modified')).rejects.toThrow('Module rejected command')

    // 新架构：正常查询/切换流程刻意不调用 close()（保持会话打开，见 UsbService）。
    expect(usb.close).not.toHaveBeenCalled()
  })
})

describe('ModuleService.queryUsbnetMode', () => {
  it('parses usbnet=0 as qmi', async () => {
    const usb = createMockUsb()
    usb.read.mockResolvedValue('AT+QCFG="usbnet"\r\n+QCFG: "usbnet",0\r\nOK')
    const service = new ModuleService(usb)
    const device = createMockDevice(0x2c7c, 0x0125)

    await expect(service.queryUsbnetMode(device)).resolves.toBe('qmi')

    expect(usb.connect).toHaveBeenCalledWith(device)
    expect(usb.send).toHaveBeenCalledWith('AT+QCFG="usbnet"')
    // 新架构：正常查询/切换流程刻意不调用 close()（保持会话打开，见 UsbService）。
    expect(usb.close).not.toHaveBeenCalled()
  })

  it('parses usbnet=1 as ecm', async () => {
    const usb = createMockUsb()
    usb.read.mockResolvedValue('+QCFG: "usbnet",1\r\nOK')
    const service = new ModuleService(usb)

    await expect(
      service.queryUsbnetMode(createMockDevice(0x2c7c, 0x0125)),
    ).resolves.toBe('ecm')
  })

  it('parses usbnet=2 as mbim', async () => {
    const usb = createMockUsb()
    usb.read.mockResolvedValue('+QCFG: "usbnet",2\r\nOK')
    const service = new ModuleService(usb)

    await expect(
      service.queryUsbnetMode(createMockDevice(0x2c7c, 0x0125)),
    ).resolves.toBe('mbim')
  })

  it('throws when the response cannot be parsed', async () => {
    const usb = createMockUsb()
    usb.read.mockResolvedValue('+QCFG: "foo",5\r\nOK')
    const service = new ModuleService(usb)

    await expect(
      service.queryUsbnetMode(createMockDevice(0x2c7c, 0x0125)),
    ).rejects.toThrow()

    // 新架构：正常查询/切换流程刻意不调用 close()（保持会话打开，见 UsbService）。
    expect(usb.close).not.toHaveBeenCalled()
  })
})

describe('ModuleService.getTelemetry', () => {
  // connect() 在测试里是 mock（不真正探测 AT），所以按顺序喂 8 条查询应答。
  const feedResponses = (usb: any, responses: string[]) => {
    responses.forEach((r) => usb.read.mockResolvedValueOnce(r))
  }

  it('parses running status and device info from AT responses', async () => {
    const usb = createMockUsb()
    feedResponses(usb, [
      '+QNWINFO: "LTE","460 11",LTE BAND 1,100\r\nOK',
      '+CREG: 0,1\r\nOK',
      'AT+CGSN\r\n861234567890123\r\n\r\nOK',
      '+QCCID: 89860112750000123456\r\nOK',
      '460001234567890\r\nOK',
      '+CNUM: 1,"13800138000",129,7,4\r\nOK',
      '+CSQ: 20,0\r\nOK',
      '+CPIN: READY\r\nOK',
    ])
    const service = new ModuleService(usb)

    const result = await service.getTelemetry(createMockDevice(0x2c7c, 0x0125))

    expect(result.running).toEqual({
      networkMode: 'LTE',
      band: 'LTE BAND 1',
      channel: '100',
      registration: '已注册（本地网络）',
      signal: { bars: 4, dbm: -73, simReady: true },
    })
    expect(result.deviceInfo).toEqual({
      imei: '861234567890123',
      iccid: '89860112750000123456',
      imsi: '460001234567890',
      phoneNumber: '13800138000',
    })
    expect(usb.send).toHaveBeenCalledWith('AT+QNWINFO')
    expect(usb.send).toHaveBeenCalledWith('AT+CREG?')
    expect(usb.send).toHaveBeenCalledWith('AT+CGSN')
    expect(usb.send).toHaveBeenCalledWith('AT+QCCID')
    expect(usb.send).toHaveBeenCalledWith('AT+CIMI')
    expect(usb.send).toHaveBeenCalledWith('AT+CNUM')
    // 新架构：正常查询/切换流程刻意不调用 close()（保持会话打开，见 UsbService）。
    expect(usb.close).not.toHaveBeenCalled()
  })

  it('maps CREG roaming and parses quoted band', async () => {
    const usb = createMockUsb()
    feedResponses(usb, [
      '+QNWINFO: "WCDMA","460 00","WCDMA 2100",10713\r\nOK',
      '+CREG: 0,5\r\nOK',
      '861234567890123\r\nOK',
      '+QCCID: 89860112750000123456\r\nOK',
      '460001234567890\r\nOK',
      '+CNUM: 1,"13900139000",129,7,4\r\nOK',
      '+CSQ: 12,0\r\nOK',
      '+CPIN: READY\r\nOK',
    ])
    const service = new ModuleService(usb)

    const result = await service.getTelemetry(createMockDevice(0x2c7c, 0x0125))

    expect(result.running).toEqual({
      networkMode: 'WCDMA',
      band: 'WCDMA 2100',
      channel: '10713',
      registration: '已注册（漫游）',
      signal: { bars: 2, dbm: -89, simReady: true },
    })
  })

  it('falls back to placeholders when phone number is unavailable', async () => {
    const usb = createMockUsb()
    feedResponses(usb, [
      '+QNWINFO: "LTE","460 11",LTE BAND 1,100\r\nOK',
      '+CREG: 0,1\r\nOK',
      '861234567890123\r\n\r\nOK',
      '+QCCID: 89860112750000123456\r\nOK',
      '460001234567890\r\nOK',
      'ERROR', // +CNUM 未分配号码 → +CME ERROR
      '+CSQ: 20,0\r\nOK',
      '+CPIN: READY\r\nOK',
    ])
    const service = new ModuleService(usb)

    const result = await service.getTelemetry(createMockDevice(0x2c7c, 0x0125))

    expect(result.deviceInfo.phoneNumber).toBe('—')
    // 手机号查询失败不影响信号强度解析。
    expect(result.running.signal).toEqual({ bars: 4, dbm: -73, simReady: true })
  })

  it('serializes concurrent queries so AT commands never interleave', async () => {
    const usb = createMockUsb()
    const single = [
      '+QNWINFO: "LTE","460 11",LTE BAND 1,100\r\nOK',
      '+CREG: 0,1\r\nOK',
      '861234567890123\r\n\r\nOK',
      '+QCCID: 89860112750000123456\r\nOK',
      '460001234567890\r\nOK',
      '+CNUM: 1,"13800138000",129,7,4\r\nOK',
      '+CSQ: 20,0\r\nOK',
      '+CPIN: READY\r\nOK',
    ]
    feedResponses(usb, [...single, ...single])
    const service = new ModuleService(usb)
    const device = createMockDevice(0x2c7c, 0x0125)

    // 两个查询几乎同时发起（SettingsCard 挂载时模式查询与遥测查询并存）。
    const results = await Promise.all([
      service.getTelemetry(device),
      service.getTelemetry(device),
    ])

    expect(results).toHaveLength(2)
    // runExclusive 保证严格串行：8 条指令按顺序完整出现两次，绝不交错。
    const commands = [
      'AT+QNWINFO',
      'AT+CREG?',
      'AT+CGSN',
      'AT+QCCID',
      'AT+CIMI',
      'AT+CNUM',
      'AT+CSQ',
      'AT+CPIN?',
    ]
    const sent = usb.send.mock.calls.map((c: any[]) => c[0])
    expect(sent).toEqual([...commands, ...commands])
  })

  it('handles no SIM: fields fall back to placeholders and signal is nulled', async () => {
    const usb = createMockUsb()
    feedResponses(usb, [
      '+QNWINFO: "NO SERVICE"\r\nOK',
      '+CREG: 0,0\r\nOK',
      'ERROR',
      'ERROR',
      'ERROR',
      'ERROR',
      '+CSQ: 15,0\r\nOK', // CSQ 有值，但 SIM 未插入，档位必须置空。
      '+CPIN: NOT INSERTED\r\nOK',
    ])
    const service = new ModuleService(usb)

    const result = await service.getTelemetry(createMockDevice(0x2c7c, 0x0125))

    expect(result.running).toEqual({
      networkMode: '—',
      band: '—',
      channel: '—',
      registration: '未注册',
      signal: { bars: null, dbm: null, simReady: false },
    })
    expect(result.deviceInfo).toEqual({
      imei: '—',
      iccid: '—',
      imsi: '—',
      phoneNumber: '—',
    })
  })
})

describe('ModuleService.setUsbnetMode', () => {
  it('sends ecm command, reboots, and returns the fresh device after reconnect', async () => {
    const usb = createMockUsb()
    usb.read.mockResolvedValue('OK')
    const service = new ModuleService(usb)
    const device = createMockDevice(0x2c7c, 0x0125)
    const fresh = createMockDevice(0x2c7c, 0x0125)

    const promise = service.setUsbnetMode(device, 'ecm', vi.fn())

    await new Promise((r) => setTimeout(r, 10))
    Object.assign(navigator.usb, {
      getDevices: vi.fn().mockResolvedValue([fresh]),
    })

    const result = await promise

    expect(result.reconnected).toBe(true)
    expect(result.device).toBe(fresh)
    expect(usb.connect).toHaveBeenCalledWith(device)
    expect(usb.send).toHaveBeenCalledWith('AT+QCFG="usbnet",1')
    expect(usb.send).toHaveBeenCalledWith('AT+CFUN=1,1')
    // 新架构：正常查询/切换流程刻意不调用 close()（保持会话打开，见 UsbService）。
    expect(usb.close).not.toHaveBeenCalled()
  })

  it('sends qmi command when target is qmi', async () => {
    const usb = createMockUsb()
    usb.read.mockResolvedValue('OK')
    const service = new ModuleService(usb)

    const promise = service.setUsbnetMode(createMockDevice(0x2c7c, 0x0125), 'qmi')

    await new Promise((r) => setTimeout(r, 10))
    Object.assign(navigator.usb, {
      getDevices: vi.fn().mockResolvedValue([createMockDevice(0x2c7c, 0x0125)]),
    })

    await promise

    expect(usb.send).toHaveBeenCalledWith('AT+QCFG="usbnet",0')
  })

  it('calls onProgress with sending, waiting-reboot, reconnecting in order', async () => {
    const usb = createMockUsb()
    usb.read.mockResolvedValue('OK')
    const service = new ModuleService(usb)
    const steps: string[] = []
    const onProgress = (s: string) => steps.push(s)

    const promise = service.setUsbnetMode(createMockDevice(0x2c7c, 0x0125), 'ecm', onProgress)

    await new Promise((r) => setTimeout(r, 10))
    Object.assign(navigator.usb, {
      getDevices: vi.fn().mockResolvedValue([createMockDevice(0x2c7c, 0x0125)]),
    })

    await promise

    expect(steps).toEqual(['sending', 'waiting-reboot', 'reconnecting'])
  })

  it('returns reconnected:false when the module does not re-enumerate (switch still succeeded)', async () => {
    const usb = createMockUsb()
    usb.read.mockResolvedValue('OK')
    const service = new ModuleService(usb)
    Object.assign(navigator.usb, {
      getDevices: vi.fn().mockResolvedValue([]),
    })

    // 传 30ms 超时，让测试不用等很久；首个轮询 tick（~1s）即超时。
    // 切换指令已确认 OK，因此重连超时不算失败，而是返回 reconnected:false。
    await expect(
      service.setUsbnetMode(createMockDevice(0x2c7c, 0x0125), 'ecm', undefined, 30),
    ).resolves.toEqual({ reconnected: false, device: null })
  })

  it('throws a localized rejection when the module rejects the command', async () => {
    const usb = createMockUsb()
    usb.read.mockResolvedValue('ERROR')
    const service = new ModuleService(usb)

    await expect(
      service.setUsbnetMode(createMockDevice(0x2c7c, 0x0125), 'ecm'),
    ).rejects.toThrow('Module rejected command')
  })
})
