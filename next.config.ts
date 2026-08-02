import type { NextConfig } from "next";
import path from "node:path";
import createNextIntlPlugin from "next-intl/plugin";

// 启动 Velite 内容构建（dev 时 watch，build 时一次性构建）
const isDev = process.argv.indexOf("dev") !== -1;
const isBuild = process.argv.indexOf("build") !== -1;
if (!process.env.VELITE_STARTED && (isDev || isBuild)) {
  process.env.VELITE_STARTED = "1";
  import("velite").then((m) => m.build({ watch: isDev, clean: !isDev }));
}

const withNextIntl = createNextIntlPlugin("./lib/i18n/request.ts");

const nextConfig: NextConfig = {
  // Docker 部署使用 standalone 输出
  output: "standalone",
  // 明确 tracing root，避免多 lockfile 时推断到父目录
  outputFileTracingRoot: path.join(__dirname),
  // MDX 运行时在服务端通过 Function 执行，外部化避免打包问题
  serverExternalPackages: ["@mdx-js/mdx"],
  images: {
    // 头像使用本地 SVG（占位），启用 SVG 支持
    dangerouslyAllowSVG: true,
  },
};

export default withNextIntl(nextConfig);
