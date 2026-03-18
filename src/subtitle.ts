/**
 * SubtitleOverlay
 *
 * Single WebSocket connection that:
 *  1. Captures microphone audio via Web Audio API
 *  2. Streams raw PCM float32 binary frames to the transcription server
 *  3. Receives translated subtitle messages back from the server
 *  4. Sends language config to the server
 *
 * Call SubtitleOverlay.setLanguages(spoken, target) to update language config.
 * Call SubtitleOverlay.startAudio() after the user grants mic permission.
 * Call SubtitleOverlay.stopAudio() to pause capture (e.g. when mic is muted).
 */

const SAMPLE_RATE        = 16000   // must match server (samplerate = 16000)
const CHUNK_DURATION_S   = 0.3     // send a chunk every 300 ms
const CHUNK_SIZE_FRAMES  = SAMPLE_RATE * CHUNK_DURATION_S  // 4800 samples

export class SubtitleOverlay {
  // ── DOM ──────────────────────────────────────────────────────────────────
  private container:  HTMLElement
  private langBadge:  HTMLElement
  private statusDot:  HTMLElement

  // ── WebSocket ─────────────────────────────────────────────────────────────
  private ws:         WebSocket | null = null
  private fadeTimer:  ReturnType<typeof setTimeout> | null = null

  // ── Language config ───────────────────────────────────────────────────────
  private spokenLang: string = 'hi'
  private targetLang: string = 'en'

  // ── Audio pipeline ────────────────────────────────────────────────────────
  private audioCtx:      AudioContext | null = null
  private sourceNode:    MediaStreamAudioSourceNode | null = null
  private processorNode: ScriptProcessorNode | null = null
  private stream:        MediaStream | null = null
  private audioActive:   boolean = false

  // Buffer accumulates samples until we have a full chunk to send
  private sampleBuffer:  Float32Array = new Float32Array(0)

  // ── Singleton ─────────────────────────────────────────────────────────────
  private static instance: SubtitleOverlay | null = null

  constructor() {
    this.container = this.createContainer()
    this.langBadge = this.createLangBadge()
    this.statusDot = this.createStatusDot()

    this.container.appendChild(this.statusDot)
    this.container.appendChild(this.langBadge)
    document.body.appendChild(this.container)

    this.connect()

    ;(window as any).__subtitleOverlay = this
    SubtitleOverlay.instance = this
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Call from Media.tsx when the user changes language dropdowns */
  setLanguages(spokenLang: string, targetLang: string) {
    this.spokenLang = spokenLang
    this.targetLang = targetLang
    this.sendConfig()
  }

  /**
   * Start capturing microphone audio and streaming it to the server.
   * Pass the existing MediaStream from peer-calls so we don't request a
   * second mic permission — we reuse the stream the call already has.
   *
   * If no stream is supplied we request one ourselves.
   */
  async startAudio(existingStream?: MediaStream): Promise<void> {
    if (this.audioActive) return

    try {
      this.stream = existingStream ?? await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate:   SAMPLE_RATE,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      })

      // AudioContext must be created (or resumed) after a user gesture
      this.audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE })
      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume()
      }

      this.sourceNode = this.audioCtx.createMediaStreamSource(this.stream)

      // ScriptProcessorNode gives us raw PCM buffers.
      // bufferSize 4096 @ 16 kHz ≈ 256 ms per callback — fine-grained enough.
      // Note: ScriptProcessorNode is deprecated but AudioWorklet requires
      // a separate .js file which is harder to bundle. For a self-contained
      // TypeScript file this is the pragmatic choice.
      const bufferSize = 4096
      this.processorNode = this.audioCtx.createScriptProcessor(bufferSize, 1, 1)

      this.processorNode.onaudioprocess = (e: AudioProcessingEvent) => {
        if (!this.audioActive) return

        // Grab mono channel
        const input = e.inputBuffer.getChannelData(0)

        // Append to rolling buffer
        const merged = new Float32Array(this.sampleBuffer.length + input.length)
        merged.set(this.sampleBuffer)
        merged.set(input, this.sampleBuffer.length)
        this.sampleBuffer = merged

        // Drain full chunks and send each one
        while (this.sampleBuffer.length >= CHUNK_SIZE_FRAMES) {
          const chunk = this.sampleBuffer.slice(0, CHUNK_SIZE_FRAMES)
          // Keep the second half as overlap (50%) for the next chunk
          this.sampleBuffer = this.sampleBuffer.slice(CHUNK_SIZE_FRAMES / 2)
          this.sendAudioChunk(chunk)
        }
      }

      this.sourceNode.connect(this.processorNode)
      // Connect to destination is required for onaudioprocess to fire,
      // but we use a gain of 0 so the user doesn't hear themselves.
      const silentGain = this.audioCtx.createGain()
      silentGain.gain.value = 0
      this.processorNode.connect(silentGain)
      silentGain.connect(this.audioCtx.destination)

      this.audioActive = true
      this.setStatusDot('active')
      console.log('[Subtitles] Audio capture started')
    } catch (err) {
      console.error('[Subtitles] Failed to start audio capture:', err)
      this.setStatusDot('error')
    }
  }

  /** Pause audio capture (e.g. when user mutes mic) */
  stopAudio(): void {
    this.audioActive = false
    this.sampleBuffer = new Float32Array(0)
    this.setStatusDot('idle')

    if (this.processorNode) {
      this.processorNode.disconnect()
      this.processorNode.onaudioprocess = null
      this.processorNode = null
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect()
      this.sourceNode = null
    }
    if (this.audioCtx) {
      this.audioCtx.close()
      this.audioCtx = null
    }
    // We do NOT stop the tracks on the stream because it may be shared
    // with the peer-calls video call. Only stop if we created it ourselves.
    console.log('[Subtitles] Audio capture stopped')
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────

  private sendConfig(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type:        'config',
        spoken_lang: this.spokenLang,
        target_lang: this.targetLang,
      }))
      console.log(`[Subtitles] Config sent: spoken=${this.spokenLang}, target=${this.targetLang}`)
    }
  }

  private sendAudioChunk(chunk: Float32Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    // Send raw binary — server reads with np.frombuffer(message, dtype=np.float32)
    this.ws.send(chunk.buffer)
  }

  private connect(): void {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const host     = window.location.host
    this.ws        = new WebSocket(`${protocol}://${host}/subtitles`)

    // Binary type must be arraybuffer so we can read audio chunks correctly
    // on the server. For our use case we only send binary (audio) and receive
    // text (JSON subtitles), so this is fine.
    this.ws.binaryType = 'arraybuffer'

    this.ws.onopen = () => {
      console.log('[Subtitles] Connected ✓')
      this.setStatusDot('idle')
      this.sendConfig()
    }

    this.ws.onmessage = (event: MessageEvent) => {
      // We only receive text JSON from the server (subtitle messages).
      // Binary messages are only ever sent *by* us, never received.
      if (typeof event.data !== 'string') return
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'subtitle') {
          this.show(data.text, data.language)
        }
      } catch (e) {
        console.warn('[Subtitles] Failed to parse message', e)
      }
    }

    this.ws.onclose = () => {
      console.warn('[Subtitles] Disconnected, retrying in 2s...')
      this.setStatusDot('error')
      setTimeout(() => this.connect(), 2000)
    }

    this.ws.onerror = () => this.ws?.close()
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────

  private createContainer(): HTMLElement {
    const el = document.createElement('div')
    el.id = 'subtitle-overlay'
    Object.assign(el.style, {
      position:      'fixed',
      bottom:        '80px',
      left:          '50%',
      transform:     'translateX(-50%)',
      background:    'rgba(0,0,0,0.75)',
      color:         '#fff',
      fontSize:      '1.4rem',
      fontFamily:    'sans-serif',
      padding:       '8px 20px',
      borderRadius:  '6px',
      maxWidth:      '80vw',
      textAlign:     'center',
      zIndex:        '9999',
      opacity:       '0',
      transition:    'opacity 0.3s ease',
      pointerEvents: 'none',
      display:       'flex',
      alignItems:    'center',
      gap:           '8px',
    })
    return el
  }

  private createLangBadge(): HTMLElement {
    const badge = document.createElement('span')
    badge.id = 'subtitle-lang'
    Object.assign(badge.style, {
      fontSize:      '0.75rem',
      background:    'rgba(255,255,255,0.2)',
      borderRadius:  '4px',
      padding:       '2px 6px',
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
      flexShrink:    '0',
    })
    return badge
  }

  /**
   * Small dot in the top-right corner of the subtitle bar that shows the
   * state of audio capture at a glance.
   *   grey  = not yet capturing
   *   green = actively sending audio
   *   red   = error / disconnected
   */
  private createStatusDot(): HTMLElement {
    const dot = document.createElement('span')
    dot.id = 'subtitle-status'
    Object.assign(dot.style, {
      width:        '8px',
      height:       '8px',
      borderRadius: '50%',
      background:   '#888',
      flexShrink:   '0',
      transition:   'background 0.3s ease',
    })
    return dot
  }

  private setStatusDot(state: 'idle' | 'active' | 'error'): void {
    const colors = { idle: '#888', active: '#4caf50', error: '#f44336' }
    if (this.statusDot) {
      this.statusDot.style.background = colors[state]
    }
  }

  private show(text: string, language?: string): void {
    if (language) {
      this.langBadge.textContent = language
      this.langBadge.style.display = 'inline'
    } else {
      this.langBadge.style.display = 'none'
    }

    // Replace any existing text node (always the first child before the badges)
    const textNode = this.container.childNodes[0]
    if (textNode && textNode.nodeType === Node.TEXT_NODE) {
      this.container.removeChild(textNode)
    }

    this.container.insertBefore(
      document.createTextNode(text),
      this.statusDot,
    )

    this.container.style.opacity = '1'

    if (this.fadeTimer) clearTimeout(this.fadeTimer)
    this.fadeTimer = setTimeout(() => {
      this.container.style.opacity = '0'
    }, 3000)
  }
}