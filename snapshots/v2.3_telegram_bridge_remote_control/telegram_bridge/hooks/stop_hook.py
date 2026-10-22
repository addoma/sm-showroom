#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Stop Hook for Antigravity.
Fires when the agent execution loop terminates (all actions/tools completed).
Sends a short, clean task-finished notification to Telegram without long reports.
"""

import sys
import json
import urllib.request

def main():
    try:
        raw_input = sys.stdin.read()
        if raw_input.strip():
            payload = json.loads(raw_input)
            term_reason = payload.get("terminationReason", "")
            fully_idle = payload.get("fullyIdle", False)
            
            # When turn completed normally without active tools
            if term_reason == "NO_TOOL_CALL" and fully_idle:
                req_data = json.dumps({
                    "summary": "Задача завершена",
                    "conversationId": payload.get("conversationId", "")
                }).encode("utf-8")
                
                try:
                    req = urllib.request.Request(
                        "http://127.0.0.1:18822/notify-finished",
                        data=req_data,
                        headers={"Content-Type": "application/json"}
                    )
                    urllib.request.urlopen(req, timeout=5)
                except Exception:
                    pass
    except Exception:
        pass
    
    # Contract: Return empty JSON object {} to allow stop
    print(json.dumps({}))

if __name__ == "__main__":
    main()
