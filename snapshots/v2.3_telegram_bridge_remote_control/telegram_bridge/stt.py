#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
STT Engine using Gemini 1.5/2.5/3.x Flash API.
Handles downloading audio from Telegram and transcribing it to text.
Zero external dependencies (pure standard library: urllib, base64, json).
"""

import json
import base64
import urllib.request
import urllib.error

def get_telegram_file_bytes(bot_token: str, file_id: str) -> tuple[bytes, str]:
    """Downloads an audio/voice file from Telegram Bot API."""
    info_url = f"https://api.telegram.org/bot{bot_token}/getFile?file_id={file_id}"
    req = urllib.request.Request(info_url)
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    
    if not data.get("ok"):
        raise RuntimeError(f"Telegram getFile failed: {data}")
    
    file_path = data["result"]["file_path"]
    download_url = f"https://api.telegram.org/file/bot{bot_token}/{file_path}"
    
    down_req = urllib.request.Request(download_url)
    with urllib.request.urlopen(down_req, timeout=60) as resp:
        file_bytes = resp.read()
    
    # MIME-type
    mime_type = "audio/ogg"
    if file_path.endswith(".mp3"):
        mime_type = "audio/mp3"
    elif file_path.endswith(".wav"):
        mime_type = "audio/wav"
    elif file_path.endswith(".m4a"):
        mime_type = "audio/m4a"
        
    return file_bytes, mime_type

def transcribe_audio_gemini(audio_bytes: bytes, mime_type: str, api_key: str, model_name: str = "gemini-flash-latest") -> str:
    """Transcribes audio using Google Gemini Flash API via REST."""
    if not api_key:
        raise ValueError("GEMINI_API_KEY is not configured")
    
    b64_audio = base64.b64encode(audio_bytes).decode("utf-8")
    
    prompt = (
        "Ты — профессиональный транскрибатор голосовых команд. "
        "Точно распознай русскую речь из этого аудиофайла. "
        "Верни ТОЛЬКО расшифрованный текст команды или сообщения. "
        "Не добавляй никаких вводных слов, кавычек, пояснений или знаков пунктуации кроме естественных."
    )
    
    payload = {
        "contents": [
            {
                "parts": [
                    {
                        "inlineData": {
                            "mimeType": mime_type,
                            "data": b64_audio
                        }
                    },
                    {
                        "text": prompt
                    }
                ]
            }
        ]
    }
    
    # Try primary model, fallback to gemini-2.5-flash if needed
    models_to_try = [model_name, "gemini-flash-latest", "gemini-2.5-flash"]
    last_err = None
    
    for m in models_to_try:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={api_key}"
        data_json = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data_json, headers={"Content-Type": "application/json"})
        
        try:
            with urllib.request.urlopen(req, timeout=45) as resp:
                res_body = json.loads(resp.read().decode("utf-8"))
                candidates = res_body.get("candidates", [])
                if candidates:
                    parts = candidates[0].get("content", {}).get("parts", [])
                    texts = [p.get("text", "") for p in parts if "text" in p]
                    recognized = "".join(texts).strip()
                    if recognized:
                        return recognized
        except urllib.error.HTTPError as e:
            err_text = e.read().decode("utf-8", errors="replace")
            last_err = f"HTTP {e.code}: {err_text}"
            if e.code == 404:
                continue
            raise RuntimeError(f"Gemini API Error ({last_err})")
        except Exception as e:
            last_err = str(e)
            continue
            
    raise RuntimeError(f"Не удалось распознать речь через Gemini API: {last_err}")
