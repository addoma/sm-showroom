#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PreToolUse Hook for Antigravity.
Intercepts tool executions (such as mutating terminal commands).
Sends a remote approval request with interactive buttons to the Telegram Bot,
or allows all commands automatically if full_terminal_access is enabled.
"""

import sys
import os
import json
import urllib.request
import urllib.error

SAFE_PREFIXES = (
    "ls", "cat", "grep", "find", "pwd", "which", "echo", "head", "tail",
    "git status", "git log", "git diff", "git branch", "clasp status",
    "python3 -c", "python -c", "node -v", "python3 --version"
)

def is_safe_command(cmd: str) -> bool:
    trimmed = cmd.strip()
    for prefix in SAFE_PREFIXES:
        if trimmed.startswith(prefix):
            return True
    return False

def is_full_access_enabled() -> bool:
    """Checks if permanent full terminal access is activated in config."""
    cfg_file = os.path.expanduser("~/.gemini/antigravity/telegram_bridge/config.json")
    if os.path.exists(cfg_file):
        try:
            with open(cfg_file, "r", encoding="utf-8") as f:
                cfg = json.load(f)
                return bool(cfg.get("full_terminal_access", False))
        except Exception:
            pass
    return False

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
    except Exception:
        pass

def main():
    sync_session()
    try:
        # If permanent full terminal access is enabled, approve all commands automatically
        if is_full_access_enabled():
            print(json.dumps({"decision": "allow"}))
            return
            
        raw_input = sys.stdin.read()
        if not raw_input.strip():
            print(json.dumps({"decision": "allow"}))
            return
            
        payload = json.loads(raw_input)
        tool_call = payload.get("toolCall", {})
        tool_name = tool_call.get("name", "")
        args = tool_call.get("args", {})
        
        # If it's run_command
        if tool_name == "run_command":
            cmd = args.get("CommandLine", "")
            
            # Allow safe read-only commands without interrupting the user
            if is_safe_command(cmd):
                print(json.dumps({"decision": "allow"}))
                return
            
            # For mutating commands, request remote approval via Telegram Daemon
            try:
                raw_resp = make_ipc_request("/request-approval", {
                    "action": "run_command",
                    "command": cmd,
                    "reason": f"Требуется подтверждение выполнения команды: {cmd[:60]}"
                }, timeout=95)
                result = json.loads(raw_resp.decode("utf-8"))
                decision = result.get("decision", "ask")
                print(json.dumps({
                    "decision": decision,
                    "reason": result.get("reason", "Решение получено из Telegram")
                }))
                return
            except Exception as e:
                # If daemon is not running or timeout, fallback to standard UI prompt
                print(json.dumps({"decision": "ask", "reason": f"Telegram bridge unavailable ({e})"}))
                return

        # For any other tools (view_file, read_url, etc.), allow
        print(json.dumps({"decision": "allow"}))
    except Exception:
        print(json.dumps({"decision": "allow"}), file=sys.stdout)

if __name__ == "__main__":
    main()
