#!/usr/bin/env bash
# 想法速记（ideas.json）定期备份脚本
#
# 由 VPS crontab 每 6 小时触发（0 */6 * * *），将数据推送到
# private 仓库 shaoyuanyu/ideas-backup（deploy key 认证，仅该仓库写权限）。
#
# 恢复方法：
#   git clone git@github.com-backup:shaoyuanyu/ideas-backup.git
#   cp ideas.json ~/personal-homepage/data/ideas.json
set -euo pipefail
export PATH="/usr/bin:/bin:/usr/local/bin:$PATH"

SRC="$HOME/personal-homepage/data/ideas.json"
REPO="$HOME/ideas-backup"

# 数据文件不存在（从未创建过速记）则跳过
if [[ ! -f "$SRC" ]]; then
  echo "[backup-ideas] $(date '+%F %T %Z') 源文件不存在，跳过"
  exit 0
fi

cd "$REPO"
cp "$SRC" ideas.json
git add ideas.json

# 内容无变更则不产生提交（用暂存区比较，首次入库的 untracked 文件也能正确识别）
if git diff --cached --quiet -- ideas.json; then
  echo "[backup-ideas] $(date '+%F %T %Z') 无变更，跳过"
  exit 0
fi

git commit -m "backup: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null
git push origin master
echo "[backup-ideas] $(date '+%F %T %Z') 备份完成: $(git rev-parse --short HEAD)"
