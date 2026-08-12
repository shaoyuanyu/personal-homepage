#!/usr/bin/env bash
# VPS 一次性部署：Radicale CalDAV（站主专属会议日历）
#
# 在 VPS 上 ~/personal-homepage 目录执行：
#   bash scripts/setup-calendar-vps.sh
#
# 完成三件事：
#   1. 生成随机强密码 + htpasswd 用户文件（radicale/users，首次运行）
#   2. 启动 radicale 容器（回环端口 5232）
#   3. 输出 Nginx 反代配置（/conference-ddl/ 前缀重写到用户目录）与 certbot 签发命令（需 sudo，自行执行）
#
# 客户端接入（Apple 日历 / Outlook / Google Calendar 等）：
#   CalDAV 地址：https://cal.shaoyuanyu.cn/conference-ddl/calendar/
#   （Nginx 把 /conference-ddl/ 重写为后端 /<用户名>/，用户名不出现在公网 URL）
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

# 默认账号：与宿主机部署用户同名（ysy）；可用 CALDAV_USER 环境变量覆盖
USERNAME="${CALDAV_USER:-ysy}"

# 1. 账号：首次运行生成强随机密码；已存在则跳过
if [[ ! -f radicale/users ]]; then
  PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)"
  HASH="$(openssl passwd -5 "$PASSWORD")"
  mkdir -p radicale
  printf '%s:%s\n' "$USERNAME" "$HASH" > radicale/users
  chmod 600 radicale/users
  echo "✔ CalDAV 账号已创建：$USERNAME"
  echo "  初始密码：$PASSWORD"
  echo "  后续可在网站「我的日历 → 设置」里查看账号密码或随机重置（无需再登录 VPS）"
else
  echo "ℹ radicale/users 已存在，跳过账号创建"
  echo "  账号密码请在网站「我的日历 → 设置」里查看或重置"
fi

# 2. 数据目录与容器启动
mkdir -p radicale/collections
docker compose up -d radicale
echo "✔ radicale 已启动：http://127.0.0.1:5232（仅回环）"

# 2.5 安装「密码重置应用」定时任务：每分钟把网站发起的密码变更同步到 Radicale
CRON_JOB="$DIR/scripts/apply-calendar-reset.sh > /dev/null 2>&1"
if crontab -l 2>/dev/null | grep -q apply-calendar-reset; then
  echo "ℹ crontab 已存在，跳过安装"
else
  (crontab -l 2>/dev/null; echo "* * * * * $CRON_JOB") | crontab -
  echo "✔ 已安装 crontab：每分钟应用网站发起的 CalDAV 密码重置"
fi

# 3. Nginx 与证书指引
cat <<EOF

===== Nginx 反代（需 sudo，请自行创建 /etc/nginx/sites-enabled/cal.shaoyuanyu.cn.conf）=====
# 自定义 URL 前缀 /conference-ddl/ → 后端 /<用户名>/（用户名不出现在公网 URL；
# CalDAV 协议不要求用户名入 URL，此重写由 Nginx 完成，Radicale 内部无感知）
server {
    listen 80;
    server_name cal.shaoyuanyu.cn;

    location /conference-ddl/ {
        proxy_pass http://127.0.0.1:5232/${USERNAME}/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # CalDAV 客户端自动发现（Apple 日历等会先请求 /.well-known/caldav）
    location = /.well-known/caldav {
        return 301 https://cal.shaoyuanyu.cn/conference-ddl/calendar/;
    }
}

# 签发并启用 HTTPS：
#   sudo certbot --nginx -d cal.shaoyuanyu.cn

===== 日历客户端接入 =====
CalDAV 地址：https://cal.shaoyuanyu.cn/conference-ddl/calendar/
（Apple 日历 / Outlook / Google Calendar 均可通过「添加日历账户」接入）
EOF
