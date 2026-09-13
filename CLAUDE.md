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
pnpm test:e2e:local  # 构建 → 启动 standalone → 全量 Playwright（66 个用例）
```

- E2E 覆盖：页面可达性、301 跳转、SEO 资源、登录（TOTP 正确/错误码、限流）、管理员菜单登出、Idea 速记 CRUD、控制台无错误、字体策略（按角色）、**排版与可访问性规格**（对比度 / 卡片内边距 / 字阶）。
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
- **UI 命名**（勿改回）：登录页「站长登录 / Owner Login」；导航「我的 / Me」菜单（仅权限类操作：退出登录，预留网站管理/权限管理等）。
- **功能入口分级**：高频重要功能在顶部栏单列入口（如「速记」）；低频功能放「更多工具」下拉菜单（有需要时再建）。**新增专属功能时先与用户确认入口位置**。
- **游客隔离**：所有专属功能对游客不可见（无入口），且路由层用 `requireOwner()` 守卫（无法直接通过 URL 访问）。
- **导航登录态刷新**：`OwnerNavItem` 监听 `owner-auth-changed` 自定义事件（登录/登出后广播）。登出时 pathname 不变，仅靠路由变化刷新会失效。新增管理员 UI 时沿用。
- **「导航」按钮位置（勿改回）**：「导航」不在 `site-header.tsx` 的 `navItems` 数组中，由 `OwnerNavItem` 统一渲染，位于桌面 nav 内最右侧（「导航」左侧有分隔线、右侧即 nav 边界，与工具栏拉开距离）。「登录/我的」账号区由 `OwnerAccountItem` 渲染在右侧工具栏最左侧（贴深色模式切换）。**组件拆分**（`owner-nav-item.tsx`）：`OwnerNavItem` = 速记/日历（owner-only span）+ 分隔线 + 导航按钮（含登录态同步逻辑 useEffect）；`OwnerAccountItem` = 登录（guest-only）/ 我的（owner-only，纯双布局渲染，登出逻辑内联）。两者均在移动端 Sheet 内再渲染一份（`w-full justify-start`，sep 移动端隐藏）提供移动端入口。
- **特殊入口视觉标识（勿改回）**：「导航」带 `CompassIcon` 图标（与导航悬浮按钮一致）、「我的」带 `UserRoundIcon` 图标、「登录」带 `LogInIcon` 图标，且「导航」左侧有一条分隔竖线 + 间距（`sep`，`owner-nav-item.tsx` 内、nav 中固定渲染，不影响零跳变机制；移动端 Sheet 隐藏）——与左侧功能导航区（博客/日历）分隔，与其余 ghost 纯文字导航项区分——「导航」是游客最需要的功能入口、「我的」是站主管理入口（唯一带下拉交互的入口）。布局：登录态 nav `… 博客 速记 日历 │ 导航` + 工具栏 `我的 🌓 🌐 ≡`；游客态 nav `… 博客 │ 导航` + 工具栏 `登录 🌓 🌐 ≡`。勿用 outline/secondary 等按钮样式做标识（曾试过，视觉突兀已弃用）；图标加 `data-icon="default"`（尺寸由 Button 的 `[&_svg]` CSS 控制）；E2E 按 role/文本断言不受影响。**⚠ 入口的可访问性 role 与渲染方式（勿改回）**：速记/日历/导航/登录等**链接型入口一律用原生 `<Link>` + `buttonVariants()` + `data-slot="button"` 渲染**（如 `<Link href="/ideas" data-slot="button" className={buttonVariants({variant:"ghost",size:"sm"})}>`）——渲染为 `<a>`，**role=link（非 button）**，E2E 断言用 `getByRole("link", ...)`；**勿用 `Button render={<Link/>}` 包裹**——Base UI 检测到非 button 宿主会 console.error（`nativeButton` 警告；加 `nativeButton={false}` 又会把 prop 泄漏进 DOM 引发 hydration mismatch），站内曾因此出现 5 个 console error 后才统一改为原生元素方案；「我的」是真正的下拉菜单触发按钮（role=button）。改入口渲染方式时同步检查 E2E role 断言与 `.sheet-nav [data-slot="button"]` 样式（globals.css 依赖 data-slot）。

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
- **已接入**：CCF 目录页筛选（key `ccf:filters`，登录时把游客期 localStorage 数据迁移上传一次）；我的日历周起始（key `calendar:weekStart`，`"sunday"|"monday"`，缺省周日；`use-owner-preferences` 通过 `owner-prefs-changed` 自定义事件广播偏好变更，**设置弹窗与主视图多实例间实时同步**——新增多组件共享偏好时沿用该事件）。
- **备份**：**无需备份**（低价值数据，丢失后重新设置即可）；`backup-ideas.sh` 只备份 ideas.json。
- **限制**：单用户低并发；会话内不轮询，跨设备需刷新页面感知。

## 会议 Deadline 日历（公开功能）

- **路由**：`/deadlines`（公开页面，`force-dynamic` 动态渲染）；入口：学术导航页「会议 Deadline 日历」链接（未加入顶部导航）。
- **数据流**：`scripts/fetch-deadlines.mjs`（零依赖行级 YAML 解析）每 12 小时从 ccfddl/ccf-deadlines 的 `allconf.yml` 拉取 → 归一化时区 → 只保留当年+次年 → 写入 `lib/data/deadlines.json`（提交入库）。同步命令：`pnpm fetch:deadlines`；工作流 `sync-deadlines.yml`（每 12 小时，有变化提交 PR）。
- **手动立即同步（主人专属）**：`/deadlines` 页面登录后显示「立即同步」按钮 → `POST /api/deadlines/sync`（`isOwner` 守卫，60 秒限流）拉取最新数据并合并覆盖层 → 原子写入运行时文件 `data/deadlines.json`（`DATA_DIR` 或 cwd/data，VPS 上即 compose 挂载的 `./data`，持久化）。页面动态渲染优先读该文件（缺失/损坏回退构建时数据），刷新即生效，无需等待部署。**按钮位置（勿改回）**：独立客户端组件 `components/deadlines/deadlines-sync-button.tsx`（`useOwnerPreferences().isOwner` 控制，游客返回 `null` 不占位），由**服务端**页面 `app/[locale]/deadlines/page.tsx` 渲染在页面头部右列——header 为 `flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between`（左列 = 标题/徽章/描述/来源，右列 = 按钮，宽屏与标题顶部对齐，`sm` 以下堆叠到描述下方左对齐）。**勿把按钮放回 `deadlines-list.tsx`**：该组件位于 header 之后（`gap-8`），按钮只能在那儿独占一行；页面头部是服务端组件，故按钮须独立成客户端组件才能排进右列。
- **覆盖层**：`content/deadlines-overrides.yaml`（velite 校验）按缩写整体替换/新增会议（非 CCF 会议、修正错误数据用；字段 l/f/d 缺省时沿用自动数据）。合并逻辑 `mergeDeadlines()` 在 `lib/data/index.ts`，构建时与手动同步共用（保证规则一致）。
- **时区约定**：fetch 时归一化为 IANA 名（AoE→`Etc/GMT+12`、PT/PST→`America/Los_Angeles`、UTC±X→`Etc/GMT∓X` 注意符号反转）；UI 用 `Intl.DateTimeFormat(timeZone)` 转访客本地时间，零依赖。
- **UI**：`components/deadlines/deadlines-list.tsx`——等级 A/B/C/未收录 + 时间范围（30/90 天）+ 领域多选筛选、倒计时、详情 Dialog、Google 日历 / .ics 导出。领域词表与 CCF 目录一致（官方中文名，短键取 `/` 前段）。⚠ **领域筛选 chip 必须 `max-w-full` + 内层 `<span className="truncate">`**（`/ccf` 与 `/deadlines` 同一份写法）：英文字段名（如 "Software Engineering, System Software & …"）可长过 360px 视口，单个 `shrink-0` 的 chip 会把窄屏撑出横向溢出（`/en/ccf` 曾溢出 64px）。**卡片内只有两层字阶（勿加层）**：16px 缩写（`font-mono font-bold`）+ 12px 其余（会议全称 `line-clamp-2`、领域徽章、倒计时、deadline/地点/会期、底部链接）。⚠ 会议全称曾用 14px，在 3 列窄卡（317px）里 2 行显得过大过重、且与卡片其余 12px 元数据割裂，已降为 `text-xs`——**勿升回 14px**（`/venues` 的 L2 全称是 14px，但那是宽行单行截断，与卡片场景不同）。⚠ 倒计时含中文（还剩/天/明天截止），用 `tabular-nums` 而非 `font-mono`（避免拉取 cjk 字体分片）。
- **注意**：allconf.yml 缩进风格不统一（数组项可与父键同级），解析器按内容模式驱动而非绝对缩进；若解析结果为空会直接报错退出（防提交空数据）。数据源（ccfddl.com）偶发连接超时，脚本内置 3 次重试；可用 `DEADLINES_URL` 环境变量覆盖源地址（CLI 另支持 `--url`）。

## 中科院 SCI 分区表（公开功能，`/cas`）

- **定位**：中科院分区表（升级版）**计算机科学大类**期刊速查（758 本），与「CCF 推荐目录」同风格姊妹页（`/ccf` 复刻：统计卡 + sticky 筛选栏 + 学科多选 chips + 单列分组表）。入口：学术导航页「中科院 SCI 分区表」链接（未加入顶部导航）。
- **数据文件**：`lib/data/cas-2025.json`（约 380KB 压缩存储；JSON 结构 `fetchedAt/version/source/count/rows/subjects/stats`）。行结构 `{n 刊名, i ISSN/EISSN, w WoS 收录, top, m [大类中文名, 分区 1-4, 大类内排名, 大类内总数], s [小类学科 × N]}`；小类 = `[JCR 学科规范英文名, 官方中文名, 学科分区, 学科内排名, 学科内总数]`（学科中英名已内置，UI 按 locale 直接取，无需运行时翻译）。`subjects` = 55 个去重小类词表（zh/en，供筛选 chips）。「大类分区」原文格式 `1 [3/58]`，入库前拆为数字段。
- **数据源与同步**：`scripts/fetch-cas.mjs`（零依赖 CSV 状态机解析 + `pnpm fetch:cas`）从 `hitfyd/ShowJCR` 仓库（advanced.fenqubiao.com 官方导出 CSV 的社区二次整理）抓 `FQBJCR2025-UTF8.csv` 全量 21772 行 → 只保留计算机科学大类。⚠ **CSV 部分单元格含逗号且用双引号包裹（如 `" MATERIALS SCIENCE, MULTIDISCIPLINARY 材料科学：综合"`），必须状态机解析，不能 `split(",")`**（曾致 757/758 行小类全空且总行数少 1 的静默错误）。raw.githubusercontent.com 国内访问经常超时（60s 超时 + 3 次重试仍失败），脚本支持 `--url` 覆盖源（本地用 HTTP 服务验证）；同步命令运行环境须能访问 GitHub（建议在 CI 或代理环境跑）。
- **数据校验**：默认按分区升序 + 大类排名排序（1 区第 1 = IEEE Communications Surveys and Tutorials）；脚本输出若行数 ≠ 758 或 subjects ≠ 55 应人工核查格式变化。**数据更新会改变页面默认排序首位**——若上游把新期刊排进 1 区第 1，E2E/人工抽查的「首位期刊」断言需随之调整。
- **UI**：`components/cas/cas-directory.tsx`——搜索（刊名/ISSN/WoS/学科，大小写不敏感）、分区 1-4 分段控件、Top/非 Top 分段、小类学科多选（chip 按中文名排序；en 界面显示英文名）。行 = 刊名 + Top 金色胶囊徽章 + 第二行 `ISSN xxx · 排名 x/y` + WoS chip（SCIE/SSCI 主色、ESCI 灰、On Hold 警示色）+ 学科点列（超宽屏，`xl:` 起，tooltip 显示排名）+ 分区徽章（红/蓝/绿/琥珀，同 CCF A/B/C 用色体系）＋ hover 行首色条。单列不分字段分组（大数据量搜索场景）；默认渲染全部行（`content-visibility` 未启用，758 行 DOM 可接受——若未来接入全大类上万行再考虑分页/虚拟化）。
- **偏好持久化**：key `cas:filters`（`{q?, zone?, top?, subjects?}` 结构同 `ccf:filters`），已在 `lib/preferences/registry.ts` 注册 sanitize；URL 参数 `?zone=&top=&q=&subjects=`（中文学科名逗号分隔，encode 后入 URL）可分享/刷新恢复。
- **⚠ 数据解构陷阱**：`entry.m` 元组是 `[大类名, 分区, 排名, 总数]`——取分区是 `m[1]` 不是 `m[0]`。曾因 `const [mainZone, ...] = entry.m` 把**大类中文名**当分区索引 `ZONE_STYLE[zone]`，服务端渲染直接抛 `Cannot read properties of undefined (reading 'bar')` 整页 500（本地 build 不报错，SSG 预渲染也不报——因为客户端组件，报错发生在 standalone 运行时）。凡「按索引取 tuple 字段再当 key 索引对象」的模式，务必核对数据列序。
- **⚠ Tailwind 动态类**：小类点色/徽章色必须整串静态写出（`SUB_DOT`/`ZONE_STYLE` map，key 为 1-4 字面量），勿用 `var(--color-zone-N)` 之类未定义 CSS 变量或模板字符串拼类名（Tailwind 扫描不到会丢样式）。

## 期刊会议速查（公开功能，`/venues`，Venue Explorer）

- **定位**：三源数据（CCF / 中科院 / ccfddl）的**搜索驱动**速查页（非目录浏览页）——输入关键词即对照展示会议/期刊的 CCF 等级 + 中科院分区 + 会议截稿/会期/地点。入口：学术导航页「会议与投稿」组首条链接（未加入顶部导航）。原 `/ccf`、`/cas`、`/deadlines` 三页保留，页面底部 sourceNote 互链回三页。静态 SSG（deadline 相对时间客户端算，不依赖运行时同步文件）。
- **数据整合层**：`lib/data/venue.ts`（纯数据模块，import `lib/data/index.ts` 的 ccf/cas/deadlines）：
  - 会议 `venueConferences` = CCF 386 ∪ ccfddl 313（union 422），连接键 = **缩写规范化**（小写去非字母数字）；ccfddl-only 会议 `inCcf: false`、等级可仍为 A/B/C（ccfddl 侧别名）。行含完整 `years`（DeadlineYear[]）供客户端算 deadline。
  - 期刊 `venueJournals` = CAS 758 ∪ CCF 295（union 842：295 + 547 CAS-only），连接键 = **确定性规范化刊名**（`normName`：小写 → 去前导 The → `&`→` and ` → 去标点折叠空格）。⚠ **只做精确等值匹配**：曾验证 token 序列嵌入匹配会张冠李戴（The Computer Journal 被嵌入到 "Future Generation Computer Systems-The International Journal of eScience"），禁止用模糊/嵌入匹配。当前精确命中 214/295（72.5%）；其余 81 本多为不在中科院计算机大类（医学/生物等归他类）或写法系统性差异。
  - `venue.ts` 导出：类型 `VenueConference`/`VenueJournal`、`venueConferences`/`venueJournals`/`venueStats`、`FIELD_EN`（领域完整英文名，搜索用）、`normSearch`（搜索词归一：去 & 与标点直拼）。`make*` 纯函数可在测试/脚本复用。领域短键 `FIELD_KEY`/`FIELD_EN` 与 ccf/deadlines 页同源（各页各自内联，改动需三处同步）。
- **UI**：`components/venues/venue-explorer.tsx` + `app/[locale]/venues/page.tsx`（server 层读 venueStats 渲染 meta 行）。
  - **默认态（无查询）不铺列表**：引导文案 + 热门速查 chips——「即将截稿的 CCF-A 会议」6 个（按未来最近 deadline 排序）+「双顶期刊（CCF-A ∩ 中科院 1 区 Top）」6 个（按大类排名）。
  - 结果态：会议 | 期刊 **两栏**（lg 起，每侧上限 24 条 + tooMany 提示）；只查 URL `?q=`（**无偏好持久化**——搜索页打开即恢复旧词不友好；注册表勿加）。
  - 搜索评分：缩写/全称完全等于 0 < 缩写前缀 1 < 名称前缀 2 < 包含 3 < 领域/ISSN/学科包含 4；领域搜索命中 zh 短键与 FIELD_EN 英文名。
  - **会议卡**（button，点击开 Dialog）：左等级色条 + L1 **届别标题**（缩写 + 届年份小号弱化紧随其后、同基线，如 `CVPR 2027`——年份来自 `main.year.y`（未来最近/已过最近 deadline 所属年份），**用户指定方案：年份字号小于缩写且弱化为 muted，只作附属标注不抢缩写主视觉**；无年份数据（`years` 为空）时不显示年份；无简称的会议直接以全称作标题行，如 IEEE World Haptics Conference，此时不重复第二行全称）+ `CCF-A/B/C` 药丸徽章（**会议与期刊统一带 CCF- 前缀文字，用户指定勿改回**；无 = 灰「未收录」徽章，label 仍为 `CCF A` 供 E2E）+ 领域（sm 起）→ L2 全称 → **仅一行「最近一次会议举办时间」**（📅 `main.year.date` 原文，即该届会期；卡片**不显示倒计时与截稿时间**——用户指定勿改回，截稿各节点时间只在点开卡片后的 Dialog 展示）。Dialog：标题缩写/无简称全名 + 年份块（未来有截稿年份优先，降序，最多 3 届）——每块 date/place/官网 + timeline 全列表（过去条目 55% 透明）+ DBLP 链接。
  - **期刊卡**（不可点）：左色条（CAS 分区色优先，无 CAS 用 CCF 等级色）+ L1 刊名 + 右侧中科院分区方徽（1-4；无 = 灰「—」title 解释）→ L2 `CCF-A/B/C` 药丸徽章（**带 CCF- 前缀文字，与分区数字方徽区分**；无 = 「非 CCF」灰徽章）+ Top 金 pill + 缩写·ISSN·中科院大类排名 x/y + DBLP 尾链 → L3 小类学科点列（最多 2 +N，title 全量）。⚠ 徽章体系（勿改回）：CCF 等级（会议/期刊统一）= 红蓝绿药丸带 `CCF-` 前缀文字；中科院分区 = 无前缀数字方徽（1-4）——两者靠前缀文字区分。
  - ⚠ **Dialog 宽度与溢出**：`DialogContent` 默认含 `sm:max-w-sm`，传无前缀的 `max-w-lg` 会被其覆盖（≥640px 永远 384px 宽）——宽度覆盖必须写 **`sm:max-w-lg`** 这类同变体类；共享组件已加 `grid-cols-[minmax(0,1fr)]`（单列轨道按内容 min-content 撑破内容盒的共性根因——含 truncate/nowrap 长文本的 Dialog 会溢出 10~26px，如 IEEE CEC 的 Maastricht 会场行，曾致内容越出卡片边界；改动 DialogContent 后勿移除该列模板）。
  - 领域短名表 `FIELD_EN_SHORT` 从 deadlines-list 同源复制（改动需两处同步）；`fmtDateTime` 模块级缓存 Intl。⚠ 时区函数 `zonedToUtcMs`/`localTzOffset` 已从 deadlines-list / venue-explorer 的两份拷贝**收敛到 `lib/utils/tz.ts`**（零依赖零数据 import，`/deadlines`、`/venues` 与日历服务端补齐共用：改动只需一处）。
- **E2E**：`/venues` 可达（zh h1「期刊会议速查」）+ 3 用例——默认态热门区标题、搜 CVPR（会议栏命中 + `CCF A` 徽章 label + 卡片点开 Dialog 含年份）、搜 TPAMI（期刊栏 + `CCF A` 与 `中科院 1 区` 双 label + 清空按钮复位）。⚠ 断言用 **CCF 目录全称**（如 CVPR = "IEEE/CVF Computer Vision and Pattern Recognition Conference"，与 ccfddl 的 "…Conference on Computer Vision…" 名序不同）；TPAMI 分区为 1 区 Top（数据更新若改变需同步改断言）。

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
- **⚠ deadline 同步 PR 自动合并**：`sync-deadlines.yml` 在 create-pull-request（`id: cpr`）后加两步——(1) `Enable auto-merge`（`id: am`，`continue-on-error: true`）：配置了 `AUTOMERGE_TOKEN` secret（PAT，需 `contents: R/W` + `pull-requests: R/W`）时用 `gh pr merge --auto --squash --delete-branch`（原生 automerge，`if` 含 `env.AUTOMERGE_TOKEN != ''` 判断）；(2) `Auto-merge sync PR (fallback)`：PAT 未配置**或启用 automerge 失败**（`env.AUTOMERGE_TOKEN == '' || steps.am.outcome == 'failure'`）时降级为 `gh pr merge --squash --delete-branch`（`GH_TOKEN: ${{ github.token }}`，`pull-requests: write` 即可）立即合并。**⚠ step 级 `if` 表达式无法访问 `secrets` context**（GitHub 解析工作流直接报 `Unrecognized named-value: 'secrets'`、运行失败且不执行任何步骤），必须先在 **job 级 `env` 中转**（`env: AUTOMERGE_TOKEN: ${{ secrets.AUTOMERGE_TOKEN }}`，job env 可用 secrets，未配置时为空串不报错），step `if` 里引用 `env.AUTOMERGE_TOKEN`；step 级 `env:` 中直接引用 secrets 是合法的。**GITHUB_TOKEN 无法「启用 automerge」**（GitHub 限制，需 PAT），但可直接合并 PR。**GITHUB_TOKEN 的合并 push 不触发 ci/deploy**（防循环），故合并后线上构建时数据不更新——线上 deadline 数据靠「立即同步」按钮（运行时 `data/deadlines.json`）或下次常规部署承载，属预期。若运行仍失败：可能是脚本网络偶发（fetch 已加 30s 超时，3 次重试）或 PAT 无效/权限不足（看 `Enable auto-merge` 步骤报错，此时 fallback 会自动合并不阻塞）。

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
- **⚠ 事件身份 = 「某会议某投稿节点的截止提醒」，不是会议本体（勿改回）**：这是语义地基，所有字段都按此归位——`DTSTART` 是**节点截止时刻**、`SUMMARY` 是「会议 + 年份 + 节点词」、`LOCATION` 是**会议举办地**、`X-CONF-DATES` 是**会期**。曾因标题只写会议名（`ADMA 2026`）而时间/地点按会议本体摆放，日历读起来变成「ADMA 2026 于 9 月 12 日在香港举办」——语义割裂（用户反馈）。
- **⚠ 事件字段归位（勿把信息全塞进 DESCRIPTION）**：CalDAV 写入 / .ics 下载 / Google 日历链接三处同源，格式统一为——
  - `SUMMARY` = `缩写 年份 · 英文节点词`（`NODE_LABEL_EN`，如 `ADMA 2026 · Full Paper`）：外部客户端（Apple/Google）**只有标题**，不带节点词就会把截止时刻误读成会议举办时间。
  - `X-CONF-TITLE` = `缩写 年份`（本站 UI 用的洁净标题）：本站靠 `CATEGORIES` + `calendar.cat*` 本地化合成「ADMA 2026 · 全文」，若直接显示带英文节点词的 SUMMARY 就是中英夹杂，若靠裁字符串又太脆。
  - `CATEGORIES` = 节点类型（`abstract`/`paper`/…，语言中立的机器可读标签）；`LOCATION` = 会议地点；`X-CONF-DATES` = 会期（iCal 无标准会期字段，用 X- 扩展属性承载，外部客户端忽略、本站结构化取用）；`URL` = 官网。
  - `X-CONF-NAME` = **会议全称**；`DESCRIPTION` = **用户备注**（二者最易搞反，理由见下条）。
  - ⚠ **会议全称为何不放标准的 `DESCRIPTION`**：三大生态把 DESCRIPTION 当成用户的「备注/描述」框（Apple EventKit 的自由文本框只有 `notes`、鸿蒙 `calendarManager.Event` 只有 `description`，两家的模型里**都没有 comment**）——若把会议全称写进 DESCRIPTION，用户在手机日历里一改备注就把全称改坏了（用户明确提出的风险）。而 `X-` 属性是 RFC 5545 §3.8.8.2 明确允许的扩展位，且规定客户端必须忽略未识别的扩展属性 → 全称放这里既安全、又随事件同步（不显示但不会丢）。曾试过 `COMMENT` 存备注（RFC 5545 §3.8.1.4 语义上确实匹配「给日历用户的说明」），但 Apple/华为都不展示它 → 改成 DESCRIPTION（客户端里就能看/改备注，双向同步）。
  - ⚠ **未采纳的备选：不存字段、按缩写反查数据源**——缩写会冲突（不同会议同缩写），反查错就会显示成**另一个会议的全会称**（错名比无名更糟），且事件不再自包含。
  - ⚠ **勿再写 `Deadline: … / Dates: … / Location: …` 这类硬编码英文标签行**：截止时刻就是 `DTSTART`、会期就是 `X-CONF-DATES`，写进去只是重复（曾先在描述里带标签、后又把会期同时写进描述与 X- 字段，均被用户指出）。
  - **旧格式事件需在会议卡片日历菜单重新点一次「添加到我的 CalDAV 日历」**（UID 稳定、幂等覆盖）才会变成新格式；未重加前本站 UI 自动降级（副标题回退描述首行、备注视为空，且首次写备注时服务端自愈：把旧描述首行落到 `X-CONF-NAME`）。
- **日历列表第二行 / 详情弹窗（勿改回整段描述）**：`calendar-view.tsx` 的 `appointmentSecondaryLine()` 取「地点 · 会期」（结构化字段），无结构化字段时回退**描述首行**——**列表第二行必须是单行**（`truncate` 下多行描述会被 `nowrap` 压成一长条再截断，曾致「描述被挤成一行」）。
  - **弹窗标签随事件类型切换**（`isDeadlineNode()` = `CATEGORIES` 命中节点词）：投稿节点事件 = 标题「缩写 年份 · 本地化节点名」+ **副标题 = 「会议全称 + 届别年份」且本身即该届官网超链接**（`AppointmentSubtitle` / `appointmentConfName()`：名称取 `X-CONF-NAME`（旧事件回退描述首行），年份取 `X-CONF-TITLE` 尾部四位，缺时回退事件年份；名称已带年份则不重复拼接）+ 行 **截止时间（节点名）/ 会议会期 / 会议地点**（标签写作「截止时间（摘要）」这类形式标明节点；曾先试过在标签前放类别徽章，视觉上太重已弃用）；个人日程 = **时间 / 地点 / 链接**（不出现「会议会期」这种怪行）。行 `时间/地点` 与 `截止时间/会议会期/会议地点` 是两套语义，勿合并成一套。
  - ⚠ **官网链接上提到副标题里（用户指定，勿改回单列一行）**：会议每届一个域名（如 adma2026.github.io），故全称必须带届别年份才能表意清晰；链接行只在**无会议全称**时（如个人日程）才单独出现。链接末尾带 `ExternalLinkIcon`（提示整段文字可点）。
  - ⚠ **弹窗标题必须带 `leading-snug`**：`ui/dialog.tsx` 的 `DialogTitle` 基础类是 `leading-none`，配上 `truncate`（overflow:hidden）会把 `g/y/p` 的下半截裁掉（用户报「Eurographics 的 g 少一截」；程序化实测：字形盒 18px > 行盒 16px，加 `leading-snug` 后 22px ✓）。
  - **「添加备注」用 ghost 小按钮（带 `PlusIcon`），勿改回带下划线的文字链**：用户反馈下划线暗示「可编辑」有误导性（2026-09）。
  - **会期显示保持上游英文原文**（如 `May 10-14, 2027`）：曾写过一个本地化解析器（实测覆盖 390/394 的写法，中英双格式），用户权衡后决定不做 → **勿再引入**（`lib/utils/conf-dates.ts` 已删除）。
  - **备注（自由文本）在弹窗底部统一成一项**（`AppointmentNote`，对所有事件可编辑，读写 DESCRIPTION）——**勿再加一个只读的「描述」行**（曾同时存在只读「描述」行与可编辑「备注」项，两个框打架）。
  - 列表标题 = 洁净标题（`appointmentBaseTitle`，类别徽章已表意，勿再拼节点词）；月视图 chip / tooltip / 弹窗标题 = `appointmentDisplayTitle`（洁净标题 · 本地化节点名）。
  - **弹窗的类别视觉提示（勿改回单色标题）**：标题里的节点名用**类别色**（`CATEGORY[].textClass`，与徽章同一套 700/400 token——**勿用 500 号色**，浅色底上不足 AA），且 `DialogContent` 左缘有一条 **4px 类别色条**（`inset-y-0 left-0 w-1`，颜色取 `CATEGORY[].color`，与 `/venues` 会议卡的左色条同一视觉语言；`DialogContent` 需加 `overflow-hidden` 以贴合圆角）。原本标题前只有一个 `size-2.5` 小圆点，视觉提示太弱（用户反馈），已换成上述两个更强的提示；`isDeadlineNode()` 为假（个人日程）时节点名与色条退回主色。
  - **弹窗中间区域的横向「会议时间线」（用户指定：横向 / 彩色节点 / 悬浮看详情，勿改回竖向）**：位置 = 会议事件信息与「删除日程 + 关闭」之间（`AppointmentDetails` 之后、`AppointmentNote` 之前）。
    - **数据**：服务端 `/api/calendar` 调 `lib/data/conference.ts` 的 `enrichAppointments()`——从事件标题（`X-CONF-TITLE`，回退 `SUMMARY`，按 `·` 去掉节点词）解析「缩写 + 年份」，用**缩写规范化精确等值**从 `deadlines`（含覆盖层）取该届 `years[].timeline`，节点经 `zonedToUtcMs`（`lib/utils/tz.ts`，与写入端同一实现）换算为 UTC 后按时间升序。⚠ 连接键只做精确等值，**绝不用模糊/嵌入匹配**（匹配错会把 A 会议的时间线挂到 B 会议事件上，比不显示更糟）；个人日程 / 第三方事件没有 `conference` 字段。服务端做是为了不把 313 个会议的数据打进浏览器包。
    - ⚠ **2026-09-13 重大改版：时间线由「横向」改为「竖向」+ 弹窗响应式分栏**（下面旧描述里的方向词按此换算）：
      - **布局**：`ol` 为 `flex flex-col`（竖向列表 + `max-h-[65vh] overflow-y-auto` 内滚动）；每个节点是**一行** `li`（`h-12` 定高）＝ **轴线列**（`w-6`：上半段竖线 + 圆 + 下半段竖线）+ **文字列**（名称 + 日期，日期 `ml-auto` 右对齐）。
        - ⚠ **行高固定 `h-12`**：圆垂直居中、相邻行的竖线自然相接（行高随内容变会让各行的圆参差）。
        - ⚠ 方向换算：旧文的「列」= 现在的「行」、「左右半段」=「上下半段」、「left 递增」=「top 递增」、「各列同一 top」=「各行同一 left」、「横向滚动」=「纵向滚动」。
      - **行宽与节点数无关**（竖向的核心优势）：横向每列宽 = 内容宽 ÷ 节点数（VLDB 24 节点时只剩 45.6px）；竖向行宽 = 弹窗内容宽（窄屏全宽）或右栏宽（宽屏分栏），节点数只影响**高度**（滚动消化）。实测可用宽：宽屏分栏 297px、窄屏 396px、380px 视口 217px → 短标签全部单行显示。
      - **弹窗两档（响应式）**：`max-w-[min(calc(100%-2rem),32rem)]! lg:max-w-[min(calc(100%-2rem),48rem)]!`
        - 窄屏（<1024）= 512px，时间线**全宽竖向**；宽屏（lg ≥1024）= 768px，**左右分栏**（左栏信息+备注 356px、右栏时间线 320px）。实测断点精确在 1024 切换。
        - ⚠ **必须带 `!`（important）+ 用 `min()` 自带「视口 − 2rem」边距**：`DialogContent` 基础类里的 `sm:max-w-sm`(384) 是**变体类**，会压过无变体的 `max-w-*`——实测不加 `!` 时 900px 视口下弹窗被顶成 384px。**旧记录说「写同变体类即可」不够**（`sm:max-w-lg` / `lg:max-w-3xl` 都被 `sm:max-w-sm` 压过）。
        - 弹窗另加 `max-h-[85vh] overflow-y-auto` 兜底（实测 420px 视口：弹窗 357px、内滚动生效，不溢出）。
      - ⚠ **虚线竖段必须用 `border-l`（不是 `border-t`）**：`border-t` 在 1px 宽的竖元素上等于不可见——横向版直接平移会**静默失效**（E2E 会漏数）。虚线段 = `w-0 border-l border-dashed border-<色> bg-<色>`（`bg-*` 只为让 E2E 统一读 `backgroundColor`，宽 0 不可见）。
      - **名称三档（用户指定「空间够就显示完整名称」）**：`full` = **完整轮次备注**（`conferenceRoundFullLabel`，只去尾部 `" Paper"`、**不剥流程词**，如 `April Cycle Submission Deadline`）→ `short` = 剥掉流程词的短标签（`conferenceRoundLabel`，如 `April`）→ `none` = 不显示（只留圆内图标）。判据 = 「行内**可用宽**」（`文字列宽 − 日期宽 − gap(8)`）与该文本的**实际渲染宽度**比较。
        - 实测：宽屏分栏（297px）与窄屏堆叠（396px）**都显示完整备注**；380px 视口（217px）下 37 字符的 `September Cycle Submission Deadline`（≈220px）**自动降级**为 `September`，而同届 33 字符的 `April Cycle Submission Deadline`（≈200px）仍是完整名。
        - ⚠ 短标签（`conferenceRoundLabel`）仍用于 **UID slug / SUMMARY / 列表徽章**——那些位置宽度受限（且外部客户端标题要短），不要改成完整备注。
      - 滚动定位：把当前节点滚到**纵向**居中（`scrollTop`）。⚠ 只在该事件挂载时算一次；弹窗开着时改窗口尺寸不重定位（极少见）。
    - **版式（竖向时间线，见上条改版说明）**：`ol` 竖向列表；每行 = 轴线列（`w-6`：上半段 + 圆 + 下半段）+ 文字列（名称 → 日期右对齐）。
    - **状态区分（三重）**：① **轴线段深浅**：**以「今天」标记为界**——标记**左侧**一律浅（`foreground/20` = 浅灰，那段时间已经过去）、右侧一律深（`foreground` = 近黑，还没到）；⚠ 颜色是**用户指定**的「黑 / 浅灰」两档，深色主题下 `foreground` 本身变近白，于是自然成为「白 / 浅白」——跨主题成立的仍是「实 / 淡」这一相对关系。⚠ 判据是「与今天标记的相对位置」：既**不是**「与当前打开的节点的相对位置」（那样会随打开哪条日程而变，且用户明确排除），也**不是**「该线段通向/右侧最近的节点是否已发生」——后者是**过度修正**，会把「最后一个已过节点 → 今天」那一段画成深色（用户指出：今天左边的线应该是浅色，因为那段时间确实已经过去了）。因为「今天」是独立一列、翻转点恰好落在标记处，**每个线段仍然只有一种颜色**（跨标记的两段分别整体浅/整体深）。首列左半段 / 末列右半段透明。② **已发生节点淡化**（判据 `daySeq(node.utc) < daySeq(now)`，即「今天之前」）——⚠ **必须下在节点自己的徽章/日期/圆点上，不能下在整列 `opacity-55` 上**：祖先 opacity 会衰减整列内的**轴线半段**，而一个线段的两半分属相邻两列，于是「最后一个已过节点 → 今天」那段渲染成一半正常、一半变淡（用户报的「一个线段两种颜色」；只用 `getComputedStyle().backgroundColor` 驗证看不出来，因为它不反映祖先 opacity）。③ **光晕 = 点开的那一个节点**（判据 `isCurrent`，与 `aria-current` 一一对应；a11y 的「当前项」必须唯一 + 横向自动滚动定位靠它）：圆 `ring-3 ring-ring/30`（即圆外那圈更大更淡的圆环），**与时间无关**——与淡化可同时生效（看的这条在今天之前 = 有光晕 + 已淡化）。⚠ 同一天有多条节点日程时（ADMA 2026 的 Poster / Encore）**也必须只亮一个**——「我在看哪条」的指向不能模糊；它们的区分靠**轮次名文字**（见下条「轮次短标签」），不靠光晕（用户最终决定：曾按日粒度全亮过一版，随即被否掉）。
    - **「今天」列（用户指定方案：「今天」抽象成与事件节点同级的一列，勿叠在节点列上）**：`entries` = 事件节点 + 一个 `{ kind: "today" }` 列——于是**任何情况下都有「今天」**（含「最早节点都晚于今天」那种届别）。插入位置见下面「今天列与同日节点的相对位置」。
      - **版式与事件列同一行流（轴线**上方**，勿改回「镜像到轴线下方」）**：事件列 = 「徽章在上、日期在下」；「今天」列 = 「「今天」二字在上（与名称**同字阶、同槽高**，灰色纯文字）+ 日期在下（12px，同事件日期）」，轴线上的标记为**同尺寸的空心圆**（`size-6` + `border-2 border-foreground`）。实测各列的名称槽 / 日期 / 圆三行 top 完全一致（名称槽 `h-4` 占位是前提）。
        - ⚠ 曾把「今天」的信息放在轴线**下方**（日期 + 「今天」，镜像事件列），初衷是「今天与某个事件节点重合时可以合并（事件在上、今天在下）」。但「今天」永远是自己一列、**不存在与事件节点合并的情形**，镜像版式便失去了目的，反而多出「两行占位 + 一行日期 + 一行文字」把整行从 **68px 撑到 112px**（实测白占 44px，且该列成为最高列，`items-stretch` 把其它列一并拉高）。故已改为上方一行流（用户指出）。
        - 今天列 `w-12 shrink-0`（固定 48px；6 节点时实测列宽 68.4px，6 × 68.4 + 45.6 ≈ 内容宽 456px，ADMA 正好不横向滚动）。轴线行固定 `h-6`（与圆直径 `size-6` 同高，行高不统一会让各列垂直中心不一致）。
      - ⚠ **不要退回「把刻度叠在某个节点列上」的写法**：早期版本刻度绝对定位在节点列左缘、标签用列内 `text-center`，两者必然错位 → 「今天」显示在相邻事件节点下方；再用 `boundaryIndex > 0` 跳过「无过去一侧」的情形 → 那种届别完全不显示标记（用户报的两个 bug，根因就是没把它当一列构造）。现在圆点/日期/标签同列且都居中，天然对齐（E2E 断言中心偏差 ≤1px、「今天」在日期之上、日期在空心圆上方）。
      - ⚠ 仍**只表示「今天」的位置标记，不表示时间比例**：各列等宽，与真实间隔无关（ADMA 的间隔是 14/0/7/35/0 天，却渲染为等宽列）；刻意不做「按时间插位置」——那会制造一个不存在的精度，要真做就得把整条轴改成时间比例间距（VLDB 那种 24 节点 rolling deadline 会大量重叠）。
      - **节点自身的视觉语义 = 两条互不冲突的通道（用户指定）**：
        - ① **光晕通道（圆外那圈更大更淡的圆环，`ring-3 ring-ring/30`）→ 只指示点开的那一个节点**（`isCurrent`，与 `aria-current` 一一对应）。⚠ **不要把它挪去当「今天」的标记**——这是我曾犯的错（用户纠正：光晕是「你在看哪条」的指示）。⚠ 也**不要**为了「同一天多条日程」而让它一次亮多个（曾按日粒度全亮过一版，随即被用户否掉：指向必须唯一）。
        - ② **时间通道 → 指示时间**（日粒度，判据只看节点日期）：**今天之前 → 淡化**（徽章/日期/圆点 `opacity-55`）/ **今天 → 日期加重**（`font-medium text-foreground`，即时间维度的高亮）/ **今天之后 → 正常**。
        - 两通道**可同时生效**：看的那条若在今天之前 = 有光晕 + 已淡化；若在之后 = 有光晕 + 正常。⚠ 正在查看的节点**不享「不淡化」豁免**（曾为了让它可见而豁免，与「已过即淡化」打架）。
        - `data-highlighted` 钩子的含义 = **今天到期**（时间通道），与光晕（`isViewedDay`）是两回事。
      - **今天列与同日节点的相对位置**：`todayIndex = 首个与今天同一天的节点 ?? 首个尚未发生节点 ?? nodes.length`——即「今天与某些节点同一天时，今天放在这些节点的**最左侧**」（用户指定）；无同日节点时仍插在首个尚未发生节点之前。⚠ 副作用（已知且可接受）：与今天同一天、但已过时刻的节点会落在今天标记右侧（深色侧），而它自身仍按 `utc <= now` 淡化——即线段深浅是**日粒度**的分界。
      - **同日之间的线段用虚线**（用户提议，表示「零时间间隔」）：`markerDay(from) === markerDay(to)`（含「今天」标记本身，如「今天 → 今天到期的节点」）→ `border-t border-dashed`（颜色仍按今天左右侧取浅/深）；数字上相等的日期不可信（各列等宽，与真实间隔无关），虚线是给读者的「这两端其实是同一时刻」的指引。实线段仍是「今天左侧浅 / 右侧深」。
      - ⚠ **线段回归断言（四条件都要）**：① 同一线段的两半段必须「同为虚线」或「同为实线且亮度相同」（曾因整列 opacity 衰减出现一个线段两种颜色）；② 实线以「今天」为界左浅右深（用合成到白底后的**亮度**比较，**勿用 alpha**——同色相下 alpha 越小反而越浅，曾因此写反）；③ 虚线数 = 「同一天相邻列」对数 × 2（测试内按组件同一规则重算：节点列按序对应 nodes、「今天」列即今天）；④ 从半段到 `ol`（不含 `ol`）的**祖先 opacity 乘积恒为 1**。⚠ 条件④必须用 `Math.min` 而不是 `Math.max`（用 max 会把「个别列被淡化」漏过，反向验证时实测漏过）；⚠ 也不要把弹窗自身的 opacity 计入（弹窗入场动画会让整棵树 opacity=0，断言会被空过）；⚠ 测试里的辅助函数必须写在 `evaluate` 内部（浏览器侧），引测试作用域闭包会 ReferenceError。
    - **轴线上的节点 = 大圆 + 圆内图标（用户指定方案，替换了此前的「小圆点 + 上方徽章」）**：每列自上而下 = 名称槽（可选文字）→ 日期 → **`size-6`（实测 22.8px）的圆**；圆内嵌该节点类别的图标，**边缘与内部同色**（实心，用户指定）：`CATEGORY[].dotClass` = 浅色主题 `border-<cat>-600 bg-<cat>-600 text-white`、深色主题 `dark:border-<cat>-500 dark:bg-<cat>-500 dark:text-<cat>-950`（整串静态类名）。
      - ⚠ **实心圆的对比度已实测达标**（canvas 换算 + WCAG 公式，勿凭感觉改号）：浅色主题白图标 on `-600` = violet 5.89 / rose 4.53 / sky 4.02 / emerald 3.65 / **amber 3.20（最紧）**，均 ≥3:1（WCAG 1.4.11 图形元素）；深色主题 `-950` 图标 on `-500` = amber 7.03 / emerald 6.14 / sky 5.13 / rose 4.18 / violet 3.46，均达标。圆 vs 背景：`-600` on 白 ≥3.2、`-500` on 近黑 ≥5。
      - 「今天」列的空心圆 = **同尺寸** `size-6` + **`border-2 border-foreground`**（用户指定「加粗一点的黑线」）。⚠ 实测两者外径都是 22.8px（**本来就一样大**），觉得「今天更大」是空心轮廓的视觉错觉——加粗描边后视觉重量与实心圆一致；**不要靠缩小今天圆来解决**（不同直径会破坏「圆串在一条线」的对齐）。
      - **为什么比「小圆点 + 徽章」好**：图标**永远在**（不像徽章要靠宽度三档自适应去升降级），所以「空间不足」只是少一档名称文字、不会丢类别信息，紧凑档也不再显得像妥协。于是只需**一档判定**（不再是 icon / text / both 三档）。
      - ⚠ **圆内图标必须「单独出现时也认得出」**：列窄时图标是唯一的类别线索，而 `FileText`（旧「摘要」）与 `FileCheck`（「全文」）在 14px 下轮廓几乎不可分（偏偏这两个最常用）→ 「摘要」已改用 `FilePenLineIcon`（文件 + 笔）。⚠ 也别用纯 `Pencil`——它已是「编辑备注」按钮的图标，同弹窗内会撞车。改类别图标前先想清楚这两点。
      - 名称显示判定 = 「列宽 vs 该名称的**实际渲染宽度**」：`TIMELINE_LABEL_EXTRA_PX = 8`，判据 `列宽 ≥ 文字宽 + 8` 才显示、否则**整条不渲染**（不截断）。⚠ **不要改回「折两行」**：曾用 `line-clamp-2` + 两行槽（`h-8`）试过一版，同一届的列「1 行/2 行参差」、断词尴尬（用户反馈观感很差）。短标签（`Main` / `Spring` / `Poster`）单行都放得下；放不下的（如 35 字符的 `Paper submission deadline (cycle 1)`）直接隐藏、只留圆内图标。实测：ADMA 6 节点（68.4px 列）六个名称全部单行显示、无截断。
      - ⚠ **名称槽必须占位（固定单行高）**：`<span className="flex h-4 … items-center justify-center">`（`h-4` = `text-xs` 行高）——名称不显示时也要留槽，否则该列的日期与圆会整体上移、与相邻列错位（E2E 不变式④即为此）。「今天」列的文字用同一个槽样式。
      - 测量靠与名称同字号字重的**隐藏探针** `[data-slot=timeline-probe]` 量文字宽；结果存 `showLabels` state（未量出前**不显示** = SSR/首帧的保守档）。重算触发：`ResizeObserver`（ol）+ `window resize` + **弹窗入场动画结束后 350ms 兜底** + `document.fonts.ready`（Inter 未加载完量出的文字宽偏小）。⚠ 集成浏览器的 `setViewportSize` 既不触发 RO 也不派发 `resize`（页面被节流），验证时得手动 `window.dispatchEvent(new Event('resize'))`。
      - ⚠ **勿改用 CSS 容器查询**（列上 `@container` + `@max-[…]:`/`@min-[…]:`）：节点列是 flex item，而内容又受容器查询控制 → **互为因果**，浏览器会落到不同「不动点」。实测同一届本该等宽的四列同时出现 **57px 与 117.8px** 两种宽度、且判定结果互不一致。
      - ⚠ **勿改用「按语言分组的固定阈值」**：中文页的 `camera` 文案也是英文 "Camera-ready"（≈62px），与「全文」（≈23px）差 2.5 倍，任何一组定值都必然让一侧错档（中文被无谓隐藏 / 英文被截断）。
      - 列宽下限 `min-w-12`（=「今天」列的 `w-12`，实测 45.6px）：与「今天」列同宽（圆串在一条线上更整齐），又比旧值 `min-w-18`（72px）紧凑——超长届别（VLDB 2027 的 24 节点）横向滚动从 1776px 降到 1200px。⚠ 曾试 `min-w-10`（40px）：跨年节点的 `2026/12/15`（≈66px）会截断得更多，且与「今天」列宽度不齐，故取 45.6px。跨年日期在 45.6px 列下仍会截断（完整时刻在悬浮 `title` 里），属上述「截断 + title」原则内。
      - **E2E 五条不变式（与具体数据无关）**：① 每列都有「大圆（≥20px，区分旧 10px 小圆点）+ 圆内图标」；② 列宽 ≥ 100px **必须**显示名称；③ 名称不超出列宽、不被截断；④ 各列的名称槽 / 日期 / 圆 top 一致（靠槽位占位）；⑤ 今天列的空心圆与事件圆同尺寸、同一水平线。已做反向验证（把事件圆的 `size-6` 临时改成 `size-2.5` → 条件①、⑤ 立刻红）。
    - **轮次短标签（让同一天、同类型的多条日程可区分）**：ccfddl 的节点备注 `c`（如 "Poster Paper" / "Encore Paper"）经 `lib/ical.ts` 的 `conferenceRoundLabel()` 清洗后用在**四处**：
      - 清洗三步：① trim 后 **≤ 40 字符且不含 `.:;,`** 才采纳（`c` 也可能是整句说明，如 "Supplementary material due Sep 2, 2026. …" → 不采纳、回退类别名）；② 去掉尾部 `" Paper"`（类别名已表达）；③ **反复剥掉尾部流程词**（`Track|Session|Paper|Deadline|Cycle|Submission|Round|Phase|Schedule`，剥完为空则停）：`Spring Submission Deadline` → `Spring`、`September Cycle Submission Deadline` → `September`、`Main Track` → `Main`、`Special Session` → `Special`、`Cycle 1 Submission deadline` → `Cycle 1`。实测 313 个会议：**205 个可清洗标签中 136 个被缩短，同一届内零冲突**（核心词仍能区分）。
      - ⚠ 第 ③ 步是必需的：标签会**直接显示在时间线节点名里**（列宽仅 45~70px），原样长度只会折成两行、断词尴尬 —— 实测 ADMA 2026 的 6 列出现「1 行/2 行参差」（用户反馈「观感很差」），剥成短标签后才整齐。
      1. **UID**（`app/api/deadlines/caldav`）：`缩写-年份-类型[-轮次slug]`（slug = 短标签小写、非字母数字转 `-`，如 `adma-2026-paper-poster` / `asplos-2027-paper-september`）——同日同类型的多个节点因此各自成为**独立日程**（否则互相覆盖，日历里只留得下一条）；写入**成功后**顺带 DELETE 旧的「不含轮次」UID（幂等迁移；放 PUT 之后，写失败时旧的还在）。⚠ 清洗规则改动会改变 slug → 已写入的这类事件需**重新添加一次**，且旧 UID 要手动删除（写入端只自动清理"不含轮次"那一种旧格式）。
      2. **SUMMARY / .ics 下载 / Google 链接**（`icsEventSummary(abbr, year, labelKey, round)`）：`ADMA 2026 · Poster Full Paper`——外部客户端（Apple / 华为）只有标题可用，不带轮次时同一天的两条事件长得一模一样。
      3. **弹窗标题 / 月视图 tooltip**（`appointmentDisplayTitle`）：`ADMA 2026 · Poster 全文`。
      4. **列表徽章**（`CategoryBadge` 的 `round` prop）= `Poster 全文`，**时间线节点名**（`nodeLabel`）= `Poster`（无轮次时回退类别名）。
      - ⚠ **事件 ↔ 节点的定位必须优先按 `SUMMARY` 里的「轮次 节点词」精确匹配**（`matchedConferenceNode`），**不能只用时刻**：同一天多个节点可能**共用同一截止时刻**（Poster / Encore），时刻匹配只能命中第一个——实测修前两条日程都显示成 "Poster 全文"、打开 Encore 时亮的是 Poster 那列。时刻容差匹配保留为回退（旧格式事件 / 第三方写入的无轮次事件）。时间线的「当前节点」（光晕 + `aria-current`）也用同一个函数定位。
      - 时间线节点名用**短标签**（`nodeLabel = conferenceRoundLabel(node) ?? 类别名`），名称槽固定**单行** `h-4`。
      - ⚠ 月视图 chip 文字与列表行标题仍用 `appointmentBaseTitle`（洁净标题，不含节点词）——**不要**给它们再加轮次（会与徽章重复）。
      - 实测数据分布：**168 短标签 / 53 长句 / 536 无备注**。清洗规则改动后，已写入的事件需**重新在卡片菜单里添加一次**才会换成新 UID / 新 SUMMARY。
    - ⚠ **文字一律单行截断 + `title` 悬浮看详情（用户指定方案）**：名称与日期都 `truncate`（**名称另有策略：放不下就整条不渲染，见上条**），完整信息（完整时刻 · 节点名 · 轮次备注，可点时附「切换到该节点日程」）放 `title`——**勿改回多行/换行撑开列**。悬浮用原生 `title`（非 Tooltip 组件）是因为部分节点不可点，`TooltipTrigger` 挂非 button 宿主会触发 Base UI 的 `nativeButton` 警告（参见入口渲染那条教训）。
    - **点击节点跳转**：按「同会议同届 + 时刻一致（±1 分钟）」在已加载事件里找**另一条**日程 → `setSelected()` 原地切换弹窗（网格不动）。⚠ **必须排除事件自身 uid**：同届两个节点共用同一截止时刻时（ADMA 2026 的 Poster / Encore），未命中的那列会找到当前事件而显得可点、点下去却无反应。
    - **长届别**（VLDB 2027 有 24 个节点）：`ol` 横向滚动，`useEffect` 用 rect 差（`curRect.left - listRect.left - (…)/2`）把当前节点居中——⚠ **勿用 `scrollIntoView`**（会连带滚动弹窗与页面）；dep 为 `[event.uid, abbr, year]`，在组件早返回**之前**调用（hooks 不能条件化）。
    - **弹窗宽度/布局**：见上条「2026-09-13 重大改版」（`min()` + `!`；窄屏全宽竖向、宽屏分栏）。
    - **单节点会议不显示**（一列不成时间线）。E2E 钩子与断言：`[data-slot=timeline-node]` 行数 = 节点数（同日节点仍各占一行）/ `[data-slot=timeline-today]` 恰 1 个 / `[data-slot=timeline-today-dot]` 空心圆 / `[data-slot=timeline-today-date]` / `[data-slot=timeline-today-label]` / `data-highlighted="true"` = 今天到期的节点（时间通道，与「打开哪条」无关）/ `aria-current=true` 恰 1 个（**精确命中时刻**的那个节点）；几何（「今天」行的圆/名称/日期**同一行**、圆垂直居中、水平顺序 = 圆 → 名称 → 日期、「今天」在日期之上、各行同一 `left` 且 `top` 递增）、每节点有悬浮 `title`、点可点列的 `button` 后弹窗标题变化（另断言：光晕恰 1 个且与 `aria-current` 一致、今天列无光晕、打开节点按日期规则淡化）。
- **⚠ Base UI 迁移陷阱**：Base UI 1.x 的 `MenuItem` 用 **`onClick`**（非 Radix 的 `onSelect`）——`onSelect` 会被静默忽略且不报错，曾致日历菜单三个动作全部失效。项目内 DropdownMenuItem 一律用 `onClick`。
- **⚠ 菜单项事件冒泡**：Base UI 菜单默认渲染在卡片组件树内（Portal 仅影响 DOM 树），菜单项 `click` 会按 **React 组件树**冒泡到卡片触发其 `onClick`（如打开详情 Dialog）。凡卡片内嵌 DropdownMenu，菜单项 `onClick` 必须 `e.stopPropagation()`。

### 我的日历（站主专属，`/calendar`）

- **用途**：站主浏览器内查看 CalDAV 日历的月视图（会议 Deadline + 个人事件）；**仅供站主**（`requireOwner` 守卫，未登录重定向 `/login`），顶部导航登录后显示「日历」一级入口（`owner-nav-item.tsx` 中与「速记」并列）。
- **API**：`GET /api/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD`（`isOwner` 守卫；参数不合法 400；CalDAV 未配置 503；网络失败 502）→ CalDAV `REPORT`（calendar-query + `time-range`）查询 Radicale → 解析 multistatus XML 中的 `calendar-data` → `parseIcsText` 解析日程。30 秒内存缓存（`?v=` 参数绕过——**cacheKey 必须含 v**，前端刷新按钮靠它生效；缓存实现在 `lib/caldav/cache.ts`）。**⚠ time-range 的 end 是排他**（不含当天），结束日期需 +1 天（`toRangeEndExclusive`），否则 start==end 时区间为空（曾致聚焦某天显示「当天暂无日程」）。
- **删除日程**：`DELETE /api/calendar/events/[uid]`（`isOwner` 守卫；UID 校验字符集 `[A-Za-z0-9._@+-]` 防路径注入；CalDAV 未配置 503）→ REPORT 按 UID `text-match` 查资源 href → 逐一 `DELETE`（404 视为已被其他客户端删除，算成功）→ `invalidateCalendarCache()` 清缓存。UI：日程详情 Dialog 左下「删除日程」两步确认（首次点击变「确认删除」，5 秒未再点自动复位；执行中 spinner），成功后关 Dialog + 刷新。**⚠ Next.js route.ts 只能导出 HTTP handler 与少数配置，导出业务函数会触发类型错误（`Property is incompatible with index signature`）**——缓存等共享逻辑放 lib，路由间互相 import 也不行（`events/[uid]` 不能 `import "../route"`）。
- **双向联动**：网格点击日期格聚焦（再次点击取消；非当月格自动跳月）→ 下方 `DayEventsList` 按需加载当天事件（跨天事件每天可查）；未聚焦（`selectedDate === null`，初始默认）→ 下方 `UpcomingEventsList` 显示**当前查看月份+之后 7 个月**事件总览，点击跳转对应月份并聚焦。
- **事件备注（站主可编辑，**就是标准的 `DESCRIPTION`**）**：详情弹窗底部「备注」项（`components/calendar/calendar-view.tsx` 的 `AppointmentNote`）→ `PUT /api/calendar/events/[uid]`（body `{note}`，空串 = 删除；1000 字符上限，前后端同值）。存 `DESCRIPTION` 的好处：**Apple/华为日历的「备注/描述」框读写的就是它**，用户在手机端改完本站刷新即见（反之亦然）。⚠ 会议全称另存 `X-CONF-NAME`，与备注互不干扰（详见「事件字段归位」）；曾用自造 `X-USER-NOTE` → 又改 `COMMENT`（RFC 语义确实匹配，但 Apple/华为都不展示，达不到「手机端可见」）→ 最终定案 `DESCRIPTION`。**写入必须走属性级就地改写**（`lib/ical.ts` 的 `upsertIcsProperty`：展开折行 → 替换/插入/删除单个属性行 → 写回），⚠ **勿改成「解析成对象再重建 ICS」**——本站只认识事件的一部分字段，重建会静默丢掉外部客户端写入的 `VALARM` / `ATTENDEE` / 其它属性。⚠ **旧事件首次写备注时服务端自愈**：若无 `X-CONF-NAME` 且有 `CATEGORIES`，先把旧描述首行（即全称）落到 `X-CONF-NAME`，再写 DESCRIPTION，否则会把全称抹掉。备注随事件存储（删事件即删备注，不需第二份存储）。⚠ **`POST /api/deadlines/caldav` 在覆盖写入前会先 GET 旧事件继承 `DESCRIPTION`——但仅当旧事件带 `X-CONF-NAME`**（否则那段描述是旧格式的全称，不能当备注）。备注用例未纳入 E2E（会写真实日历数据），靠人工验证。
- **UpcomingAppointmentsList 空态（勿改回，用户指定语义）**：网格下方**无独立空状态块**（曾显示「本月暂无日程」与下方列表信息重复，已移除）；`UpcomingAppointmentsList` **以当前查看月份（`viewDate`）为第一分组并始终显示**（分组 label 无「（本月）」标记——用户明确标记多余），查看月无日程时分组内显示「本月暂无日程」虚线占位（`border-dashed`）；非查看月的无日程月份不显示（如查看 6 月时 7 月无日程则跳过）。**数据范围跟随 `viewDate`**：`/api/calendar` start = 查看月 1 日 ~ 之后 7 个月末（useEffect deps 含 viewDate，翻月即重取）。查看月及之后均无日程（`events.length === 0`，勿用 `groups.length`——占位组使 groups 恒非空）时显示「本月及未来暂无日程」+ `emptyHint` 引导文案。
- **iCal 解析**：`lib/ical.ts` 的 `parseIcsText`（与写入共用文件）——支持行折叠、UTC（Z 结尾）、全天（`VALUE=DATE`，`DTEND` 不含结束日）、浮时；TZID 事件降级为浮时（按访客本地解释）。UTC 事件客户端按浏览器本地时区显示（如上海 UTC+8）。
- **UI**：`components/calendar/calendar-view.tsx` —— 基于 **REUI `EventCalendar`**（`npx shadcn add @reui/c-event-calendar-4`，custom event chips 示例）的卡片式月视图（`Card` 包裹、`h-[640px]`、**周起始默认周日（zh/en 统一），可在「设置」Dialog 切换为周一**（偏好 `calendar:weekStart`，见「主人偏好持久化」；`weekStartsOn = prefs[...] === "monday" ? 1 : 0`，JumpDatePicker 同步传该值）、`maxEventsPerCell={3}` 溢出「还有 N 个」+ popover、多日事件渲染为连续横条）。工具栏为自定义 `EventCalendarNav` children：**左右两个半区——左半区全部 ghost 无边框（「本月」「今日」纯文字按钮 + `‹ 年月 ›`，年月标题即日期选择器入口，点击弹出 rdp 日历跳转并聚焦），右半区 `EventCalendarToolbar` 带边框（刷新 / 设置，均 outline）**。卡底部（`</EventCalendar>` 后、`border-t`）有**颜色图例**：六类圆点 + 标签（`CATEGORY` map 驱动，样式同 reui 示例）。下方 `DayEventsList`/`UpcomingEventsList` 双向联动与删除 Dialog 保留自绘。
- **事件类别体系**：`categorizeEvent()` 按 summary 关键词归为 摘要/全文/注册/Camera-ready/通知/其他 六类（`CATEGORY` map：`var(--color-*)` + lucide 图标 + 列表徽章完整类名，勿动态拼接 Tailwind 类）。**月视图 chip = `[彩色类别图标] 标题`**（无时间前缀，颜色由 `--ec-event-color` 注入）；**列表视图用彩色 pill 徽章**（`CategoryBadge`：类别色文字+淡底，整行保持中性）；详情 Dialog 标题前有类别色圆点。tooltip = 标题 + 类别点·时间 + 描述。
- **聚焦 vs 今日（勿改回，用户指定语义）**：今日 = **空心圆圈**（日号透明底 + primary 色 + 1px 内环，`box-shadow: inset 0 0 0 1px`）；聚焦 = **灰底（`bg-primary/10`）+ 日号实心圆圈**；今日与聚焦同日时聚焦优先（实心+灰底）。实现分三层：① `todayClassName="bg-transparent border-b-transparent"` 去掉 REUI 内置的今日 cell 高亮（`bg-primary/3` + 顶部 2px 条）与日号实底圆；② `dayClassName` 返回 `ec-day-focused bg-primary/10`（`ec-day-focused` 是标记类）；③ globals.css 用**属性选择器组合覆盖** REUI 内联 Tailwind 类（`[data-today] [data-slot=…day-number]` 特异性 0-3-0 > 0-1-0）——**`.ec-day-focused` 规则必须写在 `[data-today]` 规则之后**（同优先级后者胜，实现同日叠加时聚焦优先）。`onSlotClick` 点击日期格聚焦/取消聚焦、非当月自动跳月；「今日」按钮 = `goTo` + 聚焦，「本月」= `goTo` + 取消聚焦。本月日号 `font-size: 0.8125rem`（13px）不加粗（REUI 日历整体 `text-xs` 12px、正文 16px，取偏小；用户试过 16px 加粗太大、17px/14px 也偏大，勿再加大），非本月保持 12px 默认。今日/聚焦圆圈 `1.375rem`（22px，REUI 默认 `size-5` 20px，放大一点两者协调）。
- **REUI EventCalendar 集成经验**（`components/reui/event-calendar/`，版本随 shadcn add 安装）：
  - **数据加载用 `onRangeChange` 驱动**：挂载时自动触发一次 + 翻月/跳转时触发，`info.range` 即可见范围。**⚠ range 不变时刷新按钮不会触发它**——刷新需显式重取最近范围（`lastRangeRef` 保存 + 直接调用加载函数），否则 API 30s 缓存（`?v=` 参数）会返回旧数据。
  - **日程映射**：全天日程 start/end **必须是显示时区（浏览器本地）的午夜且 end 排他**（`allDayDate` → `new Date(y, m-1, d)` ~ `new Date(y, m-1, d+days)`）；定时日程用原始 UTC/浮时；`end` 须 > `start`（缺 DTEND 兜底 +1h）。`data` 携带原始 `ParsedIcsAppointment` 供详情 Dialog / tooltip 用（`id` 用 `ev.uid`）。
  - **`interactions={{ drag:false, resize:false, selectSlot:false }}`** 只读月视图；`onEventClick` 打开详情、`onSlotClick`（点击日期格）实现聚焦联动（非当月格自动 `apiRef.goTo` 跳月并聚焦，再次点击取消聚焦）。
  - **i18n**：`i18n` prop 覆盖 `labels.today/previous/next/allDay/more/goToDate` 等复用现有翻译 key（`labels.more: (n) => t("more", {n})`），`formats.monthTitle`（zh `"yyyy年M月"` / en `"MMMM yyyy"`）；`locale` 传 date-fns locale（`date-fns/locale` 的 `zhCN`/`enUS`）。
  - **⚠ REUI 内置 `EventCalendarDatePicker` 只 `goTo` 不聚焦**（无 onPick 回调）——为保留「选日期→聚焦联动」用自绘 `JumpDatePicker`（shadcn Popover + `components/ui/calendar.tsx` + `useEventCalendarNavigation().goTo`）。
  - **⚠ rdp 10 用 `startMonth`/`endMonth`**（Date 对象）而非旧版 `fromYear`/`toYear`（类型不存在，build 直接失败）；`captionLayout="dropdown"` 默认范围是 100 年前~今年底，需显式 `startMonth`/`endMonth` 收窄。
  - **⚠ rdp 下拉替换为 Base UI Select**（`components={{ Dropdown: CalendarDropdown }}`，替代原生 select）：① **必须给 `SelectTrigger` 加 `relative z-10`**——rdp 的 `Nav`（`absolute inset-x-0`）先于 `MonthCaption` 渲染，会盖住中间的 static 下拉按钮（原生 select 靠 absolute+opacity-0 天然在上层，自定义组件没这个待遇）；加在 `dropdown_root` classNames 无效（整体替换后该容器不再渲染）。② **`SelectValue` 的 label 自动解析在 popover 内不可靠**（会回退显示 value 数字如「7」而非「8月」），须显式 `items.find(o => String(o.value) === String(value))?.label` 传入 children。③ rdp 的 `onChange` 只读 `e.target.value`，Base UI `onValueChange` 回调里伪造 `{ target: { value: String(v) } }` 事件即可。④ `DropdownProps` 的 `size`（原生 select 的 number 属性）与 `SelectTrigger` 的 `size` 变体 prop 同名冲突，且其余原生 select 事件处理器与 button 不兼容——**只解构 `options/value/onChange/aria-label`，其余丢弃**。
  - **⚠ 月视图 DOM**：日期格 `[data-slot=event-calendar-month-cell]`（非当月带 `data-outside`、今天带 `data-today`），日期号 `[data-slot=event-calendar-month-day-number]`（右下角，今天 primary 圆底），周表头 `[data-slot=event-calendar-month-header]`（zh 的 `EEE` = 「周一」）；事件 chip `[data-slot=event-calendar-event]`（chip 点击不会触发 cell 的 `onSlotClick`，组件已隔离）。
  - **⚠ E2E dispatchEvent 需等 hydration**：SSR 渲染的 heading 可见 ≠ React 事件已挂载——就绪信号由 `gotoReady`（等 `data-hydrated`）提供，**勿加回定时等待**。另注意 `dispatchEvent` 的调用写法用 `cell?.dispatchEvent(...)`：**找不到单元格时会静默什么都不做**（曾把「单元格没找到」误判成「点击被吞」），排查时先确认真实命中。
  - **⚠ 已修复上游 REUI 的哨兵初值缺陷（`event-calendar-dnd.tsx`，勿改回 `= 0`）**：模块级 `lastGestureEndedAt` / `lastChipPressAt` 初值为 `0`，而 `wasRecentDrag()` / `wasRecentChipPress()` 是 `performance.now() - 哨兵 < 250 / 300`，`performance.now()` 又以**导航开始**为原点 ⇒ **页面加载后 250ms（点击格）/ 300ms（chip）内的点击被当成「刚结束的手势」静默丢弃**。standalone 首屏 hydration 约在 250ms 完成，E2E「点击日期格聚焦」因此在「刚 hydration 完就点」时红、加等待就绿（曾误判为偶发）；真实用户在快网速下点首屏日期格同样无反应。修复 = 两个初值改 `Number.NEGATIVE_INFINITY`（同一文件另有一处 `markChipPress` 写入真实值，不受影响）。排查手法：在点击处打印 `performance.now()`——落在 300 以内即命中该窗口。
  - **⚠ `npx shadcn add` 生成的示例 `components/examples/c-event-calendar-4.tsx` 有类型错误**（`useRef<EventCalendarApi>` 缺泛型 → build 失败），需改成 `useRef<EventCalendarApi<EventData> | null>`；REUI 组件内部 ~21 个 lint warning（`_v` 等 destructure-strip 模式）属安装产物，保持 0 error 即可。
- **官方 Calendar 组件**：`components/ui/calendar.tsx`（react-day-picker 10 封装，`--cell-radius` 变量在 globals.css）。`JumpDatePicker` 用它做跳转选择器（`captionLayout="dropdown"` + `startMonth`/`endMonth` + `timeZone` prop 避免 SSR 不一致）。
- **注意**：本地验证需 `CALDAV_*` 环境变量注入（standalone 不自动加载 `.env`，`.env` 的 `RECOVERY_CODES` 含逗号无法 `source`）——`export CALDAV_URL=... CALDAV_USER=... CALDAV_PASSWORD=...` 后启动。Radicale 集合不存在时 REPORT 返回 404，按空日历处理（不报错）。

### CalDAV 凭证设置（站主在「日历」页面配置）

- **用途**：站主无需改 VPS `.env`，直接在 `/calendar` 工具栏「设置」里管理凭证：**查看用户名/密码明文、修改或随机重置密码**。适合初始化时尚未部署 env 凭证的场景。
- **存储**：`lib/caldav/store.ts` 读写 `data/caldav.json`（与 ideas.json 同款原子写入 + **chmod 600** 收紧权限；`/data/` 已在 .gitignore，凭证不入库）。**只存用户名+密码**，服务器地址由部署环境决定（环境变量 `CALDAV_URL`），不在网站内配置。
- **读取优先级**：`getCalDavConfig()` = 文件凭证（用户名/密码）> 环境变量（`CALDAV_URL`/`CALDAV_USER`/`CALDAV_PASSWORD`，compose 注入作为回退）。`GET /api/calendar` 与 `POST /api/deadlines/caldav` 均走此函数。
- **API**：`GET/PUT/DELETE/POST /api/calendar/credentials`（`isOwner` 守卫；游客 401）。
  - GET 返回 `{configured, source(file/env), user, password, pending}`——**含密码明文**（仅站主会话可访问，单站主场景无泄露面）
  - PUT 校验 user 必填/密码限长，密码留空保留原值（**回退链：文件凭证 → 环境变量 `CALDAV_PASSWORD` → 均无才报「首次设置必须填写密码」**——环境变量来源时留空密码可保存，文件凭证继承 env 密码，避免「页面显示已配置、保存却要求首次填密码」的语义分裂）；**同步队列触发条件：密码变更 / 首次写入文件凭证 / 用户名与文件凭证不同**（用户名变更也会登记队列，apply-calendar-reset.sh 对不存在的用户是追加，改用户名后 Radicale 才有对应用户，否则日历 API 401）
  - POST 随机重置：`randomBytes(24).toString("base64url")` 生成强随机密码 → 更新网站侧 + 登记队列 → 返回 `{user, password}`
  - DELETE 清除文件凭证回退环境变量
- **密码同步 Radicale（VPS crontab）**：网站侧密码变更（PUT 改密 / POST 重置）会原子写入 `data/caldav-reset.json` 队列；VPS crontab 每分钟执行 `scripts/apply-calendar-reset.sh` → `openssl passwd -5` 生成 sha256 hash → 更新/追加 `radicale/users` → 删除队列文件。Radicale 配置 `htpasswd cache: False`，改文件立即生效无需重启。**部署时须安装 crontab**（setup-calendar-vps.sh 自动安装；手动：`* * * * * ~/personal-homepage/scripts/apply-calendar-reset.sh`）。
- **UI**：`components/calendar/calendar-settings.tsx`——工具栏「设置」齿轮按钮 → Dialog（当前用户名+密码明文展示、待同步 pending 提示、用户名/密码表单、随机重置按钮、新密码高亮展示），保存/重置成功 toast 并 `onSaved` 触发日历刷新。
- **默认用户名**：setup 脚本 `CALDAV_USER` 默认 `ysy`（与部署用户同名）。
- **E2E**：凭证用例自清理（保存后 DELETE + 删除队列文件），失败残留时会写入 standalone data 的 caldav.json / caldav-reset.json；重跑前可 `rm -f .next/standalone/data/caldav.json .next/standalone/data/caldav-reset.json`。

### 关键经验

1. **改 `docker-compose.yml` 必须手动同步 VPS**：流水线只拉镜像，不同步 compose 文件。`scp -i ~/.ssh/vps-deploy docker-compose.yml ysy@106.14.135.32:~/personal-homepage/` 后由流水线（或手动 `docker compose up -d web`）重建容器。漏同步会导致容器缺环境变量/挂载（曾致登录 401、数据无法落盘）。
2. **GHCR 从 VPS 拉取慢/易卡死**：流水线已内置 3 次 × 10 分钟超时重试。**勿手动并行 pull 与流水线竞争**；需手动接管时，等流水线失败后再操作。
3. **数据目录权限**：容器以 uid 1001（nextjs）运行；docker 创建的绑定挂载目录属主为 root，需修正：`docker run --rm -v $HOME/personal-homepage/data:/data alpine chown -R 1001:1001 /data`。
4. **推送命令**：本机 SSH config 可能使 GitHub 认证走错密钥，需强制指定：`GIT_SSH_COMMAND="ssh -F /dev/null -i ~/.ssh/id_rsa" git push origin main`（`-F /dev/null` 忽略 SSH config，`-i` 指定 GitHub 部署密钥）。
5. **VPS sudo 需密码**（agent 无法执行）；docker 命令无需 sudo（ysy 在 docker 组）。
6. **VPS 只读检查**：`ssh -i ~/.ssh/vps-deploy ysy@106.14.135.32 "..."`；compose 目录 `~/personal-homepage/`。
7. **生产验证**：`curl -s -o /dev/null -w "%{http_code}" https://shaoyuanyu.cn/xxx`、`curl -s https://shaoyuanyu.cn/api/auth/me`；登录后创建/删除 idea 验证落盘（测试后清理）。

## 博客（多语言文章，`/blog` 与 `/en/blog` 同一批文章）

- **语义（勿改回「按语言各列各的」旧行为）**：`slug` 是**文章标识**而非语言版本标识——同一 slug 出现在 `content/posts/zh/` 与 `content/posts/en/` 下即同一篇文章的两个语言版本。`/blog` 与 `/en/blog` 列出**同一批文章**；某篇文章缺当前语言版本时**回退显示原文**（默认语言 zh），即「只有中文版的文章在 `/en/blog` 下也显示中文原文」。因此 `/blog/<slug>` 与 `/en/blog/<slug>` 总是成对存在（`generateStaticParams` 返回 `全部文章 × 全部语言`），语言切换不会 404。
- **聚合层**：`lib/data/blog.ts`（`lib/data/index.ts` 转出）——`blogArticles`（按 slug 聚合）、`resolvePost(article, locale)`（目标语言 → 默认语言 zh → 任一版本）、`listPosts(locale)`（该语言可见的全部文章，按**实际展示版本**的日期倒序）、`getPost(locale, slug)`、`blogStaticParams()`。**旧的 `posts` 直出数组已移除**，页面一律改用这些函数；新增消费方也勿再直接 import `@velite/index`。
- **⚠ velite slug 唯一性坑（`velite.config.ts`）**：`s.slug("posts")` 的唯一性校验是**集合级**的——`zh/welcome.mdx` 与 `en/welcome.mdx` 同为 `slug: welcome` 会被判 `duplicate value`（构建期报错、且其中一条被丢弃），**这正是早期「中英文博客内容不一样」争论的根因之一**。故 schema 已改为普通字段 `s.string().min(3).max(200).regex(slug 正则)`（保留格式约束、去掉唯一性），改由 `lib/data/blog.ts` 按 `(locale, slug)` 校验：同语言重名抛带文件路径的错误，跨语言同名合法。**勿改回 `s.slug()`**。
- **⚠ velite 忽略下划线开头的文件**：`content/posts/zh/_probe.mdx` 这类文件名不会被收录，且**不报任何错**（曾误判为「slug 重复导致静默丢弃」）。做临时验证时勿用 `_` 前缀命名。
- **回退提示**：正文语言与页面语言不一致时（`post.locale !== locale`），详情页正文上方显示虚线框提示（`blog.fallbackNotice` + `blog.contentLanguage.{zh,en}` 文案，`LanguagesIcon`）。新增语言时同步补这两个 key。
- **canonical（SEO）**：详情页 `alternates.canonical` 指向**正文实际语言**的 URL——回退页（如 `/en/blog/<仅中文的 slug>`）canonical 指回 `/blog/<slug>`，避免同一内容在两种语言下被重复收录；JSON-LD 的 `inLanguage` 同样用 `post.locale`（正文语言）而非页面 locale。`siteUrl` 已有 `metadataBase`，故 canonical 用相对路径即可。
- **同步改动点**：`app/[locale]/blog/page.tsx`（列表）、`app/[locale]/blog/[slug]/page.tsx`（详情 + 相邻文章 + JSON-LD + 回退提示）、`app/[locale]/blog/[slug]/opengraph-image.tsx`、`app/[locale]/page.tsx`（首页最新文章）、`app/sitemap.ts`、`app/feed.xml/route.ts`（feed 以默认语言视角列出全部文章，链接指向正文语言 URL）。
- **E2E（`e2e/smoke.spec.ts` 博客多语言用例）**：回退提示框带 `data-slot="blog-fallback-notice"`，**断言必须用该属性**（`page.locator('[data-slot="blog-fallback-notice"]')`）——next-intl 会把整个 `blog` 消息字典注入 RSC payload（客户端组件 `BlogSearch` 用 `useTranslations("blog")`），故页面上即使没有渲染提示框，`getByText(/本文暂无中文版本/)` 也可能命中 payload 文本而误通过。
- **⚠ E2E 混用 `/en/*` 与无前缀路径会串 locale**：访问 `/en/*` 后 next-intl 写入 `NEXT_LOCALE=en` cookie，同一 browser context 内**之后**的无前缀路径会被重定向到 `/en`（`playwright.config.ts` 的 `locale: "zh-CN"` 只影响首次、无 cookie 时的判定）。该用例因此**先测中文（无前缀）再测英文（/en）**，并在开头 `page.context().clearCookies()`。此前 `/blog/welcome` 的中文标题断言一直被掩盖——因为 `/en/blog/welcome` 回退后也显示中文标题。
- **双语文章的手动验证**（E2E 不含双语样本，内容侧只有 welcome 仅中文、llm-interpretability-notes 仅英文）：临时 `content/posts/en/welcome.mdx`（`slug: welcome`）→ `pnpm build` → 确认输出含 `/en/blog/welcome` 与 `/zh/blog/welcome` 两组路由（**跨语言同名 slug 不再报 duplicate value**）→ `pnpm start` 后 `/blog/welcome` h1 为中文标题、`/en/blog/welcome` h1 为英文标题且**无**回退提示 → 验证完删除该临时文件。
- **新增语言**：`lib/i18n/routing.ts` 加 locale → `content/posts/<locale>/` → `messages/<locale>.json` → `blog.contentLanguage` 补语言名 → `lib/data/blog.ts` 的 `FALLBACK_LOCALE` 无需改（仍为站点原文语言）。领域外的新语言目录（如 `content/posts/jp/`）会触发 `[blog] 无法识别的语言目录` 构建期报错。

## 开发规范

- **内容即代码**：`content/` 下 YAML/MDX 由 velite 编译，结构错误构建期即报错。新增博客 = 在 `content/posts/{zh,en}/` 下新建 MDX（多语言同名 slug 即翻译版本，见上节）；改论文/报告/导航 = 改 YAML。
- **i18n**：`messages/zh.json` 与 `messages/en.json` 同步修改（先 zh 后 en）；文案一律走 `useTranslations`/`getTranslations`，不硬编码。**页面 tab 标题已本地化**：页面 metadata 用 `generateMetadata` + `lib/i18n/metadata.ts` 的 `pageMetadata(params, "namespace")`（复用 section 的 `title`/`description` key），zh 显示中文标题；新增页面时沿用该模式，勿再写硬编码英文 `export const metadata`。首页标签页用 `title: { absolute: "Yu Shaoyuan" }` 只显示姓名（absolute 绕过父布局 template 后缀），`meta.defaultTitle`（首页/Home）仅作兜底。
- **UI**：优先使用 `components/ui/` 下的 shadcn 封装（Button、Card、Input、DropdownMenu、ToggleGroup 等）；lucide-react 图标传 `data-icon="default"`（与既有组件一致）。
- **主题切换按钮（`components/layout/theme-toggle.tsx`）显示「所选设置」，不是「当前生效主题」**：触发按钮 = 浅色（`SunIcon`）/ 深色（`MoonIcon`）/ 跟随系统（**`SunMoonIcon`「半日半夜」**），与下拉三项一一对应。⚠ **勿把「跟随系统」改回 `MonitorIcon`**（显示器是「设备」语义，用户明确反馈不直观）；`Eclipse` / `Contrast` 是候选备选（`Contrast` 半黑半白，但无障碍语境里常被读成「高对比度」）。
  - ⚠ **根因：不能用 `.dark` 判断「所选设置」**——next-themes（`attribute="class"` + `enableSystem`）只把**解析后**的主题写进 DOM：选「跟随系统」时它先读 `prefers-color-scheme`、再把结果（`light`/`dark`）写成 class，**「system」这个设置值在 DOM 里根本不存在**（只活在 `localStorage["theme"]` 与 React state）。原实现照搬 shadcn 官方写法（`dark:hidden` / `hidden dark:block`）按 `.dark` 判断，于是「跟随系统 + 系统为浅色」时显示太阳，看起来像设置没生效。
  - **实现（勿改回按 React state 渲染）**：`app/layout.tsx` 的内联 script 在首帧 paint 前读 `localStorage["theme"]` 给 `<html>` 加 `theme-light/dark/system` 标记（与 `owner-logged-in` 同一套零跳变机制）；三个图标**都渲染**，可见性由 `globals.css` 的 `.theme-icon` + `[data-theme-icon]`（默认无标记 = 跟随系统）按标记类择一显示 → SSR 结构固定，无 hydration mismatch、无首帧闪烁，且同一时刻仅一个图标 `display:inline-flex`、按钮宽度恒定。组件内 effect 只做兜底同步（CSP 拦下内联脚本、其他标签页改设置）。**勿改回 `useTheme()` 的 `theme` 直接渲染图标**——next-themes 的 `H()` 在 SSR 返回 `undefined`、客户端首次 render 才读到 localStorage 值，会 hydration mismatch。
  - **`data-theme-icon` 是 E2E 断言钩子**：`e2e/smoke.spec.ts` 的「主题切换（顶部栏）」用例锁定该语义——跟随系统时即便 `emulateMedia({ colorScheme: "dark" })` 让 `.dark` 生效、也仍显示半日半夜图标（而非月亮）；已做反向验证（改回按 `.dark` 判断即红）。改图标或标记机制时同步该用例。
- **顶部栏响应式断点 = lg（1024），勿改回 md（768）**：`site-header.tsx` 的内联桌面导航用 `hidden lg:flex`，汉堡 Sheet 触发器同步用 `lg:hidden`（**两者必须同断点**，否则同宽度下「既无内联导航又无菜单入口」出现功能真空，主人专属「速记/日历」将无法到达）；`owner-nav-item.tsx` 的 `sep` 分隔竖线也是 `lg:block`。原因：**英文文案比中文长两倍以上**——`Publications` / `Scratchpad` / `Calendar` 在登录态下，768~1023 区间即使收紧内边距也放不下（实测 768px 英文登录态内容需 910px、容器可用仅 705px；英文游客态单靠 `md` 也溢出 50px），横向溢出会把「我的/主题/语言」挤出视口。⚠ 旧版是 `md` 断点，**线上英文 768px 一直存在此 bug**（生产实测溢出 116px），换 Inter 后（比 Tinos 宽）进一步放大。修复后 <lg 全部收进汉堡 Sheet（内容完整、无功能缺失）。
- **顶部栏字号 = 14px / w500（`globals.css` 的 `.site-header [data-slot="button"]`，勿改 15px）**：
  - **字号不能脱离栏高单独决定。** 实测「栏高 / 字号」比：Anthropic 69px÷15px=**4.60**、Linear 72÷16=4.50、Vercel 64÷16=4.00、Stripe 64÷16=4.00、GitHub 50÷16=3.13。
  - 本站栏高固定 **56px**（`h-14`，被 4 处 `sticky top-14` 依赖）。曾照抄 Anthropic 的导航 15px，但**没抄它的 69px 栏高** → 比值跌到 **3.73**，文字在栏里显得挤、钝（用户反馈「太大、呆呆的」）。14px 时比值 **4.0**，与 Vercel / Stripe 一致。
  - **另一层原因（双语站特有）：中文字形在相同字号下视觉上大于拉丁**——汉字几乎撑满 em 框，拉丁 x-height 只占约一半。所以 15px 的中文导航观感接近 16.5px 的英文。（参考：Vercel/Stripe/Linear/GitHub 的导航都是 16px，但那是纯拉丁站。）
  - **w500 而非 400**：栏高偏矮时，中等字重的汉字比常规字重更有分量、不发「平」。层级上低于 Logo（`font-mono` w600），不冲突。
  - 实测余量（改后）：最紧组合 `1024px + 英文 + 登录态` 余量 **100px**（改前 15px 时约 68px）；中文登录态 284px。
- **桌面导航紧凑档（`globals.css`，`@media (min-width: 1024px)`）**：收紧 `.site-header nav` 的 `gap`（0.25rem→0.125rem）与 nav 内 `[data-slot="button"]` 的 `padding-inline`（0.625rem→0.5rem）。⚠ 字号从 15px 回到 14px 后，`gap` 已放宽回默认 4px（`gap-0.25rem`，与 `gap-1` 相同，该条现为 no-op，保留以便日后需要时再收紧）；`padding-inline` 仍为 8px。⚠ 该媒体查询只命中桌面内联 nav（移动端 Sheet 已 portal 到 body、不在 `.site-header` 内，走 `.sheet-nav` 规则不受影响）。**新增导航项前先按 `1024 视口 + 英文登录态` 核算余量**（最紧组合，当前 100px）。
- **E2E 回归**（`e2e/smoke.spec.ts` 的「主人登录（TOTP）」describe）：两个用例锁定该行为——①「多视口 × 中英文的顶部栏均不横向溢出」（768/820/1024/1280/1440 × `/` 与 `/en`，断言 `.site-header > div` 的 `scrollWidth - clientWidth <= 0`，需登录态）；②「断点两侧入口都可达」（<lg 断言内联 nav 隐藏 + 点开汉堡后 `.sheet-nav` 内「首页/博客/速记/日历/导航」齐备且竖线隐藏；≥lg 断言内联 nav 可见且入口齐备、汉堡消失）。**改动顶部栏布局/导航文案时必须重跑**。
- **字体策略（对齐 Anthropic 官网范式；按「角色」分派，与页面语言无关；勿改回按语言切换）**：
  - **⚠ 先弄清 Anthropic 的真实做法（实测计算样式，与直觉相反）**：它的 `body`/`main` **默认字体就是衬线**（`Anthropic Serif` 20px）——**无衬线是「覆盖层」**，只用在「功能性 UI + 编辑型标题」上。三族实际落点：
    | 角色 | 字体 | 实测值 |
    |---|---|---|
    | `h1` 首页大标题 | **无衬线** | 60.9px / 700 / lh 1.1 |
    | `h2`/`h3` 文章标题 | **无衬线** | 32px/700、23px/600 |
    | 导航链接 / 页脚 / 元数据 | **无衬线** | 15px、12px |
    | **`.big-cta_title` 品牌展示标题** | **衬线** | **68.3px / 500 / lh 1.1** |
    | `.big-cta_subtitle` 其副标题 | **衬线** | 24px / 400 |
    | 文章正文 | **衬线** | **17px / 400 / lh 1.55** |
    | eyebrow 标签（DATE/CATEGORY） | 等宽 + 全大写 | 16px / 400 |
    ⇒ 所以它**有两个衬线角色**：**大字展示标题**（品牌/身份签名）与**长正文**。
  - **核心原则：sans/serif 的对比必须单义。** 我们的分配：
    1. **无衬线**（默认，约 90% 文本）——**全部页面标题（`h1` 默认无衬线）**、全部功能性 UI（顶部栏、按钮、菜单、标签页、分段/多选控件、下拉与命令面板、徽章与 chip、表单、提示/Toast、日历网格与工具栏）、全部说明性文字（页面 description、卡片描述、空态文案、副标题）、全部元数据（日期、分类、计数、页脚）、**全部外部专名（会议/期刊全名、地名、论文标题/作者/venue、导航站外链名）**。
    2. **有衬线（两个角色，其余场景一律不用）**：
       a. **长正文** —— 博客正文、速记正文（含输入框）。载体必须带 **`data-longform`**，且字号 ≥16px、行高 ≥1.6（衬线 x-height 小、笔画细，同字号下需更大字号 + 更松行距才达同等可读性；Anthropic 文章正文即 17px/1.55）。
       b. **展示标题块（display serif）** —— **仅**首页 hero 的人名 + 职务行。载体必须带 **`data-display-serif`**。这是「个人站的名即品牌」的签名式用法，对应 Anthropic 的 `.big-cta_title`（68px/500 衬线）+ `.big-cta_subtitle`（24px 衬线）。⚠ **全站只此一处**，**不要**把它扩散到其它页面标题（会退回「衬线既是大标题又是小字说明」的语义混乱）。
    3. **等宽**——标识符与数字（缩写、ISSN、年份、日期、凭据、统计数值）、逐字代码（`pre`/`code`/`kbd`、BibTeX）、品牌 Logo，以及 `.eyebrow-label` 全大写技术眉标。
  - **兜底：未列举的一律无衬线。**
  - **`data-longform` / `data-display-serif` 是机器可校验的边界**：E2E 断言「`main` 内任何解析到衬线的元素都必须位于 `[data-longform]` **或** `[data-display-serif]` 内」。新增任何使用衬线的场景时**必须**加对应属性，否则测试红。
  - **关键收益：同一元素在中/英页面必然同族**（三族字体栈各自都同时含拉丁与中文）。这正是旧范式做不到的——旧范式下「CCF 会议全名」在 `/ccf` 是 Inter、在 `/en/ccf` 是 Tinos，同一份数据两种观感。
  - 由 `app/globals.css` 承载，两层：`--font-stack-sans/serif/mono`（`:root`，真实字体栈）→ `--font-sans` / `--font-serif` / `--font-mono`（`@theme inline` 映射）。
  - 历史（勿改回）：曾用「注入 `<style>` 覆盖 `--font-body`」实现「英文页整页衬线」（`components/layout/locale-font-style.tsx`，已整体删除）。⚠ 若将来真需要按语言切字体，**勿用**「在 `<html>` 上渲染 `data-locale` 属性 + CSS 选择器」：React 客户端导航不会 diff `<html>` 的属性（`<html lang>` 同样如此），实测切语言后字体不更新、必须刷新。
  - `--font-heading` 已删除（它曾与 `--font-sans` 逐字相同、纯空转层）；Card/Dialog/Sheet/Empty 的标题直接走 `--font-sans`。
  - **`<html lang>` 由根 layout 的 `getLocale()` 渲染**（`app/layout.tsx`，`HTML_LANG` 映射 zh→`zh-CN`）。此前硬编码 `lang="en"`，中文页也声明 en（a11y/SEO 问题）。性能：本站所有页面本就是每请求 SSR（构建产物中零个页面级预渲染 `.body`、响应头 `Cache-Control: no-store`），故 `getLocale()` 不引入额外开销（实测注入前后每请求服务端处理时间 62~68ms 不变）。⚠ 客户端切语言后 `lang` 不会更新（同上 React 不 diff html 属性），刷新即正；如需修复得加客户端同步。
  - ⚠ **⚠ 逐页静态化：已尝试并确认「不是补 setRequestLocale 就能解决」，暂缓（重要）**：本项目**没有任何页面被预渲染**——`prerender-manifest.json` 只有 10 条（6 张 OG 图 + feed/robots/sitemap/icon），standalone 产物中零个页面级 `.body`，响应 `Cache-Control: no-store`。`pnpm build` 的路由表把它们标成 `● (SSG)` 且日志打印 `Generating static pages (53)`，**这个标记具有误导性**，别据此判断（判定只看 `.body`/`prerender-manifest`/响应头）。每请求服务端处理 ~70ms（对比预渲染路由 ~1ms、实测 78~93ms vs 8.8ms 墙钟）。
    - **2026-09 已完整尝试并回退**（下面记录的尝试组合**全部无效**，勿重复）：① 去掉根 layout 的 `getLocale()`（根级动态源）；② `getMessages({ locale })` 显式传参；③ `NextIntlClientProvider locale={locale}`；④ **给全部 14 个页面补 `setRequestLocale(locale)`**（同步页用「薄 async 包装 + 同步子组件」保持 hooks 合法）。结果仍为 0 个页面级 `.body`。
    - **诊断方法（关键）**：`pnpm exec next build --debug`，然后 `grep "Static generation failed due to dynamic usage"` —— 它会直接给出原因（本项目为 `reason: headers` 24 条、`cookies` 6 条、`force-dynamic` 2 条）。`cookies`（login/ideas/calendar 的 `requireOwner`）与 `force-dynamic`（deadlines）属预期，**只需关注 `headers`**。
    - **根因**：next-intl 的 `getConfig` 里 `requestLocale` 是个 getter——`locale ? Promise.resolve(locale) : getRequestLocale()`，而 `getRequestLocale() = getCachedRequestLocale() || headers()`（`RequestLocaleCache.js` 用 `React.cache` 存）。`setRequestLocale` 写入的缓存**在静态生成阶段取不到**，于是回退 `headers()` → 动态。决定性证据：连一个只有 `setRequestLocale` + 静态 JSX 的**最小探针页**（`app/[locale]/probe/page.tsx`）也会报 `reason: headers`；去掉 `middleware.ts` 同样如此。即**不是页面级补丁能解决的**，属 next-intl 与 Next 打包/静态分析层面的交互问题。
    - **不要用 `export const dynamic = "force-static"` 绕过**：它会让 `headers()`/`cookies()` 返回空值 → `useTranslations`（未显式传 locale）解析成**默认语言**，`/en/*` 页面会静默渲染成中文内容；且会破坏 `requireOwner` 的守卫语义。
    - 若日后重启此项：先确认 next-intl 版本是否有相关修复，或评估换用 `i18n` 配置方式（如把 locale 通过 `params` 显式传给每个 `getTranslations`/`useTranslations` 调用、彻底不依赖 `requestLocale`）；无论哪种都必须全量回归（28 个页面×语言组合）并保留 `<html lang>` 的正确性。
    - **性能评估（决定暂缓的依据）**：VPS 为 4 核 / 7.2GB，实测 load average 0.01，web 容器 CPU 0%；按最坏 85ms CPU/请求估单核 ≈12 req/s、4 核 ≈47 req/s，个人学术站峰值远低于此。故此项是「优化」而非「瓶颈」，收益（~78ms→~1ms）与 14 个文件的改动风险不成比例。
  - `app/not-found.tsx`（根级 404）渲染在 `[locale]/layout` 之外，但字体来自全站 CSS（`html` 上的字体栈），无需额外处理。
  - **字源（三族）**：
    - 无衬线：西文 **Inter**（`@fontsource-variable/inter`）；中文**不引入 webfont**、走系统回退：`PingFang SC` → `Hiragino Sans GB` → `Noto Sans CJK SC` → `Source Han Sans SC` → `Microsoft YaHei`。⚠ **勿把 `Microsoft YaHei` 提前**——Linux 上若装了雅黑会命中较老的雅黑而非思源黑体。
    - 有衬线：西文 **Tinos**（Times 度量兼容）；中文 **自托管 `@fontsource-variable/noto-serif-sc`**——不用系统回退是因为 Windows 会落到 SimSun（点阵味、小字号明显差）。现只用于长正文（17px，面积小、字号大、行距松），这两族在此场景下表现稳定。
    - 等宽：**全站唯一等宽字体 `Noto Sans Mono CJK SC`**（自托管，见下条）。
  - **用变量版 `index.css` 而非分字重 `latin-400.css`**：变量 CSS 内含按 `unicode-range` 切分的分片 `@font-face`，浏览器只下载实际用到的分片。⚠ Inter 的 `latin-ext` 分片是必需的——`lib/data/deadlines.json` 含 Montréal / Türkiye / Malmö / Poznań 等带变音符号地名。（Inter / Tinos / Noto Serif SC 保持上游分片不变；只有**等宽族**做了单文件处理，理由见下。）
  - **⚠ 等宽字体必须自己子集化（`scripts/subset-fonts.mjs` + `pnpm fonts:subset`）**：
    - **没有任何现成 webfont 来源**：npm 上 `@fontsource/noto-sans-mono-cjk-sc` 等 8 个候选包全部 404；**Google Fonts 完全没有 CJK Mono 变体**（`Noto Sans Mono CJK SC/JP/KR/TC/HK` 全部 HTTP 400，只有拉丁版 `Noto Sans Mono`）。唯一源是 notofonts 官方仓库的 `NotoSansMonoCJKsc-{Regular,Bold}.otf`（16/17MB 静态）或 `-VF.otf`（28.9MB 可变字重）。
    - **选它的理由**：拉丁 **0.5em** / 汉字 **1.0em** = **恰好 2:1**，中英混排精确对齐；且一个字体同时提供拉丁与汉字，无需第二个等宽族（多数等宽字体无 CJK 字形）。⚠ 若拉丁用普通等宽字体（0.6em）+ 中文系统回退（1.0em）= **1.667:1 非整数，汉字永远落不到拉丁的列网格**——这是选它的决定性原因。E2E 有「汉字按 2:1 倍宽渲染」回归。
    - ⚠ **单文件、不做 `unicode-range` 分片（2026-09 改，勿改回分片）**：早期版本切 latin + cjk 两个分片，期望「只在等宽遇到汉字时才下载 cjk」。**实测该期望落空**——`font-mono` 曾被错用在若干**含中文的 UI 文案**上（`还剩 2 天`、`681 项`、`758 本`、`63 个会议`、「当前密码」标签、验证码的中文 placeholder），于是 /ccf、/cas、/deadlines、/login **每次访问都多下 1.3MB**。那些用法已改回无衬线（**数字对齐用 `tabular-nums`，不必切字体族**，见「排版/颜色/组件规格」），但分片机制本身是脆的：它把「等宽族里有没有汉字」变成性能开关，而**代码注释里写中文完全正常**（含中文注释的代码块必须等宽显示）。故改为**单文件**：一次下载 + immutable 长期缓存，不存在「误拉大文件」这种失败模式。
      - 输出两个文件：`noto-sans-mono-cjk-sc.woff2`（**894KB**，`font-weight: 400 500`）与 `noto-sans-mono-cjk-sc-bold.woff2`（**911KB**，`font-weight: 600 700`）。这是**字重**划分而非覆盖分片，每个文件都是完整字体。
      - 覆盖范围 = 拉丁/标点/符号 + 21 个日期汉字 + `scripts/fonts/han-common.txt` 的 3100 常用汉字（约 6220 码位）。
      - ⚠ **静态字体的 `font-weight` 必须写具体区间**（`400 500` / `600 700`），写 `100 900` 会让浏览器以为一个字重全支持，从而对粗体不做任何处理（粗体与常规长得一样）。不用合成粗体是因为合成粗体在中文上观感明显发虚。
      - 实测：**每页 2 个文件 / 约 1.8MB**（Regular + Bold 都用到时）；`/nav`、`/login`、`/calendar` 只用 Regular = 911KB。全部 `font-display: swap`，**不阻塞首屏**（同页 JS+CSS 386KB，FCP 428ms / CLS 0.0004 的旧实测仍成立）。用 `--lean` 可退化为「拉丁 + 日期汉字」（≈80KB/字重，仅当确认不需要中文等宽时）。
    - ⚠ **必须输出到 `app/fonts/`，且 CSS 里必须用相对 `url("./fonts/…")`（勿改回 `public/` + 绝对路径）**：`public/` 下的文件不经构建管线，Next.js 对其默认发 `Cache-Control: public, max-age=0`——**每次访问都要发一次条件请求 revalidate**（304 不重传 body，但多一次往返）。相对 url() 会被 webpack 当作 asset 处理：自动加**内容哈希**重命名 → 输出到 `_next/static/media/` → 发 `Cache-Control: public, max-age=31536000, immutable`（与 @fontsource 的 Inter/Tinos 待遇一致）。内容哈希同时解决「重跑脚本后文件名不变、已缓存用户永远拿到旧字体」的隐患。E2E 断言：恰好 2 条 `@font-face`、**均无 `unicode-range`**、URL 带哈希、响应头含 immutable。
    - ⚠ **`pyftsubset --unicodes` 的区间末尾不能再写 `U+`**：写 `U+4E0A-4E0B`（对），**不要**写 `U+4E0A-U+4E0B`（错）。fontTools 的 `parse_unicodes` 会把 `+U` 等字符一律替换成空格再按空白切分，于是后者被劈成 `4E0A-` 与 `4E0B` 两个 token，前者空 end 直接抛 `int('', 16)` 的 ValueError。`compactRanges()` 已按此产出。
    - ⚠ **源字体下载慢/不可达**（`raw.githubusercontent.com` 国内易超时）：源字体缓存在 `.cache/`（已在 `.gitignore`，30MB+ 不入库）。可用 `--regular <path> --bold <path>` 指定本地静态字体绕过；需 Python fontTools 提供 `pyftsubset`（`PYFTSUBSET` 指定路径）。
    - ⚠ **`pyftmerge` 无法合并可变字体**（`VarStore` 无 `mergeMap`），所以「把旧的两个 VF 分片合并成一个」这条路走不通；`font-weight: 100 900` 的单文件只能从 VF 源重新子集化。
    - **OG 图字体**：`lib/og-fonts.ts` 用 `@fontsource/tinos` + `@fontsource/noto-serif-sc` 的 **woff** 子集（satori/fontkit 不支持 woff2），`FONT_FAMILY = "Tinos, Noto Serif SC"` 按列表回退；两包在 `devDependencies`（仅构建期用，不进运行时容器）。
  - ⚠ **新增页面时主标题 `h1` 不要加 `font-serif`**（无衬线是默认，如 `className="text-3xl font-bold tracking-tight"`）。新增**内容类**元素（描述文字、外部专名、元数据）同样**不要**加；仅当确实是「连续阅读的长正文」时才加 `font-serif` **并同时加 `data-longform`**。首页 hero 的人名/职务行是唯一的「展示标题块」例外（已在 `data-display-serif` 内，勿再增其它元素）。
  - ⚠ **根级 404（`app/not-found.tsx`）是必需的，勿删**：`not-found.tsx` 只对「该路由段内调用 `notFound()`」生效——`app/[locale]/not-found.tsx` 处理的是语言前缀非法等场景；而**未匹配任何路由**的 URL（手输错地址、失效外链）会落到根级 not-found，缺失时渲染 Next 内置 404（英文硬编码文案、`next-error-h1` + 内置 `system-ui` 字体 → 无站点样式、无返回入口）。根级文件渲染在 `app/layout.tsx` 之内（有全站 CSS 与字体，但**没有** SiteHeader/SiteFooter——二者在 `[locale]/layout.tsx`），语言用 `getLocale()` 取，首页回链需按 `as-needed` 规则自行拼前缀（zh 无前缀、en 加 `/en`），故用 `next/link` 而非 i18n 的 `Link`。
  - **E2E 回归**（`e2e/smoke.spec.ts` 的「字体策略（按角色）」describe，9 个用例）：① **核心不变式**——同一元素在 `/`、`/ccf`、`/venues` 与各自 `/en` 版本下解析到**同一个** `font-family`；② 功能性 UI（顶部栏链接 / 页脚 / `h2` / 徽章 / 分段控件）**不得**匹配 `Tinos`；③ ★ **衬线只在长正文或首页展示标题块内**——遍历 16 条路由的 `main *`，任何解析到 `Tinos` 的元素必须位于 `[data-longform]` 或 `[data-display-serif]` 内；④ **`h1` 无衬线（首页人名除外）**——12 条路由断言无衬线，`/` 与 `/en` 断言衬线 h1 **必须在 `[data-display-serif]` 内**；⑤ 等宽（`.prose code`、Logo、CCF 缩写）须匹配 `Noto Sans Mono CJK SC`；⑥ **正文不小于 12px**（字阶下限，扫描 7 条路由；排除 REUI 日历内部 11px chip）；⑦ **等宽眉标**（`.eyebrow-label`）走等宽且 `text-transform: uppercase`；⑧ **客户端切换语言字体不变**（角色制与语言无关；用**点击语言菜单**而非直接 `goto`——直接 goto 走完整 SSR、会绕过客户端路径；URL 先于 RSC 提交落地，故用 `expect.poll`）；⑨ `/no-such-page` 返回 404 且渲染站内 404（`h1` **无衬线**、文案随语言、回链带 `/en`）。⚠ 断言要选**该页面实际存在**的元素（如 `/ccf` 无 `card-title`、`/` 的 CardTitle 仅在博客卡片存在）——否则 `locator.evaluate` 会等 30s 超时；⚠ **先访问中文（无前缀）再访问 `/en`**——访问 `/en/*` 会写 `NEXT_LOCALE=en` cookie，之后无前缀路径会被重定向到 `/en`（本项目已因此误判过两次）。
  - 历史坑：曾把 `--font-sans`/`--font-heading`/`--font-serif` 三个 token 全设为同一套 Tinos+宋体栈，导致组件里散落的 `font-serif` 实为空操作、全站正文都是宋体观感。改动字体前先 grep `font-serif` 确认引用点。

### 排版 / 颜色 / 组件规格（2026-09 统一）

> 起因：网站各页「细节不协调但说不清哪里不对」。程序化取证（逐页抓计算样式 + 几何）定位到四类系统性漂移，均已收敛。**新增页面/组件时必须遵守以下约定，勿新增例外。**

- **字阶（唯一允许的值）**：`12 / 14 / 16 / 18 / 20 / 24 / 30 / 36 / 48 / 60 px`（`text-xs/sm/base/lg/xl/2xl/3xl/4xl/5xl/6xl`）。体系外一律不许出现。
  - 用途分层：`12/14` = 元数据与密集列表；`16` = 正文与卡片主信息（缩写）；`17` = 长正文（`.prose`，**唯一的非 Tailwind 标准值**）；`18/20` = 区块标题；`24` = 大区块标题；`30` = **页面主标题（全站 h1 默认）**；`36` = **文章标题（`/blog/<slug>` 的 `sm:text-4xl`，比页面标题高一级）**；`48/60` = **首页展示标题块（hero 人名，`data-display-serif`）**。
  - ⚠ **最小字号 12px**——清理前全站存在 10px(1629)、11px(4132)、以及 `text-[0.8rem]` 造成的 **12.8px** 非整数值，密集列表在 10/11px 下已影响可读性。E2E 有「正文不小于 12px」与「字阶只用体系内的值」两条回归。
  - ⚠ **不要再写 `text-[Npx]` / `text-[0.Nrem]`**（`components/ui/*.tsx` 内为 shadcn 上游产物，保持原样即可）。
- **行高**：标题 `1.15`（`globals.css` 的 `@layer base` 给了 `h1..h4` 默认值）、UI `1.43`（Tailwind 默认）、长正文 `1.7`、密集列表 `1.4`。
- **等宽眉标 `.eyebrow-label`**（`globals.css`）：12px 等宽 + `font-weight 500` + `letter-spacing .06em` + `text-transform: uppercase`。用于数据卡片的短标签（CCF 等级 `CCF-A`、中科院分区数字、WoS 收录 `SCIE`、`Top`、博客目录标题）。⚠ 只用于 ≤8 字符的短标签；中文无大小写，`uppercase` 对其无效，靠等宽 + 字距区分。
- **等级 / 分区配色：单一事实来源 `lib/design/grade.ts`**（`TONE_CHIP` / `TONE_BAR` / `TONE_DOT` + `ccfChipClass` / `casChipClass` / `casDotClass` / `ccfBarClass` / `casBarClass`）。ccf · cas · deadlines · venues **四页共用**——此前四处各自内联定义了同一套色板，改一处颜色需同步四个文件。
  - 色相语义固定：**A / 1区 = 红（最高）→ B / 2区 = 蓝 → C / 3区 = 绿 → 4区 = 琥珀**；`none`（未收录）必须中性灰，不得借彩色（否则会被误读为「有等级」）。
  - ⚠ 类名必须**整串静态写出**（Tailwind 扫描不到模板拼接的类名）。
- **对比度基线（WCAG AA）**：浅/深色下全部正文文本 ≥4.5:1（大字号 ≥3:1），图标类交互元素 ≥3:1。E2E 有「正文文本对比度达 WCAG AA（浅色 + 深色）」回归（8 条路由 × 2 主题）。
  - ⚠ **彩色小徽章是最大陷阱**：用 `text-*-700` on `bg-*-50`（浅色，4.85~6.65:1）+ `text-*-400` on `bg-*-500/15`（深色，≥6.8:1）。**不要**用 `text-*-600` + `bg-*-500/10`（浅色下仅 **4.02:1**，未达 AA，且半透明底叠在灰底上会发脏）——日历 `CATEGORY[].badgeClass` 曾漏改这一版（`calendar-view.tsx`），已统一。
  - ⚠ **次级色文字压在中性灰底上会擦线**：`--muted-foreground`（浅色 `oklch(0.556)` = rgb(115)）原本只对白底达标（4.74:1），一旦落在 `bg-muted`/`bg-secondary`/`bg-accent`（都 = `oklch(0.97)` = rgb(245)）的表面（如 `/ccf`、`/cas` 的「会议/期刊」「ESCI」徽章、`/deadlines` 的未收录徽章）就只有 **4.35:1**。已把浅色 token **调深到 `oklch(0.54)` = rgb(111)**：灰底上 4.64:1、白底上 5.04:1，两处均达标且观感无变化。**新增「muted 底 + muted 字」的组合前先按 4.5:1 核算。**
  - ⚠ **不要用 `text-muted-foreground/70` 之类给「真文本」降透明度**（`/70` 合成后仅 2.71:1，远低于 AA）。`muted-foreground` 本身已是次级色，再叠 alpha 只用于**纯装饰**（如 `·` 分隔符，且现统一用全色 `/`）。新增次级文字层级请新增 token，勿叠 alpha。CCF 行的 DBLP 图标链也曾用 `/80`（3.05:1），已改全色。
  - 清理前：浅色 **49.8%** 文本不达标；2026-09 用 canvas 精确复测后仍有 3 类徽章停在 4.35:1，均已修复 → **现状 0%**（浅/深色均为 0）。
- **组件规格统一**：
  - `Badge` 基础圆角 = `rounded-full`（胶囊）；需要「方块编码」样式（如 CCF 等级 `w-7 justify-center`）时显式覆写 `rounded-md`。⚠ 此前基础值是 `rounded-4xl`（26px），在 20px 高的徽章上被浏览器裁到 10px、与 `rounded-full` 视觉相同，属**假第三种形状**。
  - 按钮 `size="sm"` 字号 = `text-sm`（14px）。⚠ 上游默认是 `text-[0.8rem]`（**12.8px**，非整数、非体系值）；顶部栏另有 `globals.css` 覆盖为 14px。
  - 图标栅格（有意保留的 4 档）：**12px** = 徽章内联（`badge.tsx` 的 `[&>svg]:size-3!`）、**14px** = 小控件/内联、**16px** = 默认控件、**20px** = 特征图标（统计卡、悬浮导航）。
  - ⚠ **`Card` + `CardContent` 的上下内边距会叠加（易踩）**：`ui/card.tsx` 的 `Card` 自带 `py-(--card-spacing)`（默认 `py-4` = 16px），而 `CardContent` 基础类只有 `px-(--card-spacing)`（与 shadcn 上游一致，垂直由 Card 提供）。故调用方若写 `<CardContent className="p-3">`，**只会覆盖水平方向**，垂直变成 `16 + 12 = 28px` 而水平仍 12px —— 卡片上下明显发空、与左右不对称（`/deadlines` 会议卡曾是 28:12，统计卡是 32:16 正好 2 倍）。**凡在 `CardContent`/`CardHeader` 上用 `p-*`/`py-*`/`pt-*`/`pb-*` 控制内边距时，必须同时给 `Card` 加 `py-0`**，让内层独自掌控；若本就只想要默认的 16px，**直接删掉那些多余的类**（`Card` 已给）。
  - 两轮清理覆盖：`/deadlines` 会议卡（`p-3` → 12px 均齐）、`StatCard`（`deadlines`/`ccf`/`cas` 三处 `p-3.5 sm:p-4` → 14/16px 均齐）；以及**冗余类删除**——`/` 与 `/blog` 的 `CardHeader className="py-4"`、`/publications` 的 `CardContent … py-4`（两者都在把 16 变成 32）、`/nav` 的 `CardHeader pb-2` + `CardContent pb-3`（本意是收紧间距，实际是加大：`8+16=24`）、`/projects` 的 `pb-2`+`pt-2`、`/talks` 的 `py-5`。E2E 有「卡片内边距四边对称」回归（8 条路由）。
  - 纯 `CardContent` + 交由其控制的全出血卡片（如 `calendar-view.tsx`）用的是 `Card className="py-0"` + `CardContent className="p-0"`，同一约定。
  - ⚠ 审查时注意排除**被 grid 拉伸到等高**的卡片（如 `/nav` 的链接卡）：内容顶对齐导致的底部留白属布局，不是内边距问题——E2E 断言已内置该排除。
- **取证方法（可复用，含一个必须避开的坑）**：本项目**没有**视觉回归基线，故 UI 改动靠「程序化取证」验证——用 Playwright 逐页 `getComputedStyle` 抓 `fontFamily / fontSize / fontWeight / lineHeight / letterSpacing / color / padding / borderRadius` + `getBoundingClientRect` 几何，聚合成直方图对比，并自算 WCAG 对比度。多宽度（360~1920）× 中英文 × 明暗，均应无横向溢出。已有三条断言固化在 E2E（对比度 / 卡片内边距 / 字阶）。
  - ⚠ **颜色换算必须交给浏览器，绝不能手写**：Tailwind v4 下 `getComputedStyle` 返回的是 **`lab(...)`（`oklch()` 的序列化形式）和 `oklab(...)`，不是 `rgb()`**。任何只会 `match(/^rgba?\(/)` 的解析器都会返回 null，进而回退成「前景=背景=白」→ 算出对比度 1:1 或干脆全部跳过，**给出假的「全部通过」**（本项目据此误判过一次，真实情况是浅色徽章 4.35:1 未达 AA）。正确做法：`canvas.fillStyle` 依次赋「非法哨兵 → 目标颜色」，再 `fillRect` + `getImageData`，即可得到浏览器自己的**非预乘 sRGB（含 alpha）**；`lab(50 40 30)` → `187,88,70` 与手工值一致，可作正确性自检。
  - ⚠ **暗色主题必须真测**：暗色徽章大量使用 `bg-*-500/15` 这类**半透明底**，只有把祖先背景链逐层合成后才是实际背景色；只看元素自身 `backgroundColor` 必然算错。查询背景时要沿祖先向上找**第一个 alpha ≥ 0.99** 的层。

- **客户端组件**（`"use client"`）放 `components/`；服务端页面守卫在 page.tsx 中。
- **SSG**：`cookies()` 使页面动态渲染（如 /login、/ideas），属预期；其余页面保持静态。
- **Lint**：`eslint-plugin-react-hooks` 缺失为既有 warning（非阻塞），勿改 package.json；保持 0 error。

## 常见问题

- **`app/page.tsx` 已于 2026-09 删除（曾是 create-next-app 遗留模板页）**：其内容是 Next.js 默认的「Get started by editing app/page.tsx」，与首页无关——首页由 `app/[locale]/page.tsx` 提供，`middleware.ts` 把 `/` 重写到 `/[locale]`。删除前已验证：全仓库无任何 import 引用该文件，且 E2E「首页：200 + 中文内容」通过。⚠ 删除后构建路由表中不再有独立的 `/` 条目（由 `[locale]` 段承担），属预期，不要为此加回文件。
- 本地 `localhost:3000` 反复 EADDRINUSE：残留 next-server 进程，`fuser -k 3000/tcp` 后再起。
- Base UI `ToggleGroup` 的 `value` 恒为数组（单选也传 `[value]`），onValueChange 取 `v[0]`。
- VS Code 集成浏览器对部分元素点击会因稳定性检查超时（如 DropdownMenu trigger）：用 Playwright `evaluate(el => el.click())` 或直接跑 E2E 验证，勿误判为代码问题。
- standalone 构建会把 `.env` 复制到 `.next/standalone/.env` 并被 server.js 加载（本地 standalone 读取密钥的原因）；VPS 密钥来自 compose 的 environment 注入。
- 登录/登出 E2E 会真实写入会话与 Idea 数据，用例内自清理；跑完可检查 `data/ideas.json` 应为 `[]`。
- **E2E 勿开 fullyParallel**：所有用例共享同一 standalone 服务器的 `preferences.json`/`ideas.json`，多 worker 并行写会互相覆盖导致随机失败（曾致偏好恢复用例间歇红）。playwright.config.ts 保持默认单文件串行（66 用例约 1.4 分钟）。

## 排版与可访问性规格的 E2E 回归（`e2e/smoke.spec.ts` 的「排版与可访问性规格」describe，4 个用例）

这几条把「肉眼说不清、靠取证才发现」的漂移固化为机器断言。**改动 `ui/card.tsx`、`globals.css` 的颜色 token、或任何卡片的 `p-*` 时必须重跑**；**三条都做过「反向验证」**（人为改回错误值 → 确认断言真的红），不是一个只会绿的摆设。

1. **正文文本对比度达 WCAG AA（浅色 + 深色）**——8 条路由 × 2 主题，逐元素比 `fg` 与其**祖先链上第一个不透明背景**。判据：正文 4.5:1、≥24px（或 ≥18.66px 且 w≥700）为 3:1。⚠ 用 `page.emulateMedia({ colorScheme })` 后必须 `waitForFunction` 等 `html.dark` 就位（`defaultTheme="system"`），否则测的还是浅色。
2. **卡片内边距四边对称**——取每张卡片 `[data-slot=card]` 的 `card-header/content/footer` 直系子元素，按各自 padding 算出墨迹边界，比对上/下/左/右四个内缩量。⚠ 已内置**排除被 grid 拉伸到等高**的卡片（内容顶对齐 → 底部留白属布局）。
3. **字阶只用体系内的值**——扫描 `main *` 中「有自有文本节点」的元素，字号必须在 `12/14/16/17/18/20/24/30/36/48/60` 内（排除 REUI 日历子树）。防的是 `text-[0.8rem]`（12.8px）这类非体系值。
4. **窄屏（360px）无横向溢出**——8 条路由 × 中英双语。顶部栏另有一条自己的溢出断言；这条防的是**内容区**：英文字段名比中文长得多，单个 `shrink-0` 的筛选 chip 就能宽过 360px 视口（`/en/ccf` 曾溢出 64px，已用 chip `max-w-full` + 内层 `<span className="truncate">` 修好）。⚠ 同样遵守「先中文再 `/en`」的 cookie 顺序。
- **顶部栏跳转横向抖动**：三个叠加根因——(1) `OwnerNavItem` 曾每次路由变化先 `setOwner(null)` 回退占位态（3×36px≈116px）再异步查询恢复（游客仅「登录」≈46px），nav 居中布局下所有链接左右横移；修复为**保留上次登录态、后台静默刷新**（登录/登出由 `owner-auth-changed` 事件驱动，此时宽度变化属合理反馈）。(2) **刷新页面时的占位跳变**：组件重挂载后 `owner=null` 渲染 4 个 `size-9` 占位方块，真实按钮要等 `/api/auth/me` 网络往返（dev 数百 ms），刷新必现「入口消失→出现」的抽搐。**最终方案（双布局 + 内联 script，登录/游客均零跳变且不破坏 SSG）**：`OwnerNavItem` 将游客布局与登录布局**在 SSR 都渲染**（结构固定 → 无 hydration mismatch），可见性由 CSS 类控制（`.guest-only`/`.owner-only`，`display:none` 不占宽，首帧宽度即最终宽度）；`app/layout.tsx` 的**内联 script 在首帧 paint 前**同步读 localStorage（键 `owner:auth`）设置 `<html>.owner-logged-in`，故登录用户刷新时首帧即登录布局。组件只负责挂载后同步 html class 与缓存（读缓存、`/api/auth/me` 校验、事件驱动），会话过期/跨设备以服务器为准（此时会修正布局一次，属预期）。⚠ 内联 script 键名必须与组件 `OWNER_CACHE_KEY` 一致；游客时隐藏布局的按钮仍在 DOM（`display:none`），E2E 用 `getByRole` 按可访问性断言不受影响（勿改用 `getByText`/`locator` 数 DOM 存在性）。(3) 长/短页面切换时滚动条消失/出现使视口宽度变化，居中内容偏移约 7.5px；已用 `html { scrollbar-gutter: stable }` 恒定预留滚动条空间。验证方法：Playwright 2ms 高频采样 nav 宽度 + console 错误监听（hydration mismatch）。
- **本地 E2E 日历用例需要 Radicale 容器在跑**：`.env` 已含 `CALDAV_*`（指向 `http://127.0.0.1:5232`、用户名 caladmin），容器 `ysy-personal-homepage-radicale-1` 停止时——「删除日程返回 503」变 502（连接失败）、「/calendar 月视图/日期格聚焦」失败（页面显示「日历服务未配置」不渲染网格）。跑日历用例前 `docker start ysy-personal-homepage-radicale-1`；若仅跑非日历用例可临时注释 `.env` 的 `CALDAV_*`。

## E2E 与 hydration 时序（CD Smoke Test 稳定性，2026-09）

- **症状**：`deploy.yml` 的 Smoke Test（对生产跑）3 条用例红——「客户端切换语言：字体不变」（点语言菜单后等不到 menuitem，30s 超时）、「/venues 搜索 CVPR」（`toHaveURL(/q=CVPR/)` 收到 `https://shaoyuanyu.cn/venues`）、「/venues 搜索 TPAMI」（期刊卡 not found）。**同一套用例在本地 66/66 全过**。
- **根因（不是代码回归，是测试的时序假设错了）**：测试用 `waitUntil: "domcontentloaded"` 导航后**立刻** click / fill。此时 SSR 出的 HTML 已完整可见，但 **React 合成事件尚未挂载**——此窗口内派发的 click / fill 会被**静默丢弃**（不抛错、无 console 警告，Playwright 的 click/fill 自身还正常返回），失败延后到后面的断言，表现为「URL 没变」「菜单没弹开」「元素找不到」，极难归因。本机（离 VPS 近）hydration ≈ DCL + 100ms，恰好盖住该窗口故本地全绿；**CI runner 在海外、站点在国内 VPS，JS chunk 晚到数秒 → 首个交互必丢**。
- **复现方法（可复用）**：用 `page.route` 拦截 `_next/static/chunks` 下的 JS chunk 人为加延迟，`domcontentloaded` 后立刻 `fill("CVPR")` → URL 永不更新（与 CD 报错逐字一致）。⚠ 集成浏览器工具里 Playwright 的路由处理会串行化，多个 chunk 各加 800ms 会把 hydration 拖到分钟级；只给**单个** chunk 加延迟即可看清。
- **修复：应用侧提供机器可校验的就绪信号**——`components/providers.tsx` 挂载后用 `useEffect` 置 `document.documentElement.dataset.hydrated = "true"`。Providers 是 hydration 提交中最外层的客户端组件，其 effect 在已 hydration 的子组件**之后**执行，故属性置位 = 整棵树可交互。⚠ **该属性只能由客户端设置，SSR HTML 中必须为 0**（`curl -s …/venues | grep -c data-hydrated` → `0`），否则它就不是 hydration 信号。
- **E2E 侧**：`e2e/smoke.spec.ts` 新增 `waitForHydration(page)`（等 `data-hydrated="true"`，20s 超时）与 `gotoReady(page, path)`（= `goto` + 等待），`expectPageOk` 末尾也补了该等待。**任何 click / fill 之前都必须先就绪**——`loginWithCode`、语言切换、汉堡菜单、日历设置与日期格、CalDAV 菜单、Idea CRUD、偏好恢复等所有「导航后即交互」处已全部改用 `gotoReady`。日历用例里原先的 `waitForTimeout(1000)` 定时 hack 已由该信号取代——**勿再加回定时等待**。
- **局限**：`data-hydrated` 只在**整页加载**时置位，客户端路由跳转后的新树不会重新置位（同一页面内本就是 SPA，交互能力在，无需重置）。故测试一律用 `page.goto` 整页加载；若将来有用例依赖「客户端跳转后新树已就绪」，需改成按 pathname 置位（如 `data-hydrated={pathname}`）再断言。
- **耦合**：该等待要求线上镜像包含 `data-hydrated`，所以「对生产跑冒烟」只能与同一次部署一起跑（`deploy.yml` 的 `smoke-test` 排在 `build-and-deploy` 之后，满足）。若在新镜像上线前手动 `E2E_BASE_URL=https://shaoyuanyu.cn pnpm exec playwright test`，会看到「等待 hydration 超时」——那是版本落后，不是 bug。

## 常用命令速查

```bash
pnpm dev                 # 开发模式（turbopack）
pnpm build && pnpm start # 生产构建 + standalone 运行
pnpm lint                # ESLint
pnpm test:e2e:local      # 本地全量冒烟（构建+启动+Playwright）
E2E_BASE_URL=https://shaoyuanyu.cn pnpm exec playwright test  # 对生产跑冒烟
pnpm totp:setup          # 生成/重生成 TOTP 密钥与恢复码
pnpm fonts:subset        # 重新生成等宽字体（Noto Sans Mono CJK SC，单文件不分片，见「字体策略」）
pnpm fetch:publications  # 同步 Semantic Scholar 论文
pnpm fetch:ccf-dblp      # 同步 CCF 目录（DBLP）
pnpm fetch:deadlines     # 同步会议 deadline（ccfddl）
pnpm fetch:cas           # 同步中科院分区表（ShowJCR，需可访问 GitHub）
```
