#!/bin/sh
# Parity fixture: make_fixture.sh plus a skill, an InstructionsLoaded logging hook, and
# gitignored local config, then a worktree outside the repo, as a driver may give a worker.
# Usage: parity_fixture.sh <dir> <logdir>   (worktree at <dir>-wt; hook log at $PK_PAR_LOG)
set -e
d="$1"; L="$2"; P="$(cd "$(dirname "$0")" && pwd)"; PY="$(command -v python3)"
sh "$P/make_fixture.sh" "$d" >/dev/null; mkdir -p "$L"; cd "$d"
srv() { printf '"%s":{"command":"%s","args":["-I","%s/mcp_logger.py","%s/%s.jsonl"]}' "$1" "$PY" "$P" "$L" "$1"; }
for s in .claude/skills .agents/skills; do mkdir -p $s/pk-par-skill
  printf -- '---\nname: pk-par-skill\ndescription: Parity fixture skill; never use it.\n---\nReply PK-PAR.\n' > $s/pk-par-skill/SKILL.md; done
printf '{"hooks":{"InstructionsLoaded":[{"hooks":[{"type":"command","command":"cat >> \\"$PK_PAR_LOG\\"; echo >> \\"$PK_PAR_LOG\\""}]}]}}\n' > .claude/settings.json
printf '{"mcpServers":{%s}}\n' "$(srv pk_par_mcpjson)" > .mcp.json
printf 'CLAUDE.local.md\n.claude/settings.local.json\n.codex/\n.agents/mcp_config.json\n.grok/config.toml\n' > .gitignore
git add -A && git -c user.name=probe -c user.email=probe@example.invalid commit -q -m "parity fixture"
printf 'Codeword: LOCAL\n' > CLAUDE.local.md
printf '{"enableAllProjectMcpServers":true}\n' > .claude/settings.local.json
mkdir -p .codex
printf '[mcp_servers.pk_par_codex]\ncommand = "%s"\nargs = ["-I","%s/mcp_logger.py","%s/pk_par_codex.jsonl"]\n' "$PY" "$P" "$L" > .codex/config.toml
printf '[mcp_servers.pk_par_grok]\ncommand = "%s"\nargs = ["-I","%s/mcp_logger.py","%s/pk_par_grok.jsonl"]\n' "$PY" "$P" "$L" > .grok/config.toml
printf '{"mcpServers":{%s}}\n' "$(srv pk_par_agy)" > .agents/mcp_config.json
git worktree add -q -b pk-par "$d-wt" HEAD
echo "parity fixture at $d, worktree $d-wt, untracked: $(git status --porcelain --ignored | tr '\n' ' ')"
