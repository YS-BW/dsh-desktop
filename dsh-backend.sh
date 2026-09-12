#!/bin/bash
# 启动一个「常驻」dsh 后端。
#
# 为什么需要：桌面壳拉起的后端是壳的子进程，关掉桌面 App 它就死了（我给它加了
# watchdog 兜底，所以不会变孤儿，但也就意味着它不会活下来）。开发桌面端时你会反复
# 关掉壳，那后端就断，正在聊的会话也就断了。用一个独立的、不在壳进程树里的后端，
# 才能在你反复重启壳的时候保持不断。
#
# 用法:
#   ./dsh-backend.sh              # 启动（默认端口 3081）
#   ./dsh-backend.sh stop         # 停止
#   ./dsh-backend.sh status       # 看状态

set -eu

PORT="${DSH_BACKEND_PORT:-3081}"
# 工作目录决定会话分桶 —— 必须和你要继续的会话所在目录一致。
WORKSPACE="${DSH_MIN_WORKSPACE:-/Users/lixinlv/Documents/DSH}"
HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="$HERE/.backend-state.json"
LOG="$HERE/.backend.log"
DSH_BIN="${DSH_MIN_BIN:-$(command -v dsh)}"

# 注意：管道里的 head 会提前关闭，让 lsof 收到 SIGPIPE —— 配合 set -o pipefail
# 会把「没有进程监听」这种正常情况变成失败退出。所以这里一次性读进去再取第一个。
pid_of_port() {
  local out
  out="$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true)"
  printf '%s' "${out%%$'\n'*}"
}

case "${1:-start}" in
  status)
    PID="$(pid_of_port "$PORT")"
    if [ -n "$PID" ]; then
      echo "运行中: pid=$PID port=$PORT"
      ps -o command= -p "$PID" | cut -c1-120
      [ -f "$STATE" ] && echo "启动 URL 记录在: $STATE"
    else
      echo "未运行 (port=$PORT)"
    fi
    ;;

  stop)
    PID="$(pid_of_port "$PORT")"
    if [ -z "$PID" ]; then echo "没有在跑 (port=$PORT)"; exit 0; fi
    echo "发送 SIGTERM 给 pid=$PID（DSH 需要约 5 秒排空）..."
    kill "$PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      [ -z "$(pid_of_port "$PORT")" ] && break
      sleep 0.5
    done
    if [ -n "$(pid_of_port "$PORT")" ]; then
      echo "排空超时，强制结束"
      kill -9 "$PID" 2>/dev/null || true
    fi
    echo "已停止"
    ;;

  start)
    if [ -n "$(pid_of_port "$PORT")" ]; then
      echo "端口 $PORT 已被占用 — 先执行 ./dsh-backend.sh stop"
      exit 1
    fi

    # 单写者纪律：DSH 的 workspace 索引是 home 级单文件，多个实例同时写会让会话
    # 掉进 Ungrouped（上游 discussion #1485）。所以启动前先把别的实例指出来。
    echo "=== 检查是否有其他 dsh 实例在写同一个 home ==="
    OTHERS="$(ps -eo pid,command 2>/dev/null \
      | grep -E "dsh.*(bin\.js )?web" | grep -v grep | grep -v "dsh-backend" || true)"
    if [ -n "$OTHERS" ]; then
      echo "$OTHERS" | cut -c1-130
      echo
      echo "⚠️  上面这些实例与本次启动共用 DSH_HOME，同时运行有两个后果："
      echo "    1. workspace.json 并发写风险（会话可能掉进 Ungrouped）"
      echo "    2. 各自的实时推送互不可见（就是「网页端看不到桌面端对话」那个现象）"
      printf "继续启动? [y/N] "
      read -r ans
      [ "$ans" = "y" ] || [ "$ans" = "Y" ] || { echo "已取消"; exit 1; }
    else
      echo "  没有其他实例，干净"
    fi

    echo
    echo "=== 启动常驻后端 ==="
    echo "  端口:     $PORT"
    echo "  工作目录: $WORKSPACE"
    echo "  DSH_HOME: ${DSH_HOME:-$HOME/.dsh}"
    echo "  日志:     $LOG"

    cd "$WORKSPACE"
    # setsid/独立进程组：让它不随启动它的终端退出。
    nohup env DSH_HOME="${DSH_HOME:-$HOME/.dsh}" NO_COLOR=1 \
      "$DSH_BIN" web --no-open --host 127.0.0.1 --port "$PORT" \
      >"$LOG" 2>&1 &
    disown 2>/dev/null || true

    # 从日志里抓带 token 的启动 URL
    URL=""
    for _ in $(seq 1 120); do
      URL="$(grep -oE "http://127\.0\.0\.1:${PORT}/\?token=[A-Za-z0-9_-]+" "$LOG" 2>/dev/null | head -1 || true)"
      [ -n "$URL" ] && break
      sleep 0.5
    done

    if [ -z "$URL" ]; then
      echo "❌ 没等到启动 URL，看日志: $LOG"
      tail -20 "$LOG"
      exit 1
    fi

    printf '{\n  "port": %s,\n  "url": %s,\n  "workspace": %s\n}\n' \
      "$PORT" "$(printf '%s' "$URL" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
      "$(printf '%s' "$WORKSPACE" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
      > "$STATE"

    echo
    echo "✅ 常驻后端已就绪 (pid=$(pid_of_port "$PORT"))"
    echo
    echo "浏览器打开这个地址（token 只能兑换一次，用后即失效）："
    echo "  $URL"
    echo
    echo "打开后地址会跳成干净的 http://127.0.0.1:$PORT/ ，之后可以收藏它。"
    echo "侧栏里选工作区、点你要继续的会话即可 —— 会话内容就在磁盘上，不依赖哪个进程。"
    ;;
  *)
    echo "用法: $0 [start|stop|status]"; exit 1;;
esac
