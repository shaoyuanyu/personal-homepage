import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 为 next/og（ImageResponse）加载 Noto Sans SC 字体（含中文）。
 *
 * 背景：ImageResponse 在 Node（alpine 容器）中渲染时没有中文字体，
 * 中文会显示为豆腐块，且 satori 要求至少加载一个字体。
 *
 * 方案：字体来自 @fontsource/noto-sans-sc（devDependency），构建时
 * 直接从 node_modules 读取 woff 子集（satori/fontkit 不支持 woff2），
 * 无网络依赖、不进入 Docker 镜像。
 * （OG 图在构建期静态生成，运行时容器无需字体文件。）
 */

export const FONT_FAMILY = "Noto Sans SC";

type OgFont = {
  name: string;
  data: Buffer;
  weight: 400 | 700;
  style: "normal";
};

const WEIGHTS = [400, 700] as const;
let cache: OgFont[] | null = null;

export async function loadOgFonts(): Promise<OgFont[]> {
  if (cache) return cache;

  const fontDir = path.join(
    process.cwd(),
    "node_modules",
    "@fontsource",
    "noto-sans-sc",
    "files",
  );

  cache = WEIGHTS.map((weight) => ({
    name: FONT_FAMILY,
    weight,
    style: "normal" as const,
    data: readFileSync(
      path.join(fontDir, `noto-sans-sc-chinese-simplified-${weight}-normal.woff`),
    ),
  }));
  return cache;
}
