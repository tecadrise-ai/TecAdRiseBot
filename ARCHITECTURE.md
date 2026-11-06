# TecAdRiseBot architecture

Local Windows Electron app. Named agents have chat, Soul, routines, workflows, and a workspace. Turns run on this PC through the Cursor SDK. One agent, one in-flight turn. Each chat or routine turn is a **new** SDK agent; the previous one is deleted. The UI keeps chat history. We do not reuse SDK sessions.

**Host contract:** connected apps and catalog tools are available to every agent. Tool schemas are the capability list. Secrets stay in `secrets.bin`. The model never decrypts that file.

```
You / Routine / Interbot / Local API
        |
        v
   HOST (Electron)
        |  1. Bind connected apps + catalog + this agent’s JSON + host tools. The model chooses tools.
        |  2. Fill MCP ${env:NAME} from secrets.bin
        |  3. SYSTEM.md + holdings paths + Soul
        v
   Cursor SDK  -->  model
        v
   Workspace, memory wiki, skills, connectors
```

```
User -> UI -> Main process -> Cursor SDK -> model
              |- Scheduler: routines, workflow turns
              |- Workflow MCP + tecadrise-host MCP on 127.0.0.1:8787
              |- SQLite + App data: workspaces, memory, skills, secrets.bin
```

## This message

Every turn binds **every connected app**, the **MCP catalog**, this agent’s JSON, and `tecadrise-host` (`message_agent`, `list_peers`, `list_secret_names`, `show_connector`). No per-agent ticks. A new catalog server is for every agent once it is in Settings → MCP. Disconnected apps get `show_connector` and the Connectors pane, not a dead schema dump. The model decides whether to call a tool.

SYSTEM.md is the global system prompt. It is inlined every turn. MEMORY.md and this file stay as files; the agent opens memory when a fact is needed.

## Where things live

| What | Where | How it is used |
| --- | --- | --- |
| API keys, SSH keys, tokens | `secrets.bin` (Settings → API Keys) | Host fills MCP `${env:NAME}`. `list_secret_names` returns names. HTTP `GET /api/secrets/:name` is 403. |
| Cursor SDK key | same file, host-only | Never in the model. |
| Connectors | Settings → Connectors | Bound every turn when the account is connected. Every agent can use them. |
| Extra MCP | Settings → MCP catalog | Bound every turn for every agent. Agent JSON is extra for that agent. |
| Soul | agent `instructions` | In the host prompt. |
| Shared facts | Memory directory | Path in the prompt. The agent decides when to read `index.md` and notes. |
| Private notes | workspace `memory.md` | Workspace path in the prompt. |
| Skills | Skills directory | Index in the prompt. The agent opens `SKILL.md` when that skill helps. Product skill: `tecadrisebot`. |

No OS env for secrets.bin names. Do not decrypt `secrets.bin`. Do not write keys to Soul, memory, disk, or `~/.ssh`.

## Step workflows

Runner sees only the open step. Owner reviews and fixes. The app runs hard checks. Human Retry / Skip / Abort. Host tool MCP for workflows attaches every turn. Kickoff, review, and fix prompts are the job, not a standing essay.

## Rules

- Write only in the agent workspace.
- Talk to another agent with `list_peers` then `message_agent`. That call waits and returns `{ reply }`. Target must be idle. Do not curl the control plane.
- Never print secret values.
