"""
Publish a TecAdRiseBot Windows installer to the VPS.

GitHub must already match the exe:
  - clean working tree
  - package.json version == vX.Y.Z tag at HEAD
  - origin/master and origin tag pushed before upload

Does not store VPS passwords in this repo. Login is TECADRISE_VPS_* env
or the same assignments as website2026/python/commit_and_deploy_vps.py.

Usage (from the TecAdRiseBot repo):
  python scripts/publish-release.py
  python scripts/publish-release.py --skip-build --exe "C:/TecAdRise/tecadrise-bot-release/TecAdRiseBot Setup 0.1.2.exe"
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_OUT = Path(r"C:\TecAdRise\tecadrise-bot-release")
REMOTE_DIR = "/var/www/TecAdRise/downloads/tecadrisebot"
NGINX_SNIPPET = "/etc/nginx/snippets/tecadrisebot-downloads.conf"
NGINX_SITE = "/etc/nginx/sites-available/tecadrise"
PUBLIC_BASE = "https://tecadrise.ai/downloads/tecadrisebot"
GITHUB = "https://github.com/tecadrise-ai/TecAdRiseBot"
WEBSITE_DEPLOY = Path(r"C:\TecAdRise\website2026\python\commit_and_deploy_vps.py")


def die(msg: str, code: int = 1) -> None:
    print(msg, file=sys.stderr)
    sys.exit(code)


def git(*args: str, check: bool = True) -> str:
    r = subprocess.run(["git", *args], cwd=REPO, text=True, capture_output=True)
    if check and r.returncode != 0:
        die(r.stderr.strip() or r.stdout.strip() or f"git {' '.join(args)} failed")
    return (r.stdout or "").strip()


def load_vps() -> tuple[str, str, str]:
    host = os.environ.get("TECADRISE_VPS_HOST", "173.212.247.44")
    user = os.environ.get("TECADRISE_VPS_USER", "root")
    pw = os.environ.get("TECADRISE_VPS_PASSWORD", "")
    if pw:
        return host, user, pw
    if not WEBSITE_DEPLOY.is_file():
        die("Set TECADRISE_VPS_PASSWORD or keep website2026/python/commit_and_deploy_vps.py on this PC")
    text = WEBSITE_DEPLOY.read_text(encoding="utf-8", errors="replace")
    def grab(name: str, default: str = "") -> str:
        m = re.search(rf'^{name}\s*=\s*["\'](.+)["\']', text, re.M)
        return m.group(1) if m else default
    return grab("VPS_HOST", host), grab("VPS_USER", user), grab("VPS_PW")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def connect():
    try:
        import paramiko
    except ImportError:
        die("pip install paramiko")
    host, user, pw = load_vps()
    if not pw:
        die("VPS password missing")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=pw, timeout=30)
    return client


def ssh(client, cmd: str) -> str:
    _stdin, stdout, stderr = client.exec_command(cmd)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if code != 0:
        die(f"remote failed ({code}): {cmd}\n{err or out}")
    return out


def ensure_nginx(client) -> None:
    snippet = r"""
location ^~ /downloads/tecadrisebot/ {
    alias /var/www/TecAdRise/downloads/tecadrisebot/;
    types {
        application/json json;
        application/octet-stream exe;
        text/plain sha256;
    }
    default_type application/octet-stream;
    add_header Access-Control-Allow-Origin "*" always;
    add_header Cache-Control "public, max-age=300";
}
""".strip()
    b64 = __import__("base64").b64encode(snippet.encode()).decode()
    ssh(
        client,
        f"mkdir -p {REMOTE_DIR} && echo {b64} | base64 -d > {NGINX_SNIPPET} && "
        f"grep -q 'tecadrisebot-downloads.conf' {NGINX_SITE} || "
        f"sed -i '/server_name tecadrise.ai www.tecadrise.ai;/a \\    include {NGINX_SNIPPET};' {NGINX_SITE} && "
        "nginx -t && nginx -s reload",
    )


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--skip-build", action="store_true")
    p.add_argument("--exe", default="")
    p.add_argument("--skip-push", action="store_true", help="do not git push (still requires local tag == HEAD)")
    args = p.parse_args()

    pkg = json.loads((REPO / "package.json").read_text(encoding="utf-8"))
    version = str(pkg["version"])
    tag = f"v{version}"
    if git("status", "--porcelain"):
        die("working tree is dirty — commit (and tag) before publishing so GitHub matches the exe")
    branch = git("rev-parse", "--abbrev-ref", "HEAD")
    if branch != "master":
        die(f"publish from master, not {branch}")
    head = git("rev-parse", "HEAD")
    tagged = git("rev-parse", f"{tag}^{{commit}}", check=False)
    if not tagged:
        die(f"missing tag {tag} at HEAD. git tag -a {tag} -m \"TecAdRiseBot {version}\"")
    if tagged != head:
        die(f"{tag} is {tagged}, HEAD is {head}. Move the tag or bump package.json so GitHub matches this exe.")

    if not args.skip_push:
        subprocess.check_call(["git", "push", "origin", "master"], cwd=REPO)
        subprocess.check_call(["git", "push", "origin", tag], cwd=REPO)
        git("fetch", "origin", "master", "--tags")
        remote_master = git("rev-parse", "origin/master")
        if remote_master != head:
            die("origin/master is not HEAD after push")
        remote_tag = git("rev-parse", f"{tag}^{{commit}}")
        if remote_tag != head:
            die(f"origin {tag} is not HEAD after push")

    out_dir = DEFAULT_OUT
    setup_src = Path(args.exe) if args.exe else out_dir / f"TecAdRiseBot Setup {version}.exe"
    if not args.skip_build:
        print("Building NSIS + unpacked dir…")
        subprocess.check_call(["npm", "run", "build"], cwd=REPO, shell=True)
        subprocess.check_call(
            [
                "npx",
                "electron-builder",
                "--win",
                "nsis",
                "dir",
                f"--config.directories.output={out_dir.as_posix()}",
            ],
            cwd=REPO,
            shell=True,
        )
    if not setup_src.is_file():
        die(f"missing installer {setup_src}")

    digest = sha256_file(setup_src)
    remote_exe = f"TecAdRiseBot-Setup-{version}.exe"
    payload = {
        "name": "TecAdRiseBot",
        "version": version,
        "gitTag": tag,
        "gitCommit": head,
        "gitRepo": GITHUB,
        "setupUrl": f"{PUBLIC_BASE}/{remote_exe}",
        "sha256": digest,
        "releasedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    sha_text = f"{digest}  {remote_exe}\n"
    print(f"SHA-256 {digest}")
    print(f"Git {tag} {head}")

    client = connect()
    try:
        ensure_nginx(client)
        sftp = client.open_sftp()
        tmp_exe = f"{REMOTE_DIR}/{remote_exe}.part"
        print(f"Uploading {setup_src.name} ({setup_src.stat().st_size} bytes)…")
        sftp.put(str(setup_src), tmp_exe)
        ssh(client, f"mv {tmp_exe} {REMOTE_DIR}/{remote_exe}")
        sftp.putfo(io.BytesIO(sha_text.encode("ascii")), f"{REMOTE_DIR}/{remote_exe}.sha256")
        tmp_json = f"{REMOTE_DIR}/latest.json.part"
        sftp.putfo(io.BytesIO((json.dumps(payload, indent=2) + "\n").encode("utf-8")), tmp_json)
        ssh(client, f"mv {tmp_json} {REMOTE_DIR}/latest.json")
        ssh(
            client,
            f"ln -sfn {remote_exe} {REMOTE_DIR}/TecAdRiseBot-Setup-win64.exe",
        )
        sftp.close()
        print("Published", payload["setupUrl"])
        print("win64", f"{PUBLIC_BASE}/TecAdRiseBot-Setup-win64.exe")
        print("latest.json", f"{PUBLIC_BASE}/latest.json")
    finally:
        client.close()


if __name__ == "__main__":
    main()
