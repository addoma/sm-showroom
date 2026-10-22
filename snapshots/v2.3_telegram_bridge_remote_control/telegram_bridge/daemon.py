#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Telegram Bridge Daemon for Antigravity.
Provides two-way interaction between Antigravity chat session and Telegram Bot.
- Remote task creation (text & voice via Gemini Flash STT)
- Remote command approval with Telegram inline buttons
- Completion notifications without lengthy reports
- Strict security gate (@tvoyaddoma, +79266011608)
Zero external dependencies (pure standard library: urllib, http.server, threading, json, subprocess).
"""

import os
import sys
import json
import time
import uuid
import threading
import subprocess
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

def load_config():
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
        "allowed_chat_id": None,
        "conversation_id": "e942a502-2c31-4a43-9392-a2b04b0a99ba",
        "gemini_api_key": os.environ.get("GEMINI_API_KEY", ""),
        "gemini_model": "gemini-3.5-flash-lite",
        "ipc_port": 18822,
        "agentapi_path": "/Applications/Gemini.app/Contents/Helpers/agy"
    }

def save_config(cfg):
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"[Config] Error saving {CONFIG_FILE}: {e}", file=sys.stderr)

CONFIG = load_config()

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
    except urllib.error.URLError as e:
        err_str = str(e).lower()
        if "timed out" in err_str or "eof occurred" in err_str:
            return {"ok": True, "result": []}
        print(f"[Telegram Poller] Network reconnect: {e}", file=sys.stderr)
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

def tg_edit_message_text(chat_id: int, message_id: int, text: str, reply_markup: dict = None):
    payload = {
        "chat_id": chat_id,
        "message_id": message_id,
        "text": text,
        "parse_mode": "HTML"
    }
    if reply_markup is not None:
        payload["reply_markup"] = reply_markup
    tg_api_call("editMessageText", payload)

def tg_send_chat_action(chat_id: int, action: str = "typing"):
    tg_api_call("sendChatAction", {"chat_id": chat_id, "action": action})

# --- ANTIGRAVITY AGENTAPI INTEGRATION ---

SESSION_FILE = os.path.join(CURRENT_DIR, "session.json")

def get_agent_env() -> dict:
    env = os.environ.copy()
    
    # 1. From in-memory config if synced
    if CONFIG.get("ls_address"):
        env["ANTIGRAVITY_LS_ADDRESS"] = CONFIG["ls_address"]
    if CONFIG.get("csrf_token"):
        env["ANTIGRAVITY_CSRF_TOKEN"] = CONFIG["csrf_token"]
        
    # 2. From session.json
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
            
    # 3. Fallback: auto-detect hub-port from running agy process
    if "ANTIGRAVITY_LS_ADDRESS" not in env:
        try:
            out = subprocess.check_output(["ps", "aux"], text=True)
            import re
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
    
    # 1. Matches already bound chat_id
    if allowed_id and uid == allowed_id:
        return True
    
    # 2. Matches username: bind chat_id
    if username == allowed_u:
        CONFIG["allowed_chat_id"] = uid
        save_config(CONFIG)
        print(f"[Security] Auto-bound allowed_chat_id to {uid} for user @{username}", flush=True)
        return True
        
    return False

# --- TELEGRAM UPDATES HANDLER ---

def process_telegram_update(update: dict):
    # 1. Handle Callback Queries (inline button clicks for approvals)
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

    # 2. Handle Messages
    if "message" in update:
        msg = update["message"]
        sender = msg.get("from", {})
        chat_id = msg.get("chat", {}).get("id")
        
        # Check authorization
        if not is_authorized(sender):
            # Check if contact with allowed phone was shared
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

        # /start or /help
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
                "• 🏁 <b>Уведомление о готовности:</b> когда задача будет выполнена, вы получите короткий сигнал."
            )
            return

        # Voice message
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

        # Plain text task
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

# --- LOCAL IPC HTTP SERVER FOR ANTIGRAVITY HOOKS ---

class LocalIPCHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Quiet standard logging
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
            reason = payload.get("reason", "Запрос подтверждения действия")
            
            chat_id = CONFIG.get("allowed_chat_id")
            if not chat_id:
                # If chat_id not bound yet, allow fallback to computer UI
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
                f"<b>Действие:</b> {action}\n"
                f"<b>Команда:</b>\n<code>{cmd}</code>\n\n"
                f"<i>Нажмите кнопку для ответа с телефона:</i>"
            )
            tg_send_message(chat_id, msg_text, reply_markup=keyboard)

            # Wait for user click in Telegram (up to 90 seconds)
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
                tg_send_message(
                    chat_id,
                    "🏁 <b>Antigravity: Задача успешно выполнена!</b>\n"
                    "Все действия завершены."
                )
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
    print("==================================================", flush=True)

    # Thread 1: Telegram long poller
    poller_t = threading.Thread(target=telegram_poller_loop, daemon=True)
    poller_t.start()

    # Thread 2 (Main): Local IPC server
    try:
        start_ipc_server()
    except KeyboardInterrupt:
        print("\n[Daemon] Stopped by user.")

if __name__ == "__main__":
    main()
