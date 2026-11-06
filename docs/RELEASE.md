# TecAdRiseBot — release and build

The Setup.exe, GitHub `master` + tag, and `https://tecadrise.ai/downloads/tecadrisebot/latest.json` must be the **same commit**. Never reuse a version that already left this folder. Do not upload an exe if git is dirty or the tag is on another commit.

| Current | Value |
| --- | --- |
| Product | TecAdRiseBot |
| Version in git | **0.1.3** (`package.json`) |
| Repo | `C:\TecAdRise\projects-git\TecAdRiseBot` |
| Remote | `https://github.com/tecadrise-ai/TecAdRiseBot.git` |
| Branch | `master` |
| Commit prefix | `V02:` |
| Binaries folder | `C:\TecAdRise\tecadrise-bot-release\` |
| Public latest | `https://tecadrise.ai/downloads/tecadrisebot/latest.json` |
| Public Setup | `https://tecadrise.ai/downloads/tecadrisebot/TecAdRiseBot-Setup-<version>.exe` |
| Product page | `https://tecadrise.ai/products/tecadrisebot` |
| App id | `com.tecadrise.bot` |

Dev work stays `npm run dev`. Do not iterate on a packaged exe.

---

## Version control (required before any exe)

1. Working tree **clean**.
2. **Bump** `"version"` in `package.json`. If `TecAdRiseBot Setup 0.1.3.exe` already exists, do not build 0.1.3 again.
3. Commit on `master`: `V02: 0.1.x — …`
4. **Annotated tag on that commit:**

```bat
git tag -a v0.1.3 -m "TecAdRiseBot 0.1.3"
```

5. Publish script pushes `master` and the tag, then uploads. If you build by hand, push both **before** you copy the exe anywhere:

```bat
git push origin master
git push origin v0.1.3
```

The Settings → Updates check reads `latest.json` (`version`, `gitCommit`, `sha256`, `setupUrl`). GitHub at `gitCommit` must be this release.

---

## One command (preferred)

From a clean `master` with `package.json` version matching tag `v<version>` at HEAD:

```bat
cd /d C:\TecAdRise\projects-git\TecAdRiseBot
python scripts/publish-release.py
```

That script:

1. Refuses dirty git, wrong branch, or a tag that is not HEAD
2. `git push origin master` and `git push origin v<version>`
3. Builds NSIS + unpacked dir into `C:\TecAdRise\tecadrise-bot-release\`
4. SHA-256 of the Setup exe
5. Uploads `TecAdRiseBot-Setup-<version>.exe`, `.sha256`, and `latest.json` to the VPS path `/var/www/TecAdRise/downloads/tecadrisebot/` (outside the website `client/build`, so a site rebuild does not delete it)
6. Ensures nginx serves `/downloads/tecadrisebot/`

VPS login is **not** in this repo. It uses `TECADRISE_VPS_PASSWORD` or the same host/user/password assignments as `website2026/python/commit_and_deploy_vps.py` on this PC. `pip install paramiko`.

Already built:

```bat
python scripts/publish-release.py --skip-build --exe "C:\TecAdRise\tecadrise-bot-release\TecAdRiseBot Setup 0.1.3.exe"
```

---

## Manual Windows build

Node **≥ 22.13**. Close TecAdRiseBot and anything locking `win-unpacked`. Default `npm run dist` writes `release\` in the repo and can `EPERM`.

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
- `extraResources` copies it next to the asar as `resources/tecadrisebot-v2.ico`

---

## Website product page

The React page fetches `latest.json` for the Download button. After changing `website2026/src/pages/ProductsTecAdRiseBot.js`, deploy the **site** with `python C:\TecAdRise\website2026\python\commit_and_deploy_vps.py`. That deploy must **not** overwrite `/var/www/TecAdRise/downloads/`.

---

## Checklist

- [ ] New `package.json` version
- [ ] Commit `V02: <version> — …` on `master`
- [ ] Tag `v<version>` **on that commit**
- [ ] `python scripts/publish-release.py` (push + build + SHA-256 + VPS)
- [ ] `https://tecadrise.ai/downloads/tecadrisebot/latest.json` version, `gitCommit`, `sha256` match the tag
- [ ] GitHub `tree/<gitCommit>` is this source
- [ ] Settings → Updates shows the new version
- [ ] Product page Download matches the same file
