#!/usr/bin/env bash
# 本地一站式冒烟测试：构建 → 启动 standalone server → 运行 Playwright
set -e
cd "$(dirname "$0")/.."

# 构建前先清场（2026-10-10 踩过）：`next dev` 与 `next build` 并发写同一个 `.next/` 会让 build
# 在 Collecting page data 阶段挂掉——报 `Cannot find module '../chunks/ssr/[turbopack]_runtime.js'`
# （dev 的 turbopack 产物与生产构建产物混在一起）。
# ⚠ `fuser -k 3000/tcp` 只杀得掉监听套接字那个子进程，**父进程 `next dev` 仍活着继续写**，
#   所以必须按命令行再杀一次。⚠ 模式写成 `next [d]ev`（正则）：这样**调用者的命令行里即使
#   出现这串字面量**（例如你正拿着 `pkill -f "next dev"` 调试）也不会把自己杀掉——实测过一次
#   自匹配（同 CLAUDE.md「静默失效陷阱」里 `pkill -f "tsx src/index.ts"` 那笔）。
echo "=== [0/3] 清场：结束 3000 端口与 dev server ==="
fuser -k 3000/tcp > /dev/null 2>&1 || true
pkill -f "next [d]ev" > /dev/null 2>&1 || true
sleep 1

echo "=== [1/3] 构建 ==="
pnpm build > /tmp/e2e-build.log 2>&1 || { tail -30 /tmp/e2e-build.log; exit 1; }

echo "=== [2/3] 启动 standalone server ==="
# 再释放一次端口（构建期间可能有别的东西重新占上）
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
