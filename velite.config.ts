import { relative } from "node:path";
import { defineCollection, defineConfig, s } from "velite";

// 论文类型单一来源（相对路径导入：velite 配置文件由 esbuild 单独打包，
// 不走 @/ 别名，故此处不能用 "@/lib/..."）
import { PUBLICATION_TYPES } from "./lib/publications/constants";

/**
 * 给 h1-h4 标题注入 id = 标题原文（与 s.toc() 生成的锚点 URL 一致，
 * 例如 `## 欢迎` → `id="欢迎"` / `#欢迎`）。纯文本递归拼接，无额外依赖。
 */
type HastNode = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: { id?: string };
  children?: HastNode[];
};

function headingIdPlugin() {
  return (tree: unknown) => {
    const collectText = (node: HastNode | undefined): string => {
      if (!node) return "";
      if (node.type === "text") return node.value ?? "";
      return (node.children ?? []).map(collectText).join("");
    };
    const walk = (node: HastNode | undefined) => {
      if (!node) return;
      if (
        node.type === "element" &&
        /^h[1-4]$/.test(node.tagName ?? "") &&
        !node.properties?.id
      ) {
        const id = collectText(node).trim();
        if (id) node.properties = { ...node.properties, id };
      }
      (node.children ?? []).forEach(walk);
    };
    walk(tree as HastNode);
  };
}

// ---------- Posts (MDX 博客) ----------
const posts = defineCollection({
  name: "Post",
  pattern: "posts/**/*.mdx",
  schema: s
    .object({
      title: s.string().max(120),
      date: s.isodate(),
      tags: s.array(s.string()).default([]),
      summary: s.string().max(300).optional(),
      // slug 是「文章标识」而非「语言版本标识」：同一 slug 出现在 zh/ 与 en/ 下表示
      // 同一篇文章的两个语言版本（见 lib/data/blog.ts）。
      // 故不能用 s.slug("posts")——它的唯一性校验是集合级（跨语言同名也判冲突），
      // 这里只保留格式约束，唯一性由 lib/data/blog.ts 按 (locale, slug) 校验。
      slug: s
        .string()
        .min(3)
        .max(200)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i, "Invalid slug"),
      body: s.mdx({ rehypePlugins: [headingIdPlugin] }),
      // 目录（标题锚点树）与阅读统计，由 Velite 从 MDX 自动提取
      toc: s.toc(),
      meta: s.metadata(),
    })
    .transform((data, { meta }) => {
      // content/posts/{zh|en}/{slug}.mdx → locale 从路径推断
      const rel = relative(meta.config.root, meta.path).replace(/\\/g, "/");
      const locale = rel.split("/")[1];
      // source 供 lib/data/blog.ts 在校验失败时给出可定位的文件路径
      return { ...data, locale, source: rel };
    }),
});

// ---------- Profile (个人资料, 单文件) ----------
const profile = defineCollection({
  name: "Profile",
  pattern: "profile.yaml",
  single: true,
  schema: s.object({
    name: s.string(),
    title: s.object({ zh: s.string(), en: s.string() }),
    institution: s.object({ zh: s.string(), en: s.string() }),
    avatar: s.string(),
    email: s.string().email(),
    location: s.object({ zh: s.string(), en: s.string() }),
    bio: s.object({ zh: s.string(), en: s.string() }),
    researchInterests: s.array(
      s.object({ key: s.string(), zh: s.string(), en: s.string() }),
    ),
    socials: s.object({
      github: s.string().default(""),
      googleScholar: s.string().default(""),
      semanticScholar: s.string().default(""),
      orcid: s.string().default(""),
      twitter: s.string().default(""),
      zhihu: s.string().default(""),
      bilibili: s.string().default(""),
    }),
    education: s.array(
      s.object({
        period: s.string(),
        zh: s.string(),
        en: s.string(),
        institution: s.object({ zh: s.string(), en: s.string() }),
      }),
    ),
    experience: s
      .array(
        s.object({
          period: s.string(),
          zh: s.string(),
          en: s.string(),
          institution: s.object({ zh: s.string(), en: s.string() }),
        }),
      )
      .default([]),
  }),
});

// ---------- Publications (论文，纯手工维护 —— 见 content/publications.yaml) ----------
const publicationSchema = s.object({
  // BibTeX 引用 key，同时用作列表的 React key；BibTeX key 不允许空格/逗号/花括号
  key: s
    .string()
    .min(1)
    .regex(/^[^\s,{}]+$/, "BibTeX key 不能包含空格、逗号或花括号"),
  title: s.string().min(1),
  // 作者数组（按论文上的顺序）。自己那一项可加 `*` 后缀，见 lib/publications/authors.ts
  authors: s.array(s.string().min(1)).min(1),
  venue: s.string().min(1),
  year: s.number().int().min(1990).max(2100),
  type: s.enum(PUBLICATION_TYPES).default("conference"),
  // 可选链接字段：留空则不渲染对应按钮
  url: s.string().optional(),
  pdf: s.string().optional(), // 允许站内相对路径（如 /papers/xxx.pdf），故不校验为绝对 URL
  doi: s.string().optional(), // 裸 DOI（如 10.1145/xxxx），UI 自动拼 https://doi.org/
  arxiv: s.string().optional(), // 裸 arXiv id（如 2501.01234）
  code: s.string().optional(),
  // 直接粘贴出版社给的 BibTeX：填了就原样展示/复制，不再自动生成（见 lib/bibtex.ts）
  bibtex: s.string().optional(),
});


const publications = defineCollection({
  name: "Publication",
  pattern: "publications.yaml",
  // schema 描述文件结构；Velite 输出 Array<_output>，lib/data 中解包
  schema: s.object({ publications: s.array(publicationSchema) }),
});

// ---------- Talks (学术报告) ----------
const talks = defineCollection({
  name: "Talk",
  pattern: "talks.yaml",
  schema: s.object({
    talks: s.array(
      s.object({
        title: s.string(),
        event: s.string(),
        date: s.isodate(),
        location: s.string().optional(),
        url: s.string().optional(),
        slides: s.string().optional(),
      }),
    ),
  }),
});

// ---------- Projects (项目) ----------
const projects = defineCollection({
  name: "Project",
  pattern: "projects.yaml",
  schema: s.object({
    projects: s.array(
      s.object({
        name: s.string(),
        description: s.object({ zh: s.string(), en: s.string() }),
        tags: s.array(s.string()).default([]),
        github: s.string().optional(),
        url: s.string().optional(),
        featured: s.boolean().default(false),
      }),
    ),
  }),
});

// ---------- Nav Links (学术导航) ----------
const navLinks = defineCollection({
  name: "NavLinkGroup",
  pattern: "nav-links.yaml",
  schema: s.object({
    groups: s.array(
      s.object({
        group: s.object({ zh: s.string(), en: s.string() }),
        links: s.array(
          s.object({
            name: s.object({ zh: s.string(), en: s.string() }),
            url: s.string(),
            desc: s.object({ zh: s.string(), en: s.string() }).optional(),
            icon: s.string().optional(),
          }),
        ),
      }),
    ),
  }),
});

// ---------- Deadlines Overrides (会议 deadline 覆盖层) ----------
const deadlinesOverrides = defineCollection({
  name: "DeadlinesOverrides",
  pattern: "deadlines-overrides.yaml",
  single: true,
  schema: s.object({
    conferences: s
      .array(
        s.object({
          a: s.string().min(1),
          n: s.string().min(1),
          l: s.enum(["A", "B", "C"]).optional(),
          f: s.string().optional(),
          d: s.string().optional(),
          /**
           * ⚠ `years` 是**可选**的：省略时沿用自动同步数据里的届别/时间线，
           * 于是可以只修正名称等字段（如上游把会议全称截断）而不必把整份
           * timeline 复制进覆盖层再随上游一起过期。合并逻辑见 `mergeDeadlines()`。
           */
          years: s
            .array(
              s.object({
                y: s.number().int().min(2000).max(2100),
                link: s.string().optional(),
                tz: s.string().default("UTC"),
                date: s.string().optional(),
                place: s.string().optional(),
                timeline: s
                  .array(
                    s.object({
                      t: s.string().min(1),
                      c: s.string().optional(),
                      k: s.enum(["abstract", "paper"]).optional(),
                    }),
                  )
                  .min(1),
              }),
            )
            .min(1)
            .optional(),
        }),
      )
      .default([]),
  }),
});

export default defineConfig({
  root: "content",
  strict: true,
  output: {
    data: ".velite",
    clean: true,
  },
  collections: {
    posts,
    profile,
    publications,
    talks,
    projects,
    navLinks,
    deadlinesOverrides,
  },
});
