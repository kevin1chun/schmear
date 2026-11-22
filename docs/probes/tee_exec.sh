#!/bin/sh
# Stand-in for an agent binary (CLAUDE_CODE_EXECUTABLE, CODEX_PATH): logs argv and both
# stdio streams to $PK_TEE_LOG.{argv,in,out}, then runs $PK_TEE_REAL with the same args.
printf '%s\n' "$*" >> "$PK_TEE_LOG.argv"
tee -a "$PK_TEE_LOG.in" | "$PK_TEE_REAL" "$@" | tee -a "$PK_TEE_LOG.out"
