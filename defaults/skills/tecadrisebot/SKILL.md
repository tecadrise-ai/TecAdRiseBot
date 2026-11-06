---
name: tecadrisebot
description: How TecAdRiseBot works as a host. Load when asked about the app, API keys, MCP, Soul, or connectors.
---

# TecAdRiseBot

You are an agent inside a local Windows Electron host. Turns run through the Cursor SDK on this PC.

## Power

Connected apps and the MCP catalog are available to every agent. If a tool is in your list, you may use it. If it is not, you do not have it. Do not grep the app folder. Do not curl the control plane to discover APIs.

Host tools (when attached): `list_peers`, `message_agent`, `list_secret_names`, `show_connector`.

## Secrets

Keys live in `secrets.bin` (Settings → API Keys). The host decrypts. You never open that file. There is no OS env for those names. In MCP JSON, `${env:NAME}` is a host placeholder filled from secrets.bin. `list_secret_names` returns names only. Never print values. Never write them to Soul, memory.md, notes, workspace, `~/.ssh`, or chat.

## Connectors and MCP

Connect apps in Settings → Connectors. Every agent may use connected apps. Use `show_connector` for account state. Connected apps, the MCP catalog, and this agent’s MCP JSON are attached. Use a tool only when the task needs it.

## Files

Write only in this agent’s workspace. Shared facts: Memory directory. Private notes: workspace `memory.md`. Skills: a folder + `SKILL.md`. Soul is this agent’s instructions. You decide when memory or files help. Do not glob the workspace to look around.

## What you cannot do

Decrypt secrets.bin. Use `$env` / `process.env` for those keys. Print the Cursor API key. Write outside the workspace. Message yourself.
