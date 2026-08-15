// ADB 传输层协议（host <-> device 消息）。参考 Android adb 源码的 adb_protocol.h：
// 消息 = 24 字节头 + 数据负载；头字段为 little-endian u32，依次为
// command, arg0, arg1, data_length, data_crc32, magic（magic = command ^ 0xFFFFFFFF）。
//
// 针对 EG25-G 模块的适配（对齐参考实现 celldock-for-mac 的 ADBWire）：
// 1. 版本字段用 A_VERSION_SKIP_CHECKSUM（0x01000001）：该模块 adbd 不按 CRC-32
//    校验 data_crc32，而是用「字节和」；0x01000001 关闭标准 CRC 校验路径。
// 2. 载荷上限 4096（模块 adbd 的包缓冲上限，远小于 Android 桌面的 256KB）。

export const ADB_HEADER_SIZE = 24
export const ADB_VERSION = 0x01000001
export const ADB_MAX_PAYLOAD = 4096

// 命令码（u32）。
export const A_SYNC = 0x434e5953
export const A_CNXN = 0x4e584e43
export const A_OPEN = 0x4e45504f
export const A_OKAY = 0x59414b4f
export const A_CLSE = 0x45534c43
export const A_WRTE = 0x45545257
export const A_AUTH = 0x48545541

// A_AUTH 的 arg0 子类型。
export const AUTH_TOKEN = 1
export const AUTH_SIGNATURE = 2
export const AUTH_RSAPUBLICKEY = 3

// ADB 接口描述符特征（class 0xFF、subclass 0x42、protocol 0x01，Android 通用）。
export const ADB_INTERFACE_CLASS = 0xff
export const ADB_INTERFACE_SUBCLASS = 0x42
export const ADB_INTERFACE_PROTOCOL = 0x01

export interface AdbHeader {
  command: number
  arg0: number
  arg1: number
  dataLength: number
  dataCrc32: number
  magic: number
}

// 该模块 adbd 用「字节和」（mod 2^32）而非标准 CRC-32 填充 data_crc32 字段。
// 对齐参考实现 ADBWire.checksum：payload.reduce(0) { $0 &+ UInt8($1) }。
export function checksum(data: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < data.length; i++) {
    sum = (sum + data[i]) >>> 0
  }
  return sum
}

/** 拼接多个 Uint8Array。 */
export function concatBytes(arrays: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0
  for (const a of arrays) total += a.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const a of arrays) {
    out.set(a, offset)
    offset += a.length
  }
  return out
}

/** 24 字节消息头（不含数据）。 */
export function packHeader(
  command: number,
  arg0: number,
  arg1: number,
  dataLength: number,
  dataCrc32: number,
): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(ADB_HEADER_SIZE)
  const dv = new DataView(buf.buffer)
  dv.setUint32(0, command >>> 0, true)
  dv.setUint32(4, arg0 >>> 0, true)
  dv.setUint32(8, arg1 >>> 0, true)
  dv.setUint32(12, dataLength >>> 0, true)
  dv.setUint32(16, dataCrc32 >>> 0, true)
  dv.setUint32(20, (command ^ 0xffffffff) >>> 0, true)
  return buf
}

/** 解析 24 字节消息头。 */
export function parseHeader(bytes: Uint8Array): AdbHeader {
  if (bytes.length < ADB_HEADER_SIZE) {
    throw new Error('ADB 消息头不完整')
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, ADB_HEADER_SIZE)
  return {
    command: dv.getUint32(0, true),
    arg0: dv.getUint32(4, true),
    arg1: dv.getUint32(8, true),
    dataLength: dv.getUint32(12, true),
    dataCrc32: dv.getUint32(16, true),
    magic: dv.getUint32(20, true),
  }
}

/** 拼接 24 字节头 + 数据负载，得到一条完整 ADB 消息。 */
export function packMessage(
  command: number,
  arg0: number,
  arg1: number,
  data: Uint8Array = new Uint8Array(0),
): Uint8Array<ArrayBuffer> {
  const header = packHeader(command, arg0, arg1, data.length, checksum(data))
  return concatBytes([header, data])
}
