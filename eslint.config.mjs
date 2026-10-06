import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      // 本地缓存（.gitignore 同款）：Radicale venv、字体源等。
      // 不忽略的话，按 CLAUDE.md 的「docker 不可用时用 .cache/radicale-venv 起 Radicale」
      // 跑一次本地验收，lint 就会多出 37 条来自 venv 内第三方 JS 的 warning，
      // 把「既有 2 个 warning」的基线淹掉、真问题被噪声盖住。
      ".cache/**",
    ],
  },
];

export default eslintConfig;
