import { useCallback, useRef, useState } from 'react'
import { moduleVoiceService } from '../services/ModuleVoiceService'

// AudioContext.setSinkId 是较新 API（Chrome 110+），TS lib.dom 未收录，手动补类型。
declare global {
  interface AudioContext {
    setSinkId?: (sinkId: string) => Promise<undefined>
  }
}

type VoiceStatus = 'idle' | 'preparing' | 'ready' | 'error'

export interface VoiceCallControls {
  status: VoiceStatus
  error: string | null
  /**
   * 建立语音通路：ADB 侧驱动+校准+会话 + 浏览器侧下行/上行音频。
   * @param inputDeviceId 上行麦克风（本地输入设备）；缺省用默认麦克风。
   * @param outputDeviceId 下行扬声器（本地输出设备）；缺省用默认扬声器。
   */
  setup: (inputDeviceId?: string, outputDeviceId?: string) => Promise<void>
  /** 只建上行麦克风流（getUserMedia + AudioContext，不 setSinkId AS），供「未接通时」提前建流。 */
  ensureInput: (inputDeviceId?: string) => Promise<void>
  /** 通话接通后把 voice 路由到 AFE（发 S）。 */
  routeVoice: () => Promise<void>
  /** 切换上行麦克风（重新建立上行流，通话中即时生效）。 */
  setInputDevice: (inputDeviceId: string) => Promise<void>
  /** 静音/取消静音（禁用/启用上行麦克风 track）。 */
  setMuted: (muted: boolean) => void
  /** 清理：回退路由(T/B) + 停音频 + 停会话 + 关 UAC。 */
  teardown: () => Promise<void>
}

/** 模块 UAC 被 macOS 识别为「AC Interface」(输入/下行) 和「AS Interface」(输出/上行)。 */
function isModuleInput(d: MediaDeviceInfo): boolean {
  return d.kind === 'audioinput' && /2c7c|AC Interface/i.test(d.label)
}
function isModuleOutput(d: MediaDeviceInfo): boolean {
  return d.kind === 'audiooutput' && /2c7c|AS Interface/i.test(d.label)
}

/**
 * 建立上行麦克风流（getUserMedia + AudioContext，保持 suspended 不输出）。
 * asDeviceId 给定则 setSinkId 到 AS。是否 resume 由调用方决定——未 setSinkId 到 AS 前
 * 若 resume 会输出到默认扬声器，形成麦克风↔扬声器啸叫，故这里一律不 resume。
 */
async function createUpContext(
  inputDeviceId: string | undefined,
  asDeviceId?: string,
): Promise<{ upStream: MediaStream; upContext: AudioContext }> {
  const upStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}),
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  })
  const upContext = new AudioContext()
  const src = upContext.createMediaStreamSource(upStream)
  src.connect(upContext.destination)
  if (asDeviceId && typeof upContext.setSinkId === 'function') {
    await upContext.setSinkId(asDeviceId)
  }
  // 接通前默认静音：把麦克风 track 置 enabled=false（浏览器层面静音，比 suspend 更彻底），
  // 避免麦克风经 destination 输出到扬声器形成啸叫。接通（发 S）后再启用。
  upStream.getAudioTracks().forEach((t) => {
    t.enabled = false
  })
  return { upStream, upContext }
}

/**
 * 语音通话生命周期：标准 Web Audio API 收发 QDC507 的 UAC，无需 WebUSB 读端点。
 * - 下行（对方→我）：getUserMedia 读 AC Interface → 播放到本地扬声器。
 * - 上行（我→对方）：getUserMedia 读本地麦克风 → setSinkId 输出到 AS Interface。
 * 前置（ADB 侧）：prepare（insmod .ko）+ alsaucm_test 校准 + voice-route-session（hold hw:0,4
 * + audio_enable=1 拉起 UAC，内核驱动配 AFE 拓扑）；通话接通后发 S 路由 voice。
 */
export function useVoiceCall(device: USBDevice): VoiceCallControls {
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const resources = useRef<{
    sessionStarted: boolean
    downStream?: MediaStream
    upStream?: MediaStream
    downAudio?: HTMLAudioElement
    upContext?: AudioContext
    asDeviceId?: string
  }>({ sessionStarted: false })
  // 用户是否手动选择了「静音」（接通后不自动取消默认静音）。
  const mutedByUser = useRef(false)

  const teardown = useCallback(async () => {
    const r = resources.current
    if (r.downAudio) {
      try { r.downAudio.pause() } catch { /* 忽略 */ }
    }
    if (r.upContext) {
      try { await r.upContext.close() } catch { /* 忽略 */ }
    }
    if (r.downStream) r.downStream.getTracks().forEach((t) => t.stop())
    if (r.upStream) r.upStream.getTracks().forEach((t) => t.stop())
    if (r.sessionStarted) {
      // 对齐参考实现 stop 序列：回退 voice 路由 T/T/B，再停会话。
      try { await moduleVoiceService.vocSvrCommand(device, 'T') } catch { /* 忽略 */ }
      try { await moduleVoiceService.vocSvrCommand(device, 'T') } catch { /* 忽略 */ }
      try { await moduleVoiceService.vocSvrCommand(device, 'B') } catch { /* 忽略 */ }
      try { await moduleVoiceService.stopRawPcmBridge(device) } catch { /* 忽略 */ }
    }
    try { await moduleVoiceService.setAudioEnable(device, false) } catch { /* 忽略 */ }
    resources.current = { sessionStarted: false }
    mutedByUser.current = false
    setStatus('idle')
  }, [device])

  const setup = useCallback(async (inputDeviceId?: string, outputDeviceId?: string) => {
    setStatus('preparing')
    setError(null)
    try {
      // 1. ADB 侧：驱动 + 校准 + 会话（hold hw:0,4 + audio_enable=1）。
      await moduleVoiceService.prepare(device)
      await moduleVoiceService.runVolteCalibration(device)
      await moduleVoiceService.startVoiceRouteSession(device, true)
      resources.current.sessionStarted = true
      await new Promise((r) => setTimeout(r, 2000)) // 等 UAC re-enumeration

      // 2. 先请求麦克风权限（未授权时 enumerateDevices 的 deviceId 为空字符串）。
      //    授权后立即停掉临时流。
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
      probe.getTracks().forEach((t) => t.stop())

      // 3. 枚举模块音频设备（此时 deviceId 完整）。
      const devices = await navigator.mediaDevices.enumerateDevices()
      const ac = devices.find(isModuleInput)
      const as = devices.find(isModuleOutput)
      if (!ac || !as) {
        throw new Error('未找到模块音频设备（AC/AS Interface，UAC 未激活？）')
      }
      resources.current.asDeviceId = as.deviceId

      // 4. 下行：AC Interface → 用户选定的扬声器（缺省用默认）。先建流不播放，
      //    接通（发 S）后再播放，避免未接通时模块把上行环回下行经扬声器形成啸叫。
      const downStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: ac.deviceId } },
      })
      const downAudio = new Audio()
      downAudio.srcObject = downStream
      if (outputDeviceId) {
        await downAudio.setSinkId(outputDeviceId)
      }
      resources.current.downStream = downStream
      resources.current.downAudio = downAudio

      // 5. 上行：用户选定的麦克风（缺省用默认）→ AS Interface。
      //    ensureInput 若已提前建好麦克风流，这里只补 setSinkId 到 AS（不 resume）；
      //    否则建上行流（setSinkId AS，不 resume）。resume 在接通（发 S）后统一做，
      //    避免未接通时上行输出经模块环回到下行扬声器产生啸叫。
      const r = resources.current
      if (r.upContext && r.upStream) {
        if (typeof r.upContext.setSinkId === 'function') {
          await r.upContext.setSinkId(as.deviceId)
        }
      } else {
        const { upStream, upContext } = await createUpContext(inputDeviceId, as.deviceId)
        r.upStream = upStream
        r.upContext = upContext
      }

      setStatus('ready')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      setStatus('error')
      await teardown()
    }
  }, [device, teardown])

  const routeVoice = useCallback(async () => {
    // 冷启动后首次发 S 可能未生效（vendor daemon 未就绪），隔 800ms 补发一次确保路由建立。
    await moduleVoiceService.vocSvrCommand(device, 'S')
    await new Promise((r) => setTimeout(r, 800))
    await moduleVoiceService.vocSvrCommand(device, 'S')
    // 发 S（接通）后，voice 已路由到 AFE，此时才启动下行播放 + 上行 resume + 取消默认静音。
    const r = resources.current
    if (r.downAudio) {
      try { await r.downAudio.play() } catch { /* 忽略 */ }
    }
    if (r.upContext) {
      try { await r.upContext.resume() } catch { /* 忽略 */ }
    }
    if (r.upStream && !mutedByUser.current) {
      r.upStream.getAudioTracks().forEach((t) => {
        t.enabled = true
      })
    }
  }, [device])

  // 只建上行麦克风流（不 setSinkId AS），供「未接通时」提前建流，切换/静音即时生效。
  const ensureInput = useCallback(async (inputDeviceId?: string) => {
    const r = resources.current
    if (r.upStream) return // 已建立，忽略。
    try {
      const { upStream, upContext } = await createUpContext(inputDeviceId)
      r.upStream = upStream
      r.upContext = upContext
    } catch {
      // 建流失败忽略。
    }
  }, [])

  // 切换上行麦克风：停旧上行流，用新麦克风重建上行流（asDeviceId 已保存则 setSinkId AS）。
  const setInputDevice = useCallback(async (inputDeviceId: string) => {
    const r = resources.current
    if (r.upStream) r.upStream.getTracks().forEach((t) => t.stop())
    if (r.upContext) {
      try { await r.upContext.close() } catch { /* 忽略 */ }
    }
    try {
      const { upStream, upContext } = await createUpContext(inputDeviceId, r.asDeviceId)
      // 只有已 setSinkId 到 AS（通话中）才 resume 并取消默认静音，避免未接通时啸叫。
      if (r.asDeviceId) {
        await upContext.resume()
        if (!mutedByUser.current) {
          upStream.getAudioTracks().forEach((t) => {
            t.enabled = true
          })
        }
      }
      r.upStream = upStream
      r.upContext = upContext
    } catch {
      // 切换失败忽略（保持原上行流已停止，通话信令不受影响）。
    }
  }, [])

  // 静音/取消静音：切换上行麦克风 track 的 enabled。
  const setMuted = useCallback((muted: boolean) => {
    mutedByUser.current = muted
    const r = resources.current
    if (r.upStream) {
      r.upStream.getAudioTracks().forEach((t) => {
        t.enabled = !muted
      })
    }
  }, [])

  return { status, error, setup, ensureInput, routeVoice, setInputDevice, setMuted, teardown }
}
