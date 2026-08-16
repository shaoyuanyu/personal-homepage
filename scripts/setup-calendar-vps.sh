#!/usr/bin/env bash
# VPS 一次性部署：Radicale CalDAV（站主专属会议日历）
#
# 在 VPS 上 ~/personal-homepage 目录执行：
#   bash scripts/setup-calendar-vps.sh
#
# 完成三件事：
#   1. 生成随机强密码 + htpasswd 用户文件（radicale/users，首次运行）
#   2. 启动 radicale 容器（回环端口 5232），自动创建日历集合并设置显示名
#   3. 输出 Nginx 全量反代配置（无前缀改写）与 certbot 签发命令（需 sudo，自行执行）
#
# 客户端接入（Apple 日历 / Outlook / Google Calendar 等）：
#   服务器地址：https://calendar.shaoyuanyu.cn/（根路径，客户端自动发现）
#   Radicale URL 即存储路径（/<用户名>/<集合名>/），Nginx 全量反代、无前缀改写；
#   路径第一段必须是用户名（owner_only 权限模型），集合名任意（本站用 conference-ddl）
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

# 默认用户名：与宿主机部署用户同名（ysy）；可用 CALDAV_USER 环境变量覆盖
USERNAME="${CALDAV_USER:-ysy}"

# 1. 用户名：首次运行生成强随机密码；已存在则跳过
if [[ ! -f radicale/users ]]; then
  PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)"
  HASH="$(openssl passwd -5 "$PASSWORD")"
  mkdir -p radicale
  printf '%s:%s\n' "$USERNAME" "$HASH" > radicale/users
  chmod 600 radicale/users
  echo "✔ CalDAV 用户名已创建：$USERNAME"
  echo "  初始密码：$PASSWORD"
  echo "  后续可在网站「我的日历 → 设置」里查看用户名密码或随机重置（无需再登录 VPS）"
else
  echo "ℹ radicale/users 已存在，跳过账号创建"
  echo "  用户名密码请在网站「我的日历 → 设置」里查看或重置"
fi

# 2. 数据目录与容器启动
mkdir -p radicale/collections
docker compose up -d radicale
echo "✔ radicale 已启动：http://127.0.0.1:5232（仅回环）"

# 2.5 自动创建日历集合并设置显示名
# Radicale URL 即存储路径：/<用户名>/<集合名>/。集合名统一用 conference-ddl；
# 客户端显示名来自集合的 displayname 属性（未设置时回退路径），需显式
# MKCOL 建集合 + PROPPATCH displayname，客户端才会显示有语义的名字
if [[ -z "${PASSWORD:-}" && -f data/caldav.json ]]; then
  PASSWORD="$(python3 -c 'import json;print(json.load(open("data/caldav.json"))["password"])' 2>/dev/null || true)"
fi
COLLECTION_URL="http://127.0.0.1:5232/${USERNAME}/conference-ddl/"
if [[ -n "${PASSWORD:-}" ]]; then
  if curl -sf -u "$USERNAME:$PASSWORD" -X PROPFIND -H 'Depth: 0' "$COLLECTION_URL" -o /dev/null; then
    echo "ℹ 日历集合已存在：/$USERNAME/conference-ddl/"
  else
    echo "✔ 创建日历集合：/$USERNAME/conference-ddl/"
    curl -s -u "$USERNAME:$PASSWORD" -X MKCOL -H 'Content-Type: application/xml; charset=utf-8' \
      --data '<?xml version="1.0" encoding="utf-8" ?><D:mkcol xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype></D:prop></D:set></D:mkcol>' \
      "$COLLECTION_URL" -o /dev/null || echo "  ⚠ MKCOL 失败（检查凭证或稍后重跑）"
  fi
  # displayname 幂等设置：Apple 日历等客户端以此作为日历显示名
  curl -s -u "$USERNAME:$PASSWORD" -X PROPPATCH -H 'Content-Type: application/xml; charset=utf-8' \
    --data '<?xml version="1.0" encoding="utf-8" ?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:displayname>会议 Deadline</D:displayname></D:prop></D:set></D:propertyupdate>' \
    "$COLLECTION_URL" -o /dev/null || echo "  ⚠ displayname 设置失败（仅影响客户端显示名，可忽略）"
  echo "✔ 日历显示名已设置：会议 Deadline（客户端重新同步后生效）"
else
  echo "ℹ 无可用凭证，跳过集合创建/显示名设置；在网站「我的日历 → 设置」保存密码后可重跑本脚本"
fi

# 2.6 安装「密码重置应用」定时任务：每分钟把网站发起的密码变更同步到 Radicale
CRON_JOB="$DIR/scripts/apply-calendar-reset.sh > /dev/null 2>&1"
if crontab -l 2>/dev/null | grep -q apply-calendar-reset; then
  echo "ℹ crontab 已存在，跳过安装"
else
  (crontab -l 2>/dev/null; echo "* * * * * $CRON_JOB") | crontab -
  echo "✔ 已安装 crontab：每分钟应用网站发起的 CalDAV 密码重置"
fi

# 3. Nginx 与证书指引
cat <<EOF

===== Nginx 反代（需 sudo，请自行创建 /etc/nginx/sites-enabled/calendar.shaoyuanyu.cn.conf）=====
# 全量反代：Radicale URL 即存储路径（/<用户名>/<集合名>/），不做任何前缀改写。
# 客户端填根路径 https://calendar.shaoyuanyu.cn/ 即可自动发现（principal 发现需访问 /）。
#
# ⚠ VPS 的 Nginx < 1.25.1 不支持「http2 on;」指令（否则 nginx -t 失败、整份配置
#   不生效，曾致手机客户端「无法连接至服务器」），443 必须写 listen 443 ssl http2;

# certbot 引导用（HTTP；签发后保留供自动续期）
server {
    listen 80;
    server_name calendar.shaoyuanyu.cn;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name calendar.shaoyuanyu.cn;

    ssl_certificate     /etc/letsencrypt/live/calendar.shaoyuanyu.cn/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/calendar.shaoyuanyu.cn/privkey.pem;

    # CalDAV 自动发现入口：指向根路径即可（根路径直通 Radicale 完成 principal 发现）
    location = /.well-known/caldav {
        return 301 https://calendar.shaoyuanyu.cn/;
    }

    # 全量反代 Radicale
    location / {
        proxy_pass http://127.0.0.1:5232;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}

# 签发并启用 HTTPS：
#   sudo certbot --nginx -d calendar.shaoyuanyu.cn   （签发后保留 80 块供续期）
# 或证书已就绪：套用上方配置后 sudo nginx -t && sudo systemctl reload nginx

===== 日历客户端接入 =====
服务器地址：https://calendar.shaoyuanyu.cn/（根路径，自动发现）
（Apple 日历 / Outlook / Google Calendar 均可通过「添加日历账户」接入）
EOF
