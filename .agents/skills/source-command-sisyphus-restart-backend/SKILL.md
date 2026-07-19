---
name: "source-command-sisyphus-restart-backend"
description: "Restart Sisyphus Translator's backend only (frontend stays on Preview)"
---

# source-command-sisyphus-restart-backend

Use this skill when the user asks to run the migrated source command `sisyphus-restart-backend`.

## Command Template

Run `scripts/restart-backend.sh` via the Bash tool now, with no preamble or
explanation. It kills any existing backend process on its port and starts a
fresh one. It deliberately does NOT touch port 1420/the frontend -- that
stays owned by Codex's Preview feature so Preview keeps working.
After it finishes, report only the script's own summary output (PID, port,
log file path) -- do not add extra commentary.
