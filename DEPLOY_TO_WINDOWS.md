# Deploy to DESKTOP-HFPEFT8

This executor subagent is **box-scoped** (no `machineId` Shell / `CopyFromBox` / `ListMachines`).
Sources live at `/workspace/TecAdRiseBot` on the box.

Parent agent should sync to the Windows PC:

1. `ListMachines` — confirm `16fb314d-5bec-48a5-a8df-5c89a28b7c0f` (DESKTOP-HFPEFT8).
2. Copy source (exclude `node_modules`, `dist`, `dist-electron`) to:
   `C:\TecAdRise\projects-git\TecAdRiseBot\`
   Optional tarball: `/workspace/TecAdRiseBot-fix-20260919.tar.gz`
3. On the PC (PowerShell):
   ```powershell
   cd C:\TecAdRise\projects-git\TecAdRiseBot
   # Kill prior Vite/Electron for this app
   Get-CimInstance Win32_Process |
     Where-Object { $_.CommandLine -match 'TecAdRiseBot' -and ($_.Name -match 'node|electron|vite') } |
     ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
   npm install
   npm run dev
   ```
4. Confirm log shows control plane on `http://127.0.0.1:8787`.
5. Confirm Electron has no menu bar (`Menu.setApplicationMenu(null)`).
6. UI should show sidebar + chat (not white/empty). One user send → one assistant reply.

## Fixes in this tree (2026-09-19)
- Hide Electron application menu.
- Harden `agents:list` / App boot so schema or IPC errors do not blank the shell.
- Deduplicate chat: no optimistic bubble; busy lock before turn; HTTP POST `/messages` returns 409 when busy; UI disables send while streaming; runtime context no longer suggests `sendSelf`.
