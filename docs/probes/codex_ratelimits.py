#!/usr/bin/env python3
# Asks the user's own codex binary for its rate limits over app-server JSON-RPC
# (`account/rateLimits/read`); this script reads no credential. Prints window fields only.
import json, subprocess, sys
codex = sys.argv[1] if len(sys.argv) > 1 else "codex"
p = subprocess.Popen([codex, "-s", "read-only", "-a", "never", "app-server"], stdin=subprocess.PIPE,
                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
def send(m):
    p.stdin.write(json.dumps(m) + "\n"); p.stdin.flush()
def call(i, method, params):
    send({"jsonrpc": "2.0", "id": i, "method": method, "params": params})
    while True:
        m = json.loads(p.stdout.readline())
        if m.get("id") == i:
            return m
init = call(1, "initialize", {"clientInfo": {"name": "broker-probe", "version": "0"}})
print("initialize:", "ok" if "result" in init else init.get("error"))
send({"jsonrpc": "2.0", "method": "initialized"})
r = call(2, "account/rateLimits/read", None)
if "error" in r:
    print("error:", r["error"]); sys.exit(1)
res = r["result"]
print("result keys:", sorted(res.keys()))
rl = res.get("rateLimits") or {}
print("rateLimits keys:", sorted(rl.keys()), "| planType:", rl.get("planType"))
for w in ("primary", "secondary"):
    print(f"  {w}:", rl.get(w))
print("rateLimitsByLimitId ids:", sorted((res.get("rateLimitsByLimitId") or {}).keys()))
p.kill()
