#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Telegram Bridge Daemon for Antigravity.
Provides two-way interaction between Antigravity chat session and Telegram Bot:
- Remote task creation (text & voice via Gemini Flash STT)
- Remote command approval with Telegram inline buttons
- Task completion notifications with concise 1-sentence (10-20 words) summaries
- Automatic .md plan attachment if /plan was requested
- Live Antigravity connection status bar in a pinned message (updated every 45 sec)
- Strict security gate (@tvoyaddoma, +79266011608)
Zero external dependencies (pure standard library: urllib, http.server, threading, json, subprocess).
"""

from __future__ import annotations

import os
import sys
import json
import time
import uuid
import threading
import subprocess
import re
import socket
import datetime
import urllib.request
import urllib.parse
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler

# Local imports
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

from stt import get_telegram_file_bytes, transcribe_audio_gemini

CONFIG_FILE = os.path.join(CURRENT_DIR, "config.json")

# Thread-safe pending approval dictionary
# request_id -> {"event": threading.Event(), "decision": "ask", "command": str}
PENDING_APPROVALS = {}
APPROVALS_LOCK = threading.Lock()

def load_config() -> dict:
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"[Config] Error loading {CONFIG_FILE}: {e}", file=sys.stderr)
    return {
        "bot_token": os.environ.get("TELEGRAM_BOT_TOKEN", ""),
        "allowed_username": "tvoyaddoma",
        "allowed_phone": "79266011608",
        "allowed_chat_id": 275899743,
        "status_message_id": None,
        "conversation_id": "e942a502-2c31-4a43-9392-a2b04b0a99ba",
        "gemini_api_key": os.environ.get("GEMINI_API_KEY", ""),
        "gemini_model": "gemini-3.5-flash-lite",
        "ipc_port": 18822,
        "agentapi_path": "/Applications/Gemini.app/Contents/Helpers/agy"
    }

def save_config(cfg: dict):
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"[Config] Error saving {CONFIG_FILE}: {e}", file=sys.stderr)

CONFIG = load_config()

def escape_html(text: str) -> str:
    """Escapes special characters for Telegram HTML mode."""
    return (text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

# --- TELEGRAM API HELPERS ---

def tg_api_call(method: str, params: dict = None) -> dict:
    bot_token = CONFIG.get("bot_token")
    url = f"https://api.telegram.org/bot{bot_token}/{method}"
    data = None
    headers = {}
    if params:
        data = json.dumps(params).encode("utf-8")
        headers = {"Content-Type": "application/json"}
    
    poll_timeout = params.get("timeout") if params else 0
    client_timeout = (poll_timeout + 20) if poll_timeout else 30
    
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=client_timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            err_body = e.read().decode("utf-8")
            err_json = json.loads(err_body)
            desc = err_json.get("description", str(e))
            if "message is not modified" in desc.lower():
                return {"ok": True, "result": True}
            return {"ok": False, "error": desc, "error_code": e.code}
        except Exception:
            return {"ok": False, "error": str(e), "error_code": e.code}
    except urllib.error.URLError as e:
        err_str = str(e).lower()
        if "timed out" in err_str or "eof occurred" in err_str:
            return {"ok": True, "result": []}
        print(f"[Telegram Network Error] {method}: {e}", file=sys.stderr)
        return {"ok": False, "error": str(e)}
    except Exception as e:
        err_str = str(e).lower()
        if "timed out" in err_str or "eof occurred" in err_str or "connection reset" in err_str:
            return {"ok": True, "result": []}
        print(f"[Telegram API Error] {method}: {e}", file=sys.stderr)
        return {"ok": False, "error": str(e)}

def tg_send_message(chat_id: int, text: str, reply_markup: dict = None) -> dict:
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML"
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
    res = tg_api_call("sendMessage", payload)
    if res.get("ok"):
        print(f"[Telegram] Sent message to chat {chat_id}: {text[:60]}...", flush=True)
    else:
        print(f"[Telegram Error] sendMessage failed: {res}", file=sys.stderr)
    return res

def tg_answer_callback(callback_query_id: str, text: str = ""):
    tg_api_call("answerCallbackQuery", {
        "callback_query_id": callback_query_id,
        "text": text
    })

def tg_edit_message_text(chat_id: int, message_id: int, text: str, reply_markup: dict = None) -> dict:
    payload = {
        "chat_id": chat_id,
        "message_id": message_id,
        "text": text,
        "parse_mode": "HTML"
    }
    if reply_markup is not None:
        payload["reply_markup"] = reply_markup
    return tg_api_call("editMessageText", payload)

def tg_pin_chat_message(chat_id: int, message_id: int, disable_notification: bool = True) -> dict:
    payload = {
        "chat_id": chat_id,
        "message_id": message_id,
        "disable_notification": disable_notification
    }
    return tg_api_call("pinChatMessage", payload)

def tg_send_document(chat_id: int, file_path: str, caption: str = "") -> dict:
    """Sends a local document (e.g. .md plan) via multipart/form-data."""
    bot_token = CONFIG.get("bot_token")
    url = f"https://api.telegram.org/bot{bot_token}/sendDocument"
    boundary = f"----FormBoundary{uuid.uuid4().hex}"
    
    if not os.path.exists(file_path):
        return {"ok": False, "error": f"File not found: {file_path}"}
        
    filename = os.path.basename(file_path)
    with open(file_path, "rb") as f:
        file_bytes = f.read()
        
    lines = []
    lines.append(f"--{boundary}".encode("utf-8"))
    lines.append(b'Content-Disposition: form-data; name="chat_id"')
    lines.append(b"")
    lines.append(str(chat_id).encode("utf-8"))
    
    if caption:
        lines.append(f"--{boundary}".encode("utf-8"))
        lines.append(b'Content-Disposition: form-data; name="caption"')
        lines.append(b"")
        lines.append(caption.encode("utf-8"))
        lines.append(f"--{boundary}".encode("utf-8"))
        lines.append(b'Content-Disposition: form-data; name="parse_mode"')
        lines.append(b"")
        lines.append(b"HTML")
        
    lines.append(f"--{boundary}".encode("utf-8"))
    lines.append(f'Content-Disposition: form-data; name="document"; filename="{filename}"'.encode("utf-8"))
    lines.append(b"Content-Type: text/markdown; charset=utf-8")
    lines.append(b"")
    lines.append(file_bytes)
    lines.append(f"--{boundary}--".encode("utf-8"))
    lines.append(b"")
    
    body = b"\r\n".join(lines)
    headers = {
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Content-Length": str(len(body))
    }
    req = urllib.request.Request(url, data=body, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            err_body = e.read().decode("utf-8")
            return json.loads(err_body)
        except Exception:
            return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": str(e)}

def tg_send_chat_action(chat_id: int, action: str = "typing"):
    tg_api_call("sendChatAction", {"chat_id": chat_id, "action": action})

# --- TASK SUMMARY GENERATOR ---

def generate_task_summary(user_text: str, assistant_text: str, api_key: str, model_name: str = "gemini-3.5-flash-lite") -> str:
    """
    Generates a concise 1-sentence (10-20 words) Russian summary of completed work.
    Strictly focuses on what was done without lengthy explanations.
    """
    if not api_key:
        return _fallback_summary(assistant_text, user_text)

    prompt = (
        "Сформируй краткое описание проделанной работы для Telegram-уведомления.\n"
        "Требования:\n"
        "1. СТРОГО ОДНО предложение.\n"
        "2. Длина: от 10 до 20 слов.\n"
        "3. Язык: русский.\n"
        "4. Сразу передавай суть того, что сделано (без вводных слов вроде 'В ходе задачи...', 'Я успешно...', 'Было выполнено...').\n\n"
        f"Запрос пользователя:\n{user_text[:600]}\n\n"
        f"Результат работы:\n{assistant_text[:1200]}"
    )

    candidate_models = [
        model_name,
        "gemini-3.5-flash-lite",
        "gemini-3.1-flash-lite",
        "gemini-3.5-flash",
        "gemini-flash-latest"
    ]
    models_to_try = []
    for cand in candidate_models:
        if cand and cand not in models_to_try:
            models_to_try.append(cand)

    for m in models_to_try:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={api_key}"
        payload = {"contents": [{"parts": [{"text": prompt}]}]}
        data_json = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data_json, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                res_body = json.loads(resp.read().decode("utf-8"))
                candidates = res_body.get("candidates", [])
                if candidates:
                    parts = candidates[0].get("content", {}).get("parts", [])
                    texts = [p.get("text", "") for p in parts if "text" in p]
                    summary = "".join(texts).strip()
                    if summary:
                        summary = summary.replace("\n", " ").replace('"', '').strip()
                        return summary
        except Exception as e:
            print(f"[Summary Generation] Error with {m}: {e}", file=sys.stderr)
            continue

    return _fallback_summary(assistant_text, user_text)

def _fallback_summary(assistant_text: str, user_text: str) -> str:
    """Fallback 1-sentence extraction if AI summary fails."""
    if assistant_text:
        lines = [l.strip() for l in assistant_text.splitlines() if l.strip() and not l.strip().startswith(("#", "```", "---"))]
        for line in lines:
            clean = re.sub(r"[*_`#]", "", line).strip()
            if len(clean) > 15:
                sentences = re.split(r"[.!?]\s+", clean)
                if sentences and len(sentences[0]) > 10:
                    return sentences[0].strip().rstrip(".!?") + "."
    if user_text:
        clean_u = re.sub(r"[*_`#]", "", user_text).strip()
        words = clean_u.split()
        if len(words) <= 20:
            return f"Выполнено: {clean_u}"
        return f"Выполнено: {' '.join(words[:18])}..."
    return "Задача успешно выполнена, все действия завершены."

# --- ANTIGRAVITY STATUS & LAPTOP POWER ---

def get_antigravity_status() -> tuple[bool, int]:
    """Checks if Antigravity / agy process is alive and its hub socket is responding."""
    try:
        out = subprocess.check_output(["ps", "aux"], text=True)
        m = re.search(r"--hub-port=(\d+)", out)
        if m:
            port = int(m.group(1))
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(2)
            err = s.connect_ex(("127.0.0.1", port))
            s.close()
            if err == 0:
                return True, port
            return False, port
    except Exception:
        pass
    return False, 0

def get_laptop_power_status() -> str:
    """Gets power source and battery percentage on macOS via pmset."""
    try:
        out = subprocess.check_output(["pmset", "-g", "batt"], text=True)
        is_ac = "AC Power" in out
        pct_match = re.search(r"(\d+)%", out)
        pct = f"{pct_match.group(1)}%" if pct_match else ""
        if is_ac:
            return f"🔌 Питание от сети ({pct})" if pct else "🔌 Питание от сети"
        else:
            return f"🔋 Батарея ({pct})" if pct else "🔋 Батарея"
    except Exception:
        return "💻 Ноутбук активен"

# --- STATUS BAR HEARTBEAT THREAD ---

def status_heartbeat_loop():
    """Periodically (every 45 sec) updates the pinned status bar in Telegram."""
    print("[Status Bar] Starting connection heartbeat loop (45s)...", flush=True)
    time.sleep(3)  # initial brief warm-up
    
    while True:
        try:
            chat_id = CONFIG.get("allowed_chat_id")
            if not chat_id:
                time.sleep(5)
                continue
                
            is_online, port = get_antigravity_status()
            power_info = get_laptop_power_status()
            now_str = datetime.datetime.now().strftime("%H:%M:%S")
            
            if is_online:
                status_text = (
                    "🟢 <b>Статус-бар: Antigravity в сети (Online)</b>\n\n"
                    f"💻 <b>Ноутбук:</b> {power_info}\n"
                    f"📡 <b>Связь:</b> Активна (порт {port})\n"
                    f"⏱ <b>Пинг:</b> {now_str} • Каждые 45 сек\n\n"
                    "<i>💡 Если время не обновляется &gt;1 мин — ноутбук выключен, спит или потеряна связь.</i>"
                )
            else:
                status_text = (
                    "🟡 <b>Статус-бар: Ожидание Antigravity</b>\n\n"
                    f"💻 <b>Ноутбук:</b> {power_info} • Antigravity не отвечает\n"
                    f"⏱ <b>Пинг:</b> {now_str} • Каждые 45 сек\n\n"
                    "<i>💡 Процесс Antigravity перезапускается или закрыт.</i>"
                )
                
            msg_id = CONFIG.get("status_message_id")
            need_new_message = False
            
            if msg_id:
                res = tg_edit_message_text(chat_id, msg_id, status_text)
                if not res.get("ok"):
                    err = str(res.get("error", ""))
                    if "message is not modified" in err:
                        pass
                    elif "message to edit not found" in err or "chat not found" in err:
                        need_new_message = True
            else:
                need_new_message = True
                
            if need_new_message:
                send_res = tg_send_message(chat_id, status_text)
                if send_res.get("ok"):
                    new_id = send_res["result"]["message_id"]
                    CONFIG["status_message_id"] = new_id
                    save_config(CONFIG)
                    tg_pin_chat_message(chat_id, new_id, disable_notification=True)
                    print(f"[Status Bar] Created and pinned new status message #{new_id}", flush=True)
                    
        except Exception as e:
            print(f"[Status Bar Error] {e}", file=sys.stderr)
            
        time.sleep(45)

# --- ANTIGRAVITY AGENTAPI INTEGRATION ---

SESSION_FILE = os.path.join(CURRENT_DIR, "session.json")

def get_agent_env() -> dict:
    env = os.environ.copy()
    
    if CONFIG.get("ls_address"):
        env["ANTIGRAVITY_LS_ADDRESS"] = CONFIG["ls_address"]
    if CONFIG.get("csrf_token"):
        env["ANTIGRAVITY_CSRF_TOKEN"] = CONFIG["csrf_token"]
        
    if os.path.exists(SESSION_FILE):
        try:
            with open(SESSION_FILE, "r", encoding="utf-8") as f:
                s = json.load(f)
                if s.get("ls_address") and "ANTIGRAVITY_LS_ADDRESS" not in env:
                    env["ANTIGRAVITY_LS_ADDRESS"] = s["ls_address"]
                if s.get("csrf_token") and "ANTIGRAVITY_CSRF_TOKEN" not in env:
                    env["ANTIGRAVITY_CSRF_TOKEN"] = s["csrf_token"]
        except Exception as e:
            print(f"[Session] Error reading {SESSION_FILE}: {e}", file=sys.stderr)
            
    if "ANTIGRAVITY_LS_ADDRESS" not in env:
        try:
            out = subprocess.check_output(["ps", "aux"], text=True)
            m = re.search(r"--hub-port=(\d+)", out)
            if m:
                env["ANTIGRAVITY_LS_ADDRESS"] = f"localhost:{m.group(1)}"
        except Exception:
            pass
            
    return env

def send_to_antigravity(text: str) -> bool:
    agentapi_path = CONFIG.get("agentapi_path", "/Applications/Gemini.app/Contents/Helpers/agy")
    conv_id = CONFIG.get("conversation_id", "e942a502-2c31-4a43-9392-a2b04b0a99ba")
    
    cmd = [agentapi_path, "agentapi", "send-message", conv_id, text]
    print(f"[Antigravity] Forwarding message to conversation {conv_id}...", flush=True)
    
    env = get_agent_env()
    try:
        res = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=15)
        if res.returncode == 0:
            print(f"[Antigravity] Successfully forwarded: {res.stdout.strip()}", flush=True)
            return True
        else:
            print(f"[Antigravity] agentapi failed (code {res.returncode}): {res.stderr} | {res.stdout}", file=sys.stderr)
            return False
    except Exception as e:
        print(f"[Antigravity] Exception running agentapi: {e}", file=sys.stderr)
        return False

# --- AUTHORIZATION GATE ---

def is_authorized(user_obj: dict) -> bool:
    if not user_obj:
        return False
    
    uid = user_obj.get("id")
    username = (user_obj.get("username") or "").lower().lstrip("@")
    allowed_u = CONFIG.get("allowed_username", "tvoyaddoma").lower().lstrip("@")
    allowed_id = CONFIG.get("allowed_chat_id")
    
    if allowed_id and uid == allowed_id:
        return True
    
    if username == allowed_u:
        CONFIG["allowed_chat_id"] = uid
        save_config(CONFIG)
        print(f"[Security] Auto-bound allowed_chat_id to {uid} for user @{username}", flush=True)
        return True
        
    return False

# --- TELEGRAM UPDATES HANDLER ---

def process_telegram_update(update: dict):
    if "callback_query" in update:
        cb = update["callback_query"]
        sender = cb.get("from", {})
        if not is_authorized(sender):
            tg_answer_callback(cb["id"], "⛔️ Доступ запрещен")
            return
            
        data = cb.get("data", "")
        message = cb.get("message", {})
        chat_id = message.get("chat", {}).get("id")
        msg_id = message.get("message_id")
        
        if data.startswith("approve:") or data.startswith("deny:"):
            parts = data.split(":", 1)
            action = parts[0]
            req_id = parts[1]
            
            with APPROVALS_LOCK:
                if req_id in PENDING_APPROVALS:
                    entry = PENDING_APPROVALS[req_id]
                    if action == "approve":
                        entry["decision"] = "allow"
                        tg_answer_callback(cb["id"], "✅ Разрешено!")
                        tg_edit_message_text(
                            chat_id, msg_id,
                            f"✅ <b>Действие подтверждено:</b>\n<code>{entry['command']}</code>",
                            reply_markup={"inline_keyboard": []}
                        )
                    else:
                        entry["decision"] = "deny"
                        tg_answer_callback(cb["id"], "❌ Отклонено!")
                        tg_edit_message_text(
                            chat_id, msg_id,
                            f"❌ <b>Действие отклонено:</b>\n<code>{entry['command']}</code>",
                            reply_markup={"inline_keyboard": []}
                        )
                    entry["event"].set()
                else:
                    tg_answer_callback(cb["id"], "Срок действия запроса истек")
        return

    if "message" in update:
        msg = update["message"]
        sender = msg.get("from", {})
        chat_id = msg.get("chat", {}).get("id")
        
        if not is_authorized(sender):
            if "contact" in msg:
                phone = str(msg["contact"].get("phone_number", "")).replace("+", "").replace(" ", "")
                allowed_p = CONFIG.get("allowed_phone", "79266011608")
                if phone == allowed_p:
                    CONFIG["allowed_chat_id"] = sender.get("id")
                    save_config(CONFIG)
                    tg_send_message(chat_id, "✅ Номер телефона подтвержден! Доступ к управлению Antigravity активирован.")
                    return
            
            tg_send_message(chat_id, "⛔️ <b>Доступ ограничен.</b>\nЭтот бот предназначен для приватного управления сессией Antigravity владельцем @tvoyaddoma.")
            return

        text = msg.get("text", "").strip()
        if text.startswith("/start") or text.startswith("/help"):
            tg_send_message(
                chat_id,
                "👋 <b>Приветствую, Иван!</b>\n\n"
                "🤖 Бот успешно соединен с вашей текущей сессией Antigravity.\n\n"
                "<b>Возможности:</b>\n"
                "• 📝 <b>Текстовые задачи:</b> напишите задачу сюда, и она сразу появится в чате Antigravity.\n"
                "• 🎙 <b>Голосовые заметки:</b> отправьте голосовое — Gemini Flash мгновенно распознает речь и передаст задачу.\n"
                "• ⚡️ <b>Удаленные подтверждения:</b> при запуске команд бот пришлет кнопки подтверждения прямо на телефон.\n"
                "• 🏁 <b>Уведомление о готовности:</b> краткая сводка (10-20 слов) по завершении каждого шага.\n"
                "• 📄 <b>Планы задач:</b> если в запросе был /plan, готовый .md файл сразу прикрепится к сообщению.\n"
                "• 📌 <b>Статус-бар:</b> закрепленное сообщение показывает реальное состояние подключения ноутбука каждые 45 сек."
            )
            return

        if "voice" in msg or "audio" in msg:
            voice = msg.get("voice") or msg.get("audio")
            file_id = voice.get("file_id")
            tg_send_chat_action(chat_id, "typing")
            
            try:
                bot_token = CONFIG.get("bot_token")
                api_key = CONFIG.get("gemini_api_key")
                model_name = CONFIG.get("gemini_model", "gemini-3.5-flash-lite")
                
                audio_bytes, mime = get_telegram_file_bytes(bot_token, file_id)
                recognized_text = transcribe_audio_gemini(audio_bytes, mime, api_key, model_name)
                
                if recognized_text:
                    tg_send_message(chat_id, f"🎙 <b>Распознано:</b>\n«<i>{recognized_text}</i>»\n\n📥 <i>Передано в Antigravity...</i>")
                    send_to_antigravity(f"Голосовая задача от владельца (@tvoyaddoma): {recognized_text}")
                else:
                    tg_send_message(chat_id, "⚠️ Не удалось распознать слова в аудиозаписи.")
            except Exception as e:
                print(f"[STT Error] {e}", file=sys.stderr)
                tg_send_message(chat_id, f"⚠️ Ошибка транскрипции: {e}")
            return

        if text:
            tg_send_message(chat_id, "📥 <i>Задача принята и передана в Antigravity...</i>")
            send_to_antigravity(f"Задача от владельца (@tvoyaddoma): {text}")
            return

# --- LONG POLLING THREAD ---

def telegram_poller_loop():
    print("[Telegram Poller] Starting long polling...", flush=True)
    offset = 0
    while True:
        try:
            res = tg_api_call("getUpdates", {"offset": offset, "timeout": 25})
            if res.get("ok"):
                updates = res.get("result", [])
                for u in updates:
                    offset = u["update_id"] + 1
                    try:
                        process_telegram_update(u)
                    except Exception as err:
                        print(f"[Poller Error] Failed processing update: {err}", file=sys.stderr)
            else:
                time.sleep(3)
        except Exception as e:
            print(f"[Poller Loop Exception] {e}", file=sys.stderr)
            time.sleep(5)

# --- NOTIFICATION DISPATCHER ---

def handle_notify_finished_async(chat_id: int, payload: dict):
    """Processes task completion notification asynchronously."""
    try:
        user_req = payload.get("user_request", "")
        asst_resp = payload.get("assistant_response", "")
        plan_path = payload.get("plan_path")
        
        api_key = CONFIG.get("gemini_api_key", "")
        model_name = CONFIG.get("gemini_model", "gemini-3.5-flash-lite")
        
        # 1. Generate short 1-sentence (10-20 words) summary
        summary = generate_task_summary(user_req, asst_resp, api_key, model_name)
        
        # 2. Build message text
        full_text = (
            "🏁 <b>Antigravity: Задача выполнена!</b>\n\n"
            f"📝 <i>{escape_html(summary)}</i>"
        )
        
        # 3. If plan requested and file exists: attach as document
        if plan_path and os.path.exists(plan_path):
            doc_res = tg_send_document(chat_id, plan_path, caption=full_text)
            if not doc_res.get("ok"):
                # Fallback: send text then document
                tg_send_message(chat_id, full_text)
                tg_send_document(chat_id, plan_path)
            print(f"[Notifier] Sent completion notification with plan {os.path.basename(plan_path)}", flush=True)
        else:
            tg_send_message(chat_id, full_text)
            print(f"[Notifier] Sent completion notification without document", flush=True)
            
    except Exception as e:
        print(f"[Notifier Error] {e}", file=sys.stderr)

# --- LOCAL IPC HTTP SERVER FOR ANTIGRAVITY HOOKS ---

class LocalIPCHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        if self.path == "/health":
            self._send_json({"status": "ok", "allowed_chat_id": CONFIG.get("allowed_chat_id")})
        else:
            self._send_json({"error": "Not found"}, status=404)

    def do_POST(self):
        content_len = int(self.headers.get("Content-Length", 0))
        post_data = self.rfile.read(content_len)
        try:
            payload = json.loads(post_data.decode("utf-8")) if post_data else {}
        except Exception:
            payload = {}

        path = self.path

        # 1. Hook requested approval for a command/tool
        if path == "/request-approval":
            cmd = payload.get("command", "")
            action = payload.get("action", "run_command")
            
            chat_id = CONFIG.get("allowed_chat_id")
            if not chat_id:
                self._send_json({"decision": "ask", "reason": "Chat ID not registered in Telegram bridge"})
                return

            req_id = str(uuid.uuid4())[:8]
            evt = threading.Event()
            
            with APPROVALS_LOCK:
                PENDING_APPROVALS[req_id] = {
                    "event": evt,
                    "decision": "ask",
                    "command": cmd
                }

            keyboard = {
                "inline_keyboard": [
                    [
                        {"text": "✅ Разрешить", "callback_data": f"approve:{req_id}"},
                        {"text": "❌ Отклонить", "callback_data": f"deny:{req_id}"}
                    ]
                ]
            }

            msg_text = (
                f"⚠️ <b>Запрос подтверждения Antigravity</b>\n\n"
                f"<b>Действие:</b> {escape_html(action)}\n"
                f"<b>Команда:</b>\n<code>{escape_html(cmd)}</code>\n\n"
                f"<i>Нажмите кнопку для ответа с телефона:</i>"
            )
            tg_send_message(chat_id, msg_text, reply_markup=keyboard)

            timeout = CONFIG.get("approval_timeout_sec", 90)
            got_response = evt.wait(timeout=timeout)

            with APPROVALS_LOCK:
                entry = PENDING_APPROVALS.pop(req_id, None)
                final_decision = entry["decision"] if entry and got_response else "ask"

            self._send_json({"decision": final_decision, "reason": "Обработано через Telegram"})
            return

        # 2. Hook reported task completion
        elif path == "/notify-finished":
            chat_id = CONFIG.get("allowed_chat_id")
            if chat_id:
                threading.Thread(
                    target=handle_notify_finished_async,
                    args=(chat_id, payload),
                    daemon=True
                ).start()
            self._send_json({"success": True})
            return

        # 3. Healthcheck / Ping
        elif path == "/health":
            self._send_json({"status": "ok", "allowed_chat_id": CONFIG.get("allowed_chat_id")})
            return

        # 4. Sync Antigravity session from hook
        elif path == "/sync-session":
            if payload.get("ls_address"):
                CONFIG["ls_address"] = payload["ls_address"]
            if payload.get("csrf_token"):
                CONFIG["csrf_token"] = payload["csrf_token"]
            self._send_json({"status": "synced"})
            return

        else:
            self._send_json({"error": "Unknown path"}, status=404)

    def _send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))

def start_ipc_server():
    port = CONFIG.get("ipc_port", 18822)
    server = HTTPServer(("127.0.0.1", port), LocalIPCHandler)
    print(f"[IPC Server] Listening on http://127.0.0.1:{port}...", flush=True)
    server.serve_forever()

# --- MAIN SERVICE RUNNER ---

def main():
    print("==================================================", flush=True)
    print("  ANTIGRAVITY TELEGRAM BRIDGE DAEMON STARTED", flush=True)
    print(f"  Bot: @Sm_tg_gema_bot", flush=True)
    print(f"  Authorized User: @{CONFIG.get('allowed_username')}", flush=True)
    print(f"  STT Model: {CONFIG.get('gemini_model')}", flush=True)
    print(f"  Conversation ID: {CONFIG.get('conversation_id')}", flush=True)
    print(f"  Status Bar Message ID: {CONFIG.get('status_message_id')}", flush=True)
    print("==================================================", flush=True)

    # Thread 1: Telegram long poller
    poller_t = threading.Thread(target=telegram_poller_loop, daemon=True)
    poller_t.start()

    # Thread 2: Pinned status bar heartbeat loop (every 45s)
    status_t = threading.Thread(target=status_heartbeat_loop, daemon=True)
    status_t.start()

    # Thread 3 (Main): Local IPC server
    try:
        start_ipc_server()
    except KeyboardInterrupt:
        print("\n[Daemon] Stopped by user.")

if __name__ == "__main__":
    main()
