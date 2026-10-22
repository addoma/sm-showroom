#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Stop Hook for Antigravity.
Fires when the agent execution loop terminates (all actions/tools completed).
Sends a short, clean task-finished notification to Telegram without long reports.
"""

import sys
import os
import json
import urllib.request
import urllib.error

DEBUG_LOG = os.path.expanduser("~/.gemini/antigravity/log/stop_hook_debug.log")

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

def main():
    log_debug("--- STOP HOOK TRIGGERED ---")
    sync_session()
    
    try:
        raw_input = sys.stdin.read()
        log_debug(f"Input payload: {raw_input.strip()}")
        
        skip_notify = False
        if raw_input.strip():
            payload = json.loads(raw_input)
            term_reason = payload.get("terminationReason", "")
            if term_reason in ("USER_CANCELED",):
                skip_notify = True
                
        if not skip_notify:
            try:
                resp = make_ipc_request("/notify-finished", {"summary": "Задача успешно выполнена"}, timeout=5)
                log_debug(f"notify-finished response: {resp.decode(errors='replace')}")
            except Exception as e:
                log_debug(f"notify-finished error: {e}")
    except Exception as e:
        log_debug(f"Exception in main: {e}")
    
    # Contract: Return empty JSON object {} to allow stop
    print(json.dumps({}))

if __name__ == "__main__":
    main()
