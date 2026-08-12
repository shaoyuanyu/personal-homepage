import { defineConfig } from "@playwright/test";

/**
 * 冒烟测试配置：
 * - 本地/CI 构建验证：默认 baseURL http://localhost:3000（standalone server）
 * - 线上验证：E2E_BASE_URL=https://shaoyuanyu.cn pnpm test:e2e
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  // 注意：保持默认（非 fullyParallel）——所有用例共享同一个 standalone 服务器
  // 状态（preferences.json / ideas.json），多 worker 并行写入会互相覆盖导致
  // 随机失败（如偏好恢复用例读到被其他 worker 覆盖的默认值）。单文件内串行执行。
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    // 站点默认语言为 zh：模拟中文浏览器，避免 middleware 语言检测重定向到 /en
    locale: "zh-CN",
    trace: "retain-on-failure",
  },
});
