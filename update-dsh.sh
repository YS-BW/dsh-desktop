#!/bin/bash
# ============================================================================
# 从这个 npm 拉取（或更新）DSH 引擎。
#
# 引擎装在 ~/.dsh-desktop/runtime，**在 App 包外面**，所以：
#   · 更新引擎不需要重新打包、不需要重新下载 App
#   · App 下次启动会自动优先使用这份引擎（见 main.js 的 resolveEngine）
#
# 用法:
#   ./update-dsh.sh                # 更新到 npm 上的 latest
#   ./update-dsh.sh 0.1.5-rc.1     # 安装指定版本
#   ./update-dsh.sh --check        # 只看当前版本和 npm 最新版，不做改动
#   ./update-dsh.sh --list         # 列出 npm 上可用的版本
#   ./update-dsh.sh --revert       # 删掉更新目录，回落到 App 自带的引擎
#
# 为什么用 npm 装而不是自己下载解包：dsh 有 500+ 个依赖包，版本和依赖闭包由 npm
# 负责解析最可靠。装进来约 300MB。
# ============================================================================

set -euo pipefail

DESKTOP_HOME="${DSH_MIN_DESKTOP_HOME:-$HOME/.dsh-desktop}"
RUNTIME="$DESKTOP_HOME/runtime"
PKG="@deepseek-ai/dsh"

# 颜色（非交互环境自动失效）
if [ -t 1 ]; then BOLD=$(tput bold); DIM=$(tput dim); RED=$(tput setaf 1); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RESET=$(tput sgr0)
else BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""; fi

say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()  { printf '%s✗%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

# npm 可能不在 PATH 里（尤其从 Finder 启动的场景）。找不到就报清楚。
find_npm() {
  if command -v npm >/dev/null 2>&1; then command -v npm; return; fi
  for c in /opt/homebrew/bin/npm /usr/local/bin/npm "$HOME/.hermes/node/bin/npm"; do
    [ -x "$c" ] && { printf '%s' "$c"; return; }
  done
  # 最后问一次登录 shell
  local shell="${SHELL:-/bin/zsh}"
  local found
  found=$("$shell" -lic 'command -v npm' 2>/dev/null | tail -1 || true)
  [ -n "$found" ] && [ -x "$found" ] && { printf '%s' "$found"; return; }
  return 1
}

installed_version() {
  local manifest="$RUNTIME/node_modules/$PKG/package.json"
  [ -f "$manifest" ] || return 1
  node -e "process.stdout.write(require('$manifest').version)" 2>/dev/null \
    || python3 -c "import json,sys;print(json.load(open('$manifest'))['version'],end='')" 2>/dev/null
}

# ── 参数处理 ────────────────────────────────────────────────────────────

NPM="$(find_npm || true)"

case "${1:-}" in
  --check)
    CUR="$(installed_version || true)"
    [ -n "${CUR:-}" ] && say "当前引擎: ${BOLD}$CUR${RESET}（来自更新目录）" \
                      || say "当前引擎: ${BOLD}App 自带${RESET}（更新目录为空）"
    [ -z "$NPM" ] && die "找不到 npm —— 更新需要 npm，请先安装 Node.js"
    say "npm: $NPM"
    say ""
    say "npm 上的可用标签:"
    "$NPM" view "$PKG" dist-tags --json 2>/dev/null | sed 's/^/  /' || warn "查询失败（网络或镜像问题）"
    exit 0
    ;;
  --list)
    [ -z "$NPM" ] && die "找不到 npm"
    say "npm 上可用的版本（末尾为最新）:"
    "$NPM" view "$PKG" versions --json 2>/dev/null | tail -20 | sed 's/^/  /'
    exit 0
    ;;
  --revert)
    if [ -d "$RUNTIME" ]; then
      rm -rf "$RUNTIME"
      ok "已删除更新目录，App 下次启动会回落到自带引擎"
    else
      say "更新目录本来就不存在，无需回退"
    fi
    exit 0
    ;;
  -h|--help)
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

TARGET="${1:-latest}"

# ── 检查 npm ────────────────────────────────────────────────────────────

[ -z "$NPM" ] && die "找不到 npm。更新引擎需要 npm（Node.js 自带），请先安装：https://nodejs.org"
say "npm: ${DIM}$NPM${RESET}"

# ── 显示将要发生什么 ────────────────────────────────────────────────────

CUR="$(installed_version || true)"
say ""
if [ -n "${CUR:-}" ]; then
  say "更新目录里已有引擎: ${BOLD}$CUR${RESET}"
else
  say "更新目录里还没有引擎（当前用的是 App 自带那份）"
fi
say "目标版本: ${BOLD}$TARGET${RESET}"
say "安装位置: ${DIM}$RUNTIME${RESET}"
say ""

# ── 确认（交互式才问）────────────────────────────────────────────────────

if [ -t 0 ]; then
  printf '继续？[y/N] '
  read -r answer
  case "$answer" in
    [yY]|[yY][eE][sS]) ;;
    *) say "已取消"; exit 0 ;;
  esac
fi

# ── 安装 ────────────────────────────────────────────────────────────────

mkdir -p "$RUNTIME"
# 独立 package.json，避免 npm 往上层目录找 package.json 而装错地方
if [ ! -f "$RUNTIME/package.json" ]; then
  printf '{"name":"dsh-desktop-runtime","private":true}\n' > "$RUNTIME/package.json"
fi

say "正在从 npm 拉取…（首次约 1 分钟、约 300MB）"
say ""

# --ignore-scripts：不跑依赖的 postinstall，避免意外的原生编译
# --no-audit --no-fund：不需要的安全审计与赞助提示
if ! "$NPM" install "$PKG@$TARGET" \
      --prefix "$RUNTIME" \
      --ignore-scripts \
      --no-audit \
      --no-fund \
      --loglevel=error; then
  die "安装失败。常见原因：网络不通、需要代理、或版本号不存在。"
fi

NEW="$(installed_version || true)"
[ -z "${NEW:-}" ] && die "安装似乎成功，但读不到版本号，请检查 $RUNTIME"

say ""
ok "引擎已更新到 ${BOLD}$NEW${RESET}"

# ── 校验：能不能真的跑起来 ───────────────────────────────────────────────

NODE_BIN="$RUNTIME/node_modules/node/bin/node"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node || true)"

if [ -n "${NODE_BIN:-}" ] && [ -x "$NODE_BIN" ]; then
  if "$NODE_BIN" "$RUNTIME/node_modules/$PKG/lib/bin.js" --version >/dev/null 2>&1; then
    ok "引擎自检通过（--version 可执行）"
  else
    warn "引擎装好了，但 --version 执行失败。App 仍会尝试启动；若起不来，用 --revert 回退。"
  fi
fi

say ""
say "下次启动 App 就会用这个版本。要立即生效，重启 App 即可。"
say "想回退到 App 自带的引擎：${DIM}./update-dsh.sh --revert${RESET}"
