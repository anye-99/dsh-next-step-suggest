#!/usr/bin/env python3
"""把 npm 令牌配置到 GitHub 仓库的 Actions secret，并可选地立即发布一次。

用法：
    python scripts/configure-npm-token.py npm_xxxxxxxx [--repo anye-99/dsh-next-step-suggest]
                                                       [--publish] [--dry-run]

做三件事：
  1. 取仓库 public key（libsodium sealed box）
  2. 用 PyNaCl 加密令牌，PUT /repos/{repo}/actions/secrets/NPM_TOKEN
  3. --publish 时，用该令牌跑一次 npm publish（走 scripts/publish-npm.mjs）

令牌来源也可以是环境变量 NPM_TOKEN，避免出现在 shell 历史里：
    NPM_TOKEN=npm_xxx python scripts/configure-npm-token.py
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

try:
    from nacl import encoding, public
except ImportError:
    sys.exit("需要 PyNaCl：pip install pynacl")

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_REPO = "anye-99/dsh-next-step-suggest"


def github_token() -> str:
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        return token.strip()
    creds = Path(os.environ.get("USERPROFILE", Path.home())) / ".git-credentials"
    if creds.exists():
        for line in creds.read_text(encoding="utf-8", errors="ignore").splitlines():
            if "github.com" in line and "ghp_" in line:
                return line.rsplit(":", 1)[-1].split("@")[0].strip()
    sys.exit("找不到 GitHub 令牌（GITHUB_TOKEN / ~/.git-credentials）")


def api(path: str, method: str = "GET", payload: dict | None = None, token: str | None = None):
    url = f"https://api.github.com{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"token {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "dsh-configure-npm-token")
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = resp.read()
        return resp.status, (json.loads(body) if body else {})


def encrypt(public_key_b64: str, secret_value: str) -> str:
    pk = public.PublicKey(public_key_b64.encode(), encoding.Base64Encoder())
    sealed = public.SealedBox(pk).encrypt(secret_value.encode())
    return base64.b64encode(sealed).decode()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("token", nargs="?", help="npm 令牌；省略时读 NPM_TOKEN 环境变量")
    ap.add_argument("--repo", default=DEFAULT_REPO)
    ap.add_argument("--publish", action="store_true", help="写完后立即发布一次")
    ap.add_argument("--dry-run", action="store_true", help="只校验令牌格式，不写 secret")
    args = ap.parse_args()

    npm_token = args.token or os.environ.get("NPM_TOKEN")
    if not npm_token:
        sys.exit("缺少 npm 令牌：位置参数或 NPM_TOKEN 环境变量")
    npm_token = npm_token.strip()

    if not npm_token.startswith("npm_"):
        sys.exit(f"令牌格式可疑：应以 npm_ 开头，实际 {npm_token[:8]}…")
    if len(npm_token) < 40:
        sys.exit(f"令牌长度异常：{len(npm_token)} 字符")

    print(f"[1/3] 令牌格式检查通过（{len(npm_token)} 字符，前缀 {npm_token[:8]}…）")

    if args.dry_run:
        print("[dry-run] 跳过 secret 写入与发布。")
        return

    gh = github_token()
    status, key = api(f"/repos/{args.repo}/actions/secrets/public-key", token=gh)
    if status != 200:
        sys.exit(f"取 public key 失败：HTTP {status} {key}")
    print(f"[2/3] 取得 public key：{key['key_id']}")

    encrypted = encrypt(key["key"], npm_token)
    status, resp = api(
        f"/repos/{args.repo}/actions/secrets/NPM_TOKEN",
        method="PUT",
        payload={"encrypted_value": encrypted, "key_id": key["key_id"]},
        token=gh,
    )
    if status not in (201, 204):
        sys.exit(f"写入 secret 失败：HTTP {status} {resp}")
    print("[2/3] NPM_TOKEN 已写入仓库 Actions secret")

    if args.publish:
        print("[3/3] 用该令牌执行 npm publish…")
        env = dict(os.environ, NPM_TOKEN=npm_token)
        subprocess.run(["node", str(ROOT / "scripts" / "publish-npm.mjs")], cwd=ROOT, env=env, check=False)
    else:
        print("[3/3] 未指定 --publish，跳过发布。打 tag 时 CI 会自动发。")


if __name__ == "__main__":
    main()
