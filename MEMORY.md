# System memory

This file is app-wide. It is injected on every agent turn (same as SYSTEM.md). Per-agent sticky rules stay in Soul.

Use the shared skill `memory-management` from the Skills directory (`skills/memory-management/SKILL.md` in App data). Read that SKILL.md when you need the procedure.

Two stores:

- Shared: `[Memory directory]` this turn (Settings → Computer). Facts every agent should know. Read `index.md` first. After a shared fact, update `index.md` and append `log.md` (and `notes/` as the skill says).
- Local: `memory.md` in this agent's workspace (cwd, the Workspace path this turn). Private to this agent. Read it at the start of a turn when you need your own history. Write lasting per-agent facts, procedures, and lessons there. Do not dump shared company facts only into local `memory.md`.

- Do not store secrets, API keys, or passwords.
