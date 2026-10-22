#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PreToolUse Hook for Antigravity.
Intercepts tool executions (such as mutating terminal commands).
Sends a remote approval request with interactive buttons to the Telegram Bot.
"""

import sys
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

def main():
    try:
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
            req_data = json.dumps({
                "action": "run_command",
                "command": cmd,
                "reason": f"Требуется подтверждение выполнения команды: {cmd[:60]}"
            }).encode("utf-8")
            
            try:
                req = urllib.request.Request(
                    "http://127.0.0.1:18822/request-approval",
                    data=req_data,
                    headers={"Content-Type": "application/json"}
                )
                with urllib.request.urlopen(req, timeout=95) as resp:
                    result = json.loads(resp.read().decode("utf-8"))
                    decision = result.get("decision", "ask")
                    print(json.dumps({
                        "decision": decision,
                        "reason": result.get("reason", "Решение получено из Telegram")
                    }))
                    return
            except Exception as e:
                # If daemon is not running, fallback to standard UI prompt
                print(json.dumps({"decision": "ask", "reason": f"Telegram bridge unavailable ({e})"}))
                return

        # For any other tools (view_file, read_url, etc.), allow
        print(json.dumps({"decision": "allow"}))
    except Exception as e:
        print(json.dumps({"decision": "allow"}), file=sys.stdout)

if __name__ == "__main__":
    main()
