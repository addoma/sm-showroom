#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Stop Hook for Antigravity.
Fires when the agent execution loop terminates (all actions/tools completed).
Sends a short, clean task-finished notification to Telegram:
- 1-sentence summary (10-20 words)
- attached .md plan document if user requested /plan or a new plan artifact was generated
"""

import sys
import os
import json
import re
import glob
import time
import urllib.request
import urllib.error

DEBUG_LOG = os.path.expanduser("~/.gemini/antigravity/log/stop_hook_debug.log")
STATE_FILE = os.path.expanduser("~/.gemini/antigravity/telegram_bridge/stop_hook_state.json")

def log_debug(msg: str):
    try:
        with open(DEBUG_LOG, "a", encoding="utf-8") as f:
            f.write(f"{msg}\n")
    except Exception:
        pass

def make_ipc_request(path: str, data_dict: dict = None, timeout: int = 5):
    """Sends HTTP request to local daemon, bypassing any system proxies."""
    proxy_handler = urllib.request.ProxyHandler({})
    opener = urllib.request.build_opener(proxy_handler)
    
    data_bytes = None
    headers = {}
    if data_dict is not None:
        data_bytes = json.dumps(data_dict).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        
    req = urllib.request.Request(f"http://127.0.0.1:18822{path}", data=data_bytes, headers=headers)
    with opener.open(req, timeout=timeout) as resp:
        return resp.read()

def sync_session():
    try:
        ls_addr = os.environ.get("ANTIGRAVITY_LS_ADDRESS")
        csrf_tok = os.environ.get("ANTIGRAVITY_CSRF_TOKEN")
        if ls_addr or csrf_tok:
            session_file = os.path.expanduser("~/.gemini/antigravity/telegram_bridge/session.json")
            with open(session_file, "w", encoding="utf-8") as f:
                json.dump({"ls_address": ls_addr, "csrf_token": csrf_tok}, f)
            make_ipc_request("/sync-session", {"ls_address": ls_addr, "csrf_token": csrf_tok}, timeout=2)
    except Exception as e:
        log_debug(f"[sync_session error] {e}")

def load_state() -> dict:
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"last_notified_step": -1}

def save_state(st: dict):
    try:
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(st, f)
    except Exception:
        pass

def extract_task_context(transcript_path: str, art_dir: str):
    """
    Extracts the latest user request, whether it contained a plan request,
    the latest assistant response, and any relevant plan file.
    Supports both direct USER_INPUT and forwarded SYSTEM_MESSAGE from Telegram.
    """
    if not transcript_path or not os.path.exists(transcript_path):
        return "", "", False, None, -1

    compact_path = os.path.join(os.path.dirname(transcript_path), "transcript.jsonl")
    path_to_read = compact_path if os.path.exists(compact_path) else transcript_path

    last_user_text = ""
    last_assistant_text = ""
    last_user_step = -1

    try:
        with open(path_to_read, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line_str = line.strip()
                if not line_str:
                    continue
                try:
                    obj = json.loads(line_str)
                    etype = obj.get("type")
                    if etype == "USER_INPUT":
                        content = obj.get("content", "")
                        m = re.search(r"<USER_REQUEST>(.*?)</USER_REQUEST>", content, re.DOTALL)
                        last_user_text = m.group(1).strip() if m else content.strip()
                        last_user_step = obj.get("step_index", -1)
                    elif etype == "SYSTEM_MESSAGE":
                        content = obj.get("content", "")
                        # Messages forwarded from Telegram Bot / agentapi send-message
                        m = re.search(r"\[Message\].*?content=(.*?)(?:</SYSTEM_MESSAGE>|\Z)", content, re.DOTALL)
                        if m:
                            last_user_text = m.group(1).strip()
                            last_user_step = obj.get("step_index", -1)
                    elif etype == "PLANNER_RESPONSE":
                        content = obj.get("content", "")
                        if content and not obj.get("tool_calls"):
                            last_assistant_text = content.strip()
                except Exception:
                    pass
    except Exception as e:
        log_debug(f"[extract_task_context error] {e}")

    # Check if user requested a plan (e.g. /plan, "plan", составь план, план действий)
    plan_pattern = r'(?i)/plan|[\"\']?plan[\"\']?|\bплан\w*'
    has_plan_request = bool(re.search(plan_pattern, last_user_text))

    plan_path = None
    if art_dir and os.path.isdir(art_dir):
        plans = glob.glob(os.path.join(art_dir, "*plan*.md"))
        if plans:
            plans.sort(key=lambda p: os.path.getmtime(p), reverse=True)
            newest_plan = plans[0]
            # Attach if user explicitly mentioned plan OR if a plan was touched/created within the last hour
            time_since_plan = time.time() - os.path.getmtime(newest_plan)
            if has_plan_request or (time_since_plan < 3600):
                plan_path = newest_plan
                has_plan_request = True

    return last_user_text, last_assistant_text, has_plan_request, plan_path, last_user_step

def main():
    log_debug("--- STOP HOOK TRIGGERED ---")
    sync_session()
    
    try:
        raw_input = sys.stdin.read()
        log_debug(f"Input payload: {raw_input.strip()[:200]}")
        
        payload = {}
        if raw_input.strip():
            payload = json.loads(raw_input)
            
        term_reason = payload.get("terminationReason", "")
        fully_idle = payload.get("fullyIdle", True)
        
        # Don't notify if user canceled
        if term_reason in ("USER_CANCELED",):
            log_debug("Skipping notify: USER_CANCELED")
            print(json.dumps({}))
            return

        # Wait until agent has completely finished all tool executions and is fully idle
        if not fully_idle:
            log_debug("Skipping notify: fullyIdle is False (agent still executing)")
            print(json.dumps({}))
            return

        transcript_path = payload.get("transcriptPath", "")
        art_dir = payload.get("artifactDirectoryPath", "")
        conv_id = payload.get("conversationId", "")
        
        user_text, asst_text, has_plan, plan_path, user_step = extract_task_context(transcript_path, art_dir)
        log_debug(f"Extracted: user_step={user_step}, has_plan={has_plan}, plan={plan_path}")
        
        state = load_state()
        if user_step > 0 and user_step <= state.get("last_notified_step", -1):
            log_debug(f"Skipping notify: already notified for step {user_step}")
            print(json.dumps({}))
            return

        notify_payload = {
            "user_request": user_text,
            "assistant_response": asst_text,
            "plan_path": plan_path if has_plan else None,
            "conversation_id": conv_id
        }
        
        resp = make_ipc_request("/notify-finished", notify_payload, timeout=5)
        log_debug(f"notify-finished response: {resp.decode(errors='replace')}")
        
        if user_step > 0:
            state["last_notified_step"] = user_step
            save_state(state)
            
    except Exception as e:
        log_debug(f"Exception in main: {e}")
        
    # Return empty JSON object {} to Antigravity
    print(json.dumps({}))

if __name__ == "__main__":
    main()
