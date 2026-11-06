# TecAdRiseBot — professional agent-host redesign

Status: plan only. Not an implementation checklist to dump in one PR.  
Sources: CopilotKit OpenBot, Nous Hermes Agent, and our current Electron + Cursor SDK host.

---

## 1. Big picture

TecAdRiseBot is a **local Windows agent host**. People and routines talk to named agents. Each agent has a Soul, a workspace, routines, and workflows. Turns run on this PC through the **Cursor SDK**. Secrets live in **secrets.bin**. Connectors and MCP are how an agent reaches the outside world.

That product is fine. The host contract is not.

Today we make an agent “app-aware” by **pasting the product into the prompt**: `[App]`, SYSTEM.md, MEMORY.md, ARCHITECTURE.md, `[MCP]` names, skills dump, Soul, `[This turn]`, plus curl for the control plane and `GET /api/secrets/<NAME>`. At the same time Cursor already sends **every SDK tool schema and every attached MCP schema**. GeneralQA saying “hi” with last messages = 0 still bills ~18k input. Playwright is not 18k by itself; **our text (~5k) + every tool schema (~13k)** is. Chat history is not the bill.

OpenBot and Hermes do the opposite:

> **A capability the model may use is a tool the host already bound for this agent, this person, this turn.**  
> The prompt only says how to use **what is already in the tool list**.  
> Secrets stay in the host. Connectors are grants + UI, not a markdown inventory.  
> If the tool list is large, the model **searches** tools; it does not receive Shopify-scale schemas on “hi”.

They learned this the hard way (OpenBot: 239 Shopify tools killed the run; Bots described capabilities they did not hold and then browsed Google). We are in that same failure mode, just smaller.

**We are not cloning OpenBot or Hermes.** We do not need AG-UI, CopilotKit Intelligence, or a Python TUI. We keep Electron, Cursor SDK, secrets.bin, SQLite, workspaces, workflows. We change **how the host offers power**.

---

## 2. Main goal

**The agent is competent because the host is strict, not because the prompt is long.**

A TecAdRiseBot agent should:

1. **See only the tools it is allowed to use this turn** (SDK subset + granted MCP + a few host tools).
2. **Never see secret values** (SSH keys, API tokens). The host injects them into MCP/stdio env. The model calls tools.
3. **Know it is TecAdRiseBot** from a short identity + Soul + a product **skill loaded on demand**, not from `[App]` + ARCHITECTURE.md every turn.
4. **Get a missing connector as a UI card**, not as “github: off” in markdown and not as “connect it in Settings”.
5. **Cost a “hi” in the low thousands of input tokens**, not ~18k, when last messages = 0 and no browser/MCP is granted.
6. **Behave the same on chat, routine, workflow, and interbot** because the same grant + prompt assembler runs for all of them.

Success is measured on those six, not on more documentation in the prompt.

What “app-aware” should mean here:
Host (Electron)
  1. Pick tools for THIS agent + THIS message
       SDK subset + granted MCP (not global Playwright on every bot)
       + a few host tools: interbot, todos, maybe list_secret_names
  2. Fill MCP env from secrets.bin  — model never sees values
  3. Prompt = short identity + holdings-only guidance + Soul
       skills = index; ARCHITECTURE stays a Settings page, not a prompt
  4. If GitHub is off: tool `show_app_access` / UI, not a markdown “off”

---

## 3. Non-negotiables (keep)

These stay true in every phase:

| Keep | Why |
| --- | --- |
| Electron app, local PC, Cursor SDK turns | Product |
| One agent, one in-flight turn | Simplicity and safety |
| `secrets.bin` + host decrypt; **no OS env** for those names | User constraint |
| Never write keys to Soul, memory.md, notes, workspace, `~/.ssh`, chat | Leak surface |
| Cursor SDK key never leaves the host | Billing |
| Workspace write boundary (not the app folder) | Isolation |
| `${env:NAME}` in MCP JSON = **host placeholder from secrets.bin**, not `process.env` | Already correct |
| Control plane on `127.0.0.1` only | Local |
| Soul, routines, workflows, shared memory wiki, skills dirs | Product |

---

## 4. Target architecture

```
You / Routine / Interbot / Local API
        |
        v
   HOST (Electron)
        |  1. Resolve grants for this agent (MCP, connectors, host tools)
        |  2. Fill MCP env from secrets.bin  — values never enter the prompt
        |  3. Build a short holdings-aware system prompt (stable prefix + Soul + volatile date)
        |  4. Attach only granted MCP servers to the Cursor SDK agent
        v
   Cursor SDK  -->  model
        |           tools: SDK + granted MCP + host tools (interbot, secret_names, show_connector, …)
        v
   Workspace, memory wiki, skills (index now, body on skill_view-equivalent)
```

### 4.1 Three planes (steal the shape, not the code)

**Grant plane (OpenBot `plugin_grants`)**  
Per agent: which MCP servers, which connectors, which host tools. Global MCP JSON is a **catalog**, not an automatic attach. Playwright is a grant, not a default.

**Execution plane (OpenBot gateway / Hermes toolsets)**  
The SDK call list **is** the capability list. Connector MCP is attached only if granted **and** connected. A disconnected grant still offers `show_connector` (card), not a dead schema dump.

**Prompt plane (Hermes stable / context / volatile)**  
- **Stable:** identity (you are agent X in TecAdRiseBot), workspace path, todo spelling for the tools that exist, “do not write outside workspace”. Byte-stable across “hi”.  
- **Context:** Soul. Skills **index** (name + one line). Optional product skill name, not the body.  
- **Volatile (last):** today UTC, this-turn workflow step, “GitHub connected / off”. Small. Last on purpose so the prefix cache lives.

ARCHITECTURE.md, SYSTEM.md, MEMORY.md, control-plane curl, `[App]`, `[MCP]` name lists **leave the default prompt**. They remain Settings pages and `GET /api` for humans and scripts.

### 4.2 How app info is passed (the professional mapping)

| Concern | Amateur (now) | Professional (target) |
| --- | --- | --- |
| “You can use GitHub” | Bullet in `[App]` | GitHub MCP actually attached **or** `show_connector` tool |
| “Playwright exists” | Global MCP on every agent | Grant `browser` toolset on agents that need it |
| “SSH key VPS1_KEY1” | `GET /api/secrets/VPS1_KEY1` into model memory | Host fills MCP/ssh tool env; model never sees PEM |
| “Here is the product” | `[App]` + ARCHITECTURE.md every turn | Short identity + skill `tecadrisebot` loaded when asked |
| “Here are skills” | Full catalog text | Index; load SKILL.md when the agent opens it |
| “Talk to another agent” | curl interbot in the prompt | Host tool `message_agent(to, text)` |
| “Secret for a form” | Agent pastes key | Host vault / masked field (later); never chat |
| Too many tools | Attach all | Per-agent grants; if > ~30–50 MCP tools, `search_tools` |

### 4.3 Holdings-only prompt rule (OpenBot `computerGuidance`)

If the agent does **not** hold a search MCP, do not mention search.  
If Playwright is **not** granted, do not mention a browser.  
If GitHub is connected but **not** granted to this agent, say it cannot use GitHub (or offer `show_connector`), do not list it as “connected” as if that were a tool.

One story, chosen by what this run holds. Two stories in one prompt is how models invent curl and decrypt `secrets.bin`.

---

## 5. Current vs target (honest)

| Now | Target |
| --- | --- |
| `mcpServersForAgent` = global MCP ∪ agent JSON ∪ **all connected connectors** ∪ extra | Same merge **intersected with this agent’s grants** |
| Playwright in Settings → MCP hits GeneralQA | Default agents: no browser MCP |
| `[App]` ~500 tokens of live map + curl | ~150–250 tokens identity + holdings |
| ARCHITECTURE.md + SYSTEM.md + MEMORY.md in every system prompt | Settings documents; prompt cites paths only if needed |
| `[MCP]` repeats server names already in tool schemas | Delete the block |
| Skills: `formatSkillsCatalog()` dump | Names + one-liners; body on demand |
| `GET /api/secrets/:name` for agents | Keep for **human/scripts** if we must; **agents do not use it**. Prefer remove agent access to values |
| Connectors: markdown connected/off | Grant + attach or card |
| Prompt rebuilt every turn, `[App]` first | Stable prefix; volatile last |
| No audit of tool/MCP use | At least log which MCP/tools were **sent** vs **called** (OpenBot `mcp.tools_discovered`) |

Token target for GeneralQA “hi”, last messages = 0, no extra MCP:

| Piece | Now | Target |
| --- | --- | --- |
| Host text | ~4.5–5k | ~1–1.5k (identity + Soul + skills index) |
| SDK tools | several k (Cursor, we cannot delete their builtins) | same, unless Cursor later allows tool subset |
| Playwright MCP | several k | **0** unless granted |
| Other connector MCP | 0–many | only granted + connected |
| **Billed input** | ~18k | SDK builtins + ~1.5k host. Should drop by whatever Playwright + extra MCP + duplicate docs were. |

We cannot make Cursor omit shell/read/grep. We **can** stop hanging Playwright and GitHub on every bot and stop paying 4k duplicate markdown.

---

## 6. Phased plan

Do not mix all phases in one commit. Each phase has a visible token or behaviour win.

### Phase 0 — Instrument (1–2 days)

**Goal:** stop guessing the 18k.

- Log per turn: host system prompt **chars**, MCP server **names attached**, agent id, `inputTokens` from Cursor.
- Footer or debug: `hostChars`, `mcp: playwright,github`, `in: 17793`.
- Optional: count tool names if the SDK ever exposes them.

Exit: we can prove “Playwright off saved Xk” with a before/after “hi” on GeneralQA.

### Phase 1 — Grants: stop the global attach (highest leverage)

**Goal:** Playwright and connectors are **opt-in per agent**.

Data model (SQLite, on `agents.config` or a `agent_grants` table):

```
grants: {
  mcp: ["playwright"],          // names from global + agent JSON catalogs
  connectors: ["github"],       // connector ids
  hostTools: ["interbot", "todos"]
}
```

Behaviour:

- **Catalog** (Settings → MCP, Settings → Connectors) stays global: “these servers exist”.
- **Attach** at `mcpServersForAgent`: `catalog ∩ grants`, plus workflow `extraMcp` which is already a grant-by-construction.
- New agents: **empty MCP grants** (chat/Q&A does not get a browser).
- Existing agents: migration — either copy current “everything on” once, or default off and let the user tick Playwright on VPS/browser agents. Prefer **default off** with a Settings notice, because 18k is the bug.
- UI: Agent gear → **Tools**: checkboxes for each catalog MCP and each connector. Not a second JSON editor.

Hermes equivalent: toolsets. OpenBot equivalent: `plugin_grants`.

Exit: GeneralQA “hi” no longer includes Playwright schemas unless ticked. Token drop is the proof.

### Phase 2 — Secrets stay in the host (correctness + security)

**Goal:** the model never receives a secret value.

- Host already expands `${env:NAME}` from secrets.bin into MCP env/headers/url. **That is the professional path. Keep it. Document it as the only agent path.**
- Agents must not be told to `GET /api/secrets/<NAME>`.
- Remove value-returning secret fetch from the **agent-facing** contract (`formatAppAwareness`, SYSTEM, MEMORY, ARCHITECTURE, snapshot curl examples).
- Keep `GET /api/secrets` **name list** for the UI and for host tools.
- Decision on `GET /api/secrets/:name`:
  - **Preferred:** 404/403 for agent use; only the Electron main process reads values.
  - If a rare tool needs a raw key in a command (SSH), add a **host tool** later that runs ssh with the key in a temp handle the model never sees — not “paste PEM into the prompt”.
- Cursor key remains host-only.

OpenBot: vault ids in config, `computer_request_secret` for UI fields. Hermes: OAuth cards, tokens in config. Neither says “here is the PEM, keep it in working memory”.

Exit: grep of prompt builders finds no instruction to fetch secret values. VPS agent still works via MCP/host-filled env or a dedicated ssh tool.

### Phase 3 — Kill prompt slop (Hermes prompt assembler)

**Goal:** one short holdings-aware prompt.

Delete from the **default** `hostSystemPrompt`:

- `[App]` live map and curl cheatsheet  
- Full ARCHITECTURE.md  
- Full SYSTEM.md / MEMORY.md as duplicate policy (fold the few remaining rules into identity)  
- `[MCP]` name list  
- Long checklist essay (replace with 4 lines **if** todo tools exist)  
- Repeated `[This turn]` overlap with identity  

Keep:

- Identity: agent name, id, workspace, “TecAdRiseBot local Electron, Cursor SDK, write only here”.  
- Soul.  
- Skills **index**.  
- Workflow/runner extra system (already a real holdings case).  
- Memory dir **path** + “read index.md first” (one line).  

Assembler shape (`electron/prompt/`):

1. `stable` — identity, workspace, holdings guidance (generated from grants)  
2. `context` — Soul, skills index  
3. `volatile` — date UTC, connected-but-not-granted connectors, workflow step  

`GET /api/awareness` becomes a **JSON holdings object** for humans/debug, not a second prompt.

Holdings guidance (OpenBot `grantedToolGuidance`):

- “You can reach: github (tools already attached).”  
- “Drive is in this install but not granted to you.”  
- Empty if nothing extra is attached.

Exit: host text for GeneralQA “hi” ~1–1.5k. Architecture diagram shows **host text vs billed**, and billed drops after Phase 1.

### Phase 4 — Host tools instead of curl-in-the-prompt

Cursor SDK does not give us OpenBot’s full frontend-tool runtime. We still can:

| Host tool (names illustrative) | Replaces |
| --- | --- |
| `message_agent(toAgentId, text)` | curl interbot in `[App]` |
| `list_secret_names` | dumping names + “GET value” |
| `show_connector(id)` | “github: off; human must Connect” |
| Workflow MCP (already exists) | keep; it is already a real tool |

Implementation options (pick one, do not mix):

**A. Small local MCP server** (recommended): Electron already serves `:8787`. Add `tecadrise-host` MCP (stdio or http) attached **every** turn, with the 2–4 tools above. Same pattern as workflow runner MCP. Grants can hide `message_agent` if we want.

**B. Prompt-only for leftovers** until A ships — but then we are still amateur on those verbs.

Do **not** add `get_secret(name)` as a model-visible tool. That re-opens Phase 2.

`show_connector`: tool result includes a marker the UI already knows how to turn into the Connectors tab / OAuth (OpenBot `[connect-app]` JSON). Until the card exists, the tool can return “open Settings → Connectors” **and** the UI should flash that pane. Better than a paragraph in `[App]`.

Exit: interbot and “please connect GitHub” work with **no** control-plane essay in the system prompt.

### Phase 5 — Connectors as products (OpenBot app states)

**Goal:** a connector is a grant + an account state, not a boolean in markdown.

Per person/install (we are single-user today, still model it):

`ready` | `not_connected` | `reconnect` | `disabled` | `not_granted`

- Settings → Connectors: enable catalog + Connect (OAuth) as now.  
- Agent Tools: grant connector.  
- Turn attach: only `ready` ∩ granted.  
- If granted but `not_connected`: attach **zero** GitHub tools; offer `show_connector`.  
- Do not attach failed MCP servers “so the name exists”. Dead schemas still cost tokens.

Later: user-OAuth “as the signed-in person” vs install-wide token (OpenBot Drive vs deployment token). We are one Windows user; still keep **install token vs per-agent grant** distinct.

Exit: disconnecting GitHub removes its schemas from the next turn. Granting it to one agent does not give it to GeneralQA.

### Phase 6 — Skills and product awareness (Hermes)

**Goal:** progressive disclosure.

- Skills prompt = category index, one line each (we already have a catalog formatter; shorten it).  
- Add bundled skill **`tecadrisebot`**: how Soul, routines, workflows, control plane, secrets.bin **host injection**, workspaces work. Agent loads it with the same skill mechanism humans already use (open SKILL.md), not via ARCHITECTURE.md in the system prompt.  
- Hermes line to copy: *for help with the product, load the product skill; docs are authoritative; do not invent workarounds.*  
- Auto-load that skill only on agents that are allowed to reconfigure the app; not on a locked-down Q&A bot.

Exit: an agent asked “how do I store an API key?” opens the skill or tells the user Settings → API Keys, and does **not** decrypt `secrets.bin`.

### Phase 7 — Tool search if catalogs grow (OpenBot `search_tools`)

**Goal:** survive a fat MCP (Playwright is already fat; Shopify-scale is fatal).

- Floor ~50 tools **beyond** Cursor builtins if we can see MCP tool names after connect.  
- If we cannot intercept Cursor’s tool list, the only control is **which MCP servers we attach** (Phase 1). That is enough for Playwright.  
- If the SDK later supports tool allowlists, use them. Do not wait for that to ship Phase 1.

Exit: no agent silently receives 100+ MCP tools. If someone grants Playwright, they accept that cost on **that** agent.

### Phase 8 — Policy, audit, cache (maturity)

Not required to look professional on “hi”. Required to look professional when agents can spend money or SSH.

- Audit row: agent, initiator (`person` | `routine` | `interbot` | `workflow`), MCP/tool name, allowed/denied, **no secret values**.  
- Optional allow/deny on MCP tool names per agent (OpenBot CEL is overkill; start with grant = allow).  
- Prompt cache: keep `stable` byte-identical across turns; put date last (Hermes). Recreate SDK agent when grants or Soul change, not on every “hi” if the SDK allows reuse — today `getHandle` **always** creates a fresh SDK agent; revisit whether that is required.  
- Injection scan on workspace `AGENTS.md` / skill files if we start auto-injecting them (Hermes `_scan_context_content`).

### Phase 9 — Docs and diagram (after behaviour)

- Rewrite `ARCHITECTURE.md` as **human** architecture (this file’s big picture), not as a prompt pack.  
- Diagram: Grant plane / Execution plane / Prompt plane; token numbers from Phase 0 logs.  
- `docs/control-plane.md`: scripts and UI; **not** the agent contract.  
- Remove “use GET /api/secrets/:name” from agent-facing docs.

---

## 7. UI changes (so the host matches the model)

| Screen | Change |
| --- | --- |
| Agent gear | **Tools** checklist: MCP catalog entries, connectors, host tools. Default empty MCP. |
| Settings → MCP | Copy: “Catalog. Agents attach what you tick on each agent.” Global JSON is not “on for everyone”. |
| Settings → Connectors | Keep OAuth. Show which agents are granted. |
| Settings → Architecture | Human diagram + token meter from last turns. |
| Chat footer | `in / out / mcp: a,b` so 18k is never a mystery again. |
| Connect card | From `show_connector` (Phase 4–5). |

Do not build a second SSH-key UI. Keys stay in API Keys / secrets.bin. The redesign is grants and tools, not more secret forms.

---

## 8. What we will not do

- Rewrite on AG-UI / LangGraph / CopilotKit Intelligence. Wrong product.  
- Put secrets in OS env.  
- Let agents decrypt `secrets.bin`.  
- Keep `[App]` as the “professional” awareness layer. It is a catalog pasted into context.  
- Attach all connectors because they are connected. Connected ≠ granted.  
- “Search the app repo to learn the product.” Product skill + grants replace that.  
- One giant PR. Phase 1 is the 18k fix; Phase 3 is the slop fix; Phase 2 is the security fix. Order: **0 → 1 → 2 → 3**, then 4–6, then 7–9.

---

## 9. Suggested sequence on the calendar

| Order | Phase | Why this order |
| --- | --- | --- |
| 1 | 0 Instrument | Proof |
| 2 | 1 Grants | Token drop, Playwright off GeneralQA |
| 3 | 2 Secrets out of the model | Stop the worst instruction |
| 4 | 3 Slim prompt | Stop paying 4k duplicate docs |
| 5 | 4 Host MCP tools | Replace curl |
| 6 | 5 Connector states + card | Replace markdown connectors |
| 7 | 6 Product skill + skills index | Real app-awareness |
| 8 | 7–9 | Scale, audit, docs |

---

## 10. Definition of done (the product bar)

The redesign is done when all of these are true:

1. **Main goal:** competence comes from grants + tools, not from a capability essay.  
2. GeneralQA “hi”, last messages = 0, default grants: billed input is **SDK builtins + ~1–2k host**, no Playwright.  
3. A browser agent has Playwright because it is **ticked**, and its “hi” is allowed to be expensive.  
4. No system prompt tells the model to read secret **values**. VPS still works.  
5. `[App]`, ARCHITECTURE.md, and `[MCP]` name lists are **not** in the turn prompt.  
6. Interbot and “connect GitHub” are **tools or UI**, not curl samples.  
7. An agent asked how TecAdRiseBot works loads **`tecadrisebot` skill** or answers from identity; it does not grep the app folder or decrypt `secrets.bin`.  
8. Architecture diagram and this plan match the running host.

Until then we are still the amateur host with a longer README in the model’s mouth.
