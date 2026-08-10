# CLAUDE.md

本项目（Yu Shaoyuan 个人学术主页）的 AI 编程助手开发规范与经验记录。

## 项目概览

- **定位**：个人学术网站（单作者）。含学术主页、论文、博客、学术导航、报告、项目、简历等模块，中英双语（zh 默认 / en）、明暗主题。
- **技术栈**：Next.js 15.5（App Router，`output: "standalone"`，SSG 为主）、TypeScript（strict）、Tailwind CSS v4、shadcn/ui（@base-ui/react 封装）、next-intl、velite（内容层）、fuse.js（搜索）、pnpm 10。
- **线上**：https://shaoyuanyu.cn（VPS 106.14.135.32，Docker Compose + Nginx 反代）。
- **仓库**：GitHub `shaoyuanyu/personal-homepage`，本地与远程默认分支均为 `main`。

## 工作流铁律：本地验收通过后才推送

**勿频繁推送触发 CI/CD。** 每次 push main 会触发 ci.yml + deploy.yml 两条流水线；deploy 重建镜像并在 VPS 拉取（GHCR 从国内拉取慢，单次部署约 15~30 分钟）。流程：

1. 本地完成全部验证（见下）；
2. 浏览器人工验收，经用户确认；
3. 确认后一次性提交并推送。

### 本地验证流程（推送前必经）

```bash
pnpm lint            # 0 error（允许既有 2 个 warning）
pnpm build           # 类型检查 + 构建（同步生成 velite 内容层）
pnpm test:e2e:local  # 构建 → 启动 standalone → 全量 Playwright（23 个用例）
```

- E2E 覆盖：页面可达性、301 跳转、SEO 资源、登录（TOTP 正确/错误码、限流）、管理员菜单登出、想法速记 CRUD、控制台无错误。
- **测试前清空 3000 端口**：`fuser -k 3000/tcp`。残留 standalone 进程会让测试跑在旧代码上；脚本结束后有时残留 node 子进程，重跑前先清理。
- 测试密钥：`e2e/smoke.spec.ts` 读取环境变量或本地 `.env` 的 `TOTP_SECRET`，未配置时登录相关用例自动跳过。

## 认证系统（管理员 TOTP 登录）

- **协议**：TOTP（RFC 6238，SHA1/6 位/30 秒），`otpauth` 库；恢复码 5 个一次性 16 位。
- **会话**：自研 HMAC-SHA256 签名无状态 Cookie（`owner_session`，30 天，HttpOnly + SameSite=Lax，生产自动 Secure）。
- **限流**：内存 Map，每 IP 5 次失败锁 15 分钟（单实例够用）。
- **密钥**：`.env`（gitignored）：`TOTP_SECRET`、`AUTH_SECRET`、`RECOVERY_CODES`。重新生成：`pnpm totp:setup [--force]`（**--force 使手机端验证器绑定失效，需重新扫码**）。
- **代码分层**：`lib/auth/`（totp / session / owner / rate-limit / recovery）。
  - 页面守卫：`requireOwner()`（未登录 redirect /login）；API 守卫：`isOwner()` 返回 401（**API 勿用 requireOwner，会得到 redirect 语义**）。
  - 登录态查询：`GET /api/auth/me` → `{owner: bool}`。
- **UI 命名**（勿改回）：登录页「管理登录 / Admin Login」；导航「我的 / Me」菜单（仅权限类操作：退出登录，预留网站管理/权限管理等）。
- **功能入口分级**：高频重要功能在顶部栏单列入口（如「速记」）；低频功能放「更多工具」下拉菜单（有需要时再建）。**新增专属功能时先与用户确认入口位置**。
- **游客隔离**：所有专属功能对游客不可见（无入口），且路由层用 `requireOwner()` 守卫（无法直接通过 URL 访问）。
- **导航登录态刷新**：`OwnerNavItem` 监听 `owner-auth-changed` 自定义事件（登录/登出后广播）。登出时 pathname 不变，仅靠路由变化刷新会失效。新增管理员 UI 时沿用。

## 想法速记（管理员专属）

- **路由**：`/admin/ideas`（`requireOwner` 守卫）；API：`GET/POST /api/ideas`、`PATCH/DELETE /api/ideas/[id]`（游客一律 401）。
- **存储**：单文件 JSON `data/ideas.json`（`lib/ideas/store.ts`），原子写入（tmp + rename），零依赖。容器内 `/app/data` 由 compose 绑定挂载到 VPS 宿主机 `~/personal-homepage/data/`。
- **备份**：VPS crontab 每 6 小时（`0 */6 * * *`）执行 `~/backup-ideas.sh`（仓库 `scripts/backup-ideas.sh`），把 `data/ideas.json` 推送到 private 仓库 `shaoyuanyu/ideas-backup`。认证用 deploy key `~/.ssh/ideas_backup` + SSH 别名 `github.com-backup`（仅该仓库写权限）；日志 `~/backup-ideas.log`。**改动脚本后需重新 scp 同步 VPS**：`scp -i ~/.ssh/vps-deploy scripts/backup-ideas.sh ysy@106.14.135.32:~/backup-ideas.sh`。恢复：clone 该 repo 后 `cp ideas.json ~/personal-homepage/data/ideas.json`。
- **注意**：本地 standalone 数据在 `.next/standalone/data/`（cwd 为 standalone 目录），dev 模式在项目根 `data/`，均被 gitignore。
- 后续管理员专属功能沿用 `/admin/*` + `requireOwner()`。

## 部署（GitHub Actions → GHCR → VPS）

### 流水线

| 工作流 | 触发 | 内容 |
|---|---|---|
| `ci.yml` | push/PR 到 main | lint、typecheck、构建、本地 standalone 冒烟 |
| `deploy.yml` | push 到 main | 构建推 GHCR → SSH 到 VPS pull + `docker compose up -d --no-deps web` → 对生产跑冒烟 |
| `sync-papers.yml` | 定时 | 每周同步 arXiv 论文 |

### 关键经验

1. **改 `docker-compose.yml` 必须手动同步 VPS**：流水线只拉镜像，不同步 compose 文件。`scp -i ~/.ssh/vps-deploy docker-compose.yml ysy@106.14.135.32:~/personal-homepage/` 后由流水线（或手动 `docker compose up -d web`）重建容器。漏同步会导致容器缺环境变量/挂载（曾致登录 401、数据无法落盘）。
2. **GHCR 从 VPS 拉取慢/易卡死**：流水线已内置 3 次 × 10 分钟超时重试。**勿手动并行 pull 与流水线竞争**；需手动接管时，等流水线失败后再操作。
3. **数据目录权限**：容器以 uid 1001（nextjs）运行；docker 创建的绑定挂载目录属主为 root，需修正：`docker run --rm -v $HOME/personal-homepage/data:/data alpine chown -R 1001:1001 /data`。
4. **推送命令**：本机 SSH config 可能使 GitHub 认证走错密钥，需强制指定：`GIT_SSH_COMMAND="ssh -F /dev/null -i ~/.ssh/id_rsa" git push origin main`（`-F /dev/null` 忽略 SSH config，`-i` 指定 GitHub 部署密钥）。
5. **VPS sudo 需密码**（agent 无法执行）；docker 命令无需 sudo（ysy 在 docker 组）。
6. **VPS 只读检查**：`ssh -i ~/.ssh/vps-deploy ysy@106.14.135.32 "..."`；compose 目录 `~/personal-homepage/`。
7. **生产验证**：`curl -s -o /dev/null -w "%{http_code}" https://shaoyuanyu.cn/xxx`、`curl -s https://shaoyuanyu.cn/api/auth/me`；登录后创建/删除 idea 验证落盘（测试后清理）。

## 开发规范

- **内容即代码**：`content/` 下 YAML/MDX 由 velite 编译，结构错误构建期即报错。新增博客 = 新建 MDX；改论文/报告/导航 = 改 YAML。
- **i18n**：`messages/zh.json` 与 `messages/en.json` 同步修改（先 zh 后 en）；文案一律走 `useTranslations`/`getTranslations`，不硬编码。metadata title 常用英文正式名（如 "Admin Login"、"Idea Scratchpad"）。
- **UI**：优先使用 `components/ui/` 下的 shadcn 封装（Button、Card、Input、DropdownMenu、ToggleGroup 等）；lucide-react 图标传 `data-icon="default"`（与既有组件一致）。
- **客户端组件**（`"use client"`）放 `components/`；服务端页面守卫在 page.tsx 中。
- **SSG**：`cookies()` 使页面动态渲染（如 /login、/admin/*），属预期；其余页面保持静态。
- **Lint**：`eslint-plugin-react-hooks` 缺失为既有 warning（非阻塞），勿改 package.json；保持 0 error。

## 常见问题

- 本地 `localhost:3000` 反复 EADDRINUSE：残留 next-server 进程，`fuser -k 3000/tcp` 后再起。
- Base UI `ToggleGroup` 的 `value` 恒为数组（单选也传 `[value]`），onValueChange 取 `v[0]`。
- VS Code 集成浏览器对部分元素点击会因稳定性检查超时（如 DropdownMenu trigger）：用 Playwright `evaluate(el => el.click())` 或直接跑 E2E 验证，勿误判为代码问题。
- standalone 构建会把 `.env` 复制到 `.next/standalone/.env` 并被 server.js 加载（本地 standalone 读取密钥的原因）；VPS 密钥来自 compose 的 environment 注入。
- 登录/登出 E2E 会真实写入会话与想法数据，用例内自清理；跑完可检查 `data/ideas.json` 应为 `[]`。

## 常用命令速查

```bash
pnpm dev                 # 开发模式（turbopack）
pnpm build && pnpm start # 生产构建 + standalone 运行
pnpm lint                # ESLint
pnpm test:e2e:local      # 本地全量冒烟（构建+启动+Playwright）
E2E_BASE_URL=https://shaoyuanyu.cn pnpm exec playwright test  # 对生产跑冒烟
pnpm totp:setup          # 生成/重生成 TOTP 密钥与恢复码
pnpm fetch:publications  # 同步 Semantic Scholar 论文
pnpm fetch:ccf-dblp      # 同步 CCF 目录（DBLP）
```
