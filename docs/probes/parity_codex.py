# Prints Codex's effective session inventory in one normalized form, from either a live
# app-server thread (the native reference) or a tee_exec.sh log of codex-acp's app-server.
# Usage: parity_codex.py live <codex> <cwd> [--trust: the trust override codex-acp sends]  |  parity_codex.py tee <log prefix> <cwd>
# Items not named pk* are counted, never printed (user config is private).
import json, subprocess, sys, time, select
def norm(start_params, start_result, skills, mcp, turn, cwd):
    r = start_result
    show = lambda xs: sorted(x for x in xs if x.startswith("pk")) + [f"+{len([x for x in xs if not x.startswith('pk')])} other"]
    out = {"model": r.get("model"), "approvalPolicy": (turn or r).get("approvalPolicy"),
           "approvalsReviewer": (turn or r).get("approvalsReviewer"), "sandbox": (r.get("sandbox") or {}).get("type"),
           "effort": (turn or {}).get("effort", r.get("reasoningEffort")),
           "instructionSources": sorted(p.replace(cwd, "<repo>") for p in r.get("instructionSources", [])),
           "skills": show(sorted({f'{s["name"]}:{s.get("enabled")}' for e in skills for s in e.get("skills", [])})),
           "mcp": show(sorted(mcp)), "threadConfig": (start_params or {}).get("config")}
    for k, v in out.items(): print(f"{k}: {json.dumps(v)}")
if sys.argv[1] == "tee":
    p, cwd = sys.argv[2], sys.argv[3]
    ins = [json.loads(l) for l in open(p + ".in") if l.startswith("{")]
    outs = [json.loads(l) for l in open(p + ".out") if l.startswith("{")]
    res = {m["id"]: m.get("result") for m in outs if "id" in m and "method" not in m}
    st = next(m for m in ins if m.get("method") == "thread/start")
    sk = next(m for m in ins if m.get("method") == "skills/list")
    tu = next((m["params"] for m in ins if m.get("method") == "turn/start"), None)
    mcp = {m["params"]["name"] for m in outs if m.get("method") == "mcpServer/startupStatus/updated"}
    norm(st["params"], res[st["id"]], res[sk["id"]]["data"], mcp, tu, cwd)
else:
    codex, cwd = sys.argv[2], sys.argv[3]
    trust = {"config": {"projects": {cwd: {"trust_level": "trusted"}}}} if "--trust" in sys.argv else {}
    pr = subprocess.Popen([codex, "app-server"], cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    msgs = []
    def send(m): pr.stdin.write(json.dumps(m) + "\n"); pr.stdin.flush()
    def call(i, method, params):
        send({"jsonrpc": "2.0", "id": i, "method": method, "params": params})
        while True:
            m = json.loads(pr.stdout.readline()); msgs.append(m)
            if m.get("id") == i and "method" not in m: return m.get("result")
    call(1, "initialize", {"clientInfo": {"name": "schmear-parity", "version": "0"}}); send({"jsonrpc": "2.0", "method": "initialized"})
    r = call(2, "thread/start", {"cwd": cwd, **trust}); sk = call(3, "skills/list", {"cwds": [cwd]})
    end = time.time() + 8
    while time.time() < end and select.select([pr.stdout], [], [], 0.5)[0]: msgs.append(json.loads(pr.stdout.readline()))
    pr.kill()
    norm(None, r, sk["data"], {m["params"]["name"] for m in msgs if m.get("method") == "mcpServer/startupStatus/updated"}, None, cwd)
