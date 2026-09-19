# System memory

This file is app-wide. It is injected on every agent turn (same as SYSTEM.md). Per-agent sticky rules stay in Soul.

Use the generic memory skill:

`C:\TecAdRise\.cursor\skills\llm-wiki\SKILL.md`

The live store path is in `[Memory directory]` on this turn (under App data, shown in Settings → Computer). That folder is shared by every agent. Do not use the agent workspace README as memory.

- Read the skill, then read `index.md` in the memory directory before answering from prior context.
- After a lasting fact or decision, update `index.md` and append `log.md`.
- Do not store secrets, API keys, or passwords.
