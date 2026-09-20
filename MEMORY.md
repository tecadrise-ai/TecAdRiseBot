# System memory

This file is app-wide. It is injected on every agent turn (same as SYSTEM.md). Per-agent sticky rules stay in Soul.

Use the shared skill `memory-management` from the Skills directory (`skills/memory-management/SKILL.md` in App data). Read that SKILL.md when you need the procedure.

The live store path is in `[Memory directory]` on this turn (Settings → Computer). That folder is shared by every agent. Do not write memory under the agent workspace cwd.

- Read the skill, then read `index.md` in the memory directory before answering from prior context.
- After a lasting fact or decision, update `index.md` and append `log.md` (and `notes/` as the skill says).
- Do not store secrets, API keys, or passwords.
