// ADB sync 协议（push/pull 用）与 shell 退出码标记工具。
// 参考 Android adb sync 协议（system/core/adb/sync.h）与参考实现
// celldock-for-mac 的 ADBWire / ADBModuleController。
//
// sync 帧 = 4 字节 ASCII 标识 + 4 字节 LE u32 长度/值 + 负载。
// shell 退出码标记：把命令包成子 shell，在末尾 printf 一条带 token 的状态标记，
// 再从回显里反解出输出与退出状态（见 checkedShellCommand / parseCheckedShellOutput）。

import { ADB_MAX_PAYLOAD, concatBytes } from './adbProtocol'

// 每个 DATA 块 = 4 字节标识 + 4 字节长度 + 负载，故负载上限 = ADB 载荷 - 8。
export const SYNC_CHUNK_CAPACITY = ADB_MAX_PAYLOAD - 8

/** 生成 shell 退出码标记 token（只保留字母数字，避免污染回显解析）。 */
export function shellToken(): string {
  const base =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(16).slice(2) + Date.now().toString(16)
  return base.replace(/[^0-9a-zA-Z]/g, '') || 'token'
}

/**
 * 把一条 shell 命令包成「返回退出码」的形式：
 * 在子 shell 内执行（probe 里的 exit 不会杀死 ADB shell），
 * 末尾 printf 一条 __CELLDOCK_STATUS_<token>_<status>__ 标记。
 */
export function checkedShellCommand(command: string, token: string): string {
  return (
    `( ${command} ); __celldock_status=$?; ` +
    `printf '\\n__CELLDOCK_STATUS_${token}_%u__\\n' "$__celldock_status"`
  )
}

/** 从 shell 原始回显中解析 { output, status }（对齐参考实现 parseCheckedShellOutput）。 */
export function parseCheckedShellOutput(
  raw: string,
  token: string,
): { output: string; status: number } {
  const prefix = `__CELLDOCK_STATUS_${token}_`
  const markerIdx = raw.lastIndexOf(prefix)
  if (markerIdx < 0) throw new Error('模块 shell 没有返回退出状态')
  const afterMarker = raw.slice(markerIdx + prefix.length)
  const suffixIdx = afterMarker.indexOf('__')
  if (suffixIdx < 0) throw new Error('模块 shell 退出状态标记不完整')
  const status = Number.parseInt(afterMarker.slice(0, suffixIdx), 10)
  if (Number.isNaN(status)) throw new Error('模块 shell 退出状态无效')
  return { output: raw.slice(0, markerIdx).trim(), status }
}

/** 拼接一条 sync 帧：4 字节标识 + LE u32 长度 + 负载。 */
export function syncPacket(identifier: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  if (identifier.length !== 4) throw new Error(`sync 标识须为 4 字节: ${identifier}`)
  const header = new Uint8Array(8)
  for (let i = 0; i < 4; i++) header[i] = identifier.charCodeAt(i)
  new DataView(header.buffer).setUint32(4, payload.length >>> 0, true)
  return concatBytes([header, payload])
}

/** 拼接一条无负载 sync 帧：4 字节标识 + LE u32 值（DONE 时间戳 / OKAY 值 0 等）。 */
export function syncHeader(identifier: string, value: number): Uint8Array<ArrayBuffer> {
  if (identifier.length !== 4) throw new Error(`sync 标识须为 4 字节: ${identifier}`)
  const header = new Uint8Array(8)
  for (let i = 0; i < 4; i++) header[i] = identifier.charCodeAt(i)
  new DataView(header.buffer).setUint32(4, value >>> 0, true)
  return header
}

/** 解析 sync 响应的 8 字节头，返回 { identifier, value }。 */
export function parseSyncHeader(bytes: Uint8Array): { identifier: string; value: number } {
  if (bytes.length < 8) throw new Error('sync 响应不完整')
  const identifier = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
  const value = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, true)
  return { identifier, value }
}
