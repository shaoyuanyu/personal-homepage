# Yu Shaoyuan · 个人学术网站

基于 **Next.js 15 + TypeScript + Tailwind CSS v4 + shadcn/ui** 的个人学术网站，
包含学术主页、论文列表、博客、学术导航、简历等功能模块，支持中英双语与暗色模式。

## ✨ 功能

| 模块 | 说明 |
|---|---|
| 🏠 学术主页 | 个人简介、研究方向、最新论文/博客、教育经历、联系方式 |
| 📄 论文 | 按年份分组、类型过滤、**BibTeX 一键复制**、DOI/PDF/arXiv/Code 链接 |
| 📝 博客 | MDX 写作、标签过滤、fuse.js 全文搜索 |
| 🧭 学术导航 | 常用网站/工具分组 + 即时搜索（数据驱动，易维护） |
| 🎤 学术报告 | 报告时间线（Talks） |
| 🚀 项目 | 研究/开源项目展示 |
| 📋 简历 | 结构化在线 CV + PDF 下载 |
| 🌐 i18n | 中英双语（next-intl），一键切换 |
| 🌙 主题 | 明暗主题切换 |
| 📡 论文自动同步 | ~~GitHub Actions 每周从 arXiv 拉取新论文并提交 PR~~（已下线：改为手工维护 `content/publications.yaml`） |

## 🛠 技术栈

- **框架**: Next.js 15 (App Router, SSG) · TypeScript (strict)
- **样式**: Tailwind CSS v4 · shadcn/ui (Base UI)
- **内容层**: Velite（MDX + YAML，Zod 类型安全校验）
- **i18n**: next-intl
- **搜索**: fuse.js
- **部署**: Docker · docker-compose · Caddy (HTTPS) · GitHub Actions

## 🚀 快速开始

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm build        # 生产构建
pnpm start        # 生产运行
```

## 📝 内容管理（内容即代码）

所有内容位于 `content/` 目录，修改后保存即生效（dev 模式自动刷新）：

| 文件 | 内容 | 校验 schema |
|---|---|---|
| `content/profile.yaml` | 姓名、简介、社交链接、教育经历 | `velite.config.ts` |
| `content/publications.yaml` | 论文列表（含 BibTeX 字段） | 同上 |
| `content/talks.yaml` | 学术报告 | 同上 |
| `content/projects.yaml` | 项目 | 同上 |
| `content/nav-links.yaml` | 导航分组与链接 | 同上 |
| `content/posts/{zh,en}/*.mdx` | 博客文章（按语言分目录，见下） | 同上 |

> 新增论文/报告/项目/导航链接 = 编辑对应 YAML；新增博客 = 新建 MDX 文件。
> 结构错误会在构建期由 Zod 直接报错，无需担心运行时崩溃。

### 博客文章的语言与翻译

`slug` 是**文章标识**，不是语言版本标识：

- 同一 slug 同时出现在 `posts/zh/` 与 `posts/en/` 下 = 同一篇文章的两个语言版本；
- slug 只需**在同一语言内唯一**（重名会在构建期抛出可定位的错误）；
- `/blog` 与 `/en/blog` 列出**同一批文章**：某篇文章缺当前语言的版本时，
  回退显示原文（默认语言 zh），详情页顶部会给出「暂无该语言译文」的提示；
- 因此 `/blog/<slug>` 与 `/en/blog/<slug>` 总是成对存在，语言切换不会 404；
  页面的 `canonical` 指向正文实际语言的 URL，避免同一内容被重复收录。

例：`posts/zh/welcome.mdx`（slug `welcome`）+ `posts/en/welcome.mdx`（slug `welcome`）
= 一篇双语文章；只建其中一侧则该文章在两种语言下都可见，另一侧显示原文。

## 📦 部署（VPS + Docker + Nginx）

1. 准备密钥文件（`.env` 不入库）：
   ```bash
   cp .env.example .env
   # 编辑 .env，填入随机密钥（可用 openssl rand -hex 32 / -hex 16 生成）
   ```
2. 反向代理：宿主机 Nginx 按域名分流到容器端口（仅绑定回环，不直接暴露公网）：
   ```nginx
   # /etc/nginx/sites-enabled/shaoyuanyu.cn.conf
   server {
       listen 80;
       server_name shaoyuanyu.cn;

       location /_next/static/ {
           proxy_pass http://127.0.0.1:3000;
           proxy_set_header Host $host;
           expires 1y;
           add_header Cache-Control "public, immutable";
       }
       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```
   （umami 统计面板经 Nginx 分流到 127.0.0.1:3001（域名 status.shaoyuanyu.cn）；HTTPS 就绪后用 certbot 签发证书并将 SITE_URL 改为 https）
3. 服务器上执行：
   ```bash
   git clone <repo> && cd personal-homepage
   cp .env.example .env   # 填入与本地一致的密钥
   docker compose up -d --build
   ```
4. 配置 GitHub Actions secrets 实现自动部署：
   - `VPS_HOST` / `VPS_USER` / `VPS_SSH_KEY`

推送 `main` 分支 → CI 门禁（lint + typecheck + build）→ 自动构建镜像并部署。

### 镜像仓库可切换（GHCR ↔ 境内仓库）

VPS 在境内，拉 GHCR 的 blob CDN（`pkg-containers.githubusercontent.com`）会**卡死**：
实测 `Deploy to VPS` 这一步耗时 **0.2 min（镜像没变）～ 20.6 min（镜像变了）**、
中位约 7.7 min，并造成过两次 17~23 分钟的部署失败（撞满 `timeout 600` × 重试）。
而镜像本体并不大（web 84.7 MB / webmail 106.4 MB，压缩层），**瓶颈是链路而非带宽**。

流水线**默认仍走 GHCR**；切到境内仓库只改仓库配置，**不用改代码**：

1. 在阿里云容器镜像服务 ACR 建**个人版实例** + **命名空间**（如 `ysy`），并创建两个
   仓库：`personal-homepage` 与 `personal-homepage-webmail`（**webmail 仓库名 =
   `<主仓库名>-webmail`**，脚本按此规则推导）。仓库公开/私有均可——私有时部署脚本
   会用下面同一套凭据在 VPS 上登录后拉取（推荐私有）。
2. 仓库 `Settings → Secrets and variables → Actions`：

   | 类型 | 名称 | 值 |
   |---|---|---|
   | Variable | `REGISTRY` | `registry.cn-hangzhou.aliyuncs.com`（以 ACR 控制台的「公网地址」为准，也可能形如 `<实例>.cn-hangzhou.cr.aliyuncs.com`） |
   | Variable | `IMAGE_NAMESPACE` | 你的 ACR 命名空间，如 `ysy` |
   | Secret | `REGISTRY_USERNAME` | ACR 用户名（**推送必填**） |
   | Secret | `REGISTRY_PASSWORD` | ACR 固定密码（**推送必填**；也是 VPS 侧拉取的登录凭据，每次部署自动登录） |

3. 重跑一次 Deploy（push 或 `workflow_dispatch`）。日志会打印当前生效地址
   `镜像仓库：<REGISTRY>/<IMAGE_NAMESPACE>（personal-homepage + personal-homepage-webmail）`，
   `Deploy to VPS` 应从分钟级降到秒级。

**切回 GHCR**：删掉这两个 Variable 即可（自动回退 `ghcr.io` + `GITHUB_TOKEN`）。

⚠ 部署脚本用 compose **override 文件**传入镜像地址，因此**不需要**同步 VPS 上的
`docker-compose.yml` 也不会错配（VPS 那份副本可能滞后于 `main`）。但 VPS 那份仍必须
**定义过** `web` / `webmail` 两个服务——缺少时部署会明确报错要求先同步，而不是起一个
空壳容器。手动在 VPS 上 `docker compose up` 时，可用 `WEB_IMAGE` / `WEBMAIL_IMAGE`
覆盖 `docker-compose.yml` 里的默认地址。

## 🎨 品牌资产

- `app/icon.svg` — 站点图标（Y-Fork 标记：姓氏首字母 Y + 持续学习的知识分叉），自动作为 favicon，并按明暗主题自适应
- `app/[locale]/opengraph-image.tsx` — OG 社交分享图（1200×630，按语言本地化），分享链接到微信/推特等平台时展示
- `public/images/avatar.gif` — 个人头像（动画 GIF），引用自 `content/profile.yaml` 的 `avatar` 字段

## 🗂 目录结构

```
app/                  # App Router 路由（[locale]/ 下为各页面）
components/
  ui/                 # shadcn 组件（CLI 生成）
  layout/             # 导航栏、页脚、主题/语言切换
  sections/           # 业务组件
content/              # 内容数据（唯一数据源）
lib/
  data/               # 类型安全的数据访问层
  i18n/               # next-intl 配置
  bibtex.ts           # BibTeX 生成器
messages/             # i18n 文案（zh/en）
scripts/              # 数据同步与运维脚本（CCF 目录 / deadline / 分区表 / 字体子集 / 本地验收）
.velite/              # Velite 构建输出（git 忽略）
```
