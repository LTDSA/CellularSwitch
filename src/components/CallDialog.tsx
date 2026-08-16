import { useCallback, useEffect, useRef, useState } from 'react'
import { CassetteTape, Check, Grip, Loader2, MicOff, PhoneIncoming, PhoneOff, Volume2, VolumeOff } from 'lucide-react'
import type { ModuleService } from '../services/ModuleService'
import { useVoiceCall } from '../hooks/useVoiceCall'
import { Dialog } from './Dialog'

/** 模块 UAC 的输入（下行），音频输入设备选择里排除它。 */
function isModuleInput(d: MediaDeviceInfo): boolean {
  return d.kind === 'audioinput' && /2c7c|AC Interface/i.test(d.label)
}
/** 本地麦克风启发式：优先 Built-in，排除虚拟声卡。 */
function pickDefaultMic(devices: MediaDeviceInfo[]): string {
  const builtin = devices.find(
    (d) =>
      d.kind === 'audioinput' &&
      !isModuleInput(d) &&
      d.deviceId !== 'default' &&
      /built-?in|内建|内置|内蔵/i.test(d.label),
  )
  if (builtin) return builtin.deviceId
  const nonVirtual = devices.find(
    (d) =>
      d.kind === 'audioinput' &&
      !isModuleInput(d) &&
      d.deviceId !== 'default' &&
      !/virtual|streaming|teams|recorder|loopback/i.test(d.label),
  )
  return nonVirtual?.deviceId ?? ''
}

const DEVICE_KEY = 'cellularswitch-audio-devices'

/** 读取用户上次选择的音频设备（输入麦克风/输出扬声器）。 */
function loadSavedDevices(): { input: string; output: string } {
  try {
    const v = JSON.parse(localStorage.getItem(DEVICE_KEY) ?? '{}') as {
      input?: string
      output?: string
    }
    return { input: v.input ?? '', output: v.output ?? '' }
  } catch {
    return { input: '', output: '' }
  }
}

function saveDevice(kind: 'input' | 'output', deviceId: string): void {
  try {
    const saved = loadSavedDevices()
    localStorage.setItem(
      DEVICE_KEY,
      JSON.stringify({ ...saved, [kind]: deviceId }),
    )
  } catch {
    // localStorage 不可用时忽略。
  }
}

interface Props {
  open: boolean
  /** 通话方向：拨出（打开即拨号）或呼入（打开即振铃，等接听）。 */
  mode: 'dial' | 'incoming'
  number: string
  device: USBDevice
  moduleService: ModuleService
  onClose: () => void
  /** 呼入接通后回调（父组件记录通话历史 received）。 */
  onConnected?: () => void
  /** 呼入未接（拒接/超时）后回调（父组件记录通话历史 missed）。 */
  onMissed?: () => void
}

type Phase = 'dialing' | 'ringing' | 'answering' | 'active' | 'ended'

const POLL_MS = 2000

const DTMF_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#']

/** 拨号立即失败的响应 → 人类可读文案。 */
function describeFailure(resp: string): string {
  if (/BUSY/.test(resp)) return '对方忙'
  if (/NO ANSWER/.test(resp)) return '无人接听'
  if (/NO DIALTONE/.test(resp)) return '无拨号音'
  return '呼叫失败'
}

function formatElapsed(total: number): string {
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * 通话对话框：拨出（dialing→active→ended）或呼入（ringing→active→ended）。
 * 打开时先建立语音通路（useVoiceCall：驱动+UAC+下行/上行音频）；拨出模式随后下发 ATD，
 * 呼入模式等待用户点「接听」再下发 ATA。轮询 AT+CLCC 驱动状态机；接通后发 S 路由 voice；
 * 挂断/拒接下发 ATH 并清理语音。ended 后短暂停留展示结果再关闭。
 */
export function CallDialog({ open, mode, number, device, moduleService, onClose, onConnected, onMissed }: Props) {
  const [phase, setPhase] = useState<Phase>(mode === 'dial' ? 'dialing' : 'ringing')
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // 拨出（ATD）或接听（ATA）是否已发出；发出前 CLCC 不应误判为接通。
  const [dialed, setDialed] = useState(false)
  // 音频设备选择：输入（麦克风/上行）、输出（扬声器/下行）。
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [inputDeviceId, setInputDeviceId] = useState('')
  const [muted, setMuted] = useState(false)
  const [showAudioPicker, setShowAudioPicker] = useState(false)
  // 录音 + DTMF 键盘。
  const [recording, setRecording] = useState(false)
  const [showDtmf, setShowDtmf] = useState(false)
  const recorderRef = useRef<{ recorder: MediaRecorder; chunks: Blob[]; mimeType: string } | null>(null)
  const {
    status: voiceStatus,
    error: voiceError,
    setup: setupVoice,
    ensureInput,
    routeVoice,
    setInputDevice: switchInputDevice,
    setMuted: switchMute,
    teardown: teardownVoice,
  } = useVoiceCall(device)

  // 枚举设备 + 提前建上行麦克风流（弹出对话框时调用，未接通时切换/静音即时生效）。
  const prepareDevices = useCallback(async () => {
    const saved = loadSavedDevices()
    let micId = saved.input
    let spkId = saved.output
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
      probe.getTracks().forEach((t) => t.stop())
      const ds = await navigator.mediaDevices.enumerateDevices()
      setDevices(ds)
      if (!micId) {
        micId = pickDefaultMic(ds)
        saveDevice('input', micId)
      }
      setInputDeviceId(micId)
    } catch {
      // 枚举失败，用默认设备。
    }
    await ensureInput(micId || undefined).catch(() => {
      // 建流失败忽略。
    })
    return { micId, spkId }
  }, [ensureInput])

  // 完整建立语音通路（含 audio_enable=1 触发 re-enumeration）。拨出在拨号前调用，
  // 呼入在接听后调用（避免振铃中 re-enumeration 打断来电 USB 通信）。
  const doSetup = useCallback(async () => {
    const { micId, spkId } = await prepareDevices()
    await setupVoice(micId || undefined, spkId || undefined).catch(() => {
      // 语音通路失败已在 hook 内记录，通话信令继续。
    })
  }, [prepareDevices, setupVoice])

  // 打开时：拨出模式建语音 + 拨号；呼入模式提前建上行流（枚举设备），等接听后再完整建语音。
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setPhase(mode === 'dial' ? 'dialing' : 'ringing')
    setElapsed(0)
    setError(null)
    setDialed(false)
    setShowAudioPicker(false)
    setMuted(false)
    switchMute(false)

    const start = async () => {
      if (mode === 'dial') {
        await doSetup()
        if (cancelled) return
        setDialed(true)
        moduleService
          .dial(device, number)
          .then((resp) => {
            if (cancelled) return
            if (!/OK/.test(resp)) {
              // 立即失败（NO CARRIER / BUSY / NO DIALTONE / CME ERROR 等）。
              setError(describeFailure(resp))
              setPhase('ended')
            }
            // 返回 OK：保持 dialing，等轮询到 active。
          })
          .catch((err) => {
            if (cancelled) return
            setError(err instanceof Error ? err.message : String(err))
            setPhase('ended')
          })
      } else {
        // 呼入模式：提前建上行流（枚举设备），不拨号、不建语音，等用户点「接听」后 doSetup。
        await prepareDevices()
      }
    }
    start()

    return () => {
      cancelled = true
    }
  }, [open, mode, number, device, moduleService, doSetup])

  // 轮询 AT+CLCC：拨号发出后 stat=0 → active；曾 active 后 stat=0 消失 → ended；
  // 呼入振铃中未接听、来电消失（对方挂断）→ ended（missed）。
  const incomingSeen = useRef(false)
  useEffect(() => {
    if (!open) return
    const id = setInterval(async () => {
      try {
        const calls = await moduleService.queryCurrentCalls(device)
        const hasActive = calls.some((c) => c.status === 0)
        const hasIncoming = calls.some((c) => c.direction === 'incoming' && c.status === 4)
        if (hasIncoming) incomingSeen.current = true
        if (dialed && hasActive) {
          setPhase((p) => (p === 'ended' ? p : 'active'))
        } else if (dialed && !hasActive) {
          setPhase((p) => (p === 'active' ? 'ended' : p))
        } else if (
          !dialed &&
          mode === 'incoming' &&
          incomingSeen.current &&
          !hasIncoming &&
          !hasActive
        ) {
          // 呼入振铃中未接听，来电消失（对方挂断）→ 结束（missed）。
          setPhase('ended')
        }
      } catch {
        // 轮询失败（会话短暂掉线等）忽略，下一轮再试。
      }
    }, POLL_MS)
    return () => clearInterval(id)
  }, [open, device, moduleService, dialed, mode])

  // active 时计时。
  useEffect(() => {
    if (phase !== 'active') return
    const id = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(id)
  }, [phase])

  // 接通且语音就绪后发 S（路由 voice 到 AFE）。呼入是接听后建语音，需等 setup 完成。
  useEffect(() => {
    if (phase !== 'active' || voiceStatus !== 'ready') return
    routeVoice().catch(() => {
      // 发 S 失败不影响通话信令展示。
    })
  }, [phase, voiceStatus, routeVoice])

  // 呼入接通后通知父组件记录通话历史（received），仅一次。
  const connectedNotified = useRef(false)
  useEffect(() => {
    if (phase !== 'active' || mode !== 'incoming' || connectedNotified.current) return
    connectedNotified.current = true
    onConnected?.()
  }, [phase, mode, onConnected])

  // 呼入未接（振铃阶段直接结束，未接通）通知父组件记录 missed，仅一次。
  const missedNotified = useRef(false)
  useEffect(() => {
    if (phase !== 'ended' || mode !== 'incoming' || missedNotified.current) return
    missedNotified.current = true
    if (!connectedNotified.current) {
      onMissed?.()
    }
  }, [phase, mode, onMissed])

  // ended 后：清理语音 + 短暂停留展示结果，再关闭。
  useEffect(() => {
    if (phase !== 'ended') return
    teardownVoice().catch(() => {
      // 清理失败忽略。
    })
    const t = setTimeout(() => onClose(), 1500)
    return () => clearTimeout(t)
  }, [phase, teardownVoice, onClose])

  const handleAnswer = () => {
    // UI 先切到「接听中」（answering，显示「正在建立语音」），先建语音（避免振铃中
    // re-enumeration 打断来电），建完后再真正发 ATA 接听。
    setPhase('answering')
    const answerNow = () => {
      setDialed(true)
      moduleService.answer(device).catch(() => {
        // 接听失败不影响展示。
      })
    }
    doSetup()
      .then(answerNow)
      .catch(() => {
        // 语音失败仍接听（不阻断通话信令）。
        answerNow()
      })
  }

  const handleHangup = () => {
    // 先乐观切到 ended（UI 立即反馈），挂断/拒接指令后台下发；语音由 ended 分支清理。
    setPhase('ended')
    // 对齐 celldock-for-mac：发 ATH 后确认 CLCC 清空，未清空则再发 ATH（最多 4 次）。
    // QDC507 单次 ATH 可能未真正释放通话，导致对方仍处于通话状态。
    const confirmHangup = async () => {
      for (let i = 0; i < 4; i++) {
        try {
          await moduleService.hangup(device)
          await new Promise((r) => setTimeout(r, 300))
          const calls = await moduleService.queryCurrentCalls(device)
          if (calls.length === 0) return // CLCC 已清空（真实语音 call 消失），挂断确认。
        } catch {
          // 单次确认失败，下一轮重试。
        }
      }
    }
    confirmHangup().catch(() => {
      // 挂断确认失败不影响展示，通话可能已由对方结束。
    })
  }

  // 录音：点击进入「待录音」（点亮），接通后真正开始录音；二次点击取消；通话结束下载。
  const handleRecord = () => {
    if (recording) {
      // 取消录音。
      const r = recorderRef.current
      recorderRef.current = null
      if (r) r.recorder.stop()
      setRecording(false)
      return
    }
    setRecording(true)
  }

  // 接通且处于「待录音」状态时，真正启动 MediaRecorder 录音（录下行 AC Interface）。
  useEffect(() => {
    if (phase !== 'active' || !recording || recorderRef.current) return
    const startRecording = async () => {
      try {
        const ac = devices.find(
          (d) => d.kind === 'audioinput' && /2c7c|AC Interface/i.test(d.label),
        )
        if (!ac) throw new Error('未找到下行音频设备')
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: ac.deviceId } },
        })
        const mimeType = MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : MediaRecorder.isTypeSupported('audio/mp4')
            ? 'audio/mp4'
            : ''
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
        const chunks: Blob[] = []
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data)
        }
        recorder.start()
        recorderRef.current = { recorder, chunks, mimeType }
      } catch {
        // 录音启动失败（无下行设备等），保持 recording 状态（点亮但未录）。
      }
    }
    startRecording()
  }, [phase, recording, devices])

  // ended 时若正在录音，停止并下载录音文件。
  useEffect(() => {
    if (phase !== 'ended') return
    const r = recorderRef.current
    if (r) {
      recorderRef.current = null
      r.recorder.onstop = () => {
        const blob = new Blob(r.chunks, { type: r.mimeType || 'audio/webm' })
        const ext = r.mimeType === 'audio/mp4' ? 'm4a' : 'webm'
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `call-record-${Date.now()}.${ext}`
        a.click()
        URL.revokeObjectURL(url)
      }
      r.recorder.stop()
      setRecording(false)
    }
  }, [phase])

  // DTMF 键盘按键。
  const handleDtmf = (tone: string) => {
    moduleService.sendDtmf(device, tone).catch(() => {
      // DTMF 失败忽略。
    })
  }

  // 选择音频输入设备（即时切换上行麦克风 + 持久化下次通话用）。
  const selectInput = (id: string) => {
    setMuted(false)
    switchMute(false)
    setInputDeviceId(id)
    saveDevice('input', id)
    setShowAudioPicker(false)
    switchInputDevice(id).catch(() => {
      // 切换失败忽略（下次通话仍用新设备）。
    })
  }

  // 静音：不启用任何音频输入（上行麦克风静音）。
  const selectMute = () => {
    setMuted(true)
    switchMute(true)
    setShowAudioPicker(false)
  }

  return (
    <Dialog open={open} cardClassName="max-w-sm rounded-2xl bg-white p-6 shadow-xl">
      <div className="flex flex-col items-center gap-5">
        <p className="max-w-full truncate text-xl font-semibold text-gray-900">{number}</p>

        <div className="flex min-h-6 items-center justify-center gap-2">
          {phase === 'dialing' && (
            <>
              <Loader2 className="size-5 animate-spin text-gray-400" />
              <span className="text-sm text-gray-500">正在呼叫…</span>
            </>
          )}
          {phase === 'ringing' && (
            <span className="text-sm text-gray-500">来电…</span>
          )}
          {phase === 'answering' && (
            <>
              <Loader2 className="size-5 animate-spin text-gray-400" />
              <span className="text-sm text-gray-500">正在建立语音…</span>
            </>
          )}
          {phase === 'active' && (
            <span className="text-sm text-gray-500">通话中 {formatElapsed(elapsed)}</span>
          )}
          {phase === 'ended' && (
            <span className="text-sm text-gray-500">{error ?? '通话已结束'}</span>
          )}
        </div>
        {phase !== 'ended' && voiceStatus === 'error' && (
          <span className="flex items-center gap-1 text-xs text-amber-600" title={voiceError ?? ''}>
            <MicOff className="size-3.5" />
            语音未就绪{voiceError ? `：${voiceError}` : ''}
          </span>
        )}

        <div className="flex w-full flex-col items-center gap-6">
          {/* DTMF 键盘占位区（固定高度，显示/隐藏键盘都不改变对话框高度）。 */}
          <div className="flex h-[216px] w-full items-center justify-center">
            {showDtmf && phase !== 'ended' && (
              <div className="grid w-full max-w-xs grid-cols-3 gap-2">
                {DTMF_KEYS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => handleDtmf(k)}
                    className="h-11 rounded-full text-lg font-medium text-gray-900 transition-colors hover:bg-gray-100"
                  >
                    {k}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 三个操作按钮：音频 / 录音 / 键盘。 */}
          <div className="flex items-start gap-8">
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowAudioPicker((v) => !v)}
                disabled={phase === 'ended' || devices.length === 0}
                className="flex w-16 flex-col items-center gap-1.5 disabled:opacity-40"
              >
                <span
                  className={`flex size-12 items-center justify-center rounded-full transition-colors ${
                    muted
                      ? 'bg-red-500 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {muted ? <VolumeOff className="size-5" /> : <Volume2 className="size-5" />}
                </span>
                <span className="text-xs text-gray-600">音频</span>
              </button>
              {showAudioPicker && phase !== 'ended' && (
                <div
                  role="menu"
                  className="absolute left-1/2 top-full z-20 mt-2 w-56 -translate-x-1/2 rounded-xl bg-white p-1.5 shadow-lg ring-1 ring-black/5"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => selectInput('')}
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-gray-900 transition-colors hover:bg-gray-50"
                  >
                    <span>系统默认设备</span>
                    {!muted && inputDeviceId === '' && <Check className="size-4 shrink-0 text-brand" />}
                  </button>
                  {devices
                    .filter((d) => d.kind === 'audioinput' && !isModuleInput(d) && d.deviceId !== 'default')
                    .map((d) => (
                      <button
                        key={d.deviceId}
                        type="button"
                        role="menuitem"
                        onClick={() => selectInput(d.deviceId)}
                        className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-gray-900 transition-colors hover:bg-gray-50"
                      >
                        <span className="truncate">{d.label}</span>
                        {!muted && inputDeviceId === d.deviceId && (
                          <Check className="size-4 shrink-0 text-brand" />
                        )}
                      </button>
                    ))}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={selectMute}
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-red-600 transition-colors hover:bg-red-50"
                  >
                    <span>静音</span>
                    {muted && <Check className="size-4 shrink-0 text-brand" />}
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={handleRecord}
              disabled={phase === 'ended'}
              className="flex w-16 flex-col items-center gap-1.5 disabled:opacity-40"
            >
              <span
                className={`flex size-12 items-center justify-center rounded-full transition-colors ${
                  recording
                    ? 'bg-red-500 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                <CassetteTape className="size-5" />
              </span>
              <span className="text-xs text-gray-600">录音</span>
            </button>
            <button
              type="button"
              onClick={() => setShowDtmf((v) => !v)}
              disabled={phase !== 'active'}
              className="flex w-16 flex-col items-center gap-1.5 disabled:opacity-40"
            >
              <span className="flex size-12 items-center justify-center rounded-full bg-gray-100 text-gray-700 transition-colors hover:bg-gray-200">
                <Grip className="size-5" />
              </span>
              <span className="text-xs text-gray-600">键盘</span>
            </button>
          </div>

          {/* 接听（ringing）/ 挂断按钮。 */}
          <div className="flex items-center gap-3">
            {phase === 'ringing' && (
              <button
                type="button"
                onClick={handleAnswer}
                className="flex items-center gap-2 rounded-full bg-green-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-green-600"
              >
                <PhoneIncoming className="size-4" />
                接听
              </button>
            )}
            <button
              type="button"
              onClick={handleHangup}
              disabled={phase === 'ended'}
              className="flex items-center gap-2 rounded-full bg-red-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-40"
            >
              <PhoneOff className="size-4" />
              {phase === 'ringing' ? '拒绝' : '挂断'}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
