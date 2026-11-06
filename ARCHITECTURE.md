# TecAdRiseBot architecture

Local Windows Electron app. Named agents have chat, Soul, routines, workflows, and a workspace. Turns run on this PC through the Cursor SDK. One agent, one in-flight turn. Each chat or routine turn is a **new** SDK agent; the previous one is deleted. The UI keeps chat history. We do not reuse SDK sessions.

**Host contract:** a capability is a tool already bound for this message. The prompt is identity + Soul + holdings. Secrets stay in `secrets.bin`. The model never decrypts that file.

```
You / Routine / Interbot / Local API
        |
        v
   HOST (Electron)
        |  1. Pick MCP for THIS message (optional apps + agent JSON + host tools)
        |  2. Fill MCP ${env:NAME} from secrets.bin
        |  3. Short holdings prompt + Soul
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

Greetings bind no optional MCP and no host MCP. Work turns bind `tecadrise-host` (`message_agent`, `list_peers`, `list_secret_names`, `show_connector`). Email binds Zoho, browser binds Playwright, and so on, only if that connector is connected. Disconnected apps get `show_connector` and the Connectors pane, not a dead schema dump.

SYSTEM.md, MEMORY.md, and this file are Settings documents. They are not inlined every turn.

## Where things live

| What | Where | How it is used |
| --- | --- | --- |
| API keys, SSH keys, tokens | `secrets.bin` (Settings → API Keys) | Host fills MCP `${env:NAME}`. `list_secret_names` returns names. HTTP `GET /api/secrets/:name` is 403. |
| Cursor SDK key | same file, host-only | Never in the model. |
| Connectors | Settings → Connectors | Bound when the message needs that app and the account is connected. |
| Extra MCP | Settings → MCP catalog | Attached from this message, not on every bot. Agent JSON always attaches. |
| Soul | agent `instructions` | In the host prompt. |
| Shared facts | Memory directory | Path in the prompt; `index.md` first. |
| Private notes | workspace `memory.md` | Workspace path in the prompt. |
| Skills | Skills directory | Index in the prompt; open `SKILL.md` when named. Product skill: `tecadrisebot`. |

No OS env for secrets.bin names. Do not decrypt `secrets.bin`. Do not write keys to Soul, memory, disk, or `~/.ssh`.

## Step workflows

Runner sees only the open step. Owner reviews and fixes. The app runs hard checks. Human Retry / Skip / Abort. Host tool MCP for workflows attaches when the job (or an active run) needs it, not on greetings.

## Rules

- Write only in the agent workspace.
- Talk to another agent with `message_agent`. Target must be idle.
- Never print secret values.
