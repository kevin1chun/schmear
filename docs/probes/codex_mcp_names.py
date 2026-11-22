#!/usr/bin/env python3
# Lists the MCP server names Codex would load for a cwd, via app-server `config/read`
# (the call codex-acp makes before thread/start). Prints names and layer sources only.
# Usage: codex_mcp_names.py <codex> <cwd> [--trust]   (--trust adds codex-acp's project trust override)
import json, subprocess, sys
codex, cwd = sys.argv[1], sys.argv[2]
extra = ["-c", f'projects."{cwd}".trust_level="trusted"'] if "--trust" in sys.argv else []
p = subprocess.Popen([codex, *extra, "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.DEVNULL, text=True, cwd=cwd)
def send(m):
    p.stdin.write(json.dumps(m) + "\n"); p.stdin.flush()
def call(i, method, params):
    send({"jsonrpc": "2.0", "id": i, "method": method, "params": params})
    while True:
        m = json.loads(p.stdout.readline())
        if m.get("id") == i:
            return m
call(1, "initialize", {"clientInfo": {"name": "broker-probe", "version": "0"}})
send({"jsonrpc": "2.0", "method": "initialized"})
r = call(2, "config/read", {"cwd": cwd, "includeLayers": True})
if "error" in r:
    print("error:", r["error"]); p.kill(); sys.exit(1)
res = r["result"]
print("mcp_servers:", sorted(((res.get("config") or {}).get("mcp_servers") or {}).keys()))
for layer in res.get("layers") or []:
    names = sorted(((layer.get("config") or {}).get("mcp_servers") or {}).keys())
    print("layer", json.dumps(layer.get("name") or layer.get("source"))[:140], "mcp_servers:", names)
p.kill()
