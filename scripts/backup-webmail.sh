#!/usr/bin/env bash
# 邮件库快照（webmail-data：SQLite + .eml + 凭据）——在 VPS 上手动/定时执行。
#
# 背景：项目里 data/ideas.json 有 6 小时一次的异地备份，而邮件库此前**一份备份都没有**，
# 却是唯一不可再生的数据（服务商侧删掉的邮件只有本地有）。MAIL-AGENT.md 第八节第 7 步
# 把"正经备份"绑在 OSS（待购买）上，这个脚本是**不依赖任何外部服务**的过渡方案。
#
# 用法（VPS 上，位于 ~/personal-homepage/）：
#   bash backup-webmail.sh              # 默认保留 7 份
#   bash backup-webmail.sh --keep 14    # 保留 14 份
#   crontab: 20 4 * * *  cd $HOME/personal-homepage && bash backup-webmail.sh >> $HOME/backup-webmail.log 2>&1
#
# 产物：$HOME/personal-homepage/webmail-data/backups/<时间戳>/{webmail.db,eml/,accounts.json,credentials.json}
#
# ⚠ 快照与原数据在**同一块盘**上：防误删、误改、半截写入，**不防磁盘损坏**。
#   异地那一份仍待 OSS（MAIL-AGENT.md 第十节）——别把这份当完整备份。
# ⚠ 备份逻辑本体在邮件仓库 `webmail/src/backup.ts`（有 vitest 覆盖，含保留份数与硬链语义）；
#   本脚本只负责"在容器里跑它"（SQLite 的一致快照要靠 better-sqlite3 的在线备份 API，
#   宿主上未必有 sqlite3 CLI）。改逻辑请改那边，不要在这里重写。
set -euo pipefail

cd "$(dirname "$0")"

KEEP="${WEBMAIL_BACKUP_KEEP:-7}"
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP="$2"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

if ! docker compose ps --services --filter status=running 2>/dev/null | grep -qx webmail; then
  echo "!! webmail 容器未在运行（docker compose ps 里没有 running 的 webmail）" >&2
  echo "   备份需要容器内的 better-sqlite3 做在线快照；先 docker compose up -d webmail" >&2
  exit 1
fi

echo "=== $(date '+%F %T') 开始备份（保留 $KEEP 份）==="
# -T：无 TTY（cron 下必需）；WORKDIR 已是 /app/webmail（见邮件仓库 Dockerfile）
docker compose exec -T -e WEBMAIL_BACKUP_KEEP="$KEEP" webmail \
  ./node_modules/.bin/tsx src/backup.ts

echo "=== 快照目录 ==="
ls -1dt webmail-data/backups/*/ 2>/dev/null | head -"$KEEP"
