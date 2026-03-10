import sounddevice as sd
import numpy as np
import queue
import threading
import asyncio
from websockets import serve
import json
from faster_whisper import WhisperModel
from deep_translator import GoogleTranslator

samplerate = 16000
block_duration  = 0.1
chunk_duration  = 0.7
overlap_duration = 0.3
channels = 1

frames_per_block   = int(samplerate * block_duration)
frames_per_chunk   = int(samplerate * chunk_duration)
frames_overlap     = int(samplerate * overlap_duration)

audio_queue = queue.Queue()
audio_buffer = []
connected_clients = set()
last_text = ""

# Per-client config: { websocket: { spoken_lang: "hi", target_lang: "en" } }
client_config = {}

ALLOWED_LANGUAGES = {
    "en", "hi", "ta", "te", "bn", "mr",
    "gu", "kn", "ml", "pa", "ur", "or",
    "as", "ne", "si",
}

LANGUAGE_NAMES = {
    "en": "English", "hi": "Hindi",   "ta": "Tamil",
    "te": "Telugu",  "bn": "Bengali", "mr": "Marathi",
    "gu": "Gujarati","kn": "Kannada", "ml": "Malayalam",
    "pa": "Punjabi", "ur": "Urdu",    "or": "Odia",
    "as": "Assamese","ne": "Nepali",  "si": "Sinhala",
}

# Mapping from our lang codes to deep_translator / Google Translate codes
TRANSLATOR_LANG_MAP = {
    "en": "en", "hi": "hi", "ta": "ta", "te": "te",
    "bn": "bn", "mr": "mr", "gu": "gu", "kn": "kn",
    "ml": "ml", "pa": "pa", "ur": "ur", "or": "or",
    "as": "as", "ne": "ne", "si": "si",
}

try:
    model = WhisperModel("medium", device="cuda", compute_type="float16")
    print("[Model] Running on GPU (medium float16, multilingual)")
except Exception as e:
    print(f"[Model] GPU failed ({e}), falling back to CPU int8")
    model = WhisperModel("medium", device="cpu", compute_type="int8")

# Global spoken/target language (used as defaults before any client config arrives)
# These are updated when ANY client sends a config message.
# In a single-speaker scenario this works fine.
current_spoken_lang = "hi"   # default: Hindi
current_target_lang = "en"   # default: English

async def ws_handler(websocket):
    global current_spoken_lang, current_target_lang

    connected_clients.add(websocket)
    client_config[websocket] = {
        "spoken_lang": current_spoken_lang,
        "target_lang": current_target_lang,
    }
    print(f"[WS] Client connected. Total: {len(connected_clients)}")

    try:
        async for raw in websocket:
            try:
                msg = json.loads(raw)
                if msg.get("type") == "config":
                    spoken = msg.get("spoken_lang", "hi")
                    target = msg.get("target_lang", "en")
                    client_config[websocket] = {
                        "spoken_lang": spoken,
                        "target_lang": target,
                    }
                    # Update globals so the transcriber uses the latest selection
                    current_spoken_lang = spoken
                    current_target_lang = target
                    print(f"[Config] spoken={spoken}, target={target}")
            except Exception as e:
                print(f"[WS] Bad message: {e}")
    finally:
        connected_clients.discard(websocket)
        client_config.pop(websocket, None)
        print(f"[WS] Client disconnected. Total: {len(connected_clients)}")

async def broadcast(text, spoken_lang_name, target_lang_name):
    if not connected_clients:
        return
    tasks = []
    for client in connected_clients:
        cfg = client_config.get(client, {})
        tgt = cfg.get("target_lang", current_target_lang)
        tgt_name = LANGUAGE_NAMES.get(tgt, tgt)

        # Translate if target differs from spoken language
        translated = text
        spk = cfg.get("spoken_lang", current_spoken_lang)
        if spk != tgt:
            try:
                src_code = TRANSLATOR_LANG_MAP.get(spk, spk)
                tgt_code = TRANSLATOR_LANG_MAP.get(tgt, tgt)
                translated = GoogleTranslator(source=src_code, target=tgt_code).translate(text)
            except Exception as e:
                print(f"[Translate] Error: {e}")

        message = json.dumps({
            "type": "subtitle",
            "text": translated,
            "language": tgt_name,
        })
        tasks.append(client.send(message))

    await asyncio.gather(*tasks, return_exceptions=True)

async def start_ws_server():
    async with serve(ws_handler, "0.0.0.0", 8765, origins=None):
        print("[WS] Server ready on ws://0.0.0.0:8765")
        await asyncio.Future()

def audio_callback(indata, frames, time, status):
    if status:
        print(status)
    audio_queue.put(indata.copy())

def recorder():
    with sd.InputStream(samplerate=samplerate, channels=channels,
                        callback=audio_callback, blocksize=frames_per_block):
        print("Listening... press Ctrl+C to stop")
        while True:
            sd.sleep(100)

loop = asyncio.new_event_loop()

def transcriber():
    global audio_buffer, last_text
    while True:
        block = audio_queue.get()
        audio_buffer.append(block)

        total_frames = sum(len(b) for b in audio_buffer)
        if total_frames >= frames_per_chunk:
            audio_data = np.concatenate(audio_buffer).flatten().astype(np.float32)
            audio_data = audio_data[:frames_per_chunk]

            overlap_frames = np.concatenate(audio_buffer)[-frames_overlap:]
            audio_buffer = [overlap_frames]

            # Use the user-selected spoken language — no auto-detection
            spoken = current_spoken_lang
            lang_name = LANGUAGE_NAMES.get(spoken, spoken)

            segments, info = model.transcribe(
                audio_data,
                language=spoken,           # <-- force the selected language
                beam_size=1,
                best_of=1,
                vad_filter=True,
                vad_parameters=dict(
                    min_silence_duration_ms=200,
                    threshold=0.3,
                ),
                condition_on_previous_text=False,
                without_timestamps=True,
            )

            full_text = " ".join(
                seg.text.strip() for seg in segments if seg.text.strip()
            )

            if not full_text or full_text == last_text:
                continue

            last_text = full_text
            target_name = LANGUAGE_NAMES.get(current_target_lang, current_target_lang)
            print(f"[{lang_name} → {target_name}] {full_text}")

            asyncio.run_coroutine_threadsafe(
                broadcast(full_text, lang_name, target_name), loop
            )

threading.Thread(target=recorder, daemon=True).start()
threading.Thread(target=transcriber, daemon=True).start()

loop.run_until_complete(start_ws_server())