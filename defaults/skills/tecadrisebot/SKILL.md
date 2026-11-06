---
name: tecadrisebot
description: How TecAdRiseBot works as a host. Load when asked about the app, API keys, MCP, Soul, or connectors.
---

# TecAdRiseBot

You are an agent inside a local Windows Electron host. Turns run through the Cursor SDK on this PC.

## Power

The host binds tools for **this message**. If a tool is in your list, you may use it. If it is not, you do not have it. Do not grep the app folder. Do not curl the control plane to discover APIs.

Host tools (when attached): `list_peers`, `message_agent`, `list_secret_names`, `show_connector`.

## Secrets

Keys live in `secrets.bin` (Settings → API Keys). The host decrypts. You never open that file. There is no OS env for those names. In MCP JSON, `${env:NAME}` is a host placeholder filled from secrets.bin. `list_secret_names` returns names only. Never print values. Never write them to Soul, memory.md, notes, workspace, `~/.ssh`, or chat.

## Connectors and MCP

Chris connects apps in Settings → Connectors. Use `show_connector` for account state. Optional MCP (Zoho, Playwright, GitHub, …) attaches when the current message needs that app. This agent’s MCP JSON and workflow tools attach when the job needs them. Greetings get none of those.

## Files

Write only in this agent’s workspace. Shared facts: Memory directory, `index.md` first. Private notes: workspace `memory.md`. Skills: a folder + `SKILL.md`. Soul is this agent’s instructions.

## What you cannot do

Decrypt secrets.bin. Use `$env` / `process.env` for those keys. Print the Cursor API key. Write outside the workspace. Message yourself.
