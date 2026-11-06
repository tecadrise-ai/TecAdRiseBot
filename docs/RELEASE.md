# TecAdRiseBot — release and build

Ship **binaries**, not a GitHub clone. The installer name, zip name, and Windows ProductVersion all come from **`package.json` `"version"`**. Never reuse a version that already left this folder.

| Current | Value |
| --- | --- |
| Product | TecAdRiseBot |
| Version in git | **0.1.2** (`package.json`) |
| Repo | `C:\TecAdRise\projects-git\TecAdRiseBot` |
| Remote | `https://github.com/tecadrise-ai/TecAdRiseBot.git` |
| Branch | `master` |
| Commit prefix | `V02:` |
| This folder | `C:\TecAdRise\tecadrise-bot-release\` |
| App id | `com.tecadrise.bot` |

Dev work stays `npm run dev` (Vite 5173, API 8787). Do not use a packaged exe to iterate.

---

## Version control (do this first)

1. Working tree **clean**. `git status` empty except the files for this release.
2. **Bump** `"version"` in `package.json` (semver).  
   - Patch (icon, installer, small fix): `0.1.2` → `0.1.3`  
   - Behaviour users will notice: `0.2.0`  
   If `TecAdRiseBot Setup 0.1.2.exe` already exists here, **do not build 0.1.2 again**.
3. Commit on `master` with prefix **`V02:`** and the version in the subject, for example:  
   `V02: 0.1.3 — …`
4. **Tag** the same commit (annotated):

```bat
git tag -a v0.1.3 -m "TecAdRiseBot 0.1.3"
git push origin master
git push origin v0.1.3
```

5. Build **after** the version commit exists. The exe must match git. Do not stamp a new exe on an unpushed bump.

---

## Windows build

Node **≥ 22.13**. Close TecAdRiseBot and anything locking `win-unpacked` (Explorer preview, Double Commander in that dir). A lock on `release\win-unpacked.tmp` is `EPERM`.

Default `npm run dist` writes to the repo `release\` folder and often fails when that folder is open. **Write here instead:**

```bat
cd /d C:\TecAdRise\projects-git\TecAdRiseBot
npm run build
npx electron-builder --win nsis dir --config.directories.output=C:/TecAdRise/tecadrise-bot-release
```

That produces:

- `TecAdRiseBot Setup 0.1.x.exe` — NSIS installer (what you copy to another PC)
- `TecAdRiseBot Setup 0.1.x.exe.blockmap` — updater map, keep next to the Setup
- `latest.yml` — electron-builder metadata
- `win-unpacked\` — portable tree (`TecAdRiseBot.exe`)

Zip the unpacked tree so the zip name matches the version:

```powershell
$ver = (Get-Content C:\TecAdRise\projects-git\TecAdRiseBot\package.json | ConvertFrom-Json).version
$out = "C:\TecAdRise\tecadrise-bot-release"
Compress-Archive -Path "$out\win-unpacked\*" -DestinationPath "$out\TecAdRiseBot-$ver-win-unpacked.zip" -Force
```

Leave older `Setup 0.1.0.exe` / `0.1.1.exe` in place. Do not overwrite them.

---

## Icon (do not skip)

Windows cannot show a **PNG-only** `.ico` on the Setup file, and cannot load a taskbar icon from **inside `app.asar`**.

- Source icon: `resources/tecadrisebot-v2.ico` — classic **BMP/DIB** sizes (16–256). Rebuild with `python scripts/write-win-ico.py` if someone saves a PNG ico again.
- `build.win.icon` and `build.nsis.installerIcon` / `uninstallerIcon` / `installerHeaderIcon` must point at that file.
- `extraResources` copies it to `win-unpacked\resources\tecadrisebot-v2.ico` (next to the asar, not inside it).

Check before you copy the build off this PC:

- Double Commander / Explorer: **Setup 0.1.x.exe** shows the orange TecAdRise mark (refresh F2).
- `win-unpacked\TecAdRiseBot.exe` shows the same mark.
- `win-unpacked\resources\tecadrisebot-v2.ico` exists.
- After install: taskbar + Start shortcut. If the old blank icon sticks, unpin, delete `%APPDATA%\Microsoft\Windows\Start Menu\Programs\TecAdRiseBot.lnk`, reinstall, pin again.

---

## What to give another PC

1. `TecAdRiseBot Setup <version>.exe`  
   or `TecAdRiseBot-<version>-win-unpacked.zip`
2. Do **not** send the git repo as the product.
3. User data stays in `%APPDATA%\TecAdRiseBot` (`secrets.bin`, chats). Installing a new version does not replace that folder.

---

## Checklist

- [ ] `package.json` version is **new** (no Setup file with that number already)
- [ ] Commit `V02: <version> — …` on `master`
- [ ] Tag `v<version>` and `git push` branch + tag
- [ ] `electron-builder` output is this folder, not a locked `release\`
- [ ] Setup.exe, `TecAdRiseBot.exe`, and `resources\tecadrisebot-v2.ico` all branded
- [ ] Zip named with the **same** version
- [ ] Copy **only** the new Setup/zip to the other machine
