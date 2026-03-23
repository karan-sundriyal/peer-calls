import classnames from 'classnames'
import React from 'react'
import { MdError } from 'react-icons/md'
import { connect } from 'react-redux'
import { dial } from '../actions/CallActions'
import { enumerateDevices, getDeviceId, getMediaStream, MediaDevice, MediaKind, play, setDeviceIdOrDisable, toggleDevice } from '../actions/MediaActions'
import { error, info, warning } from '../actions/NotifyActions'
import { StreamTypeCamera } from '../actions/StreamActions'
import { DEVICE_DEFAULT_ID, DEVICE_DISABLED_ID, DialState, DIAL_STATE_HUNG_UP, ME } from '../constants'
import { MediaState } from '../reducers/media'
import { LocalStream } from '../reducers/streams'
import { State } from '../store'
import { config, MediaStream } from '../window'
import { Alert, Alerts } from './Alerts'
import { Message } from './Message'
import { Unsupported } from './Unsupported'
import VideoSrc from './VideoSrc'
import VUMeter from './VUMeter'

const { network } = config

const SUBTITLE_LANGUAGES: { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'hi', name: 'Hindi' },
  { code: 'ta', name: 'Tamil' },
  { code: 'te', name: 'Telugu' },
  { code: 'bn', name: 'Bengali' },
  { code: 'mr', name: 'Marathi' },
  { code: 'gu', name: 'Gujarati' },
  { code: 'kn', name: 'Kannada' },
  { code: 'ml', name: 'Malayalam' },
  { code: 'pa', name: 'Punjabi' },
  { code: 'ur', name: 'Urdu' },
  { code: 'or', name: 'Odia' },
  { code: 'as', name: 'Assamese' },
  { code: 'ne', name: 'Nepali' },
  { code: 'si', name: 'Sinhala' },
  // European
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'es', name: 'Spanish' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'nl', name: 'Dutch' },
  { code: 'pl', name: 'Polish' },
  { code: 'ru', name: 'Russian' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'sv', name: 'Swedish' },
  { code: 'no', name: 'Norwegian' },
  { code: 'da', name: 'Danish' },
  { code: 'fi', name: 'Finnish' },
  { code: 'cs', name: 'Czech' },
  { code: 'ro', name: 'Romanian' },
  { code: 'hu', name: 'Hungarian' },
  // Asian
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'th', name: 'Thai' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'id', name: 'Indonesian' },
  { code: 'ms', name: 'Malay' },
  // Middle Eastern
  { code: 'ar', name: 'Arabic' },
  { code: 'fa', name: 'Persian' },
  { code: 'tr', name: 'Turkish' },
  { code: 'he', name: 'Hebrew' },
]

/**
 * Route language config through the SubtitleOverlay's single WebSocket
 * so there is only ever ONE connection to the transcription server per client.
 */
function sendSubtitleConfig(spokenLang: string, targetLang: string) {
  const overlay = (window as any).__subtitleOverlay
  if (overlay && typeof overlay.setLanguages === 'function') {
    overlay.setLanguages(spokenLang, targetLang)
  }
}

export type MediaProps = MediaState & {
  joinEnabled: boolean
  dial: typeof dial
  dialState: DialState
  visible: boolean
  enumerateDevices: typeof enumerateDevices
  setDeviceId: typeof setDeviceIdOrDisable
  stream?: LocalStream
  getMediaStream: typeof getMediaStream
  play: typeof play
  logInfo: typeof info
  logWarning: typeof warning
  logError: typeof error
  nickname?: string
}

export interface MediaComponentState {
  nickname: string
  error?: boolean
  spokenLang: string
  targetLang: string
}

function mapStateToProps(state: State) {
  const stream = state.streams.localStreams[StreamTypeCamera]
  return {
    ...state.media,
    nickname: state.nicknames[ME],
    stream,
    joinEnabled:
      state.media.dialState === DIAL_STATE_HUNG_UP &&
      state.media.socketConnected &&
      !state.media.loading,
    visible: state.media.dialState === DIAL_STATE_HUNG_UP,
  }
}

const mapDispatchToProps = {
  enumerateDevices,
  dial,
  toggleDevice,
  setDeviceId: setDeviceIdOrDisable,
  getMediaStream,
  play,
  logInfo: info,
  logWarning: warning,
  logError: error,
}

const c = connect(mapStateToProps, mapDispatchToProps)

export class MediaForm extends React.PureComponent<MediaProps, MediaComponentState> {
  constructor(props: MediaProps) {
    super(props)
    this.state = {
      nickname: props.nickname || '',
      spokenLang: 'hi',
      targetLang: 'en',
    }
  }

  async componentDidMount() {
    let stream: MediaStream
    try {
      const res = await this.getMediaStream()
      stream = res.stream
    } catch (e) {
      stream = new MediaStream()
    }
    await this.props.enumerateDevices({
      getUserMedia: stream.getTracks().length === 0,
    })
    // Push initial language config to the overlay's WebSocket
    sendSubtitleConfig(this.state.spokenLang, this.state.targetLang)
  }

  async componentDidUpdate(prevProps: MediaProps) {
    const { video, audio } = this.props
    if (video === prevProps.video && audio === prevProps.audio) return
    const { stream } = this.props
    if (stream) stream.stream.getTracks().forEach(t => t.stop())
    try {
      await this.getMediaStream()
    } catch {
      this.setState({ error: true })
    }
  }

  getMediaStream = async () => {
    const constraints: MediaStreamConstraints = { audio: false, video: false }
    const { audio, video } = this.props
    if (audio.enabled) constraints.audio = audio.constraints
    if (video.enabled) constraints.video = video.constraints
    return this.props.getMediaStream(constraints)
  }

  handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
  const { nickname } = this.state
  localStorage && (localStorage.nickname = nickname)
  event.preventDefault()
  const { props } = this
  props.logInfo('Dialling...')
  try {
    await props.dial({ nickname })

    // Start streaming audio to transcription server
    const overlay = (window as any).__subtitleOverlay
    if (overlay) {
      overlay.startAudio(props.stream?.stream)
    }
  } catch (err) {
    props.logError('Error dialling: {0}', err)
  }
}

  handleVideoChange = async (event: React.ChangeEvent<HTMLSelectElement>) => {
    this.props.setDeviceId({ kind: 'video', deviceId: event.target.value })
  }

  handleAudioChange = async (event: React.ChangeEvent<HTMLSelectElement>) => {
    this.props.setDeviceId({ kind: 'audio', deviceId: event.target.value })
  }

  handleNicknameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    this.setState({ nickname: event.target.value })
  }

  handleSpokenLangChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const spokenLang = event.target.value
    this.setState({ spokenLang }, () => sendSubtitleConfig(spokenLang, this.state.targetLang))
  }

  handleTargetLangChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const targetLang = event.target.value
    this.setState({ targetLang }, () => sendSubtitleConfig(this.state.spokenLang, targetLang))
  }

  render() {
    const { props } = this
    const { audio, video, stream } = props
    const { nickname, spokenLang, targetLang } = this.state

    const videoId = getDeviceId(video.enabled, video.constraints)
    const audioId = getDeviceId(audio.enabled, audio.constraints)

    const spokenName = SUBTITLE_LANGUAGES.find(l => l.code === spokenLang)?.name ?? spokenLang
    const targetName = SUBTITLE_LANGUAGES.find(l => l.code === targetLang)?.name ?? targetLang

    return (
      <form className='media' onSubmit={this.handleSubmit}>

        <div className='form-item'>
          <VideoSrc
            srcObject={stream ? stream.stream : null}
            autoPlay
            muted
            mirrored={stream && stream.mirror}
          />
          <div className='video-footer'>
            {stream && <VUMeter streamId={stream && stream.streamId} />}
          </div>
        </div>

        <div className='form-item'>
          <label className={classnames({ 'label-error': !nickname })}>
            Enter your name
          </label>
          <input
            required
            className={classnames({ error: !nickname })}
            name='nickname'
            type='text'
            placeholder='Name'
            autoFocus
            onChange={this.handleNicknameChange}
            value={nickname}
          />
        </div>

        <div className='form-item'>
          <select name='video-input' onChange={this.handleVideoChange} value={videoId} autoComplete='off'>
            <Options devices={props.devices.video} default={DEVICE_DEFAULT_ID} type='videoinput' />
          </select>
        </div>

        <div className='form-item'>
          <select name='audio-input' onChange={this.handleAudioChange} value={audioId} autoComplete='off'>
            <Options devices={props.devices.audio} default={DEVICE_DEFAULT_ID} type='audioinput' />
          </select>
        </div>

        {/* Subtitle language settings */}
        <div className='subtitle-lang-settings'>
          <div className='subtitle-lang-settings__header'>
            <span className='subtitle-lang-settings__icon'>💬</span>
            Live Subtitle Settings
          </div>

          <div className='subtitle-lang-row'>
            <div className='subtitle-lang-item'>
              <label>Language being spoken</label>
              <select
                name='spoken-lang'
                value={spokenLang}
                onChange={this.handleSpokenLangChange}
                autoComplete='off'
              >
                {SUBTITLE_LANGUAGES.map(l => (
                  <option key={l.code} value={l.code}>{l.name}</option>
                ))}
              </select>
            </div>

            <div className='subtitle-lang-arrow' aria-hidden='true'>→</div>

            <div className='subtitle-lang-item'>
              <label>Translate subtitles into</label>
              <select
                name='target-lang'
                value={targetLang}
                onChange={this.handleTargetLangChange}
                autoComplete='off'
              >
                {SUBTITLE_LANGUAGES.map(l => (
                  <option key={l.code} value={l.code}>{l.name}</option>
                ))}
              </select>
            </div>
          </div>

          <p className='subtitle-lang-settings__note'>
            {spokenLang === targetLang
              ? 'Subtitles will appear in the spoken language (no translation).'
              : <>Subtitles translated from <strong>{spokenName}</strong> → <strong>{targetName}</strong> in real time.</>
            }
          </p>
        </div>

        <button type='submit' disabled={!props.joinEnabled}>
          Join Call
        </button>

        <a className='button-abort' href={config.baseUrl || '/'}>
          Abort
        </a>

        {this.state.error && (
          <Message className='message-error'>
            <MdError className='icon' />
            <span>
              Could not get access to microphone or camera. Please grant the
              necessary permissions and try again.
            </span>
          </Message>
        )}

        <Unsupported />

        <div className='network-info'>
          <span>Network: {network}</span>
        </div>
      </form>
    )
  }
}

export interface AutoplayProps {
  play: () => void
}

export const AutoplayMessage = React.memo(function Autoplay(props: AutoplayProps) {
  return (
    <React.Fragment>
      Your browser has blocked video autoplay on this page.
      To continue with your call, please press the play button:
      &nbsp;
      <button className='button' onClick={props.play}>Play</button>
    </React.Fragment>
  )
})

export const Media = c(React.memo(function Media(props: MediaProps) {
  return (
    <div className='media-container'>
      <Alerts>
        {props.autoplayError && (
          <Alert>
            <AutoplayMessage play={props.play} />
          </Alert>
        )}
      </Alerts>
      {props.visible && <MediaForm {...props} />}
    </div>
  )
}))

interface OptionsProps {
  devices: MediaDevice[]
  type: 'audioinput' | 'videoinput'
  default: string
}

const labels = { audioinput: 'Audio', videoinput: 'Video' }

function Options(props: OptionsProps) {
  const label = labels[props.type]
  return (
    <React.Fragment>
      <option value={DEVICE_DISABLED_ID}>No {label}</option>
      <option value={DEVICE_DEFAULT_ID}>Default {label}</option>
      {props.devices.map(device => (
        <option key={device.id} value={device.id}>
          {device.name || device.type}
        </option>
      ))}
    </React.Fragment>
  )
}