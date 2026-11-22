#!/bin/sh
# Creates a throwaway git repo with one codeword per rule-file convention.
# Usage: make_fixture.sh <dir>
set -e
d="$1"; mkdir -p "$d" && cd "$d"
git init -q
printf 'PINEAPPLE\nProbe fixture repo.\n' > README.md
printf 'Codeword: KIWI\n' > AGENTS.md
printf 'Codeword: LIME\n' > CLAUDE.md
printf 'Codeword: PLUM\n' > GEMINI.md
mkdir -p .grok/rules .agents/rules .claude/rules
printf 'Codeword: FIG\n' > .grok/rules/probe.md
printf -- '---\ntrigger: always_on\n---\nCodeword: PEAR\n' > .agents/rules/probe.md
printf 'Codeword: DATE\n' > .claude/rules/probe.md
git add -A
git -c user.name=probe -c user.email=probe@example.invalid commit -q -m "fixture"
echo "fixture at $d: $(git log --oneline | head -1)"
