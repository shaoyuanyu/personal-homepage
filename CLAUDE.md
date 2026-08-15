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

- E2E 覆盖：页面可达性、301 跳转、SEO 资源、登录（TOTP 正确/错误码、限流）、管理员菜单登出、Idea 速记 CRUD、控制台无错误。
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
- **「导航」按钮位置（勿改回）**：「导航」不在 `site-header.tsx` 的 `navItems` 数组中，由 `OwnerNavItem` 统一渲染——保证其始终紧跟最右侧入口（我的/登录）左侧（从右往左第二个），无论是否登录。已登录顺序：`首页 论文 报告 项目 博客 速记 日历 导航 我的`；游客：`… 博客 导航 登录`。

## Idea 速记（管理员专属）

- **路由**：`/ideas`（`requireOwner` 守卫）；API：`GET/POST /api/ideas`、`PATCH/DELETE /api/ideas/[id]`（游客一律 401）。
- **存储**：单文件 JSON `data/ideas.json`（`lib/ideas/store.ts`），原子写入（tmp + rename），零依赖。容器内 `/app/data` 由 compose 绑定挂载到 VPS 宿主机 `~/personal-homepage/data/`。
- **备份**：VPS crontab 每 6 小时（`0 */6 * * *`）执行 `~/backup-ideas.sh`（仓库 `scripts/backup-ideas.sh`），把 `data/ideas.json` 推送到 private 仓库 `shaoyuanyu/ideas-backup`。认证用 deploy key `~/.ssh/ideas_backup` + SSH 别名 `github.com-backup`（仅该仓库写权限）；日志 `~/backup-ideas.log`。**改动脚本后需重新 scp 同步 VPS**：`scp -i ~/.ssh/vps-deploy scripts/backup-ideas.sh ysy@106.14.135.32:~/backup-ideas.sh`。恢复：clone 该 repo 后 `cp ideas.json ~/personal-homepage/data/ideas.json`。
- **注意**：本地 standalone 数据在 `.next/standalone/data/`（cwd 为 standalone 目录），dev 模式在项目根 `data/`，均被 gitignore。
- 后续管理员专属功能沿用**顶级路径**（如 `/ideas`、`/settings`）+ `requireOwner()`，不用 `/admin/*` 前缀（单作者站无多管理员语义）。

## 主人偏好持久化（登录用户跨设备同步）

- **场景**：登录后偏好/状态在服务器端持久化（跨设备），游客回退 localStorage，登录后自动迁移。
- **存储**：单文件 JSON `data/preferences.json`（`lib/preferences/store.ts`，与 ideas.json 同款原子写入）。
- **API**：`GET/PATCH /api/preferences`（owner 专属，游客 401；PATCH body `{key: value|null}`，null 删除；未知 key / 非法值 → 400）。
- **注册表**：`lib/preferences/registry.ts` 集中注册 key + sanitize 校验（只做结构校验，非法返回 null）。**新增偏好功能必须在此注册**；key 同时作为游客 localStorage 键名。
- **客户端 hook**：`lib/preferences/use-owner-preferences.ts` 的 `useOwnerPreferences()` → `{ ready, isOwner, prefs, setPref }`。owner 防抖 500ms PATCH 服务器；游客写 localStorage；UI 恢复状态前先等 `ready`（避免默认值覆盖已存偏好）。
- **已接入**：CCF 目录页筛选（key `ccf:filters`，登录时把游客期 localStorage 数据迁移上传一次）。
- **备份**：**无需备份**（低价值数据，丢失后重新设置即可）；`backup-ideas.sh` 只备份 ideas.json。
- **限制**：单用户低并发；会话内不轮询，跨设备需刷新页面感知。

## 会议 Deadline 日历（公开功能）

- **路由**：`/deadlines`（公开页面，`force-dynamic` 动态渲染）；入口：学术导航页「会议 Deadline 日历」链接（未加入顶部导航）。
- **数据流**：`scripts/fetch-deadlines.mjs`（零依赖行级 YAML 解析）每 12 小时从 ccfddl/ccf-deadlines 的 `allconf.yml` 拉取 → 归一化时区 → 只保留当年+次年 → 写入 `lib/data/deadlines.json`（提交入库）。同步命令：`pnpm fetch:deadlines`；工作流 `sync-deadlines.yml`（每 12 小时，有变化提交 PR）。
- **手动立即同步（主人专属）**：`/deadlines` 页面登录后显示「立即同步」按钮 → `POST /api/deadlines/sync`（`isOwner` 守卫，60 秒限流）拉取最新数据并合并覆盖层 → 原子写入运行时文件 `data/deadlines.json`（`DATA_DIR` 或 cwd/data，VPS 上即 compose 挂载的 `./data`，持久化）。页面动态渲染优先读该文件（缺失/损坏回退构建时数据），刷新即生效，无需等待部署。同步按钮 UI 在 `deadlines-list.tsx`（`useOwnerPreferences().isOwner` 控制显示）。
- **覆盖层**：`content/deadlines-overrides.yaml`（velite 校验）按缩写整体替换/新增会议（非 CCF 会议、修正错误数据用；字段 l/f/d 缺省时沿用自动数据）。合并逻辑 `mergeDeadlines()` 在 `lib/data/index.ts`，构建时与手动同步共用（保证规则一致）。
- **时区约定**：fetch 时归一化为 IANA 名（AoE→`Etc/GMT+12`、PT/PST→`America/Los_Angeles`、UTC±X→`Etc/GMT∓X` 注意符号反转）；UI 用 `Intl.DateTimeFormat(timeZone)` 转访客本地时间，零依赖。
- **UI**：`components/deadlines/deadlines-list.tsx`——等级 A/B/C/未收录 + 时间范围（30/90 天）+ 领域多选筛选、倒计时、详情 Dialog、Google 日历 / .ics 导出。领域词表与 CCF 目录一致（官方中文名，短键取 `/` 前段）。
- **注意**：allconf.yml 缩进风格不统一（数组项可与父键同级），解析器按内容模式驱动而非绝对缩进；若解析结果为空会直接报错退出（防提交空数据）。数据源（ccfddl.com）偶发连接超时，脚本内置 3 次重试；可用 `DEADLINES_URL` 环境变量覆盖源地址（CLI 另支持 `--url`）。

## 部署（GitHub Actions → GHCR → VPS）

### 流水线

| 工作流 | 触发 | 内容 |
|---|---|---|
| `ci.yml` | push/PR 到 main | lint、typecheck、构建、本地 standalone 冒烟 |
| `deploy.yml` | push 到 main | 构建推 GHCR → SSH 到 VPS pull + `docker compose up -d --no-deps web` → 对生产跑冒烟 |
| `sync-papers.yml` | 定时 | 每周同步 arXiv 论文 |
| `sync-deadlines.yml` | 定时 | 每 12 小时同步 CCF 会议 deadline（ccfddl） |

- **⚠ 同步工作流必须显式声明 `permissions: {contents: write, pull-requests: write}`**：仓库创建于 2023-02-02 之后，`GITHUB_TOKEN` 默认只读，`peter-evans/create-pull-request` 推分支/建 PR 会 403（`Resource not accessible by integration`），工作流每次运行必失败且不留任何痕迹（无分支、无 PR）。排查时看 Actions 日志最后一步是否报该错；若加了 permissions 仍失败，再检查仓库 Settings → Actions → General → Workflow permissions 是否被设为只读。
- **⚠ 勿给 create-pull-request 配不存在的 label**：`labels` 输入若引用仓库中不存在的 label，`issues.addLabels` 会 404/422 使步骤失败（v6 无 catch 直接抛错）。仓库没建 `automation` label，故两个 sync 工作流都不用 `labels`；要打标签先手动建好 label。同步工作流统一用 `create-pull-request@v8`。
- **⚠ deadline 同步 PR 自动合并**：`sync-deadlines.yml` 在 create-pull-request（`id: cpr`）后加两步——(1) `Enable auto-merge`（`id: am`，`continue-on-error: true`）：配置了 `AUTOMERGE_TOKEN` secret（PAT，需 `contents: R/W` + `pull-requests: R/W`）时用 `gh pr merge --auto --squash --delete-branch`（原生 automerge，`if` 含 `secrets.AUTOMERGE_TOKEN != ''` 判断）；(2) `Auto-merge sync PR (fallback)`：PAT 未配置**或启用 automerge 失败**（`secrets.AUTOMERGE_TOKEN == '' || steps.am.outcome == 'failure'`）时降级为 `gh pr merge --squash --delete-branch`（`GH_TOKEN: ${{ github.token }}`，`pull-requests: write` 即可）立即合并。**GITHUB_TOKEN 无法「启用 automerge」**（GitHub 限制，需 PAT），但可直接合并 PR。**GITHUB_TOKEN 的合并 push 不触发 ci/deploy**（防循环），故合并后线上构建时数据不更新——线上 deadline 数据靠「立即同步」按钮（运行时 `data/deadlines.json`）或下次常规部署承载，属预期。若运行仍失败：可能是脚本网络偶发（fetch 已加 30s 超时，3 次重试）或 PAT 无效/权限不足（看 `Enable auto-merge` 步骤报错）。

### CalDAV 会议日历（站主专属）

- **用途**：站主个人日历客户端（Apple 日历/Outlook 等）通过 CalDAV 接入，私有会议安排不入公网。
- **架构**：`docker-compose.yml` 的 `radicale` 服务（官方镜像 `kozea/radicale`，`command: --config /data/config`）仅绑定回环 `127.0.0.1:5232`；Nginx 反代 `calendar.shaoyuanyu.cn`（HTTPS，**全量反代无前缀改写**）。**不是公开服务**——用户要求仅站主可访问。
- **路径模型**：Radicale **URL 即存储路径**（`collections/collection-root/<用户名>/<集合名>/`），无虚拟路径概念；路径第一段必须是对应用户名（`owner_only` 权限按此判定归属），集合名任意（本站统一 `conference-ddl`）。客户端填根路径 `https://calendar.shaoyuanyu.cn/` 自动发现即可，无需任何 URL 前缀。
- **认证**：Radicale `htpasswd`（sha256 加密）+ 认证延迟 1s 防爆破；`owner_only` 权限（各账号仅能访问自己的集合）。用户文件 `radicale/users`（gitignored，VPS 生成）。
- **初始化**：VPS 上执行 `bash scripts/setup-calendar-vps.sh`（生成随机强密码 + htpasswd + 启动容器 + 自动 MKCOL 建集合并设置 displayname + 输出 Nginx/certbot 指引）。客户端服务器地址：`https://calendar.shaoyuanyu.cn/`（根路径，自动发现；另配 `/.well-known/caldav` 301 → 根）。
- **关键经验**：
  - 镜像选择 `kozea/radicale`（`tomasz1986/radicale` 在 Docker Hub 已不存在）。
  - MKCOL 创建集合需标准 CalDAV XML（`resourcetype` 含 `calendar`），空 body 会 400。
  - **客户端显示的日历名 = Radicale 集合的 `displayname`**，未设置时回退为内部路径（如 `ysy/conference-ddl`）；显式 `PROPPATCH` displayname（setup 脚本已自动执行；改后客户端需重新同步——下拉刷新或关闭重开账户）。
  - **VPS Nginx < 1.25.1 不支持 `http2 on;` 指令**，443 必须写 `listen 443 ssl http2;`，否则 `nginx -t` 失败、整份配置不生效（曾致手机客户端「无法连接至服务器」）；根路径 `location /` 直通 Radicale 供 principal 自动发现。
  - **集合路径改动需三处同步**：Radicale 存储目录（停容器后 `mv collections/collection-root/<用户>/<旧名> <新名>`，displayname 随目录迁移）、网站代码 `lib/caldav/store.ts` 的 `CALDAV_COLLECTION_NAME` 常量、客户端重新添加账户（客户端存的是发现后的真实路径）。
  - 本地 `docker compose config` 会因 `.env` 中 `RECOVERY_CODES` 含逗号解析失败，校验语法用 `docker compose --env-file /dev/null config`。
  - 本地测试认证流程：`openssl passwd -5` 生成 htpasswd，curl 验证 401/201/403。
  - Radicale 3.4+ 存储结构带 `collection-root` 前缀（`collections/collection-root/<user>/<collection>/`）。

### 会议卡片 → 站主 CalDAV（一键添加）

- **入口**：卡片右下角日历菜单，登录后多出「添加到我的 CalDAV 日历」（`useOwnerPreferences().isOwner` 控制）。
- **API**：`POST /api/deadlines/caldav`（`isOwner` 守卫）→ 用运行时凭证（`getCalDavConfig()`：网站内设置的文件凭证优先，环境变量回退，见下方「CalDAV 凭证设置」）向 Radicale `MKCOL`（标准 XML）+ `PUT` 事件（稳定 UID `会议-年份-类型`，**幂等覆盖**不产生重复事件）。**防抖按 UID**（同一事件 5 秒内限一次，防连点；不同会议之间不限流——全局限流会误伤正常批量添加）。
- **iCal 构造**：`lib/ical.ts`（`buildIcsText`/`toIcsUtc`）客户端 .ics 下载与 CalDAV API 共用。
- **⚠ Base UI 迁移陷阱**：Base UI 1.x 的 `MenuItem` 用 **`onClick`**（非 Radix 的 `onSelect`）——`onSelect` 会被静默忽略且不报错，曾致日历菜单三个动作全部失效。项目内 DropdownMenuItem 一律用 `onClick`。
- **⚠ 菜单项事件冒泡**：Base UI 菜单默认渲染在卡片组件树内（Portal 仅影响 DOM 树），菜单项 `click` 会按 **React 组件树**冒泡到卡片触发其 `onClick`（如打开详情 Dialog）。凡卡片内嵌 DropdownMenu，菜单项 `onClick` 必须 `e.stopPropagation()`。

### 我的日历（站主专属，`/calendar`）

- **用途**：站主浏览器内查看 CalDAV 日历的月视图（会议 Deadline + 个人事件）；**仅供站主**（`requireOwner` 守卫，未登录重定向 `/login`），顶部导航登录后显示「日历」一级入口（`owner-nav-item.tsx` 中与「速记」并列）。
- **API**：`GET /api/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD`（`isOwner` 守卫；参数不合法 400；CalDAV 未配置 503；网络失败 502）→ CalDAV `REPORT`（calendar-query + `time-range`）查询 Radicale → 解析 multistatus XML 中的 `calendar-data` → `parseIcsText` 解析事件。30 秒内存缓存（`?v=` 参数绕过——**cacheKey 必须含 v**，前端刷新按钮靠它生效；缓存实现在 `lib/caldav/cache.ts`）。**⚠ time-range 的 end 是排他**（不含当天），结束日期需 +1 天（`toRangeEndExclusive`），否则 start==end 时区间为空（曾致聚焦某天显示「当天暂无事件」）。
- **删除事件**：`DELETE /api/calendar/events/[uid]`（`isOwner` 守卫；UID 校验字符集 `[A-Za-z0-9._@+-]` 防路径注入；CalDAV 未配置 503）→ REPORT 按 UID `text-match` 查资源 href → 逐一 `DELETE`（404 视为已被其他客户端删除，算成功）→ `invalidateCalendarCache()` 清缓存。UI：事件详情 Dialog 左下「删除事件」两步确认（首次点击变「确认删除」，5 秒未再点自动复位；执行中 spinner），成功后关 Dialog + 刷新。**⚠ Next.js route.ts 只能导出 HTTP handler 与少数配置，导出业务函数会触发类型错误（`Property is incompatible with index signature`）**——缓存等共享逻辑放 lib，路由间互相 import 也不行（`events/[uid]` 不能 `import "../route"`）。
- **双向联动**：网格点击日期格聚焦（再次点击取消；非当月格自动跳月）→ 下方 `DayEventsList` 按需加载当天事件（跨天事件每天可查）；未聚焦（`selectedDate === null`，初始默认）→ 下方 `UpcomingEventsList` 显示本月+未来 7 个月事件总览，点击跳转对应月份并聚焦。
- **iCal 解析**：`lib/ical.ts` 的 `parseIcsText`（与写入共用文件）——支持行折叠、UTC（Z 结尾）、全天（`VALUE=DATE`，`DTEND` 不含结束日）、浮时；TZID 事件降级为浮时（按访客本地解释）。UTC 事件客户端按浏览器本地时区显示（如上海 UTC+8）。
- **UI**：`components/calendar/calendar-view.tsx`——月视图（6 行卡片式网格、zh 周一起 / en 周日起、今天高亮、每格最多 3 个事件块（蓝色实底，超出显示「还有 N 个」）、跨天事件逐日显示、点击事件打开详情 Dialog、非当月格仅淡显日期、空月份显示提示）。工具栏为 `‹ 月份 › | 今天 | 刷新`（月份标题点击弹出跳转选择器）。
- **⚠ Base UI Select 在 Dialog 内 Popup 定位失败**：Dialog 内嵌 `Select` 时其浮动 Popup 会测出 0×0（anchor 宽度测量异常，`w-(--anchor-width)`=0，选项不可点），`key` 重挂载也无法修复。**跳转选择器因此用自绘 Popover 浮层**（relative 容器 + fixed inset-0 遮罩 + absolute 面板），浮层内 Select 正常。同理 Caption 需移除 rdp 内置 `Nav`（其 absolute 全宽层拦截 Select 点击）+ `relative z-10`。
- **官方 Calendar 组件**：`components/ui/calendar.tsx`（react-day-picker 封装，`--cell-radius` 变量在 globals.css）。月份/年份选择通过自定义 `MonthCaption` 用 shadcn Select 实现（替代原生 dropdown，v10 中组件名为 `MonthCaption` 非 `Caption`）。
- **注意**：本地验证需 `CALDAV_*` 环境变量注入（standalone 不自动加载 `.env`，`.env` 的 `RECOVERY_CODES` 含逗号无法 `source`）——`export CALDAV_URL=... CALDAV_USER=... CALDAV_PASSWORD=...` 后启动。Radicale 集合不存在时 REPORT 返回 404，按空日历处理（不报错）。

### CalDAV 凭证设置（站主在「日历」页面配置）

- **用途**：站主无需改 VPS `.env`，直接在 `/calendar` 工具栏「设置」里管理凭证：**查看账号/密码明文、修改用户名密码、一键随机重置密码**。适合初始化时尚未部署 env 凭证的场景。
- **存储**：`lib/caldav/store.ts` 读写 `data/caldav.json`（与 ideas.json 同款原子写入 + **chmod 600** 收紧权限；`/data/` 已在 .gitignore，凭证不入库）。**只存用户名+密码**，服务器地址由部署环境决定（环境变量 `CALDAV_URL`），不在网站内配置。
- **读取优先级**：`getCalDavConfig()` = 文件凭证（用户名/密码）> 环境变量（`CALDAV_URL`/`CALDAV_USER`/`CALDAV_PASSWORD`，compose 注入作为回退）。`GET /api/calendar` 与 `POST /api/deadlines/caldav` 均走此函数。
- **API**：`GET/PUT/DELETE/POST /api/calendar/credentials`（`isOwner` 守卫；游客 401）。
  - GET 返回 `{configured, source(file/env), user, password, pending}`——**含密码明文**（仅站主会话可访问，单站主场景无泄露面）
  - PUT 校验 user 必填/密码限长，密码留空保留原值（首次必填）；**密码变更时登记重置队列**
  - POST 随机重置：`randomBytes(24).toString("base64url")` 生成强随机密码 → 更新网站侧 + 登记队列 → 返回 `{user, password}`
  - DELETE 清除文件凭证回退环境变量
- **密码同步 Radicale（VPS crontab）**：网站侧密码变更（PUT 改密 / POST 重置）会原子写入 `data/caldav-reset.json` 队列；VPS crontab 每分钟执行 `scripts/apply-calendar-reset.sh` → `openssl passwd -5` 生成 sha256 hash → 更新/追加 `radicale/users` → 删除队列文件。Radicale 配置 `htpasswd cache: False`，改文件立即生效无需重启。**部署时须安装 crontab**（setup-calendar-vps.sh 自动安装；手动：`* * * * * ~/personal-homepage/scripts/apply-calendar-reset.sh`）。
- **UI**：`components/calendar/calendar-settings.tsx`——工具栏「设置」齿轮按钮 → Dialog（当前账号+密码明文展示、待同步 pending 提示、用户名/密码表单、随机重置按钮、新密码高亮展示），保存/重置成功 toast 并 `onSaved` 触发日历刷新。
- **默认账号**：setup 脚本 `CALDAV_USER` 默认 `ysy`（与部署用户同名）。
- **E2E**：凭证用例自清理（保存后 DELETE + 删除队列文件），失败残留时会写入 standalone data 的 caldav.json / caldav-reset.json；重跑前可 `rm -f .next/standalone/data/caldav.json .next/standalone/data/caldav-reset.json`。

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
- **i18n**：`messages/zh.json` 与 `messages/en.json` 同步修改（先 zh 后 en）；文案一律走 `useTranslations`/`getTranslations`，不硬编码。**页面 tab 标题已本地化**：页面 metadata 用 `generateMetadata` + `lib/i18n/metadata.ts` 的 `pageMetadata(params, "namespace")`（复用 section 的 `title`/`description` key），zh 显示中文标题；新增页面时沿用该模式，勿再写硬编码英文 `export const metadata`。首页标签页用 `title: { absolute: "Yu Shaoyuan" }` 只显示姓名（absolute 绕过父布局 template 后缀），`meta.defaultTitle`（首页/Home）仅作兜底。
- **UI**：优先使用 `components/ui/` 下的 shadcn 封装（Button、Card、Input、DropdownMenu、ToggleGroup 等）；lucide-react 图标传 `data-icon="default"`（与既有组件一致）。
- **客户端组件**（`"use client"`）放 `components/`；服务端页面守卫在 page.tsx 中。
- **SSG**：`cookies()` 使页面动态渲染（如 /login、/ideas），属预期；其余页面保持静态。
- **Lint**：`eslint-plugin-react-hooks` 缺失为既有 warning（非阻塞），勿改 package.json；保持 0 error。

## 常见问题

- 本地 `localhost:3000` 反复 EADDRINUSE：残留 next-server 进程，`fuser -k 3000/tcp` 后再起。
- Base UI `ToggleGroup` 的 `value` 恒为数组（单选也传 `[value]`），onValueChange 取 `v[0]`。
- VS Code 集成浏览器对部分元素点击会因稳定性检查超时（如 DropdownMenu trigger）：用 Playwright `evaluate(el => el.click())` 或直接跑 E2E 验证，勿误判为代码问题。
- standalone 构建会把 `.env` 复制到 `.next/standalone/.env` 并被 server.js 加载（本地 standalone 读取密钥的原因）；VPS 密钥来自 compose 的 environment 注入。
- 登录/登出 E2E 会真实写入会话与 Idea 数据，用例内自清理；跑完可检查 `data/ideas.json` 应为 `[]`。
- **E2E 勿开 fullyParallel**：所有用例共享同一 standalone 服务器的 `preferences.json`/`ideas.json`，多 worker 并行写会互相覆盖导致随机失败（曾致偏好恢复用例间歇红）。playwright.config.ts 保持默认单文件串行（27 用例约 12 秒）。
- **顶部栏跳转横向抖动**：两个叠加根因——(1) `OwnerNavItem` 曾每次路由变化先 `setOwner(null)` 回退占位态（3×36px≈116px）再异步查询恢复（游客仅「登录」≈46px），nav 居中布局下所有链接左右横移；修复为**保留上次登录态、后台静默刷新**（登录/登出由 `owner-auth-changed` 事件驱动，此时宽度变化属合理反馈）。(2) 长/短页面切换时滚动条消失/出现使视口宽度变化，居中内容偏移约 7.5px；已用 `html { scrollbar-gutter: stable }` 恒定预留滚动条空间。验证方法：Playwright 1ms 高频采样目标链接 `getBoundingClientRect().x` + MutationObserver 观察 nav 子节点替换。
- **本地 E2E 日历用例需要 Radicale 容器在跑**：`.env` 已含 `CALDAV_*`（指向 `http://127.0.0.1:5232`、账号 caladmin），容器 `ysy-personal-homepage-radicale-1` 停止时——「删除事件返回 503」变 502（连接失败）、「/calendar 月视图/日期格聚焦」失败（页面显示「日历服务未配置」不渲染网格）。跑日历用例前 `docker start ysy-personal-homepage-radicale-1`；若仅跑非日历用例可临时注释 `.env` 的 `CALDAV_*`。

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
pnpm fetch:deadlines     # 同步会议 deadline（ccfddl）
```
