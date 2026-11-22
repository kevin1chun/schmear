#!/bin/sh
# A1 fixture: a git repo whose project-level config files each declare one logger MCP
# server for a worker that must start none. Each server logs to <logdir>/<name>.jsonl.
# Usage: a1_fixture.sh <dir> <logdir>
set -e
d="$1"; L="$2"; P="$(cd "$(dirname "$0")" && pwd)"; PY="$(command -v python3)"
sh "$P/make_fixture.sh" "$d" >/dev/null; mkdir -p "$L"; cd "$d"
srv() { printf '"%s":{"command":"%s","args":["-I","%s/mcp_logger.py","%s/%s.jsonl"]}' "$1" "$PY" "$P" "$L" "$1"; }
printf '{"mcpServers":{%s}}\n' "$(srv pk_a1_dotmcp)" > .mcp.json
printf '{"enableAllProjectMcpServers":true}\n' > .claude/settings.local.json
mkdir -p .codex .cursor
printf '[mcp_servers.pk_a1_codexproj]\ncommand = "%s"\nargs = ["-I","%s/mcp_logger.py","%s/pk_a1_codexproj.jsonl"]\n' "$PY" "$P" "$L" > .codex/config.toml
printf '[mcp_servers.pk_a1_grokproj]\ncommand = "%s"\nargs = ["-I","%s/mcp_logger.py","%s/pk_a1_grokproj.jsonl"]\n' "$PY" "$P" "$L" > .grok/config.toml
printf '{"mcpServers":{%s}}\n' "$(srv pk_a1_cursorproj)" > .cursor/mcp.json
printf '{"mcpServers":{%s}}\n' "$(srv pk_a1_agyproj)" > .agents/mcp_config.json
git add -A && git -c user.name=probe -c user.email=probe@example.invalid commit -q -m "a1 configs"
echo "a1 fixture at $d"
