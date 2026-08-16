// QDC507 语音驱动运行时：把 insmod 需要的 .ko 载荷经 ADB push 进模块并加载，
// 使其出现 ALSA 声卡（mdm9607-tomtom-i2s-snd-card）。
//
// 移植自参考实现 celldock-for-mac 的 ModuleVoiceRuntime / ADBModuleController，
// 流程对齐：root 校验 → 内核版本 → mkdir → push .ko → insmod（跳过已加载）→ 校验声卡。
// 通话语音本身走标准 Web Audio API（getUserMedia / setSinkId 收发 UAC），见 useVoiceCall。

import { AdbService } from './AdbService'

/** manifest.json 的载荷条目（mode 为十进制权限位，如 420=0o644、493=0o755）。 */
interface ManifestFile {
  name: string
  mode: number
  size: number
  sha256: string
}

interface ManifestModule {
  file: string
  name: string
}

export interface ModuleVoiceManifest {
  formatVersion: number
  runtimeVersion: string
  kernelRelease: string
  cardName: string
  helper: string
  files: ManifestFile[]
  modules: ManifestModule[]
  requiredDevices: string[]
}

// 模块侧临时目录。
const REMOTE_DIR = '/tmp/cellularswitch-call'
// 载荷静态资源根（public/voice/，随 base 相对路径解析）。
const ASSET_BASE = `${import.meta.env.BASE_URL}voice`
// S_IFREG（常规文件类型位）。
const S_IFREG = 0o100000
// raw PCM 桥 helper 的 pid/日志（默认模式：hw:0,0 ⇄ ttyGS0 裸 PCM16）。
const HELPER_LOG = `${REMOTE_DIR}/pcm-bridge.log`
const HELPER_PID = `${REMOTE_DIR}/pcm-bridge.pid`

let cachedManifest: ModuleVoiceManifest | null = null

export class ModuleVoiceService {
  /** 拉取并缓存 manifest（进程内只读一次）。 */
  private async loadManifest(): Promise<ModuleVoiceManifest> {
    if (cachedManifest) return cachedManifest
    // cache: 'no-store' 绕过浏览器 HTTP 缓存，确保推送到模块的总是最新清单/二进制。
    const resp = await fetch(`${ASSET_BASE}/manifest.json`, { cache: 'no-store' })
    if (!resp.ok) throw new Error('加载语音驱动清单失败')
    const manifest = (await resp.json()) as ModuleVoiceManifest
    if (!manifest.files?.length || !manifest.modules?.length) {
      throw new Error('语音驱动清单无效')
    }
    cachedManifest = manifest
    return manifest
  }

  private async fetchAsset(name: string): Promise<Uint8Array<ArrayBuffer>> {
    const resp = await fetch(`${ASSET_BASE}/${name}`, { cache: 'no-store' })
    if (!resp.ok) throw new Error(`加载组件失败：${name}`)
    return new Uint8Array(await resp.arrayBuffer())
  }

  /** 临时连接 ADB 执行一次操作，结束后释放接口（与 AT 会话无冲突）。 */
  private async withAdb<T>(device: USBDevice, fn: (adb: AdbService) => Promise<T>): Promise<T> {
    const adb = new AdbService()
    try {
      await adb.connect(device)
      return await fn(adb)
    } finally {
      await adb.close()
    }
  }

  /** 拼装声卡就绪检查：5 个 snd 字符设备 + /proc/asound/cards 卡名。 */
  private soundDeviceChecks(manifest: ModuleVoiceManifest): string {
    return [
      ...manifest.requiredDevices.map((d) => `test -c '${d}'`),
      `grep -Fq '${manifest.cardName}' /proc/asound/cards`,
    ].join(' && ')
  }

  /**
   * 准备语音驱动：push .ko 并 insmod（已加载则跳过），校验声卡设备出现。
   * 成功返回 manifest.runtimeVersion；任一步失败抛带诊断信息的错误。
   */
  async prepare(device: USBDevice): Promise<string> {
    const manifest = await this.loadManifest()
    await this.withAdb(device, async (adb) => {
      // 1. root 控制权限。
      const id = await adb.runCommand('id -u', 8_000)
      if (id.status !== 0 || !id.output.split(/\s+/).includes('0')) {
        throw new Error('模块 ADB 没有 root 控制权限')
      }
      // 2. 内核版本匹配。
      const release = await adb.runCommand('uname -r', 8_000)
      if (
        release.status !== 0 ||
        !release.output.split(/\s+/).includes(manifest.kernelRelease)
      ) {
        throw new Error(
          `模块内核版本与语音驱动不匹配：需要 ${manifest.kernelRelease}，实际 ${
            release.output || '未知'
          }`,
        )
      }
      // 3. 临时目录。
      await this.checked(adb, `mkdir -p '${REMOTE_DIR}' && chmod 700 '${REMOTE_DIR}'`)

      // 4. 声卡已就绪则直接返回（已加载）。
      if ((await adb.runCommand(this.soundDeviceChecks(manifest), 8_000)).status === 0) {
        return
      }

      // 5. 旧版 qdc507_afe 仍驻留时拒绝热切换。
      const legacy = await adb.runCommand("grep -q '^qdc507_afe ' /proc/modules", 8_000)
      if (legacy.status === 0) {
        throw new Error('检测到旧版 qdc507_afe 声卡仍在内核中；请重启模块后再试')
      }

      // 6. 逐个上传 .ko 并 insmod（已加载的跳过）。
      for (const module of manifest.modules) {
        const present = await adb.runCommand(
          `grep -q '^${module.name} ' /proc/modules`,
          8_000,
        )
        if (present.status === 0) continue
        const file = manifest.files.find((f) => f.name === module.file)
        if (!file) throw new Error(`语音驱动清单缺少组件：${module.file}`)
        const data = await this.fetchAsset(module.file)
        await adb.push(data, `${REMOTE_DIR}/${module.file}`, S_IFREG | file.mode)
        const result = await adb.runCommand(`insmod '${REMOTE_DIR}/${module.file}'`, 20_000)
        if (result.status !== 0) {
          const dmesg = await adb.runCommand('dmesg | tail -n 80', 8_000).catch(() => null)
          const detail = [result.output, dmesg?.output].filter(Boolean).join('\n')
          throw new Error(detail || '模块语音驱动加载失败')
        }
      }

      // 7. 等声卡设备出现（最多 100 × 0.2s）。
      const ready = await this.waitForSoundDevices(adb, manifest)
      if (!ready) {
        const dmesg = await adb.runCommand('dmesg | tail -n 80', 8_000).catch(() => null)
        throw new Error(dmesg?.output || '语音驱动已加载，但 ALSA 设备没有出现')
      }
    })
    return manifest.runtimeVersion
  }

  /** push helper 二进制并 chmod +x，返回模块侧路径。 */
  private async pushHelper(adb: AdbService, manifest: ModuleVoiceManifest): Promise<string> {
    const helper = `${REMOTE_DIR}/${manifest.helper}`
    const file = manifest.files.find((f) => f.name === manifest.helper)
    if (!file) throw new Error(`语音驱动清单缺少组件：${manifest.helper}`)
    const data = await this.fetchAsset(manifest.helper)
    await adb.push(data, helper, S_IFREG | file.mode)
    await this.checked(adb, `chmod +x '${helper}'`)
    return helper
  }

  /**
   * VoLTE 校准：alsaucm_test 灌 ACDB（open 卡 + set _verb VoLTE + Auxpcm Rx/Tx），
   * 对齐参考实现 DJOneHub-mac-enhanced 的 voiceEnsureCalibration。成功判据：
   * /tmp/alsaucm.log 出现「ACDB -> Sent VocProc Cal!」。alsaucm_test 保持常驻
   * （不 quit，否则 snd_use_case_close 会复位 mixer / 可能 deallocate cal）。
   */
  async runVolteCalibration(device: USBDevice): Promise<string> {
    return this.withAdb(device, async (adb) => {
      const cmd =
        "pkill -x alsaucm_test 2>/dev/null; sleep 1; rm -f /run/alsaucm_test /tmp/alsaucm.log; " +
        "nohup /usr/bin/alsaucm_test </dev/null >>/tmp/alsaucm.log 2>&1 & pid=$!; " +
        "n=0; while test \"$n\" -lt 50 && test ! -p /run/alsaucm_test; do " +
        "kill -0 \"$pid\" 2>/dev/null || break; sleep 0.1; n=$((n+1)); done; " +
        "if test -p /run/alsaucm_test; then " +
        "printf 'open snd_soc_msm_9x07_Tomtom_I2S\\n' > /run/alsaucm_test; sleep 1; " +
        "printf 'set _verb VoLTE\\n' > /run/alsaucm_test; sleep 1; " +
        "printf 'set _enadev Auxpcm Rx\\n' > /run/alsaucm_test; sleep 1; " +
        "printf 'set _enadev Auxpcm Tx\\n' > /run/alsaucm_test; " +
        "n=0; while test \"$n\" -lt 100; do " +
        "grep -q 'ACDB -> Sent VocProc Cal!' /tmp/alsaucm.log 2>/dev/null && break; " +
        "sleep 0.1; n=$((n+1)); done; " +
        "else echo '(alsaucm_test FIFO 未出现)'; fi; " +
        "echo '== alsaucm.log 关键行 =='; " +
        "grep -E 'Sent VocProc|VocProc|Voice|Auxpcm|Cal|Error|error' /tmp/alsaucm.log 2>/dev/null | tail -n 20"
      const r = await adb.runCommand(cmd, 30_000)
      return r.output || '(无输出)'
    })
  }

  /**
   * 后台启动 helper 的 --voice-route-session 模式：建立 VoLTE 会话（voice_route_setup 开
   * AFE mixer + 打开并保持 hw:0,4 hostless FE 补全 DAPM）。
   * @param withAudioEnable true=写 audio_enable=1（拉起 UAC，触发 DSP 把 voice 路由到
   *   AFE-PROXY，是 celldock-for-mac 工作路径的关键）；false=--no-audio-enable。
   */
  async startVoiceRouteSession(device: USBDevice, withAudioEnable = false): Promise<void> {
    const manifest = await this.loadManifest()
    await this.withAdb(device, async (adb) => {
      const helper = await this.pushHelper(adb, manifest)
      const audioFlag = withAudioEnable ? '' : '--no-audio-enable '
      const launch =
        `rm -f '${HELPER_LOG}' '${HELPER_PID}'; ` +
        `setsid '${helper}' --voice-route-session ${audioFlag}--verbose </dev/null >>'${HELPER_LOG}' 2>&1 & pid=$!; ` +
        `printf '%s\\n' "$pid" > '${HELPER_PID}'; sleep 2`
      await this.checked(adb, launch)
    })
  }

  /** 往 /run/voc_svr 写单字符命令（S=路由 voice 到 AFE；T/B=清理回退）。 */
  async vocSvrCommand(device: USBDevice, cmd: 'S' | 'T' | 'B'): Promise<string> {
    return this.withAdb(device, async (adb) => {
      const r = await adb.runCommand(
        `if test -p /run/voc_svr; then printf '${cmd}\\n' > /run/voc_svr && echo '已写入 ${cmd}'; ` +
          `else echo '(voc_svr FIFO 不存在)'; fi`,
        8_000,
      )
      return r.output || '(无输出)'
    })
  }

  /**
   * 写 /sys/class/android_usb/f_audio/audio_enable：enabled=0 停用 UAC 释放 hw:0,5/0,6，
   * 让用户态能直接读 hw:0,6（AFE-PROXY capture）。enabled=1 会拉起 UAC gadget 抢占
   * hw:0,5/0,6 并触发坏 CVS 会话，导致用户态 pcm_read 报「Arec: error5」——因此语音
   * 桥接全程应保持 audio_enable=0（helper 的 --no-audio-enable 正是为此）。
   */
  async setAudioEnable(device: USBDevice, enabled: boolean): Promise<string> {
    const value = enabled ? '1' : '0'
    return this.withAdb(device, async (adb) => {
      const r = await adb.runCommand(
        "if test -e /sys/class/android_usb/f_audio/audio_enable; then " +
          `echo ${value} > /sys/class/android_usb/f_audio/audio_enable 2>&1 && ` +
          `echo 'audio_enable=${value} 已写入'; ` +
          "else echo '(audio_enable sysfs 不存在)'; fi",
        8_000,
      )
      return r.output || '(无输出)'
    })
  }

  /** 停止 raw PCM 桥 helper（SIGTERM，1s 后未退出则 KILL，防止残留进程累积）。 */
  async stopRawPcmBridge(device: USBDevice): Promise<void> {
    await this.withAdb(device, async (adb) => {
      const stop =
        `if test -s '${HELPER_PID}'; then ` +
        `pid=$(cat '${HELPER_PID}'); kill -TERM "$pid" 2>/dev/null || true; sleep 1; ` +
        `if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi; fi; ` +
        `rm -f '${HELPER_PID}'`
      await adb.runCommand(stop, 8_000)
    })
  }

  private async checked(adb: AdbService, command: string, timeoutMs = 8_000): Promise<void> {
    const r = await adb.runCommand(command, timeoutMs)
    if (r.status !== 0) throw new Error(r.output || '模块命令执行失败')
  }

  private async waitForSoundDevices(
    adb: AdbService,
    manifest: ModuleVoiceManifest,
  ): Promise<boolean> {
    const checks = this.soundDeviceChecks(manifest)
    const command =
      `ready=0; n=0; while test "$n" -lt 100; do ` +
      `if ${checks}; then ready=1; break; fi; ` +
      `sleep 0.2; n=$((n+1)); done; test "$ready" -eq 1`
    const r = await adb.runCommand(command, 25_000)
    return r.status === 0
  }
}

/** 应用级单例：PhoneView 与其它入口共用（manifest 进程内缓存）。 */
export const moduleVoiceService = new ModuleVoiceService()
