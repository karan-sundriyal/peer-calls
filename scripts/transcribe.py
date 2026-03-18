import asyncio
import numpy as np
import json
from websockets import serve
from websockets.server import WebSocketServerProtocol
from faster_whisper import WhisperModel
from deep_translator import GoogleTranslator

# =======================
# Model setup
# =======================
try:
    model = WhisperModel("medium", device="cuda", compute_type="float16")
    print("[Model] Running on GPU")
except Exception as e:
    print(f"[Model] GPU failed ({e}), using CPU")
    model = WhisperModel("medium", device="cpu", compute_type="int8")

# =======================
# Audio config
# =======================
samplerate = 16000
chunk_duration = 0.7
frames_per_chunk = int(samplerate * chunk_duration)

# =======================
# Client state
# =======================
connected_clients = set()
client_config = {}
audio_buffers = {}
last_texts = {}

# =======================
# Language mapping
# =======================
LANGUAGE_NAMES = {
    "en": "English", "hi": "Hindi",   "ta": "Tamil",
    "te": "Telugu",  "bn": "Bengali", "mr": "Marathi",
    "gu": "Gujarati","kn": "Kannada", "ml": "Malayalam",
    "pa": "Punjabi", "ur": "Urdu",    "or": "Odia",
    "as": "Assamese","ne": "Nepali",  "si": "Sinhala",
}

# =======================
# WebSocket handler
# =======================
async def ws_handler(websocket: WebSocketServerProtocol):
    connected_clients.add(websocket)

    client_config[websocket] = {
        "spoken_lang": "hi",
        "target_lang": "en",
    }

    audio_buffers[websocket] = np.array([], dtype=np.float32)
    last_texts[websocket] = ""

    print(f"[WS] Client connected. Total: {len(connected_clients)}")

    try:
        async for message in websocket:

            # -----------------------
            # TEXT = config message
            # -----------------------
            if isinstance(message, str):
                try:
                    msg = json.loads(message)

                    if msg.get("type") == "config":
                        client_config[websocket] = {
                            "spoken_lang": msg.get("spoken_lang", "hi"),
                            "target_lang": msg.get("target_lang", "en"),
                        }

                        print(f"[Config] {client_config[websocket]}")

                except Exception as e:
                    print(f"[WS] Bad config: {e}")

            # -----------------------
            # BINARY = audio chunk
            # -----------------------
            elif isinstance(message, bytes):
                chunk = np.frombuffer(message, dtype=np.float32)

                audio_buffers[websocket] = np.concatenate(
                    [audio_buffers[websocket], chunk]
                )

                if len(audio_buffers[websocket]) >= frames_per_chunk:
                    await process_audio(websocket)

    finally:
        connected_clients.discard(websocket)
        client_config.pop(websocket, None)
        audio_buffers.pop(websocket, None)
        last_texts.pop(websocket, None)

        print(f"[WS] Client disconnected. Total: {len(connected_clients)}")

# =======================
# Audio processing
# =======================
async def process_audio(websocket):
    cfg = client_config.get(websocket, {})

    spoken = cfg.get("spoken_lang", "hi")
    target = cfg.get("target_lang", "en")

    data = audio_buffers[websocket][:frames_per_chunk]

    # 50% overlap for smoother transcription
    audio_buffers[websocket] = audio_buffers[websocket][frames_per_chunk // 2:]

    # -----------------------
    # Transcription
    # -----------------------
    segments, _ = model.transcribe(
        data,
        language=spoken,
        beam_size=1,
        best_of=1,
        vad_filter=True,
        without_timestamps=True,
        vad_parameters=dict(
            min_silence_duration_ms=200,
            threshold=0.3,
        ),
    )

    text = " ".join(s.text.strip() for s in segments if s.text.strip())

    if not text or text == last_texts.get(websocket, ""):
        return

    last_texts[websocket] = text

    print(f"[{spoken} → {target}] {text}")

    # -----------------------
    # Translation
    # -----------------------
    translated = text
    if spoken != target:
        try:
            translated = GoogleTranslator(source=spoken, target=target).translate(text)
        except Exception as e:
            print(f"[Translate] Error: {e}")

    # -----------------------
    # Send result
    # -----------------------
    message = json.dumps({
        "type": "subtitle",
        "text": translated,
        "language": LANGUAGE_NAMES.get(target, target),
    })

    await websocket.send(message)

# =======================
# Server start
# =======================
async def main():
    async with serve(ws_handler, "0.0.0.0", 8765):
        print("[WS] Server running on ws://0.0.0.0:8765")
        await asyncio.Future()

asyncio.run(main())