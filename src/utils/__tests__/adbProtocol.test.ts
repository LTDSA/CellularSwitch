import { describe, it, expect } from 'vitest'
import {
  ADB_HEADER_SIZE,
  A_CNXN,
  A_OPEN,
  checksum,
  concatBytes,
  packHeader,
  parseHeader,
  packMessage,
} from '../adbProtocol'

const encoder = new TextEncoder()

describe('adbProtocol.checksum', () => {
  it('computes the byte-sum (mod 2^32) used by the EG25-G adbd', () => {
    // '123456789' ASCII 之和 = 477。
    expect(checksum(encoder.encode('123456789'))).toBe(477)
  })

  it('returns 0 for empty input', () => {
    expect(checksum(new Uint8Array(0))).toBe(0)
  })
})

describe('adbProtocol.packHeader / parseHeader', () => {
  it('round-trips a header and sets magic = command ^ 0xffffffff', () => {
    const header = packHeader(A_CNXN, 0x01000000, 0x40000, 5, 0xdeadbeef)
    expect(header.length).toBe(ADB_HEADER_SIZE)
    const parsed = parseHeader(header)
    expect(parsed).toEqual({
      command: A_CNXN,
      arg0: 0x01000000,
      arg1: 0x40000,
      dataLength: 5,
      dataCrc32: 0xdeadbeef,
      magic: (A_CNXN ^ 0xffffffff) >>> 0,
    })
  })

  it('throws when fewer than 24 bytes are provided', () => {
    expect(() => parseHeader(new Uint8Array(23))).toThrow('ADB 消息头不完整')
  })
})

describe('adbProtocol.packMessage', () => {
  it('prepends a header whose dataLength/dataCrc32 describe the payload', () => {
    const data = encoder.encode('shell:\0')
    const message = packMessage(A_OPEN, 1, 0, data)
    expect(message.length).toBe(ADB_HEADER_SIZE + data.length)

    const header = parseHeader(message.slice(0, ADB_HEADER_SIZE))
    expect(header.command).toBe(A_OPEN)
    expect(header.arg0).toBe(1)
    expect(header.dataLength).toBe(data.length)
    expect(header.dataCrc32).toBe(checksum(data))

    // 负载紧随头之后。
    expect(Array.from(message.slice(ADB_HEADER_SIZE))).toEqual(Array.from(data))
  })
})

describe('adbProtocol.concatBytes', () => {
  it('concatenates arrays in order', () => {
    const out = concatBytes([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])])
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5])
  })
})
