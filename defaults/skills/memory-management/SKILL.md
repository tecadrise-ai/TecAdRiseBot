# Memory management (TecAdRiseBot)

Two stores. Shared host folder is `[Memory directory]` this turn (App data `memory`, Settings → Computer). Per-agent store is `memory.md` in the workspace cwd (Workspace path this turn). Do not use the workspace README as memory. Do not create a second `memory/` folder under cwd.

## Layout (create on first use if missing)

All paths are under the `[Memory directory]` root:

```
index.md     # catalog: links to every note with a one-line blurb
log.md       # append-only timeline of what was learned/decided
raw/         # immutable source material (do NOT rewrite)
notes/       # agent-owned synthesis pages (one topic/entity per file)
```

## Operations

- Query: read workspace `memory.md` for this agent's private notes. Then start from `index.md` in the memory directory, open the linked notes, answer using them, and cite the note path. If both are empty, say so and proceed from the request.
- Ingest / save (shared): when you learn something durable that other agents should know, add or update a note in `notes/`, refresh `index.md`, and append a line to `log.md` as `## [YYYY-MM-DD] <topic> - <one line>`.
- Ingest / save (local): when the fact is only for this agent (its procedures, its clients, lessons from its own runs), append or update workspace `memory.md`. Keep it short. Date entries when useful.
- Link: connect related notes with `[[wikilinks]]`. Keep notes short and one-topic.
- Lint (occasionally): flag contradictions, stale claims vs newer sources, orphan notes, and missing index entries; fix or list follow-ups.

## Rules

- Save only durable, reusable knowledge. No secrets, API keys, tokens, or one-off details.
- Prefer updating an existing note over creating near-duplicates. Do not create low-value notes.
- `raw/` is read-only source; synthesis goes in `notes/`.
- Keep notes dated when useful.
- The Memory directory is shared by every agent. Workspace `memory.md` is private to this agent.
