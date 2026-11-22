# Compares the Claude CLI's system/init and InstructionsLoaded hook records between a native
# run and a worker run. Items not named pk_* are counted, never printed (user config is private).
# Usage: parity_claude.py <native stream-json> <worker tee .out> <native hook log> <worker hook log> <main> <wt>
import json, sys
nat, wrk, nh, wh, main, wt = sys.argv[1:7]
def init(path):
    for line in open(path):
        try: m = json.loads(line)
        except ValueError: continue
        if m.get("type") == "system" and m.get("subtype") == "init": return m
def items(m, k):
    v = m.get(k)
    if k == "mcp_servers": return {f'{s["name"]}:{s["status"]}' for s in v}
    if k == "plugins": return {p["name"] for p in v}
    return set(v) if isinstance(v, list) else {str(v)}
def hooks(path, root):
    out = set()
    for line in open(path):
        if line.strip():
            r = json.loads(line); p = r["file_path"]
            out.add(f'{r["memory_type"]}:{p.replace(root, "<repo>") if p.startswith(root) else "<outside>"}')
    return out
show = lambda s: sorted(x for x in s if "pk" in x.lower() or "<repo>" in x) + ([f"+{len([x for x in s if 'pk' not in x.lower() and '<repo>' not in x])} other"] if s else [])
a, b = init(nat), init(wrk)
for k in ["model", "permissionMode", "output_style", "apiKeySource", "tools", "mcp_servers", "skills", "slash_commands", "plugins", "agents"]:
    x, y = items(a, k), items(b, k)
    print(f"{k}: " + ("equal " + str(show(x)) if x == y else f"native-only {show(x - y)} worker-only {show(y - x)}"))
x, y = hooks(nh, main), hooks(wh, wt)
print("instructions: " + ("equal " + str(sorted(x)) if x == y else f"native-only {sorted(x - y)} worker-only {sorted(y - x)}"))
