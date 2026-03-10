/**
 * SubtitleOverlay
 *
 * Single WebSocket connection that:
 *  1. Receives translated subtitle messages from the transcription server
 *  2. Sends language config to the server (no separate config socket needed)
 *
 * Call SubtitleOverlay.setLanguages(spoken, target) to update language config.
 */
export class SubtitleOverlay {
  private container: HTMLElement
  private langBadge: HTMLElement
  private ws: WebSocket | null = null
  private fadeTimer: ReturnType<typeof setTimeout> | null = null
  private spokenLang: string = 'hi'
  private targetLang: string = 'en'
  private static instance: SubtitleOverlay | null = null

  constructor() {
    this.container = this.createContainer()
    this.langBadge = this.createLangBadge()
    this.container.appendChild(this.langBadge)
    document.body.appendChild(this.container)
    this.connect()

    // Expose singleton on window so Media.tsx can call setLanguages
    ;(window as any).__subtitleOverlay = this
    SubtitleOverlay.instance = this
  }

  /** Call this from Media.tsx whenever the user changes language dropdowns */
  setLanguages(spokenLang: string, targetLang: string) {
    this.spokenLang = spokenLang
    this.targetLang = targetLang
    this.sendConfig()
  }

  private sendConfig() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'config',
        spoken_lang: this.spokenLang,
        target_lang: this.targetLang,
      }))
      console.log(`[Subtitles] Config sent: spoken=${this.spokenLang}, target=${this.targetLang}`)
    }
  }

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

  private connect(): void {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const host = window.location.host
    this.ws = new WebSocket(`${protocol}://${host}/subtitles`)

    this.ws.onopen = () => {
      console.log('[Subtitles] Connected ✓')
      // Send config immediately on connect so server knows our language preference
      this.sendConfig()
    }

    this.ws.onmessage = (event) => {
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
      setTimeout(() => this.connect(), 2000)
    }

    this.ws.onerror = () => this.ws?.close()
  }

  private show(text: string, language?: string): void {
    if (language) {
      this.langBadge.textContent = language
      this.langBadge.style.display = 'inline'
    } else {
      this.langBadge.style.display = 'none'
    }

    const textNode = this.container.childNodes[0]
    if (textNode && textNode.nodeType === Node.TEXT_NODE) {
      this.container.removeChild(textNode)
    }

    this.container.insertBefore(
      document.createTextNode(text),
      this.langBadge,
    )

    this.container.style.opacity = '1'

    if (this.fadeTimer) clearTimeout(this.fadeTimer)
    this.fadeTimer = setTimeout(() => {
      this.container.style.opacity = '0'
    }, 3000)
  }
}