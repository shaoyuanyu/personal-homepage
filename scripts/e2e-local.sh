#!/usr/bin/env bash
# 本地一站式冒烟测试：构建 → 启动 standalone server → 运行 Playwright
set -e
cd "$(dirname "$0")/.."

echo "=== [1/3] 构建 ==="
pnpm build > /tmp/e2e-build.log 2>&1 || { tail -30 /tmp/e2e-build.log; exit 1; }

echo "=== [2/3] 启动 standalone server ==="
# 释放可能残留的 3000 端口（测试专用）
fuser -k 3000/tcp > /dev/null 2>&1 || true
pnpm start > /tmp/e2e-server.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

for i in $(seq 1 30); do
  if curl -s -o /dev/null http://localhost:3000/; then break; fi
  sleep 1
done
if ! curl -s -o /dev/null http://localhost:3000/; then
  echo "!!! 服务器启动失败"; tail -20 /tmp/e2e-server.log; exit 1
fi

echo "=== [3/3] 运行冒烟测试 ==="
pnpm exec playwright test "$@"
