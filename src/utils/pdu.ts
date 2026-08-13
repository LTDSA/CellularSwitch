// SMS PDU 编解码（3GPP TS 23.040 / TS 27.005）。
// 用于 PDU 模式（AT+CMGF=0）下解析 AT+CMGL 返回的 PDU，尤其支持
// 长短信（concatenated SMS）的 UDH 解析与重组——文本模式不提供分段信息。
import { decodeUcs2Hex } from './ucs2'

export interface ConcatInfo {
  /** 引用号：同一条长短信的所有分段共享。 */
  ref: number
  /** 总段数。 */
  total: number
  /** 当前段号（从 1 开始）。 */
  seq: number
}

export type PduAlphabet = '7bit' | '8bit' | 'ucs2'

export interface ParsedPdu {
  direction: 'incoming' | 'outgoing'
  address: string
  /** 仅 incoming（SMS-DELIVER）有时间戳；outgoing 无 SCTS，为空串。 */
  timestamp: string
  text: string
  /** 长短信分段信息；非分段消息为 null。 */
  concat: ConcatInfo | null
}

// --- 十六进制 / BCD ---

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '')
  const bytes = new Uint8Array(Math.floor(clean.length / 2))
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0').toUpperCase()
  }
  return out
}

/** 号码 BCD（半字节，低位在前），取 digitCount 位，忽略 0xF 填充。 */
function decodeSemiOctets(bytes: Uint8Array, digitCount: number): string {
  let out = ''
  for (let i = 0; i < bytes.length && out.length < digitCount; i++) {
    const low = bytes[i] & 0x0f
    const high = (bytes[i] >> 4) & 0x0f
    for (const nib of [low, high]) {
      if (out.length >= digitCount) break
      if (nib <= 9) out += String(nib)
    }
  }
  return out
}

/** 号码类型字节 → 加不加「+」前缀（TON=1 为国际号码）。 */
function decodeAddress(typeByte: number, digits: string): string {
  const ton = (typeByte >> 4) & 0x07
  return (ton === 1 ? '+' : '') + digits
}

/**
 * 解析 SMS-DELIVER 的 SCTS 时间戳为 yy/MM/dd,HH:mm:ss±zz（zz 为 15 分钟单位）。
 *
 * SCTS 与号码地址一致，采用「低位半字节在前」的半字节序（3GPP TS 23.040 §9.2.3.11）：
 * 个位在低半字节、十位在高半字节，即 0x62 表示「26」而非「62」。早期按高位在前解出
 * 了 80/31 这类非法日期，即此序颠倒所致。
 */
function decodeScts(bytes: Uint8Array): string {
  const bcd = (b: number) =>
    String((b & 0x0f) * 10 + ((b >> 4) & 0x0f)).padStart(2, '0')
  // 时区字节同样是半字节序：先交换高低半字节还原成常规结构再解析。
  const tzRaw = bytes[6]
  const tz = ((tzRaw & 0x0f) << 4) | ((tzRaw >> 4) & 0x0f)
  const sign = tz & 0x08 ? '-' : '+'
  const quarter = ((tz >> 4) & 0x0f) * 10 + (tz & 0x07)
  return (
    `${bcd(bytes[0])}/${bcd(bytes[1])}/${bcd(bytes[2])},` +
    `${bcd(bytes[3])}:${bcd(bytes[4])}:${bcd(bytes[5])}` +
    `${sign}${String(quarter).padStart(2, '0')}`
  )
}

// --- 编码方案（DCS）---

/** 按 DCS（数据编码方案）判断正文编码。 */
function alphabetForDcs(dcs: number): PduAlphabet {
  const group = dcs & 0xc0
  if (group === 0x40) return '8bit'
  if (group === 0x80) return 'ucs2'
  if (group === 0xc0) return '7bit' // 保留位，回退 7-bit
  // 一般组 0x00：bits 3..2 决定编码（00=7bit，01=8bit，10=UCS2）。
  const coding = (dcs & 0x0c) >> 2
  if (coding === 1) return '8bit'
  if (coding === 2) return 'ucs2'
  return '7bit'
}

// --- GSM 03.38 7-bit 默认字母表 + 扩展表 ---

const GSM_DEFAULT: string[] = [
  '@', '£', '$', '¥', 'è', 'é', 'ù', 'ì', 'ò', 'Ç', '\n', 'Ø', 'ø', '\r', 'Å', 'å',
  'Δ', '_', 'Φ', 'Γ', 'Λ', 'Ω', 'Π', 'Ψ', 'Σ', 'Θ', 'Ξ', '\u001B', 'Æ', 'æ', 'ß', 'É',
  ' ', '!', '"', '#', '¤', '%', '&', "'", '(', ')', '*', '+', ',', '-', '.', '/',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ':', ';', '<', '=', '>', '?',
  '¡', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O',
  'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'Ä', 'Ö', 'Ñ', 'Ü', '§',
  '¿', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o',
  'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', 'ä', 'ö', 'ñ', 'ü', 'à',
]

const GSM_EXT: Record<number, string> = {
  0x0a: '\f',
  0x14: '^',
  0x28: '{',
  0x29: '}',
  0x2f: '\\',
  0x3c: '[',
  0x3d: '~',
  0x3e: ']',
  0x40: '|',
  0x65: '€',
}

/** 7-bit 七位组（septet）解包：octets → septet 数组（低位在前）。 */
function unpackSeptets(data: Uint8Array, septetCount: number): number[] {
  const septets: number[] = []
  let buffer = 0
  let bits = 0
  for (let i = 0; i < data.length && septets.length < septetCount; i++) {
    buffer |= data[i] << bits
    bits += 8
    while (bits >= 7 && septets.length < septetCount) {
      septets.push(buffer & 0x7f)
      buffer >>= 7
      bits -= 7
    }
  }
  return septets
}

/** 7-bit 打包：septet 数组 → octets（unpackSeptets 的逆运算）。 */
function packSeptetsToBytes(septets: number[]): Uint8Array {
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const s of septets) {
    buffer |= s << bits
    bits += 7
    while (bits >= 8) {
      bytes.push(buffer & 0xff)
      buffer >>= 8
      bits -= 8
    }
  }
  if (bits > 0) bytes.push(buffer & 0xff)
  return new Uint8Array(bytes)
}

/** 把 7-bit 七位组解码为字符串（处理 0x1B 扩展表转义）。 */
function decodeGsm7(septets: number[]): string {
  let out = ''
  for (let i = 0; i < septets.length; i++) {
    const s = septets[i]
    if (s === 0x1b) {
      i++
      if (i < septets.length) out += GSM_EXT[septets[i]] ?? ' '
    } else {
      out += GSM_DEFAULT[s] ?? '?'
    }
  }
  return out
}

// --- 用户数据头（UDH）---

/** 解析 UDH 中的长短信拼接信息（IEI 0x00 8-bit 引用 / 0x08 16-bit 引用）。 */
function parseConcat(udh: Uint8Array): ConcatInfo | null {
  let i = 0
  while (i + 2 <= udh.length) {
    const iei = udh[i]
    const iedl = udh[i + 1]
    const data = udh.slice(i + 2, i + 2 + iedl)
    if (iei === 0x00 && iedl === 3) {
      return { ref: data[0], total: data[1], seq: data[2] }
    }
    if (iei === 0x08 && iedl === 4) {
      return { ref: (data[0] << 8) | data[1], total: data[2], seq: data[3] }
    }
    i += 2 + iedl
  }
  return null
}

/** 按编码方案与 UDHI 解析用户数据，返回正文与拼接信息。 */
function decodeUserData(
  pdu: Uint8Array,
  offset: number,
  udl: number,
  dcs: number,
  udhi: boolean,
): { text: string; concat: ConcatInfo | null } {
  const alphabet = alphabetForDcs(dcs)
  // 7-bit 下 UDL 是七位组数；8-bit/UCS2 下是八位组数。
  const udOctets = alphabet === '7bit' ? Math.ceil((udl * 7) / 8) : udl
  const ud = pdu.slice(offset, offset + udOctets)

  if (alphabet === 'ucs2') {
    let udh: Uint8Array | null = null
    let textBytes: Uint8Array
    if (udhi) {
      const udhl = ud[0]
      udh = ud.slice(1, 1 + udhl)
      let textStart = 1 + udhl
      // UCS2 正文须 16-bit 对齐：头长为奇数时补一个填充字节。
      if (textStart % 2 === 1) textStart++
      textBytes = ud.slice(textStart)
    } else {
      textBytes = ud
    }
    return { text: decodeUcs2Hex(bytesToHex(textBytes)), concat: udh ? parseConcat(udh) : null }
  }

  if (alphabet === '8bit') {
    let udh: Uint8Array | null = null
    let textBytes: Uint8Array
    if (udhi) {
      const udhl = ud[0]
      udh = ud.slice(1, 1 + udhl)
      textBytes = ud.slice(1 + udhl)
    } else {
      textBytes = ud
    }
    return { text: decodeLatin1(textBytes), concat: udh ? parseConcat(udh) : null }
  }

  // 7-bit
  const septets = unpackSeptets(ud, udl)
  if (udhi) {
    // UDH 也被打包进 7-bit：解包后重打包回八位组以读出 UDHL 与 UDH。
    const bytes = packSeptetsToBytes(septets)
    const udhl = bytes[0]
    const udh = bytes.slice(1, 1 + udhl)
    const udhSeptets = Math.ceil(((udhl + 1) * 8) / 7)
    const textSeptets = septets.slice(udhSeptets)
    return { text: decodeGsm7(textSeptets), concat: parseConcat(udh) }
  }
  return { text: decodeGsm7(septets), concat: null }
}

function decodeLatin1(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i])
  return out
}

// --- PDU 解析 ---

/**
 * 解析一条 PDU（十六进制字符串）。支持 SMS-DELIVER（incoming）与
 * SMS-SUBMIT（outgoing）；无法识别的 MTI 返回 null。
 */
export function parsePdu(hex: string): ParsedPdu | null {
  const pdu = hexToBytes(hex)
  if (pdu.length < 2) return null
  // 跳过 SCA（服务中心地址）：首字节 = 其后地址的八位组数。
  let offset = 1 + pdu[0]
  if (offset >= pdu.length) return null
  const firstOctet = pdu[offset++]
  const mti = firstOctet & 0x03
  const udhi = (firstOctet & 0x40) !== 0

  if (mti === 0x00) return parseDeliver(pdu, offset, udhi)
  if (mti === 0x01) return parseSubmit(pdu, offset, udhi, firstOctet)
  return null
}

function parseDeliver(pdu: Uint8Array, offset: number, udhi: boolean): ParsedPdu {
  const oaLen = pdu[offset++]
  const oaType = pdu[offset++]
  const oaBytes = Math.ceil(oaLen / 2)
  const address = decodeAddress(
    oaType,
    decodeSemiOctets(pdu.slice(offset, offset + oaBytes), oaLen),
  )
  offset += oaBytes
  offset++ // PID
  const dcs = pdu[offset++]
  const timestamp = decodeScts(pdu.slice(offset, offset + 7))
  offset += 7
  const udl = pdu[offset++]
  const { text, concat } = decodeUserData(pdu, offset, udl, dcs, udhi)
  return { direction: 'incoming', address, timestamp, text, concat }
}

function parseSubmit(
  pdu: Uint8Array,
  offset: number,
  udhi: boolean,
  firstOctet: number,
): ParsedPdu {
  offset++ // MR（消息引用）
  const daLen = pdu[offset++]
  const daType = pdu[offset++]
  const daBytes = Math.ceil(daLen / 2)
  const address = decodeAddress(
    daType,
    decodeSemiOctets(pdu.slice(offset, offset + daBytes), daLen),
  )
  offset += daBytes
  offset++ // PID
  const dcs = pdu[offset++]
  // 有效期 VP：长度由 firstOctet 的 VPF（bits 4..3）决定。
  const vpf = (firstOctet >> 3) & 0x03
  offset += vpf === 0 ? 0 : vpf === 2 ? 1 : 7
  const udl = pdu[offset++]
  const { text, concat } = decodeUserData(pdu, offset, udl, dcs, udhi)
  // SMS-SUBMIT 无 SCTS 时间戳，由 CMGL 记录头以外的存储信息提供不了，留空。
  return { direction: 'outgoing', address, timestamp: '', text, concat }
}
