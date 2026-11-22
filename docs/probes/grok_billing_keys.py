#!/usr/bin/env python3
# Calls ACP _x.ai/billing over `grok agent stdio` (no credential is read by this script) and
# prints the response's key structure plus the usage-bearing fields CodexBar parses.
import json, subprocess
p = subprocess.Popen(["grok", "--no-auto-update", "agent", "stdio"], stdin=subprocess.PIPE,
                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
def call(i, method, params):
    p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params}) + "\n"); p.stdin.flush()
    while True:
        m = json.loads(p.stdout.readline())
        if m.get("id") == i:
            return m
call(1, "initialize", {"protocolVersion": 1, "clientCapabilities": {}})
r = call(2, "_x.ai/billing", {}).get("result") or {}
def keys(x, depth=0):
    return {k: keys(v, depth + 1) for k, v in x.items()} if isinstance(x, dict) and depth < 3 else type(x).__name__
print("structure:", json.dumps(keys(r)))
cfg = r.get("config") or {}
print("subscription_tier:", r.get("subscription_tier"), "| creditUsagePercent:", cfg.get("creditUsagePercent"),
      "| currentPeriod:", cfg.get("currentPeriod"), "| billingPeriodEnd:", cfg.get("billingPeriodEnd"))
p.kill()
