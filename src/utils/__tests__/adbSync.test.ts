import { describe, it, expect } from 'vitest'
import { ADB_MAX_PAYLOAD } from '../adbProtocol'
import {
  SYNC_CHUNK_CAPACITY,
  checkedShellCommand,
  parseCheckedShellOutput,
  parseSyncHeader,
  syncHeader,
  syncPacket,
} from '../adbSync'

const encoder = new TextEncoder()

describe('adbSync.syncPacket / syncHeader / parseSyncHeader', () => {
  it('frames a packet as 4-byte identifier + LE u32 length + payload', () => {
    const packet = syncPacket('DATA', new Uint8Array([1, 2, 3]))
    expect(packet.length).toBe(8 + 3)
    // 'DATA' 的 ASCII。
    expect(Array.from(packet.slice(0, 4))).toEqual([0x44, 0x41, 0x54, 0x41])
    // LE u32 长度 = 3。
    expect(Array.from(packet.slice(4, 8))).toEqual([3, 0, 0, 0])
    expect(Array.from(packet.slice(8))).toEqual([1, 2, 3])
  })

  it('frames a value-only header (identifier + LE u32 value)', () => {
    const header = syncHeader('DONE', 12345)
    expect(Array.from(header.slice(0, 4))).toEqual([0x44, 0x4f, 0x4e, 0x45])
    expect(parseSyncHeader(header)).toEqual({ identifier: 'DONE', value: 12345 })
  })

  it('parses a SEND name header back to identifier + length', () => {
    const name = encoder.encode('/tmp/x.ko,33188')
    const parsed = parseSyncHeader(syncPacket('SEND', name))
    expect(parsed.identifier).toBe('SEND')
    expect(parsed.value).toBe(name.length)
  })

  it('rejects identifiers that are not 4 bytes', () => {
    expect(() => syncPacket('DAT', new Uint8Array(0))).toThrow('sync 标识须为 4 字节')
    expect(() => syncHeader('X', 0)).toThrow('sync 标识须为 4 字节')
  })

  it('throws when parsing fewer than 8 bytes', () => {
    expect(() => parseSyncHeader(new Uint8Array(7))).toThrow('sync 响应不完整')
  })
})

describe('adbSync.checkedShellCommand / parseCheckedShellOutput', () => {
  it('round-trips output and exit status through the status marker', () => {
    const token = 'abc123'
    const wrapped = checkedShellCommand('echo hello', token)
    // 命令被包成子 shell，并带 printf 退出码标记。
    expect(wrapped).toContain(`__CELLDOCK_STATUS_${token}_%u__`)
    // 命令回显 + printf 的标记行（模拟模块 shell 的实际输出）。
    const raw = `hello\n\n__CELLDOCK_STATUS_${token}_0__\n`
    expect(parseCheckedShellOutput(raw, token)).toEqual({ output: 'hello', status: 0 })
  })

  it('parses a non-zero exit status', () => {
    const token = 't9'
    const raw = `some error\n__CELLDOCK_STATUS_${token}_3__\n`
    expect(parseCheckedShellOutput(raw, token)).toEqual({ output: 'some error', status: 3 })
  })

  it('uses the last marker when output contains a look-alike prefix', () => {
    const token = 'tok'
    const raw = `echo __CELLDOCK_STATUS_tok_9__\n\n__CELLDOCK_STATUS_${token}_0__\n`
    expect(parseCheckedShellOutput(raw, token)).toEqual({
      output: 'echo __CELLDOCK_STATUS_tok_9__',
      status: 0,
    })
  })

  it('throws when the status marker is missing', () => {
    expect(() => parseCheckedShellOutput('no marker here', 'tok')).toThrow(
      '模块 shell 没有返回退出状态',
    )
  })
})

describe('adbSync.SYNC_CHUNK_CAPACITY', () => {
  it('leaves room for the 8-byte sync frame header', () => {
    expect(SYNC_CHUNK_CAPACITY).toBe(ADB_MAX_PAYLOAD - 8)
    expect(SYNC_CHUNK_CAPACITY).toBe(4088)
  })
})
