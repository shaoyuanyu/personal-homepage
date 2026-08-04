#!/usr/bin/env node
/**
 * 启动 standalone 生产服务器（与 Docker 部署方式一致）
 *
 * 用法：pnpm start        （需先执行 pnpm build）
 *       pnpm preview      （构建 + 启动，一步到位）
 *
 * 说明：项目启用了 output: "standalone"，`next start` 不受支持，
 * 必须通过 node .next/standalone/server.js 运行生产服务器。
 */
import { cpSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const standalone = join(root, ".next", "standalone");
const serverEntry = join(standalone, "server.js");

if (!existsSync(serverEntry)) {
  console.error("✖ 未找到 standalone 产物，请先运行: pnpm build");
  process.exit(1);
}

// 复制静态资源（public / .next/static），与 Dockerfile 保持一致
cpSync(join(root, "public"), join(standalone, "public"), { recursive: true });
cpSync(join(root, ".next", "static"), join(standalone, ".next", "static"), {
  recursive: true,
});

const port = process.env.PORT ?? "3000";
console.log(`● 启动 standalone 服务器: http://localhost:${port} (Ctrl+C 停止)`);

const child = spawn(process.execPath, ["server.js"], {
  cwd: standalone,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "production",
    // 注意：Linux 环境变量中已有 HOSTNAME（机器名），必须显式覆盖为 0.0.0.0
    // 否则服务器会绑定到机器名地址，localhost 无法访问
    HOSTNAME: "0.0.0.0",
    PORT: port,
  },
});

child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
