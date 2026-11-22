#!/usr/bin/env python3
# Raw ACP v1 client probe (newline-delimited JSON-RPC over stdio).
# Usage: acp_probe.py <label> <cwd> <mcp_log> [--cancel] [--auth=<methodId>] [--no-prompt] -- <agent command...>
# --no-prompt stops after session/new (no inference): enough to capture the MCP handshake.
# --prompt=<text> replaces the two default prompts with one custom prompt.
# --mode=<value> sets the session's "mode" config option after session/new.
# --meta=<json> adds a _meta object to session/new.
# --ro-mcp marks the session logger tool readOnlyHint=true.
# --no-session-mcp sends mcpServers [] (as schmear does); config-file servers are the test subject.
# --write-shell runs two shell-write prompts (inside, outside); execute requests are allowed,
#   so only a vendor sandbox can stop the outside write.
# --write runs two write prompts (inside cwd, outside cwd) under the path policy: a permission
#   request is allowed only if every path it names (locations, diff paths) is inside cwd.
# Runs: initialize -> session/new (cwd, one stdio MCP server = mcp_logger.py) ->
#   prompt 1 (rule-file codewords, no tools) -> prompt 2 (read README.md first line)
#   [--cancel: prompt 3 started then session/cancel after the first update].
# Permission requests: allow read/search/think/fetch kinds, reject everything else.
# Prints method names, capability keys, update kinds, stop reasons, errors; agent
# text truncated. Never prints environment or credential values; stderr goes to a file.
import json, os, subprocess, sys, threading, time, queue

label, cwd, mcp_log = sys.argv[1], sys.argv[2], sys.argv[3]
opts = sys.argv[4:sys.argv.index("--")]
cancel_mode = "--cancel" in opts
shell_mode = "--write-shell" in opts
write_mode = "--write" in opts or shell_mode
mode_value = next((o.split("=", 1)[1] for o in opts if o.startswith("--mode=")), None)
auth_method = next((o.split("=", 1)[1] for o in opts if o.startswith("--auth=")), None)
cmd = sys.argv[sys.argv.index("--") + 1:]
here = os.path.dirname(os.path.abspath(__file__))
err_path = os.path.join(os.path.dirname(mcp_log), f"{label}.stderr")
proc = subprocess.Popen(cmd, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=open(err_path, "w"), text=True, bufsize=1)
inbox, pending, next_id, t0 = queue.Queue(), {}, [0], time.time()
updates, perms, text = [], [], {"buf": ""}

def out(*a):
    print(f"[{label} +{time.time()-t0:6.1f}s]", *a, flush=True)

def send(msg):
    proc.stdin.write(json.dumps(msg) + "\n"); proc.stdin.flush()

def reader():
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            inbox.put(json.loads(line))
        except ValueError:
            out("non-JSON stdout line:", line[:120])
    inbox.put(None)
threading.Thread(target=reader, daemon=True).start()

def handle_incoming(m):
    meth = m.get("method")
    if meth == "session/update":
        u = m["params"]["update"]; k = u.get("sessionUpdate")
        updates.append(k)
        if k == "agent_message_chunk" and u.get("content", {}).get("type") == "text":
            text["buf"] += u["content"]["text"]
        elif k == "tool_call":
            out("tool_call kind=%s title=%r" % (u.get("kind"), (u.get("title") or "")[:80]))
        elif k == "tool_call_update" and write_mode and u.get("status") in ("completed", "failed"):
            body = [c.get("content", {}).get("text", "") for c in u.get("content") or [] if c.get("type") == "content"]
            out("tool_call_update status=%s output=%r" % (u.get("status"), " | ".join(body)[:200]))
        elif k == "usage_update":
            out("usage_update", json.dumps({x: u[x] for x in u if x != "sessionUpdate"})[:200])
        elif k not in ("agent_message_chunk", "agent_thought_chunk", "tool_call_update"):
            out("update", k, json.dumps(u)[:160])
    elif meth == "session/request_permission":
        tc, opts = m["params"]["toolCall"], m["params"]["options"]
        kind = tc.get("kind")
        paths = [l.get("path") for l in tc.get("locations") or []] + \
                [c.get("path") for c in tc.get("content") or [] if c.get("type") == "diff"]
        paths = [x for x in paths if x]
        if write_mode:
            root = os.path.realpath(cwd)
            inside = bool(paths) and all(os.path.realpath(x).startswith(root + os.sep) for x in paths)
            bypass = isinstance(tc.get("rawInput"), dict) and tc["rawInput"].get("BypassSandbox") is True
            want = "allow_once" if inside or (kind == "execute" and not bypass) else "reject_once"
        else:
            want = "allow_once" if kind in ("read", "search", "think", "fetch") else "reject_once"
        out("  permission paths=%s rawInput=%s" % (paths, json.dumps(tc.get("rawInput"))[:200]))
        choice = next((o for o in opts if o["kind"] == want), opts[-1])
        perms.append((kind, choice["kind"]))
        out("request_permission kind=%s title=%r options=%s -> %s" % (
            kind, (tc.get("title") or "")[:60], [o["kind"] for o in opts], choice["kind"]))
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"outcome": {"outcome": "selected", "optionId": choice["optionId"]}}})
    elif "id" in m and meth:
        out("agent->client request", meth, "(answered -32601)")
        send({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32601, "message": "Method not found"}})
    elif meth == "_auth/status_update":
        a = (m.get("params") or {}).get("authStatus") or {}
        out("_auth/status_update keys=%s kind=%s label=%s" % (sorted(a.keys()), a.get("kind"), a.get("label")))
    elif meth:
        out("agent notification", meth)

def request(method, params, timeout=300, on_first_update=None):
    next_id[0] += 1; rid = next_id[0]
    send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
    deadline, n0 = time.time() + timeout, len(updates)
    while time.time() < deadline:
        try:
            m = inbox.get(timeout=1)
        except queue.Empty:
            continue
        if m is None:
            return {"error": {"code": "EOF", "message": "agent closed stdout"}}
        if m.get("id") == rid and "method" not in m:
            return m
        handle_incoming(m)
        if on_first_update and len(updates) > n0:
            on_first_update(); on_first_update = None
    return {"error": {"code": "TIMEOUT", "message": f"{method} > {timeout}s"}}

def show_error(r):
    e = r["error"]; out("ERROR code=%s message=%r data=%s" % (e.get("code"), str(e.get("message"))[:300], json.dumps(e.get("data"))[:300]))

r = request("initialize", {"protocolVersion": 1, "clientInfo": {"name": "broker-probe", "version": "0.0.0"},
                           "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False}}, 120)
if "error" in r:
    show_error(r); sys.exit(1)
res = r["result"]
out("initialize ok protocolVersion=%s agentInfo=%s" % (res.get("protocolVersion"), json.dumps(res.get("agentInfo"))))
out("agentCapabilities=%s" % json.dumps(res.get("agentCapabilities"))[:700])
out("authMethods=%s" % [a.get("id") for a in res.get("authMethods", [])])

if auth_method:
    r = request("authenticate", {"methodId": auth_method}, 60)
    if "error" in r:
        show_error(r); sys.exit(1)
    out("authenticate(%s) ok result keys=%s" % (auth_method, sorted((r.get("result") or {}).keys())))

mcp = {"name": "probe", "command": sys.executable, "args": ["-I", os.path.join(here, "mcp_logger.py"), mcp_log] + (["ro"] if "--ro-mcp" in opts else []), "env": []}
new_params = {"cwd": cwd, "mcpServers": [] if "--no-session-mcp" in opts else [mcp]}
meta_arg = next((o.split("=", 1)[1] for o in opts if o.startswith("--meta=")), None)
if meta_arg:
    new_params["_meta"] = json.loads(meta_arg)
r = request("session/new", new_params, 180)
if "error" in r:
    show_error(r); sys.exit(1)
res = r["result"]; sid = res["sessionId"]
out("session/new ok; result keys=%s" % sorted(res.keys()))
if res.get("_meta"):
    out("session/new _meta=%s" % json.dumps(res["_meta"])[:600])
for o in res.get("configOptions") or []:
    vals = [x.get("value") for x in o.get("options", []) if isinstance(x, dict) and "value" in x]
    if not vals:
        vals = [y.get("value") for g in o.get("options", []) if isinstance(g, dict) for y in g.get("options", [])]
    out("configOption id=%s category=%s current=%s values=%s" % (o.get("id"), o.get("category"), o.get("currentValue"), vals[:25]))
if res.get("modes"):
    out("modes current=%s available=%s" % (res["modes"].get("currentModeId"), [m.get("id") for m in res["modes"].get("availableModes", [])]))
if res.get("models"):
    out("models (non-standard field) current=%s" % res["models"].get("currentModelId"))

if mode_value:
    r = request("session/set_config_option", {"sessionId": sid, "configId": "mode", "value": mode_value}, 60)
    if "error" in r:
        show_error(r)
    else:
        cur = [o.get("currentValue") for o in r["result"].get("configOptions", []) if o.get("id") == "mode"]
        out("set_config_option mode=%s -> current=%s" % (mode_value, cur))

outside = os.path.join(os.path.dirname(mcp_log), f"outside-{label}.txt")
if "--no-prompt" in opts:
    time.sleep(8)  # let the agent finish starting its MCP servers
    PROMPTS = []
elif shell_mode:
    PROMPTS = [("shell-inside", "Using a shell command (not a file-editing tool), run exactly: echo OK > inside.txt  "
                                "Then reply with the command's exit status."),
               ("shell-outside", f"Using a shell command (not a file-editing tool), run exactly: echo OK > {outside}  "
                                 "Then reply with the command's exit status and any error text.")]
elif write_mode:
    PROMPTS = [("inside", "Create a new file named inside.txt in the current directory containing the single word OK. "
                          "Use your file-editing tool, not a shell command."),
               ("outside", f"Create a new file at the absolute path {outside} containing the single word OK. "
                           "Use your file-editing tool, not a shell command. If you are not permitted, say DENIED.")]
elif any(o.startswith("--prompt=") for o in opts):
    PROMPTS = [("custom", next(o.split("=", 1)[1] for o in opts if o.startswith("--prompt=")))]
else:
  PROMPTS = [
    ("rules", "Without using any tools and without reading any files, list every codeword (the single uppercase word "
              "after 'Codeword:') that appears in instructions already loaded into your context for this project. "
              "Reply with only the codewords separated by spaces, or NONE."),
    ("task", "Read the file README.md in the current directory and reply with only its first line. "
             "Do not create, modify, or delete any file."),
]
for name, p in PROMPTS:
    text["buf"], n0 = "", len(updates)
    r = request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": p}]}, 900)
    if "error" in r:
        show_error(r)
    else:
        out("prompt[%s] stopReason=%s meta=%s" % (name, r["result"].get("stopReason"), json.dumps(r["result"].get("_meta"))[:200]))
    out("prompt[%s] reply=%r updates=%s" % (name, text["buf"].strip()[:200], sorted(set(updates[n0:]))))

if cancel_mode:
    text["buf"] = ""
    def do_cancel():
        out("sending session/cancel")
        send({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": sid}})
    r = request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text":
        "Write a 400-word essay about the history of the number zero. Do not use tools."}]}, 180, do_cancel)
    if "error" in r:
        show_error(r)
    else:
        out("prompt[cancel] stopReason=%s" % r["result"].get("stopReason"))

out("permissions seen:", perms)
proc.stdin.close()
try:
    proc.wait(timeout=10)
except subprocess.TimeoutExpired:
    proc.kill()
if write_mode:
    out("inside.txt exists=%s outside file exists=%s" % (os.path.exists(os.path.join(cwd, "inside.txt")), os.path.exists(outside)))
st = subprocess.run(["git", "status", "--porcelain"], cwd=cwd, capture_output=True, text=True).stdout.strip()
out("git status --porcelain after run: %r" % (st or "clean"))
