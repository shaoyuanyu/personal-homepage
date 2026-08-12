#!/usr/bin/env bash
# 应用网站发起的 CalDAV 密码重置：读取 data/caldav-reset.json → 更新 htpasswd → 删除队列文件
#
# 运行方式：VPS crontab 每分钟执行（无需 sudo，以部署用户 ysy 运行）：
#   * * * * * /home/ysy/personal-homepage/scripts/apply-calendar-reset.sh >> /home/ysy/apply-calendar-reset.log 2>&1
#
# 原理：
#   - 网站「我的日历」设置里的「随机重置密码」/「修改密码」会写入 data/caldav-reset.json
#     （web 容器可写，与 data/ideas.json 同目录），同时更新网站侧凭证 data/caldav.json
#   - 本脚本检测到队列文件后，用 openssl 生成 sha256 crypt hash（与 setup 脚本一致），
#     更新/追加 radicale/users（htpasswd），删除队列文件
#   - Radicale 每次认证都读取 htpasswd 文件（配置 htpasswd cache: False），无需重启容器
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

QUEUE="data/caldav-reset.json"
USERS="radicale/users"

if [[ ! -f "$QUEUE" ]]; then
  exit 0
fi

# 队列文件不可读（权限问题）：保留队列等待下次运行，绝不删除（删除会丢密码变更）
if [[ ! -r "$QUEUE" ]]; then
  echo "[$(date '+%F %T')] 队列文件不可读，保留等待: $QUEUE" >> apply-calendar-reset.log
  exit 1
fi

# 队列内容损坏/非法：删除避免死循环（网站侧凭证不受影响，仅 Radicale 未同步）
USER="$(python3 -c "import json,sys;print(json.load(open('$QUEUE'))['user'])" 2>/dev/null || echo "")"
PASSWORD="$(python3 -c "import json,sys;print(json.load(open('$QUEUE'))['password'])" 2>/dev/null || echo "")"
if [[ -z "$USER" || -z "$PASSWORD" ]]; then
  echo "[$(date '+%F %T')] 队列文件内容非法，移除: $QUEUE" >> apply-calendar-reset.log
  rm -f "$QUEUE"
  exit 1
fi

HASH="$(openssl passwd -5 "$PASSWORD")"
mkdir -p "$(dirname "$USERS")"

if [[ ! -f "$USERS" ]]; then
  printf '%s:%s\n' "$USER" "$HASH" > "$USERS"
else
  if grep -q "^${USER}:" "$USERS"; then
    # 替换该用户行（保留其他用户）
    awk -F: -v u="$USER" -v h="$HASH" 'BEGIN{OFS=":"} $1==u {print u, h; next} {print}' "$USERS" > "$USERS.tmp"
  else
    # 追加新用户
    cp "$USERS" "$USERS.tmp"
    printf '%s:%s\n' "$USER" "$HASH" >> "$USERS.tmp"
  fi
  mv "$USERS.tmp" "$USERS"
fi
chmod 600 "$USERS"

rm -f "$QUEUE"
echo "[$(date '+%F %T')] CalDAV 密码已应用: $USER（Radicale 已同步）" >> apply-calendar-reset.log
