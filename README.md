# PeerCalls — Real-Time Multilingual Video Calls with Live Subtitles

> A WebRTC-based group video calling app with AI-powered live transcription and translation — speak in any language, everyone reads in theirs.

I vibecoded this, this is my first project.

## What is this?

This project extends the open-source [peer-calls](https://github.com/peer-calls/peer-calls) video calling app with a real-time subtitle system powered by OpenAI's Whisper model. Every participant's speech is transcribed and translated live — so a Hindi speaker and a French speaker can have a natural conversation, each reading subtitles in their own language.

Before checking the demo the user has to manually start the collab server to start the model after which live transcription will occur. Go on the below link and execute the commands in it.



**Note:** currently tested for two users might show strange behavious on more than that

---

## Features

- **Group video calls** — peer-to-peer WebRTC mesh, no media server required
- **Live transcription** — OpenAI Whisper (medium model) running on GPU
- **Live translation** — Google Translate API via deep-translator, per-participant target language
- **Noise filtering** — VAD threshold, RMS energy gate, per-segment confidence filtering
- **Per-user language settings** — each participant independently sets spoken and target language

---

## Architecture

```
Browser (Participant A)          Browser (Participant B)
        │                                  │
        │  WebRTC mesh (video/audio)       │
        └──────────────────────────────────┘
        │                                  │
        │  WSS /subtitles                  │  WSS /subtitles
        ▼                                  ▼
┌─────────────────────────────────────────────┐
│           Go Server (Render)                │
│         peer-calls v4 + subtitle proxy      │
│  /call/:id   /ws   /subtitles (WS proxy)    │
└─────────────────────┬───────────────────────┘
                      │ wss proxy
                      ▼
┌─────────────────────────────────────────────┐
│         Python Transcription Server         │
│         (Google Colab T4 GPU + ngrok)       │
│                                             │
│  faster-whisper medium  →  deep-translator  │
│  VAD + noise gate + confidence filter       │
│  Room registry → broadcast to all clients   │
└─────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Video calling | [peer-calls v4](https://github.com/peer-calls/peer-calls) — Go + TypeScript |
| WebRTC | Mesh mode, STUN + TURN (openrelay) |
| Transcription | [faster-whisper](https://github.com/guillaumekln/faster-whisper) medium model |
| Translation | [deep-translator](https://github.com/nidhaloff/deep-translator) (Google Translate) |
| Subtitle overlay | Custom TypeScript — `SubtitleOverlay` class with Web Audio API |
| Tunneling | [ngrok](https://ngrok.com) static domain |
| Deployment | [Render](https://render.com) (Go server) + Google Colab T4 GPU (Python server) |

---

## How it works

### Subtitle pipeline

1. When a participant joins a call, `SubtitleOverlay.ts` opens a WebSocket to `/subtitles` on the Go server
2. The Go server proxies this WebSocket connection to the Python transcription server via ngrok
3. The browser captures microphone audio using the Web Audio API (`ScriptProcessorNode` at 16kHz)
4. Raw PCM float32 audio chunks (1 second each, 50% overlap) are sent as binary WebSocket frames
5. The Python server runs faster-whisper on each chunk with:
   - RMS energy gate (drops silent audio before it hits the GPU)
   - Silero VAD with strict threshold (0.65) to filter non-speech
   - Per-segment confidence filtering (`no_speech_prob`, `avg_logprob`)
6. Transcribed text is translated for each participant's target language via Google Translate
7. Subtitle JSON is broadcast to **all participants in the same room** simultaneously
8. Each browser's `SubtitleOverlay` displays the subtitle with a fade-out after 3 seconds

### Room tracking

Each client sends a `config` message on connect containing `room_id` (extracted from the call URL), `spoken_lang`, and `target_lang`. The server maintains a room registry and routes subtitles only to clients in the same room.

---

## Running locally

### Prerequisites

- Go 1.19+
- Node.js 18+
- Python 3.10+
- CUDA GPU (for Whisper) or CPU fallback

### 1. Clone and build the Go server

```bash
git clone https://github.com/YOUR_USERNAME/peer-calls.git
cd peer-calls
npm install
npm run build
go build -o peer-calls
./peer-calls -c config.yaml
```

### 2. Start the Python transcription server

```bash
pip install uvicorn starlette faster-whisper deep-translator pyngrok websockets
python transcription_server.py
```

### 3. Set environment variables

```bash
export SUBTITLE_WS_URL=http://localhost:8765   # local
export PEERCALLS_BIND_PORT=3000
```

Open `http://localhost:3000`

---

## Deployment

### Go server → Render

1. Push to GitHub
2. Connect repo on [render.com](https://render.com)
3. Set runtime to **Docker**
4. Add env var: `SUBTITLE_WS_URL=https://your-ngrok-domain.ngrok-free.dev`
5. Deploy

### Python transcription server → Google Colab

1. Open `transcription_server.ipynb` in Google Colab
2. Set runtime to **T4 GPU**
3. Add `NGROK_TOKEN` to Colab secrets
4. Run all cells

The ngrok static domain keeps the URL stable across Colab sessions.

---

## Configuration

### Adding languages

Languages are defined in two places:

- `src/Media.tsx` — `SUBTITLE_LANGUAGES` array (frontend dropdown)
- Colab server — `LANGUAGE_NAMES` dict (display names for subtitles)

Whisper medium supports 99 languages. Any [ISO 639-1 language code](https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes) works.

### Noise tuning

In the Colab server:

| Parameter | Default | Effect |
|---|---|---|
| `MIN_ENERGY` | `0.018` | Raise to reduce background noise pickup |
| `threshold` (VAD) | `0.65` | Raise to require more confident speech detection |
| `no_speech_threshold` | `0.65` | Raise to drop more uncertain segments |
| `FRAMES_PER_CHUNK` | `16000` (1s) | Raise for more context, higher latency |

---

## What I built on top of peer-calls

This repo extends the original peer-calls with:

- `src/SubtitleOverlay.ts` — new file, WebSocket + Web Audio API audio capture + subtitle display
- `src/Media.tsx` — added language selector UI and `startAudio()` call on join
- `server/mux.go` — added `/subtitles` WebSocket proxy route using gorilla/websocket
- `config.yaml` — STUN/TURN server configuration
- `transcription_server.ipynb` — new Colab notebook with the full Python pipeline

---

## Known limitations

- Colab session must be kept alive manually (free tier disconnects after ~12 hours)
- Subtitle latency is ~0.5-1.5s depending on GPU queue depth
- Two simultaneous speakers: second speaker queues behind first (~1-2s extra delay)
- Render free tier sleeps after 15 min inactivity (30s cold start)

---

## Credits

- [peer-calls](https://github.com/peer-calls/peer-calls) by jeremija — the WebRTC foundation this is built on
- [faster-whisper](https://github.com/guillaumekln/faster-whisper) — CTranslate2 optimized Whisper
- [OpenAI Whisper](https://github.com/openai/whisper) — the underlying speech recognition model

---

## License

Apache 2.0 — same as the original peer-calls project.
