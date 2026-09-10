import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 为 next/og（ImageResponse）加载 OG 图的**衬线**字体（与页面主标题一致）。
 *
 * 背景：ImageResponse 在 Node（alpine 容器）中渲染时没有任何字体，
 * 中文会显示为豆腐块，且 satori 要求至少加载一个字体。
 *
 * 方案：字体来自 @fontsource（devDependency），构建时直接从 node_modules
 * 读取 **woff** 子集（satori/fontkit 不支持 woff2），无网络依赖、不进入
 * Docker 镜像。（OG 图在构建期静态生成，运行时容器无需字体文件。）
 *
 * 两个族：西文 Tinos（与页面主标题同源）+ 中文 Noto Serif SC；
 * satori 按 fontFamily 列表逐级回退，故中文字形由后者提供。
 */

export const FONT_FAMILY = "Tinos, Noto Serif SC";

type OgFont = {
  name: string;
  data: Buffer;
  weight: 400 | 700;
  style: "normal";
};

/** [@fontsource 包名, 字族名, files/ 下的文件名前缀] */
const SOURCES = [
  ["tinos", "Tinos", "tinos-latin"],
  ["noto-serif-sc", "Noto Serif SC", "noto-serif-sc-chinese-simplified"],
] as const;

const WEIGHTS = [400, 700] as const;
let cache: OgFont[] | null = null;

export async function loadOgFonts(): Promise<OgFont[]> {
  if (cache) return cache;

  cache = SOURCES.flatMap(([pkg, name, prefix]) =>
    WEIGHTS.map((weight) => ({
      name,
      weight,
      style: "normal" as const,
      data: readFileSync(
        path.join(
          process.cwd(),
          "node_modules",
          "@fontsource",
          pkg,
          "files",
          `${prefix}-${weight}-normal.woff`,
        ),
      ),
    })),
  );
  return cache;
}
