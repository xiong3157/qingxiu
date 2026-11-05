#!/usr/bin/env bash
# 轻修 · 一键发布到 GitHub Pages
# 用法：bash publish.sh
# 全程只需要你做一件事：在浏览器输入脚本打印的一次性验证码并点授权。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

GH_HOME="${GH_HOME:-$HOME/.qingxiu-gh}"
GH_BIN="$GH_HOME/bin/gh.exe"
export GH_CONFIG_DIR="$GH_HOME/config"
export GH_PROMPT_DISABLED=1
export GH_BROWSER=none

# 1. 确保绿色版 GitHub CLI 可用（不装系统、不改全局 git 配置）
if [ ! -f "$GH_BIN" ]; then
  echo ">> 未找到 GitHub CLI，正在下载绿色版..."
  mkdir -p "$GH_HOME/bin" "$GH_CONFIG_DIR"
  ZIP="$GH_HOME/gh.zip"
  URL="$(curl -sSL -m 30 https://api.github.com/repos/cli/cli/releases/latest \
    | python -c "import sys,json; d=json.load(sys.stdin); print([a['browser_download_url'] for a in d['assets'] if 'windows_amd64.zip' in a['name']][0])")"
  curl -sSL -C - --retry 4 --retry-delay 2 -m 560 "$URL" -o "$ZIP"
  python -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$ZIP" "$GH_HOME"
  FOUND="$(find "$GH_HOME" -name gh.exe -path '*/bin/*' | head -1)"
  cp "$FOUND" "$GH_BIN"
  rm -f "$ZIP"
fi
echo ">> GitHub CLI: $("$GH_BIN" --version | head -1)"

# 2. 授权：只有运行本脚本的这一刻才生成验证码，避免之前那种空等 15 分钟过期
if ! "$GH_BIN" auth status >/dev/null 2>&1; then
  echo
  echo "============================================================"
  echo "  需要 GitHub 授权，请在 15 分钟内完成："
  echo "  1) 打开  https://github.com/login/device"
  echo "  2) 输入下面打印的 One-time code，按提示点授权"
  echo "============================================================"
  echo
  "$GH_BIN" auth login --web --hostname github.com --git-protocol https \
    --scopes "repo,workflow,read:org" --skip-ssh-key
fi

OWNER="$("$GH_BIN" api user --jq .login)"
REPO="${REPO:-qingxiu}"
echo ">> GitHub 账号: $OWNER ，目标仓库: $OWNER/$REPO"

# 3. 收尾提交（应用卡片等本地生成物已在 .gitignore 中排除）
git config user.name  >/dev/null 2>&1 || git config user.name  "$OWNER"
git config user.email >/dev/null 2>&1 || git config user.email "$OWNER@users.noreply.github.com"
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "chore: 发布前同步改动" || true
fi

# 4. 建公开仓库
if ! "$GH_BIN" repo view "$OWNER/$REPO" >/dev/null 2>&1; then
  "$GH_BIN" repo create "$REPO" --public \
    --description "轻修 · 免费手机修图 PWA（无水印、图片不出手机）"
fi

# 5. 推送。令牌只临时写进 remote URL，脚本退出时一定抹掉，不落盘到全局配置
trap 'git remote set-url origin "https://github.com/${OWNER:-}/${REPO:-qingxiu}.git" >/dev/null 2>&1 || true' EXIT
TOKEN="$("$GH_BIN" auth token)"
git remote remove origin >/dev/null 2>&1 || true
git remote add origin "https://x-access-token:${TOKEN}@github.com/${OWNER}/${REPO}.git"
unset TOKEN
git push -u origin main
git remote set-url origin "https://github.com/${OWNER}/${REPO}.git"

# 6. 兜底启用 Pages（正常情况下由 workflow 里的 configure-pages 自动完成）
"$GH_BIN" api -X POST "repos/$OWNER/$REPO/pages" -f 'build_type=workflow' >/dev/null 2>&1 || true

# 7. 查看部署进度
echo
echo ">> 代码已推送，GitHub Actions 正在部署 static site："
"$GH_BIN" run list --repo "$OWNER/$REPO" --limit 3 || true
echo
echo "============================================================"
echo "  正式地址（约 1~2 分钟后生效）："
echo "  https://${OWNER}.github.io/${REPO}/"
echo "  仓库：https://github.com/${OWNER}/${REPO}"
echo "============================================================"
