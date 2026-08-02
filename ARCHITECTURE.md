# 个人学术网站 · 技术架构

> 最后更新：2026-08-03
> 目标：可拓展、可维护、可持续迭代的个人学术网站

## 1. 需求总览

| 板块 | 说明 | 状态 |
|---|---|---|
| 学术主页 | 简介、经历、研究方向、联系方式、首页聚合 | ✅ 核心 |
| 工具导航页 | 学术常用网站/工具，分类 + 搜索 + 分组自定义 | ✅ 核心 |
| 博客 | MDX 写作、标签、时间线归档 | ✅ 核心 |
| 出版物列表 | 按年份分组、领域过滤、**BibTeX 一键复制**、DOI/PDF 链接 | ✅ 已选 |
| 简历 CV 页 | 结构化在线 CV + PDF 下载 | ✅ 已选 |
| 学术报告 Talks | 受邀报告、会议演讲时间线 | ✅ 已选 |
| 项目展示 | 研究/开源项目，GitHub 链接 | ✅ 已选 |
| 中英双语 i18n | next-intl 中英文切换 | ✅ 已选 |
| 明暗主题切换 | shadcn 原生支持 | ✅ 已选 |
| 博客站内搜索 | fuse.js 客户端全文搜索 | ✅ 已选 |
| 论文自动同步 | arXiv / Semantic Scholar API + 定时任务 | ✅ 已选 |
| 访问统计 | 自托管 Umami（Docker） | ✅ 已选 |

## 2. 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 框架 | **Next.js 15 (App Router, RSC)** + TypeScript (strict) | shadcn 第一支持、SSG/ISR 灵活、生态全 |
| UI | **Tailwind CSS v4 + shadcn/ui** | 组件源码内置于项目，可自由定制 |
| 样式底座 | shadcn 初始化时按提示选择（Base UI / React Aria / Radix） | 遵循 `npx shadcn@latest init` 官方流程 |
| 内容层 | **Velite**（MDX 博客 + YAML 数据 + Zod schema） | 类型安全的内容管道，构建期生成索引 |
| i18n | **next-intl** | App Router 官方推荐，类型安全的消息加载 |
| 搜索 | **fuse.js** | 构建期生成搜索索引，客户端模糊搜索 |
| 论文同步 | **GitHub Actions cron** + arXiv / Semantic Scholar API | 定时自动更新 YAML 数据 |
| 分析 | **Umami**（自托管，Docker） | 隐私友好、轻量，与站点同机部署 |
| 部署 | **VPS + Docker Compose + Caddy** | 站点容器 + Umami + Caddy 自动 HTTPS |

## 3. 目录结构

```
ysy-personal-homepage/
├── app/                          # App Router 路由
│   ├── [locale]/                 # i18n 路由段
│   │   ├── page.tsx              # 首页（聚合展示）
│   │   ├── publications/         # 出版物
│   │   ├── talks/                # 学术报告
│   │   ├── projects/             # 项目
│   │   ├── cv/                   # 简历
│   │   ├── blog/                 # 博客列表（搜索/标签）
│   │   ├── blog/[slug]/          # 博文详情（MDX 渲染）
│   │   └── nav/                  # 工具导航页
│   ├── layout.tsx
│   ├── sitemap.ts                # SEO
│   └── robots.ts
├── content/                      # 内容即代码（唯一数据源）
│   ├── posts/**/*.mdx            # 博客文章（按 locale 分目录）
│   ├── publications.yaml         # 论文数据
│   ├── talks.yaml                # 报告数据
│   ├── projects.yaml             # 项目数据
│   ├── nav-links.yaml            # 导航链接数据（分组）
│   └── profile.yaml              # 个人资料（教育/工作经历）
├── components/
│   ├── ui/                       # shadcn 组件（CLI 生成，勿手改）
│   ├── layout/                   # 导航栏、页脚、主题切换、语言切换
│   └── sections/                 # 业务组件（PublicationCard、TalkCard…）
├── lib/
│   ├── i18n/                     # next-intl 配置与路由
│   ├── data/                     # 内容读取 + Zod 校验 + 查询函数
│   ├── bibtex/                   # BibTeX 生成器
│   └── search/                   # 搜索索引构建
├── content.config.ts             # Velite schema（zod）
├── messages/                     # i18n 文案 JSON（zh/en）
├── public/                       # 头像、PDF 简历、OG 图
├── Dockerfile                    # standalone 模式容器化
├── docker-compose.yml            # 站点 + Umami + Caddy
└── .github/workflows/
    ├── ci.yml                    # lint + typecheck + build 门禁
    ├── deploy.yml                # 构建镜像 → 推送 GHCR → SSH 部署 VPS
    └── sync-papers.yml           # 每周定时同步论文 → PR 人工确认
```

## 4. 关键设计原则

### 4.1 内容与代码解耦（Content as Code）
- 论文、报告、项目、导航链接全部是 YAML 数据文件，博客是 MDX
- **Zod schema 校验**：内容结构错误在构建期直接报错，杜绝运行时崩溃
- 修改内容 = 改数据文件，零代码改动

### 4.2 板块即目录（模块化）
- 每个功能板块 = `app/[locale]/xxx/` + `components/sections/xxx/` + `content/xxx.yaml`
- 新增板块只需三步：建数据文件 → 写业务组件 → 加路由，可独立增删不影响其他板块

### 4.3 类型安全贯穿全栈
- TS strict + `content.config.ts` 自动生成内容类型
- i18n 消息文件类型化，缺失 key 编译报错
- 数据读取层（`lib/data`）集中封装，页面只消费类型化数据

### 4.4 自动化流水线

```
论文同步（每周 cron）              CI 门禁                   部署
arXiv API ──→ publications.yaml ──→ lint/typecheck/build ──→ docker build
Semantic Scholar API ──┘            （失败禁止合并）           → 推 GHCR
        ↑ 自动提交 PR，人工确认                              → SSH 到 VPS
                                                            → compose pull && up -d
                                                            → Caddy 自动 HTTPS
```

### 4.5 渲染策略
- 博客、出版物、导航页：**静态生成 (SSG)**，构建期渲染
- 全局布局共享，减少重复渲染
- 站点为纯静态输出，无数据库，VPS 资源占用极小

## 5. 部署拓扑（VPS）

```
                    ┌─────────────────────────────┐
 用户 ──HTTPS──▶ Caddy（自动证书）──▶ 站点容器 (next standalone)
                    │                              │
                    └───────── 反代 ──▶ Umami 容器（/umami 路径）
```

- `docker-compose.yml` 管理全部服务，`docker compose up -d` 一键启动
- 数据卷持久化 Umami 数据库
- GitHub Actions 推送镜像到 GHCR，服务器拉取更新，**回滚 = 拉取旧镜像**

## 6. 持续迭代路线

| 阶段 | 内容 |
|---|---|
| **M1 骨架** | 项目初始化、shadcn 配置、i18n/主题、布局与导航、部署流水线跑通 |
| **M2 核心** | 主页、出版物（BibTeX）、博客（列表+详情+搜索）、导航页 |
| **M3 扩展** | CV、Talks、Projects、论文自动同步、Umami 接入 |
| **M4 打磨** | SEO/OG 图、性能优化、内容补全、404 页 |

## 7. 预留的可扩展点（暂未选，可随时加入）

- 博客评论（giscus，零后端，改造成本低）
- RSS 订阅（Next 原生可生成）
- 新闻时间线、教学活动、团队页（按 4.2 板块模式新增）
- AI 学术问答（RAG，作为独立服务接入）
- 友情链接页

## 8. 约定

- 包管理器：pnpm（`packageManager` 字段锁定）
- 提交规范：Conventional Commits（feat/fix/docs/chore）
- 所有 shadcn CLI 操作使用 `npx shadcn@latest`，组件源码入仓、可改
- 依赖更新：每周 Dependabot 自动 PR，CI 门禁保障
