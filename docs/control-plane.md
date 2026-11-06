# TecAdRiseBot control plane

Localhost HTTP API for external agents (Cursor IDE, scripts) and for in-app agents to reconfigure themselves.

## Base URL

```
http://127.0.0.1:8787
```

- Binds **127.0.0.1 only** (never LAN/WAN).
- **No auth** (same spirit as agent-os `:8770`).
- Override port: env `TECADRISE_API_PORT` or `PATCH /api/settings` with `{ "apiPort": 8790 }` then restart.

Machine-readable catalog: `GET /api`

## Route table

| Method | Path | Summary |
| --- | --- | --- |
| GET | `/api` | Catalog + curl examples |
| GET | `/api/health` | Liveness |
| GET | `/api/awareness?agentId=` | Live `[App]` capability brief (secrets, connectors, MCP, paths) |
| GET | `/api/agents` | List agents |
| POST | `/api/agents` | Create `{ name, model?, instructions?, config?, enabled? }` |
| GET | `/api/agents/:id` | Get agent + status |
| PATCH | `/api/agents/:id` | Update partial fields |
| DELETE | `/api/agents/:id` | Delete agent |
| GET | `/api/agents/:id/messages?limit=&before=` | Full chat history |
| POST | `/api/agents/:id/messages` | Send chat, await turn → `{ user, assistant }` |
| GET | `/api/agents/:id/status` | `busy` \| `idle` |
| GET | `/api/agents/:id/snapshot` | Self-awareness blob |
| POST | `/api/agents/:id/interbot` | `{ toAgentId, text }` |
| GET | `/api/routines` | List (`?agentId=`) |
| POST | `/api/routines` | Create |
| PATCH | `/api/routines/:id` | Update |
| DELETE | `/api/routines/:id` | Delete |
| POST | `/api/routines/:id/run` | Run now |
| GET | `/api/settings` | Public settings (**no raw API key**) |
| PATCH | `/api/settings` | Non-secret fields |
| POST | `/api/settings/api-key` | `{ apiKey }` — local secret write |
| GET | `/api/secrets` | List API Key names in secrets.bin (no values) |
| GET | `/api/secrets/:name` | Read one secrets.bin value (host decrypts). Cursor key is blocked. |
| GET | `/api/models` | Models |

## Secrets

API keys and SSH keys live in `secrets.bin` (Settings → API Keys). The host decrypts. Agents do not decrypt the file and do not get OS env vars for these names.

```
curl -s http://127.0.0.1:8787/api/secrets
curl -s http://127.0.0.1:8787/api/secrets/VPS1_KEY1
```

## Security

- Never returns the Cursor API key from GET endpoints.
- Other secrets.bin values are available on localhost `GET /api/secrets/:name` so agents can use them without writing files.
- Do not port-forward or expose `8787` outside the PC.
