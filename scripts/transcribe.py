import sounddevice as sd
import numpy as np
import queue
import threading
import asyncio
from websockets import serve
import json
from faster_whisper import WhisperModel

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

# model = WhisperModel("small.en", device="cpu", compute_type="int8")
# print("[Model] Running on CPU (only english)")

try:
    model = WhisperModel("medium", device="cuda", compute_type="float16")
    print("[Model] Running on GPU (medium float16, multilingual)")
except Exception as e:
    print(f"[Model] GPU failed ({e}), falling back to CPU int8")
    model = WhisperModel("medium", device="cpu", compute_type="int8")

async def ws_handler(websocket):
    connected_clients.add(websocket)
    print(f"[WS] Client connected. Total: {len(connected_clients)}")
    try:
        await websocket.wait_closed()
    finally:
        connected_clients.discard(websocket)
        print(f"[WS] Client disconnected. Total: {len(connected_clients)}")

async def broadcast(text, language=None):
    if connected_clients:
        message = json.dumps({"type": "subtitle", "text": text, "language": language})
        await asyncio.gather(
            *[client.send(message) for client in connected_clients],
            return_exceptions=True
        )

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

            segments, info = model.transcribe(
                audio_data,
                beam_size=1,
                best_of=1,
                vad_filter=True,
                vad_parameters=dict(
                    min_silence_duration_ms=200,
                    threshold=0.3,
                ),
                condition_on_previous_text=False,
                without_timestamps=True,
                initial_prompt="Hindi, Tamil, Telugu, Bengali, Marathi, Gujarati, Kannada, Malayalam, Punjabi, Urdu or English speech.",
            )

            detected = info.language
            confidence = info.language_probability
            lang_name = LANGUAGE_NAMES.get(detected, detected)

            if detected not in ALLOWED_LANGUAGES:
                print(f"[Skipped] {lang_name} ({confidence:.0%})")
                continue

            full_text = " ".join(
                seg.text.strip() for seg in segments if seg.text.strip()
            )

            if not full_text or full_text == last_text:
                continue

            last_text = full_text
            print(f"[{lang_name} {confidence:.0%}] {full_text}")
            asyncio.run_coroutine_threadsafe(
                broadcast(full_text, lang_name), loop
            )

threading.Thread(target=recorder, daemon=True).start()
threading.Thread(target=transcriber, daemon=True).start()

loop.run_until_complete(start_ws_server())