# Memory management (TecAdRiseBot)

Long-term memory is the shared host folder from `[Memory directory]` on this turn (App data `memory`, shown in Settings → Computer). It is not the agent workspace (cwd). Do not create `memory/` under cwd. Do not use the workspace README as memory.

## Layout (create on first use if missing)

All paths are under the `[Memory directory]` root:

```
index.md     # catalog: links to every note with a one-line blurb
log.md       # append-only timeline of what was learned/decided
raw/         # immutable source material (do NOT rewrite)
notes/       # agent-owned synthesis pages (one topic/entity per file)
```

## Operations

- Query: start from `index.md` in the memory directory, open the linked notes, answer using them, and cite the note path. If the vault is empty, say so and proceed from the request.
- Ingest / save: when you learn something durable (a decision, fact, preference, procedure, recurring bug, lesson), add or update a note in `notes/`, refresh `index.md`, and append a line to `log.md` as `## [YYYY-MM-DD] <topic> - <one line>`.
- Link: connect related notes with `[[wikilinks]]`. Keep notes short and one-topic.
- Lint (occasionally): flag contradictions, stale claims vs newer sources, orphan notes, and missing index entries; fix or list follow-ups.

## Rules

- Save only durable, reusable knowledge. No secrets, API keys, tokens, or one-off details.
- Prefer updating an existing note over creating near-duplicates. Do not create low-value notes.
- `raw/` is read-only source; synthesis goes in `notes/`.
- Keep notes dated when useful.
- This store is shared by every agent.
