#!/usr/bin/env bash
set -euo pipefail

# Local development process manager for Resource Gallery.
# It intentionally only manages listeners whose cwd and command identify this repo.

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
API_DIR="$ROOT_DIR/services/api"
WEB_DIR="$ROOT_DIR/apps/web"
PID_DIR="$ROOT_DIR/.pids"
LOG_DIR="$ROOT_DIR/.logs"

API_HOST="${API_HOST:-127.0.0.1}"
WEB_HOST="${WEB_HOST:-127.0.0.1}"
API_PORT="${PORT:-8787}"
WEB_PORT="${WEB_PORT:-5173}"
LOG_MODE="${RESOURCE_GALLERY_LOG_MODE:-foreground}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${CYAN}[Resource Gallery]${NC} $*"; }
ok() { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
die() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

API_PORT="${PORT:-$API_PORT}"
mkdir -p "$PID_DIR" "$LOG_DIR"

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令: $1"
}

resolved_dir() {
  (cd "$1" 2>/dev/null && pwd -P) || true
}

pid_command() {
  ps -p "$1" -o command= 2>/dev/null || true
}

pid_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

pid_matches_service() {
  local service="$1" pid="$2" expected_dir command cwd
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1

  case "$service" in
    api)
      expected_dir="$(resolved_dir "$API_DIR")"
      ;;
    web)
      expected_dir="$(resolved_dir "$WEB_DIR")"
      ;;
    *)
      return 1
      ;;
  esac

  command="$(pid_command "$pid")"
  cwd="$(pid_cwd "$pid")"
  [ -n "$cwd" ] && [ "$(resolved_dir "$cwd")" = "$expected_dir" ] || return 1

  case "$service" in
    api) [[ "$command" == *"tsx"* || "$command" == *"src/index.ts"* ]] ;;
    web) [[ "$command" == *"vite"* || "$command" == *"apps/web"* ]] ;;
  esac
}

service_listener_pid() {
  local service="$1" port="$2" pid
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    if pid_matches_service "$service" "$pid"; then
      echo "$pid"
      return 0
    fi
  done < <(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  return 1
}

service_healthcheck() {
  local service="$1" port="$2" path="/"
  [ "$service" = "api" ] && path="/health"
  curl -fsS --max-time 2 "http://127.0.0.1:${port}${path}" >/dev/null 2>&1
}

repair_pid_file() {
  local service="$1"
  local port="$2"
  local pid_file="$PID_DIR/$service.pid"
  local pid
  pid="$(service_listener_pid "$service" "$port" || true)"
  if [ -n "$pid" ] && service_healthcheck "$service" "$port"; then
    echo "$pid" > "$pid_file"
    echo "$pid"
    return 0
  fi
  rm -f "$pid_file"
  return 1
}

wait_for_service() {
  local service="$1" port="$2" timeout="$3"
  while ! service_listener_pid "$service" "$port" >/dev/null || ! service_healthcheck "$service" "$port"; do
    timeout=$((timeout - 1))
    [ "$timeout" -le 0 ] && return 1
    sleep 1
  done
}

ensure_dependencies() {
  if [ ! -d "$ROOT_DIR/node_modules" ]; then
    log "安装 pnpm 依赖..."
    (cd "$ROOT_DIR" && pnpm install --frozen-lockfile)
  fi
}

start_api() {
  local pid
  pid="$(repair_pid_file api "$API_PORT" || true)"
  if [ -n "$pid" ]; then
    warn "API 已在运行 (PID $pid, :$API_PORT)"
    return
  fi
  if lsof -tiTCP:"$API_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    die "API 端口 $API_PORT 已被其他进程占用，未启动服务"
  fi

  log "启动 API (:${API_PORT})..."
  if [ "$LOG_MODE" = "foreground" ]; then
    (
      cd "$API_DIR"
      PORT="$API_PORT" pnpm exec tsx watch src/index.ts > >(tee "$LOG_DIR/api.log") 2>&1
    ) &
  else
    (
      cd "$API_DIR"
      exec env PORT="$API_PORT" pnpm exec tsx watch src/index.ts
    ) >"$LOG_DIR/api.log" 2>&1 &
  fi

  if wait_for_service api "$API_PORT" 20; then
    repair_pid_file api "$API_PORT" >/dev/null
    ok "API 已启动 -> http://$API_HOST:$API_PORT/health"
  else
    die "API 启动失败，查看日志: $LOG_DIR/api.log"
  fi
}

start_web() {
  local pid
  pid="$(repair_pid_file web "$WEB_PORT" || true)"
  if [ -n "$pid" ]; then
    warn "Web 已在运行 (PID $pid, :$WEB_PORT)"
    return
  fi
  if lsof -tiTCP:"$WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    die "Web 端口 $WEB_PORT 已被其他进程占用，未启动服务"
  fi

  log "启动 Web (:${WEB_PORT})..."
  if [ "$LOG_MODE" = "foreground" ]; then
    (
      cd "$WEB_DIR"
      VITE_API_PROXY_TARGET="http://127.0.0.1:$API_PORT" \
        pnpm exec vite --host "$WEB_HOST" --port "$WEB_PORT" > >(tee "$LOG_DIR/web.log") 2>&1
    ) &
  else
    (
      cd "$WEB_DIR"
      exec env VITE_API_PROXY_TARGET="http://127.0.0.1:$API_PORT" \
        pnpm exec vite --host "$WEB_HOST" --port "$WEB_PORT"
    ) >"$LOG_DIR/web.log" 2>&1 &
  fi

  if wait_for_service web "$WEB_PORT" 25; then
    repair_pid_file web "$WEB_PORT" >/dev/null
    ok "Web 已启动 -> http://$WEB_HOST:$WEB_PORT"
  else
    die "Web 启动失败，查看日志: $LOG_DIR/web.log"
  fi
}

do_start() {
  require_command pnpm
  require_command lsof
  require_command curl
  ensure_dependencies
  start_api
  start_web

  echo ""
  ok "Resource Gallery 已就绪"
  echo "  Web: http://$WEB_HOST:$WEB_PORT"
  echo "  API: http://$API_HOST:$API_PORT/health"
  echo "  Logs: $LOG_DIR/api.log $LOG_DIR/web.log"
  echo ""

  if [ "$LOG_MODE" = "foreground" ]; then
    trap 'echo ""; log "正在停止服务..."; do_stop; exit 0' INT TERM
    wait
  fi
}

stop_service() {
  local service="$1"
  local port="$2"
  local pid_file="$PID_DIR/$service.pid"
  local pid
  pid="$(service_listener_pid "$service" "$port" || true)"
  if [ -z "$pid" ]; then
    rm -f "$pid_file"
    return 1
  fi
  kill "$pid" 2>/dev/null || true
  local timeout=10
  while kill -0 "$pid" 2>/dev/null && [ "$timeout" -gt 0 ]; do
    sleep 1
    timeout=$((timeout - 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
  ok "$service 已停止"
  return 0
}

do_stop() {
  local stopped=false
  log "停止 Resource Gallery..."
  stop_service web "$WEB_PORT" && stopped=true || true
  stop_service api "$API_PORT" && stopped=true || true
  if [ "$stopped" = false ]; then
    warn "没有正在运行的 Resource Gallery 服务"
  fi
}

do_status() {
  echo ""
  log "Resource Gallery 服务状态"
  echo "------------------------------"
  local service port pid listeners
  for service in api web; do
    port="$API_PORT"
    [ "$service" = "web" ] && port="$WEB_PORT"
    pid="$(repair_pid_file "$service" "$port" || true)"
    if [ -n "$pid" ]; then
      ok "$service  运行中 (PID $pid, :$port)"
    else
      listeners="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
      if [ -n "$listeners" ]; then
        warn "$service  端口 :$port 被其他进程占用 (PID $listeners)"
      else
        echo -e "${RED}[STOP]${NC} $service  未运行"
      fi
    fi
  done
  echo "------------------------------"
  echo ""
}

do_logs() {
  case "${1:-all}" in
    api|a) tail -f "$LOG_DIR/api.log" ;;
    web|w) tail -f "$LOG_DIR/web.log" ;;
    all|*) tail -f "$LOG_DIR/api.log" "$LOG_DIR/web.log" ;;
  esac
}

do_help() {
  cat <<EOF

Resource Gallery 本地开发启动器

用法: ./dev.sh <命令>

命令:
  start        启动 API 与 Web；默认前台输出日志
  stop         仅停止本仓识别出的 API/Vite 进程
  restart      重启服务
  status       显示 PID、端口及健康状态
  logs [a|w]   跟踪 API / Web / 全部日志
  help         显示帮助

环境变量:
  PORT                         API 端口，默认 8787
  WEB_PORT                     Web 端口，默认 5173
  API_HOST / WEB_HOST          监听地址，默认 127.0.0.1
  RESOURCE_GALLERY_LOG_MODE    foreground（默认）或 file

示例:
  ./dev.sh start
  RESOURCE_GALLERY_LOG_MODE=file ./dev.sh start
  WEB_PORT=5174 ./dev.sh start

EOF
}

case "${1:-help}" in
  start) do_start ;;
  stop) do_stop ;;
  restart) do_stop; sleep 1; do_start ;;
  status) do_status ;;
  logs) do_logs "${2:-all}" ;;
  help|-h|--help) do_help ;;
  *) die "未知命令: ${1}. 运行 './dev.sh help' 查看帮助" ;;
esac
