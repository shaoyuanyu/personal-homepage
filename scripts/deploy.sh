#!/usr/bin/env bash
# ============================================================================
# 站点部署 / 回滚脚本 —— **在 VPS 上运行**（VPS 上的副本是权威副本）
#
# 用法（在 ~/personal-homepage/ 下）：
#   bash deploy.sh                            # 只打印当前运行版本（只读）
#   bash deploy.sh <web版本>                   # 只更新 web（webmail 保持现状）
#   bash deploy.sh <web版本> <webmail版本>      # web + webmail 一起更新
#
#   版本号形如 2026.10.07-7475b30（= 提交日期-短 SHA，即 ACR 里的镜像 tag）。
#
# 为什么部署逻辑放在 VPS 上，而不是只写在工作流 YAML 里：
#   · 回滚不该依赖 GitHub / Actions / PAT / deploy key 同时健康——SSH 上来一条
#     命令就能上线或退回上一版；
#   · 流水线部署与手工回滚走**同一份实现**，不会出现"YAML 里改好了、手工那条
#     路还是旧逻辑"的漂移。
#   ⚠ 仓库里的 scripts/deploy.sh 是唯一事实来源，改完必须同步到 VPS：
#     scp -i ~/.ssh/vps-deploy scripts/deploy.sh ysy@106.14.135.32:~/personal-homepage/deploy.sh
#
# 依次做五件事（顺序即失败边界）：
#   1. 前置校验：compose 里定义过对应服务（否则 compose 会凭一个 image 造出
#      没有网络/挂载/环境变量的"空壳容器"，而不是报错）；
#   2. 拉取镜像 + **入口校验**：web 的 Cmd 必须含 server.js、webmail 必须含 tsx。
#      ⚠ 历史上 ACR 构建规则误配时，webmail 镜像里装成过 web 应用且**全链路无
#      报错**（tag 正常、流水线正常、容器正常启动，只是 /mail 打不开）。校验放在
#      "拉取后、起容器前"，所以校验失败时旧容器仍在跑，线上不受影响。
#      ⚠ 拉取失败、但 **VPS 本地已有同名镜像**时按回滚处理直接用它（见
#      pull_and_verify 的注释）；两处都没有才失败退出。
#   3. 用 override 文件按版本号钉死镜像重建容器（不依赖 VPS 上那份 compose 的
#      image: 行——它可能滞后于 main）；
#   4. **健康探测**：等 web（容器内 3000）与 webmail（容器内 /health）真的可用；
#      失败则打印容器日志并非零退出。`docker compose up -d` 返回 0 **不等于**
#      服务活着——崩溃循环的容器同样算"成功"（曾因此线上静默故障）。
#   5. 清理：每个镜像仓库只保留最近 KEEP_VERSIONS 个版本号镜像。
#
# ⚠ 回滚能退到哪一版，取决于镜像还在不在（2026-10-07 实测：ACR 两个仓库各只剩
#   当前一个版本号 tag，历史版本已不在 → 光指望 ACR 是退不回去的）：
#     · VPS 本地缓存 = 回滚的实际窗口：每次部署都 pull 一份，脚本按 KEEP_VERSIONS
#       保留最近若干个（这些镜像即使 ACR 侧被清理掉也还能用）；
#     · ⚠ 别在 ACR 控制台/本地随手删旧版本号镜像，删掉就真的退不回去了。
#
# 依赖：docker + compose v2；ACR 已登录（~/.docker/config.json，必要时先
#       docker login <registry>）。本脚本自身不接触任何密钥。
# ============================================================================
set -euo pipefail

# 脚本修订号：改动本脚本时一并更新，便于在日志里确认 VPS 上跑的是哪一版
DEPLOY_REV="2026-10-07.2"

REGISTRY="${REGISTRY:-crpi-pko4rr79dtavwpp5.cn-shanghai.personal.cr.aliyuncs.com}"
NAMESPACE="${NAMESPACE:-shaoyuanyu}"
WEB_REPO="${WEB_REPO:-ysy-homepage-web}"
WEBMAIL_REPO="${WEBMAIL_REPO:-ysy-homepage-webmail}"
# 本地保留多少个版本号镜像 = 回滚窗口（ACR 侧不保证留着历史版本，见文件头）
KEEP_VERSIONS="${KEEP_VERSIONS:-8}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
OVERRIDE_FILE="${OVERRIDE_FILE:-/tmp/registry-override.yml}"

# 入口标记：镜像 Cmd 里必须出现的字符串
WEB_CMD_MARKER="server.js"
WEBMAIL_CMD_MARKER="tsx"
# 容器内健康探测（node 一定在镜像里：web 的 Cmd 就是 node，webmail 跑 tsx）
WEB_PROBE="fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
WEBMAIL_PROBE="fetch('http://127.0.0.1:9710/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 脚本与 docker-compose.yml 同目录（VPS 上即 ~/personal-homepage/）
COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$COMPOSE_DIR"

die() { echo "!!! $*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
用法：
  bash deploy.sh                            只打印当前运行版本（只读）
  bash deploy.sh <web版本>                   只更新 web（webmail 保持现状）
  bash deploy.sh <web版本> <webmail版本>       web + webmail 一起更新
版本号形如 2026.10.07-7475b30（提交日期-短SHA，即 ACR 里的镜像 tag）。
USAGE
}

current_image() { # $1 = compose 服务名 → 该服务当前容器使用的镜像
  docker compose ps --format '{{.Image}}' "$1" 2>/dev/null | head -n1 || true
}

status() {
  echo "=== 当前运行版本（compose 目录：$COMPOSE_DIR）==="
  local svc img
  for svc in web webmail; do
    img="$(current_image "$svc")"
    printf '  %-8s %s\n' "$svc" "${img:-（未运行）}"
  done
  echo "--- 本地保留的版本号镜像 ---"
  local r tags
  for r in "$WEB_REPO" "$WEBMAIL_REPO"; do
    tags="$(docker images "$REGISTRY/$NAMESPACE/$r" --format '{{.Tag}}' 2>/dev/null \
      | grep -E '^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-' | sort -r | tr '\n' ' ' || true)"
    printf '  %-22s %s\n' "$r" "${tags:-（无）}"
  done
}

pull_and_verify() { # $1 = 完整镜像地址, $2 = 入口必须包含的标记, $3 = 说明
  local image="$1" marker="$2" label="$3" cmd i pulled=0
  for i in 1 2 3; do
    echo "=== 拉取 $label（第 $i 次）：$image ==="
    if timeout 600 docker pull "$image"; then pulled=1; break; fi
    if [ "$i" -lt 3 ]; then
      echo "!!! 拉取失败，10 秒后重试"
      sleep 10
    fi
  done
  if [ "$pulled" != 1 ]; then
    # 回滚场景：ACR 上的旧版本 tag 可能已被清理（控制台删过/构建记录没了），
    # 但 VPS 上还留着当初部署时拉下来的那一份。版本号 = 提交短SHA + 永不覆写，
    # 所以本地这份就是正确的产物 —— 直接用，别让回滚卡在"镜像源没了"上。
    # ⚠ 这也是"ACR 侧不保证留历史版本"时的最后一道保险，勿删这段。
    if docker image inspect "$image" >/dev/null 2>&1; then
      echo "⚠ ACR 上取不到 $image，但 VPS 本地有同名镜像 → 按回滚处理，使用本地镜像"
      echo "⚠ （若不是在做回滚，请先查清为什么 ACR 上没有了：被清理？改名？）"
    else
      die "$label 三次拉取均失败，且本地也没有 $image —— 该版本在 ACR 与 VPS 上都不存在，回滚不到它"
    fi
  fi
  cmd="$(docker inspect -f '{{json .Config.Cmd}}' "$image")"
  if ! printf '%s' "$cmd" | grep -qF "$marker"; then
    echo "!!! $label 镜像入口异常：Cmd 里没有 '$marker'"
    echo "!!! 实际 Cmd = $cmd"
    die "$label 镜像内容不对（ACR 构建规则是否被改坏？）——已中止，旧容器未动"
  fi
  echo "✔ $label 镜像就绪且入口正确：$cmd"
}

health_wait() { # $1 = compose 服务名, $2 = 容器内探测 JS
  local svc="$1" js="$2" waited=0
  echo "=== 健康探测：$svc（上限 ${HEALTH_TIMEOUT}s）==="
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    if docker compose exec -T "$svc" node -e "$js" >/dev/null 2>&1; then
      echo "✔ $svc 健康（等待 ${waited}s）"
      return 0
    fi
    waited=$((waited + 3))
    sleep 3
  done
  echo "!!! $svc 在 ${HEALTH_TIMEOUT}s 内未通过健康探测——最近日志："
  docker compose logs --tail=40 "$svc" 2>&1 || true
  die "$svc 容器在跑但服务不可用（健康探测失败）"
}

prune_old_versions() {
  local r t
  for r in "$WEB_REPO" "$WEBMAIL_REPO"; do
    # 只认版本号格式的 tag（YYYY.MM.DD-*，倒序即新旧序）；正在使用的镜像
    # docker rmi 会拒绝删除。ACR 构建缓存镜像（__ACR_BUILD_SERVICE_INTERNAL_...）
    # 不匹配该格式，不会被误删。
    docker images "$REGISTRY/$NAMESPACE/$r" --format '{{.Tag}}' 2>/dev/null \
      | grep -E '^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-' | sort -r | tail -n +$((KEEP_VERSIONS + 1)) \
      | while read -r t; do
          echo "清理旧版本：$r:$t"
          docker rmi "$REGISTRY/$NAMESPACE/$r:$t" || true
        done || true
  done
  docker image prune -f >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------
WEB_VERSION="${1:-}"
WEBMAIL_VERSION="${2:-}"

case "$WEB_VERSION" in
  "" | --status) status; exit 0 ;;
  -h | --help) usage; exit 0 ;;
esac

echo "[deploy] 脚本修订 $DEPLOY_REV；compose 目录 $COMPOSE_DIR"
status
echo

# 1. 前置校验：compose 必须定义过对应服务
services="$(docker compose config --services 2>/dev/null || true)"
[ -n "$services" ] || die "读不到 compose 服务列表（$COMPOSE_DIR/docker-compose.yml 是否存在？）"
if ! grep -qx web <<<"$services"; then
  die "compose 里没有 web 服务定义——VPS 上的 docker-compose.yml 需先同步仓库版本"
fi

WEB_IMAGE="$REGISTRY/$NAMESPACE/$WEB_REPO:$WEB_VERSION"
WEBMAIL_IMAGE=""
if [ -n "$WEBMAIL_VERSION" ]; then
  if ! grep -qx webmail <<<"$services"; then
    die "compose 里没有 webmail 服务定义——VPS 上的 docker-compose.yml 需先同步仓库版本"
  fi
  WEBMAIL_IMAGE="$REGISTRY/$NAMESPACE/$WEBMAIL_REPO:$WEBMAIL_VERSION"
fi

# 3. override 文件：把本次部署的镜像按版本号钉死
{
  echo "services:"
  echo "  web:"
  echo "    image: $WEB_IMAGE"
  if [ -n "$WEBMAIL_IMAGE" ]; then
    echo "  webmail:"
    echo "    image: $WEBMAIL_IMAGE"
  fi
} >"$OVERRIDE_FILE"

# 2. 拉取 + 入口校验
pull_and_verify "$WEB_IMAGE" "$WEB_CMD_MARKER" web
SERVICES="web"
if [ -n "$WEBMAIL_IMAGE" ]; then
  pull_and_verify "$WEBMAIL_IMAGE" "$WEBMAIL_CMD_MARKER" webmail
  SERVICES="web webmail"
fi

# 3. 重建容器（webmail 版本未变时 compose 自己会跳过重建）
echo "=== 重建容器：$SERVICES ==="
docker compose -f docker-compose.yml -f "$OVERRIDE_FILE" up -d --no-deps $SERVICES

# 4. 健康探测：web 必查；webmail 只要 compose 里有这个服务就一并查
#    （它是站内邮箱的后端，坏掉时公网冒烟测不到）
health_wait web "$WEB_PROBE"
if grep -qx webmail <<<"$services"; then
  health_wait webmail "$WEBMAIL_PROBE"
fi

# 5. 清理旧版本
prune_old_versions

echo
echo "✔ 部署完成：web=$WEB_VERSION${WEBMAIL_VERSION:+ webmail=$WEBMAIL_VERSION}"
status
