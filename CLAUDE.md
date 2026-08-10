# CLAUDE.md

本文件为 GitHub Copilot / Claude 等 AI 编程助手提供本项目（Yu Shaoyuan 个人学术主页）的开发规范、经验与注意事项。

## 项目概览

- **定位**：个人学术网站（单作者）。包含学术主页、论文、博客、学术导航、报告、项目、简历等模块，支持中英双语（zh 默认 / en）、明暗主题。
- **技术栈**：Next.js 15.5（App Router，`output: "standalone"`，SSG 为主）、TypeScript（strict）、Tailwind CSS v4、shadcn/ui（基于 @base-ui/react 的封装）、next-intl、velite（内容层）、fuse.js（搜索）、pnpm 10。
- **线上地址**：https://shaoyuanyu.cn（VPS 106.14.135.32，Docker Compose + Nginx 反向代理）。
- **仓库**：GitHub `shaoyuanyu/personal-homepage`。本地与远程默认分支均为 `main`（已确认 `git ls-remote --symref origin HEAD` → `refs/heads/main`）。

## ⚠️ 工作流铁律：本地验收通过后才推送

**不要为了触发 CI/CD 而频繁推送。** 每次推送 main 都会触发两条流水线（ci.yml + deploy.yml），deploy 会重建镜像并在 VPS 拉取（GHCR 从国内拉取很慢，单次部署可能耗时 15~30 分钟）。正确节奏：

1. 本地完成全部验证（见下）；
2. 在浏览器里人工验收，**请用户确认**；
3. 用户确认后，一次性提交并推送。

### 本地验证流程（推送前的必经步骤）

```bash
pnpm lint          # 0 error（允许既有 2 个 warning）
pnpm build         # 类型检查 + 构建（构建会同步生成 velite 内容层）
pnpm test:e2e:local  # 一键：构建 → 启动 standalone → 跑全部 Playwright 用例（23 个）
```

- E2E 断言覆盖：页面可达性、301 跳转、SEO 资源、登录（TOTP 正确码/错误码/限流）、管理员菜单登出、想法速记 CRUD、控制台无错误。
- **测试前确保 3000 端口干净**：`fuser -k 3000/tcp`（残留的 standalone 服务器会让测试跑在旧代码上，产生诡异失败；E2E 脚本结束后有时会残留 node 子进程，重跑前先清理）。
- 测试密钥：`e2e/smoke.spec.ts` 从环境变量或本地 `.env` 读取 `TOTP_SECRET`，未配置时登录相关用例自动跳过。

## 认证系统（管理员 TOTP 登录）

- **协议**：TOTP（RFC 6238，SHA1/6 位/30 秒），`otpauth` 库；恢复码 5 个一次性 16 位。
- **会话**：自研 HMAC-SHA256 签名无状态 Cookie（`owner_session`，30 天，HttpOnly + SameSite=Lax，生产自动 Secure）。
- **限流**：内存 Map，每 IP 5 次失败锁 15 分钟（单实例够用）。
- **密钥**：`.env`（gitignored）：`TOTP_SECRET`、`AUTH_SECRET`、`RECOVERY_CODES`。重新生成：`pnpm totp:setup [--force]`（输出二维码 + 恢复码；**--force 会使手机端验证器绑定失效，必须重新扫码**）。
- **代码分层**：`lib/auth/`（totp / session / owner / rate-limit / recovery）。
  - 服务端页面守卫：`requireOwner()`（未登录 redirect /login）；API 守卫：`isOwner()` 检查后返回 401（**API 不要用 requireOwner，会得到 redirect 语义**）。
  - 登录态查询接口 `GET /api/auth/me` → `{owner: bool}`。
- **UI 命名体系**（已统一，勿改回）：登录页「管理登录 / Admin Login」→ 登录后导航显示「管理员 / Admin」菜单（速记 / 退出登录）。内部函数仍叫 `isOwner()/requireOwner()`，保持不动。
- **导航登录态刷新**：`OwnerNavItem` 监听 `owner-auth-changed` 自定义事件（登录/登出后广播）——登出时 pathname 不变，仅靠路由变化刷新会失效。新增加密相关 UI 时沿用此机制。

## 想法速记（管理员专属功能）

- **路由**：`/admin/ideas`（`requireOwner` 守卫）；API：`GET/POST /api/ideas`、`PATCH/DELETE /api/ideas/[id]`（游客一律 401）。
- **存储**：单文件 JSON `data/ideas.json`（`lib/ideas/store.ts`），原子写入（tmp + rename），零依赖。容器内 `/app/data` 由 compose 绑定挂载到 VPS 宿主机 `~/personal-homepage/data/`。
- **注意**：本地 standalone 运行时数据在 `.next/standalone/data/`（cwd 是 standalone 目录），dev 模式在项目根 `data/`，两者均被 gitignore。
- 后续主人专属功能沿用 `/admin/*` 前缀 + `requireOwner()`。

## 部署（GitHub Actions → GHCR → VPS）

### 流水线

| 工作流 | 触发 | 内容 |
|---|---|---|
| `ci.yml` | push/PR 到 main | lint、typecheck、构建、本地 standalone 冒烟 |
| `deploy.yml` | push 到 main | 构建推 GHCR → SSH 到 VPS pull + `docker compose up -d --no-deps web` → 对生产跑冒烟 |
| `sync-papers.yml` | 定时 | 每周同步 arXiv 论文 |

### 关键经验（血泪）

1. **改 `docker-compose.yml` 必须手动同步 VPS**：部署流水线只拉镜像，**不**同步 compose 文件。`scp -i ~/.ssh/vps-deploy docker-compose.yml ysy@106.14.135.32:~/personal-homepage/` 后再由流水线（或手动 `docker compose up -d web`）重建容器。漏同步会导致容器缺环境变量/挂载（曾致登录 401、数据无法落盘）。
2. **GHCR 从 VPS 拉取很慢/易卡死**：流水线已内置 3 次 × 10 分钟超时重试。**不要手动在 VPS 上并行 pull 与流水线竞争**；实在要手动接管时，等流水线失败后再操作。
3. **数据目录权限**：容器以 uid 1001（nextjs）运行，绑定挂载目录若由 docker 创建属主是 root，需修正：`docker run --rm -v $HOME/personal-homepage/data:/data alpine chown -R 1001:1001 /data`。
4. **推送命令**：本机 SSH config 可能导致 GitHub 认证走错密钥，需强制指定：`GIT_SSH_COMMAND="ssh -F /dev/null -i ~/.ssh/id_rsa" git push origin main`（`-F /dev/null` 忽略 SSH config，`-i` 指定 GitHub 部署密钥）。
5. **VPS 上 sudo 需要密码**（agent 无法执行）；docker 命令无需 sudo（ysy 在 docker 组）。
6. **只读检查 VPS**：`ssh -i ~/.ssh/vps-deploy ysy@106.14.135.32 "..."`；compose 目录 `~/personal-homepage/`。
7. 生产验证常用命令：`curl -s -o /dev/null -w "%{http_code}" https://shaoyuanyu.cn/xxx`、`curl -s https://shaoyuanyu.cn/api/auth/me`、登录后创建/删除 idea 验证落盘（记得清理测试数据）。

## 开发规范

- **内容即代码**：`content/` 下 YAML/MDX 由 velite 编译，结构错误构建期即报错。新增博客 = 新建 MDX；改论文/报告/导航 = 改 YAML。
- **i18n**：`messages/zh.json` 与 `messages/en.json` 必须同步新增/修改（先 zh 后 en）；页面文案一律走 `useTranslations`/`getTranslations`，不硬编码。metadata title 常用英文正式名（如 "Admin Login"、"Idea Scratchpad"）。
- **UI**：优先使用 `components/ui/` 下的 shadcn 封装（Button、Card、Input、DropdownMenu、ToggleGroup 等）；图标用 lucide-react 且传 `data-icon="default"`（与既有组件一致）。
- **客户端组件**（`"use client"`）放 `components/`，服务端页面守卫在 page.tsx 里做。
- **SSG 注意**：`cookies()` 会让页面动态渲染（如 /login、/admin/*），属预期；其余页面保持静态。
- **Lint**：`eslint-plugin-react-hooks` 缺失是既有 warning（非阻塞），不要顺手改 package.json 惹出依赖变动；lint 保持 0 error 即可。

## 踩坑速查

- 本地 `localhost:3000` 反复 EADDRINUSE → 有残留 next-server 进程，`fuser -k 3000/tcp` 后再起。
- Base UI `ToggleGroup` 的 `value` 恒为数组（单选也传 `[value]`），onValueChange 取 `v[0]`。
- VS Code 集成浏览器对部分元素点击会因"稳定性检查"超时（如 DropdownMenu trigger），此时用 Playwright 代码 `evaluate(el => el.click())` 或直接跑 E2E 验证，不要误判为代码 bug。
- Next.js standalone 构建会把 `.env` 复制到 `.next/standalone/.env` 并被 server.js 加载——本地 standalone 能读到密钥的原因；不要依赖它理解 VPS（VPS 密钥来自 compose 的 environment 注入）。
- 登录/登出相关 E2E 会真实写入会话与想法数据，用例内自清理；跑完可检查 `data/ideas.json` 应为 `[]`。

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
