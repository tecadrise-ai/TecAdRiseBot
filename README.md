# TecAdRiseBot

Local-only Windows desktop multi-agent chat shell (Electron + React + TypeScript).  
Uses the [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript) for agent turns. No remote PC / cloud-box features.

## Requirements (Windows)

- **Node.js 22.13+** (required by `@cursor/sdk`)
- npm 10+
- Windows 10/11



## Agent / developer handover

Full context for continuing work (architecture, control plane, open tasks, hard rules): **[HANDOVER.md](./HANDOVER.md)**.
## Quick start

```powershell
cd C:\TecAdRise\projects-git\TecAdRiseBot
npm install
npm run dev
```

This opens the Electron window with Vite HMR.

## Set API key and chat

1. Click the **account row** at the bottom of the left sidebar (or **Settings** in the chat header).
2. Open the **General** tab.
3. Paste your **Cursor API key** (Cursor Dashboard â†’ API Keys) and click **Save**.  
   The key is stored with Electron `safeStorage` under the app `userData` folder.
4. Pick a **default model** (loaded via `Cursor.models.list()` when a key is present) and **Apply**.
5. Select an agent in the sidebar (or create one with **+**).
6. Type in the composer and press **Enter** / **Send**.  
   Turns run with `Agent.create` / `Agent.resume` + `local.cwd` under  
   `%APPDATA%\tecadrise-bot\workspaces\<agentId>\` (exact productName folder may vary).

If no key is saved, the assistant replies with a clear error instead of crashing.


## Agentic control plane

TecAdRiseBot exposes a **localhost-only** HTTP control plane so external agents (e.g. Cursor IDE) have full read/write control, and in-app agents can reconfigure themselves.

- **Base URL:** `http://127.0.0.1:8787` (override with `TECADRISE_API_PORT`)
- **Catalog:** `GET /api` (machine-readable)
- **Docs:** [docs/control-plane.md](docs/control-plane.md)
- Sidebar footer / Settings â†’ Computer show the live API URL when the server is up.

### Example curls

```powershell
# List agents
curl http://127.0.0.1:8787/api/agents

# Read chat history
curl "http://127.0.0.1:8787/api/agents/<AGENT_ID>/messages?limit=100"

# Send a message (waits for the turn)
curl -X POST http://127.0.0.1:8787/api/agents/<AGENT_ID>/messages `
  -H "Content-Type: application/json" `
  -d "{"text":"Status update"}"

# Patch agent instructions / soul
curl -X PATCH http://127.0.0.1:8787/api/agents/<AGENT_ID> `
  -H "Content-Type: application/json" `
  -d "{"instructions":"You are a concise ops agent."}"
```

Every in-app turn prepends `SYSTEM.md` (app root) plus a short live identity block (name, id, model, peer count).

## Features (MVP)

| Feature | How |
| --- | --- |
| Agent sidebar | Search, colored avatars, last-message snippets, Marketplace stub, account row |
| Chat | Streaming transcript via SDK `onDelta` / `run.stream()` |
| Settings | General / Computer / Usage & Billing / Updates |
| Inter-bot | Sidebar â†’ Inter-bot message (persisted on both sides; target agent runs a turn) |
| Routines | In-app cron while the app is open (15s tick + cron-parser) |

## Scripts

- `npm run dev` â€” Electron + Vite development
- `npm run build` â€” typecheck + production Vite/Electron build

## Security notes

- `contextIsolation: true`, `nodeIntegration: false`, preload bridge only (`window.tecapi`)
- API key never written to the SQLite chat DB
- Local agent workspaces are under Electron `userData`

## Troubleshooting

- **Node engine / SDK**: upgrade to Node â‰¥ 22.13 if `npm install` or Agent.create fails.
- **Native / Electron**: if Electron fails to download, retry with network access; delete `node_modules` and reinstall.
- **sql.js**: persistence uses WASM sql.js (no `better-sqlite3` rebuild required).
- **Models empty**: save a valid API key, then reopen Settings â†’ General.

## License

MIT
