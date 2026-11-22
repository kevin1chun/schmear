#!/usr/bin/env python3
# initialize + session/new only (no session/prompt, no inference), then session/close and terminate.
# Usage: config_probe.py <label> <cwd> <outdir> -- <agent command...>
# Writes <outdir>/<label>.json (configOptions, models, modes as returned) and prints a trimmed view.
# Never prints environment or credential values; agent stderr goes to <outdir>/<label>.stderr.
import json, os, subprocess, sys, threading, queue, time
label, cwd, outdir = sys.argv[1:4]
cmd = sys.argv[sys.argv.index("--") + 1:]
proc = subprocess.Popen(cmd, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=open(os.path.join(outdir, label + ".stderr"), "w"), text=True, bufsize=1)
inbox, nid = queue.Queue(), [0]
def reader():
    for line in proc.stdout:
        line = line.strip()
        if line:
            try: inbox.put(json.loads(line))
            except ValueError: pass
    inbox.put(None)
threading.Thread(target=reader, daemon=True).start()
def send(m): proc.stdin.write(json.dumps(m) + "\n"); proc.stdin.flush()
def request(method, params, timeout=120):
    nid[0] += 1; rid = nid[0]
    send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
    end = time.time() + timeout
    while time.time() < end:
        try: m = inbox.get(timeout=1)
        except queue.Empty: continue
        if m is None: return {"error": {"message": "EOF"}}
        if m.get("id") == rid and "method" not in m: return m
        if "id" in m and m.get("method"):
            send({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32601, "message": "Method not found"}})
    return {"error": {"message": "TIMEOUT"}}
r = request("initialize", {"protocolVersion": 1, "clientInfo": {"name": "tier-probe", "version": "0.0.0"},
            "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False}})
if "error" in r: print(label, "initialize ERROR", r["error"]); proc.kill(); sys.exit(1)
init = r["result"]
print(label, "initialize ok agentInfo=%s" % json.dumps(init.get("agentInfo")))
r = request("session/new", {"cwd": cwd, "mcpServers": []}, 180)
if "error" in r: print(label, "session/new ERROR", json.dumps(r["error"])[:400]); proc.kill(); sys.exit(1)
res = r["result"]
keep = {k: res.get(k) for k in ("configOptions", "models", "modes")}
json.dump(keep, open(os.path.join(outdir, label + ".json"), "w"), indent=1)
print(label, "session/new result keys=%s" % sorted(res))
for o in res.get("configOptions") or []:
    flat = []
    for x in o.get("options", []):
        flat += x.get("options", []) if "options" in x else [x]
    print("  configOption id=%s category=%s type=%s current=%s" % (o.get("id"), o.get("category"), o.get("type"), o.get("currentValue")))
    for x in flat:
        print("    %s | %s | %s" % (x.get("value"), x.get("name"), (x.get("description") or "")[:120]))
if res.get("models"):
    m = res["models"]; print("  models current=%s" % m.get("currentModelId"))
    for x in m.get("availableModels", []):
        print("    %s | %s | %s" % (x.get("modelId"), x.get("name"), (x.get("description") or "")[:120]))
sc = (init.get("agentCapabilities") or {}).get("sessionCapabilities") or {}
if "close" in sc:
    c = request("session/close", {"sessionId": res["sessionId"]}, 20)
    print(label, "session/close", "ok" if "result" in c else c.get("error"))
proc.stdin.close(); proc.terminate()
try: proc.wait(5)
except subprocess.TimeoutExpired: proc.kill()
