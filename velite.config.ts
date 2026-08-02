import { relative } from "node:path";
import { defineCollection, defineConfig, s } from "velite";

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
      slug: s.slug("posts"),
      body: s.mdx(),
    })
    .transform((data, { meta }) => {
      // content/posts/{zh|en}/{slug}.mdx → locale 从路径推断
      const rel = relative(meta.config.root, meta.path).replace(/\\/g, "/");
      const locale = rel.split("/")[1];
      return { ...data, locale };
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
        institution: s.string(),
      }),
    ),
    experience: s
      .array(
        s.object({
          period: s.string(),
          zh: s.string(),
          en: s.string(),
          institution: s.string(),
        }),
      )
      .default([]),
  }),
});

// ---------- Publications (论文) ----------
const publicationSchema = s.object({
  key: s.string(),
  title: s.string(),
  authors: s.array(s.string()),
  venue: s.string(),
  year: s.number().int().min(1990).max(2100),
  type: s.enum(["paper", "preprint", "thesis"]).default("paper"),
  url: s.string().optional(),
  pdf: s.string().optional(),
  doi: s.string().optional(),
  arxiv: s.string().optional(),
  code: s.string().optional(),
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
            name: s.string(),
            url: s.string(),
            desc: s.object({ zh: s.string(), en: s.string() }).optional(),
            icon: s.string().optional(),
          }),
        ),
      }),
    ),
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
  },
});
