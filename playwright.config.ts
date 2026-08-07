import { defineConfig } from "@playwright/test";

/**
 * 冒烟测试配置：
 * - 本地/CI 构建验证：默认 baseURL http://localhost:3000（standalone server）
 * - 线上验证：E2E_BASE_URL=https://shaoyuanyu.cn pnpm test:e2e
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    // 站点默认语言为 zh：模拟中文浏览器，避免 middleware 语言检测重定向到 /en
    locale: "zh-CN",
    trace: "retain-on-failure",
  },
});
