# TecAdRiseBot — release and build

The Setup.exe, GitHub `master` + annotated tag, and `https://tecadrise.ai/downloads/tecadrisebot/latest.json` must be the **same commit**. Never reuse a version that already left this folder. Do not upload an exe if git is dirty or the tag points at another commit.

## Current published (do not rebuild this number)

| | |
| --- | --- |
| Version | **0.1.5** |
| Git tag | `v0.1.5` |
| Git commit | `fb3d61815948915e42f513556844094c9e14d2a3` |
| GitHub | https://github.com/tecadrise-ai/TecAdRiseBot/tree/fb3d61815948915e42f513556844094c9e14d2a3 |
| latest.json | https://tecadrise.ai/downloads/tecadrisebot/latest.json |
| Setup (public) | https://tecadrise.ai/downloads/tecadrisebot/TecAdRiseBot-Setup-0.1.5.exe |
| SHA-256 | `95a1f814d845a43c6a1612ff4ec320c3a24b11c619c35c6232adbb06edc2d633` |
| Product page | https://tecadrise.ai/products/tecadrisebot |
| Local Setup | `C:\TecAdRise\tecadrise-bot-release\TecAdRiseBot Setup 0.1.5.exe` |
| Local zip | `C:\TecAdRise\tecadrise-bot-release\TecAdRiseBot-0.1.5-win-unpacked.zip` |

Settings → Updates fetches `latest.json` and compares `version` to `package.json` / `app.getVersion()`. Next ship is **0.1.6**.

0.1.5 is in-app BYOK (Cursor SDK or OpenAI-compatible provider), HTTP GitHub connector (no npx). Keys stay in `secrets.bin`.

| Paths | |
| --- | --- |
| Repo | `C:\TecAdRise\projects-git\TecAdRiseBot` |
| Remote | `https://github.com/tecadrise-ai/TecAdRiseBot.git` |
| Branch | `master` |
| Commit prefix | `V03:` |
| Binaries folder | `C:\TecAdRise\tecadrise-bot-release\` |
| VPS files | `/var/www/TecAdRise/downloads/tecadrisebot/` (not inside `client/build`) |
| App id | `com.tecadrise.bot` |

Dev work stays `npm run dev`. Do not iterate on a packaged exe.

---

## Version control (required before any exe)

1. Working tree **clean**.
2. Bump `"version"` in `package.json`. If `TecAdRiseBot Setup 0.1.4.exe` already exists, **do not build 0.1.4 again**.
3. Commit on `master`: `V03: 0.1.6 — …`
4. Annotated tag **on that commit**:

```bat
git tag -a v0.1.6 -m "TecAdRiseBot 0.1.6"
```

5. `python scripts/publish-release.py` pushes `master` and the tag, then uploads. If you build by hand, push both **before** the exe leaves this PC:

```bat
git push origin master
git push origin v0.1.6
```

`latest.json` fields `version`, `gitTag`, `gitCommit`, `sha256`, `setupUrl` must match the GitHub tag.

---

## One command (preferred)

Clean `master`, `package.json` version = tag `v<version>` = HEAD:

```bat
cd /d C:\TecAdRise\projects-git\TecAdRiseBot
python scripts/publish-release.py
```

That script:

1. Refuses dirty git, wrong branch, or a tag that is not HEAD
2. `git push origin master` and `git push origin v<version>`
3. Builds NSIS + unpacked dir into `C:\TecAdRise\tecadrise-bot-release\`
4. SHA-256 of the Setup exe
5. Uploads `TecAdRiseBot-Setup-<version>.exe`, `.sha256`, and `latest.json` to `/var/www/TecAdRise/downloads/tecadrisebot/`
6. Ensures nginx serves `/downloads/tecadrisebot/` (this tree is **not** wiped by a website rebuild)

VPS login is **not** in this repo. It uses `TECADRISE_VPS_PASSWORD` or the same host/user/password assignments as `C:\TecAdRise\website2026\python\commit_and_deploy_vps.py` on this PC. `pip install paramiko`.

Already built:

```bat
python scripts/publish-release.py --skip-build --exe "C:\TecAdRise\tecadrise-bot-release\TecAdRiseBot Setup 0.1.5.exe"
```

---

## Manual Windows build

Node **≥ 22.13**. Close TecAdRiseBot and anything locking `win-unpacked`. Default `npm run dist` writes repo `release\` and can `EPERM`.

```bat
cd /d C:\TecAdRise\projects-git\TecAdRiseBot
npm run build
npx electron-builder --win nsis dir --config.directories.output=C:/TecAdRise/tecadrise-bot-release
```

Zip:

```powershell
$ver = (Get-Content C:\TecAdRise\projects-git\TecAdRiseBot\package.json | ConvertFrom-Json).version
$out = "C:\TecAdRise\tecadrise-bot-release"
Compress-Archive -Path "$out\win-unpacked\*" -DestinationPath "$out\TecAdRiseBot-$ver-win-unpacked.zip" -Force
```

Leave older Setup files in place.

---

## Icon

- `resources/tecadrisebot-v2.ico` must be classic **BMP/DIB** (not PNG-only). Rebuild: `python scripts/write-win-ico.py`
- `extraResources` copies it next to the asar as `win-unpacked\resources\tecadrisebot-v2.ico`
- `build.nsis.installerIcon` stamps the Setup.exe file icon

---

## Website product page (separate from the exe)

The product page fetches `latest.json` for the Download button (`website2026/src/pages/ProductsTecAdRiseBot.js`).

**Do not** run `python C:\TecAdRise\website2026\python\commit_and_deploy_vps.py` to publish the installer. That script `git add -A` on the whole `C:\TecAdRise` tree. The installer is only `publish-release.py`.

If the **page** (not the exe) changed: commit **only** that JS file in the TecAdRise website repo, push, then rebuild `website2026` on the VPS. Do not copy into `client/build/downloads`. Confirm `/var/www/TecAdRise/downloads/tecadrisebot/latest.json` still exists after a site build.

---

## Checklist

- [ ] New `package.json` version (not 0.1.5)
- [ ] Commit `V03: <version> — …` on `master`
- [ ] Tag `v<version>` on **that** commit
- [ ] `python scripts/publish-release.py`
- [ ] `latest.json` `version` / `gitCommit` / `sha256` match the tag
- [ ] GitHub `tree/<gitCommit>` is this source
- [ ] Settings → Updates shows the new version
- [ ] Product page Download is the same file
- [ ] Copy this file to `C:\TecAdRise\tecadrise-bot-release\RELEASE.md` so the binaries folder matches git
