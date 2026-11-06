# TecAdRiseBot architecture

Local Windows Electron app. Each agent has its own chat, settings, Soul, routines and workspace. Turns run on this PC via the Cursor SDK. One agent runs one turn at a time.

**App-aware:** every turn opens with **[App]** (also `GET /api/awareness`). That is the live map of this install: features, secrets.bin names, connectors, MCP, paths, control plane. Agents do not guess, do not decrypt secrets.bin, do not search disk for keys.

```
You / Routine / Other agent / Local API
        |
        v
      AGENT  <-- [App] first, then SYSTEM.md, MEMORY.md, ARCHITECTURE.md, MCP, skills, Soul, chat, message
        |
        v
  Workspace, shared memory, workflows, connectors, secrets.bin (via GET /api/secrets)
```

```
User -> UI -> Main process -> Cursor SDK -> model
              |- Scheduler (5 s): routines, workflow turns
              |- Workflow service: steps, checks, reviews
              |- HTTP API 127.0.0.1:8787: control plane, workflow MCP
              |- SQLite + App data: workspaces, memory, skills
```

## Each turn you get
**[App]** first (capabilities + live secrets/connectors/MCP), SYSTEM.md, todo rules, MEMORY.md, ARCHITECTURE.md, memory dir, skills, your Soul, [MCP] tools, [This turn], recent chat, the message.

Host **text** is about 4–5k tokens. Cursor also sends **SDK + MCP tool schemas** every turn (often ~12k). A “hi” with last messages = 0 still bills ~18k input. Chat history is not that cost. MCP tool bodies are extra on top of the name list.

## Where things live (look here first)

| What | Where | How you use it |
| --- | --- | --- |
| API keys, SSH keys, tokens | `secrets.bin` in App data (Settings → API Keys) | Host decrypts. `GET http://127.0.0.1:8787/api/secrets` lists names. `GET /api/secrets/<NAME>` returns `{ name, value }`. Use the value in memory this turn. |
| Cursor SDK key | same file, host-only | Not available to agents. Never print it. |
| Connectors | Settings → Connectors (also in secrets.bin) | MCP servers the host already attached this turn. |
| MCP extra servers | Settings → MCP | Names in `[MCP]` this turn. In MCP JSON, `${env:NAME}` is a **host placeholder** filled from secrets.bin. It is **not** an OS environment variable. |
| Soul | agent `instructions` in SQLite | `[Agent soul]` this turn. PATCH `/api/agents/<id>`. |
| Shared facts | Memory directory | `[Memory directory]` this turn. `index.md` first. |
| Your notes | workspace `memory.md` | Workspace path this turn. |
| Skills | Skills directory | `[Skills]` this turn. |

There is **no OS env** for secrets.bin keys. Do not use `$env:NAME`, `%NAME%`, or `process.env`. Do not decrypt `secrets.bin`. Do not search `~/.ssh` or write key files. Never store secret values in Soul, memory.md, notes, workspace, or chat.

## Step workflows
```
Runner: step_current -> work -> step_done
  App: hard checks --fail--> Runner retries (uses a try)
  review on? --> Owner review --reject--> Runner retries with reason
  pass --> next step ... --> done
Runner step_fail or tries used up --> Owner fix: fix_step | retry_step | abort_run (pause)
  abort_run --> Human Resume / owner resume_run continues from the same step
```
- **Runner** (agent whose routine started the run): sees only the current step. Cannot see later steps, approve itself or edit the workflow. Reaches the owner only via `step_fail`.
- **Owner** (runner's Owner agent, else the workflow creator, may be the same agent with Owner model settings): creates and edits its workflows, reviews and fixes. Never runs workflows. Verdicts and fixes work only inside a review or fix turn the app starts. `resume_run` reopens an aborted run at the open step.
- **App**: decides whose turn it is, runs hard checks (`file_exists`, `file_contains`, `output_matches`, `command`), counts tries.
- **Human**: Retry, Skip or Abort a blocked run. Abort pauses at the current step. Resume continues from there; done steps stay done.
- Limits: 3 owner fixes per run, 3 idle runner turns, 2 idle owner turns, then blocked.

## Rules
- Write only in your workspace. Never in the app folder.
- Interbot: `POST /api/agents/<id>/interbot`, target must be idle. Live state: `GET /api`, `GET /api/agents/<id>/snapshot`.
- Never print or store the Cursor API key or any secrets.bin value.
