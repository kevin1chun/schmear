"""Token-free Claude usage read: the Agent SDK `get_usage` control request sent to the user's own
claude binary over stream-json stdio. Sends no user message (no inference) and reads no credential;
prints only window names, utilization, reset times and booleans.

usage: python3 -I claude_get_usage.py <claude binary> <cwd>
"""
import json, os, re, subprocess, sys, threading, time

STRIP = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN",
         "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]
WINDOWS = ["five_hour", "seven_day", "seven_day_oauth_apps", "seven_day_opus", "seven_day_sonnet"]

def main():
    binary, cwd = sys.argv[1], sys.argv[2]
    env = {k: v for k, v in os.environ.items() if k not in STRIP}
    argv = [binary, "--output-format", "stream-json", "--verbose", "--input-format", "stream-json",
            "--strict-mcp-config"]
    print("argv:", " ".join(argv[1:]))
    t0 = time.time()
    p = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True)
    err = []
    threading.Thread(target=lambda: err.extend(p.stderr), daemon=True).start()
    def send(rid, req):
        p.stdin.write(json.dumps({"type": "control_request", "request_id": rid, "request": req}) + "\n")
        p.stdin.flush()
    send("init", {"subtype": "initialize"})
    send("usage", {"subtype": "get_usage", "skip_behaviors": True})
    deadline = threading.Timer(60, p.kill)
    deadline.start()
    result = None
    for line in p.stdout:
        try:
            msg = json.loads(line)
        except ValueError:
            print("non-json stdout line, length", len(line))
            continue
        if msg.get("type") != "control_response":
            print(f"+{time.time() - t0:.1f}s message type={msg.get('type')} subtype={msg.get('subtype')}")
            continue
        r = msg.get("response", {})
        print(f"+{time.time() - t0:.1f}s control_response request_id={r.get('request_id')} subtype={r.get('subtype')}"
              + (f" error={str(r.get('error'))[:200]}" if r.get("subtype") == "error" else ""))
        if r.get("request_id") == "usage":
            result = r
            break
    deadline.cancel()
    p.stdin.close()
    p.terminate()
    try:
        p.wait(5)
    except subprocess.TimeoutExpired:
        p.kill()
    if not result or result.get("subtype") != "success":
        tail = [re.sub(r"[A-Za-z0-9_\-]{32,}", "<redacted>", l.rstrip())[:200] for l in err[-5:]]
        print("FAIL: no successful get_usage response; exit", p.returncode, "stderr tail:", tail)
        return 1
    u = result.get("response", {})
    print("keys:", sorted(u))
    print("subscription_type:", u.get("subscription_type"), "| rate_limits_available:", u.get("rate_limits_available"))
    rl = u.get("rate_limits") or {}
    print("rate_limits keys:", sorted(rl))
    for w in WINDOWS:
        v = rl.get(w)
        print(f"  {w}:", None if v is None else {"utilization": v.get("utilization"), "resets_at": v.get("resets_at")})
    for m in rl.get("model_scoped") or []:
        print("  model_scoped:", {k: m.get(k) for k in ("display_name", "utilization", "resets_at")})
    eu = rl.get("extra_usage")
    print("  extra_usage:", None if eu is None else {"is_enabled": eu.get("is_enabled")})
    print("behaviors is null:", u.get("behaviors") is None, "| exit", p.returncode, f"| {time.time() - t0:.1f}s")
    return 0

sys.exit(main())
