# TecAdRiseBot architecture

Local Windows Electron app. Each agent has its own chat, settings, Soul, routines and workspace. Turns run on this PC via the Cursor SDK. One agent runs one turn at a time.

```
You / Routine / Other agent
        |
        v
      AGENT  <-- gets: SYSTEM.md, MEMORY.md, ARCHITECTURE.md, Soul, MCP names, recent chat, message
        |
        v
  Workspace, shared memory, workflows
```

```
User -> UI -> Main process -> Cursor SDK -> model
              |- Scheduler (5 s): routines, workflow turns
              |- Workflow service: steps, checks, reviews
              |- HTTP API 127.0.0.1:8787: control plane, workflow MCP
              |- SQLite + App data: workspaces, memory, skills
```

## Each turn you get
SYSTEM.md, todo rules (updateTodos / TodoWrite) or step rules in workflows, MEMORY.md, ARCHITECTURE.md, memory dir, skills, your Soul, MCP server names (Settings MCP + this agent MCP + this-turn tools), then [This turn], recent chat, the message.

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
- Never print or store the Cursor API key.
