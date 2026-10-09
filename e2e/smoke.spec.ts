import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ConsoleMessage, type Locator, type Page } from "@playwright/test";
import { TOTP } from "otpauth";

/**
 * 全站冒烟测试：核心页面 200 + 关键内容渲染 + 旧链接 301 + 关键资源可用。
 * 通过 E2E_BASE_URL 在本地（localhost）或线上（https://shaoyuanyu.cn）运行。
 */

/**
 * ⚠ **超时预算（CD 与本地的网络差异）**：CD 的 Smoke Test 跑在海外 runner 上、
 *   站点在国内 VPS，单次整页导航约 1s（本地约 0.1s），故用例耗时近似与
 *   「整页导航次数」成正比。**凡是跨 ≥12 次导航的用例都标了 `test.slow()`**
 *   （30s → 90s）：这不是掩盖问题，而是「遍历 N 条路由」这类结构性成本在跨海
 *   链路上必然放大。新增此类用例时同样标 slow，或先把导航次数压下来。
 *
 *   反面教材：字体「跨中/英同族」用例曾对「3 对页面 × 5 个选择器」逐个导航
 *   （30 次）——本地全绿、CD 必红（30s 超时）。同类成本高但不该盲加 slow 的
 *   场景：能用**一次导航 + 一次 evaluate** 取代「逐元素导航」的，先重构。
 */

/**
 * 单次等待 hydration 的超时（ms）。
 * 本站 hydration 实测约 2s（CI runner；本机 ~0.1s），8s 留了 4 倍余量。
 */
const HYDRATION_TIMEOUT_MS = 8_000;

/**
 * 等待客户端 hydration 完成（React 合成事件已挂载）。
 *
 * ⚠ **任何 click / fill 之前都必须先等它**：SSR 出的 HTML 在 `domcontentloaded`
 * 时已完整可见，但此刻 React 还没接管 DOM，此时派发的交互会被**静默丢弃**——
 * Playwright 的 click / fill 自身会正常返回（元素确实可见可点），失败会延后到
 * 后面的断言，表现为「URL 没变」「菜单没弹开」「元素找不到」，极难归因。
 * 本机（离 VPS 近）hydration ≈ DCL + 100ms，恰好盖住该窗口，测试侥幸全过；
 * CI runner 在海外、站点在国内 VPS，JS chunk 晚到数秒，故 CD Smoke Test 必红。
 * 复现方式：用 `page.route` 拦截 `_next/static/chunks` 下的 JS chunk 并加 2.5s
 * 延迟，`domcontentloaded` 后立刻 `fill("CVPR")` → URL 永不更新（与 CD 报错一致）。
 * 就绪信号由 `components/providers.tsx` 在挂载（= hydration 提交）后置位。
 *
 * ⚠ **允许「重新整页加载一次」**：CI 上出现过单次加载 20s 内不完成的情况
 *   （同一轮里同一条路由此前只用 ~2s 就完成、且本地在同等条件下连跑 9 次全过 →
 *   属**偶发停滞**而非代码缺陷，怀疑与浏览器↔Node 之间的 keep-alive 连接复用竞态
 *   有关：SSR 已返回、后续静态资源请求卡住）。此时重新整页加载一次即可恢复；
 *   **确定性缺陷会在第二次同样失败**（不会因此被掩盖），且失败信息带诊断上下文。
 */
async function waitForHydration(page: Page) {
  const wait = () =>
    page.waitForFunction(
      () => document.documentElement.dataset.hydrated === "true",
      undefined,
      { timeout: HYDRATION_TIMEOUT_MS },
    );

  try {
    await wait();
    return;
  } catch {
    // 首次超时 → 重新整页加载一次（保留当前 URL）
  }

  const url = page.url();
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  try {
    await wait();
  } catch (err) {
    // 仍失败：带上诊断信息再抛，便于下次失败时直接定位
    const diag = await page
      .evaluate(() => ({
        url: location.href,
        title: document.title,
        htmlClasses: document.documentElement.className,
        scripts: document.querySelectorAll('script[src*="/_next/"]').length,
        bodyChildren: document.body?.childElementCount ?? null,
        nextErrorOverlay: !!document.querySelector("nextjs-portal, #nextjs__container_errors"),
        visibleText: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 160),
      }))
      .catch(() => null);
    throw new Error(
      `等待 hydration 超时（已整页重载重试一次仍失败）\n  重试前 URL: ${url}\n  诊断: ${JSON.stringify(diag)}\n  原始错误: ${String(err)}`,
    );
  }
}

/**
 * standalone 运行时的数据目录。
 * `pnpm start` 以 `.next/standalone` 为 cwd（见 scripts/start-standalone.mjs），
 * 故运行时 data/ 落在其下（与仓库根的 data/ 不是同一个）。
 * ⚠ 勿写死绝对路径——CI 的工作目录不是本机路径（曾因写死 `/home/ysy/...`
 *   而在 CI 必红，只是当时这些用例被 TOTP_SECRET 跳过而没暴露）。
 */
const STANDALONE_DATA_DIR = join(process.cwd(), ".next", "standalone", "data");

/**
 * 读取 Radicale 存储里某个事件资源的**原始 ICS 文本**（按内容里的 UID 匹配）。
 *
 * 为什么需要它：`\,` 这类 TEXT 转义在**读方向**会被本站与桌面客户端反转义，
 * 只有**不做反转义的手机端 CalDAV 客户端**（华为/鸿蒙日历）才会把
 * `LOCATION:Providence\, RI\, USA` 原样显示出来——即从 `/api/calendar` 看永远是
 * 干净的，必须看原始文本才拦得住这类回归。
 * 存储位置：compose 与 CI 都把仓库的 `radicale/` 挂到容器的 `/data`
 * （`collections/collection-root/<用户>/<集合>/<href>.ics`）。
 * ⚠ 别猜文件名：Radicale 的 href → 文件名会剥掉域名段（`uid@host` 只留 `uid`）。
 */
function readRawIcs(uidNeedle: string): string {
  const root = join(process.cwd(), "radicale", "collections", "collection-root");
  if (!existsSync(root)) {
    throw new Error(`未找到 Radicale 存储目录 ${root}（本地需启动 radicale 容器）`);
  }
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // .Radicale.cache 里是同一份内容的缓存副本，跳过
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name.endsWith(".ics")) {
        const text = readFileSync(full, "utf8");
        if (text.includes(uidNeedle)) return text;
      }
    }
  }
  throw new Error(`未在 ${root} 找到含 ${uidNeedle} 的 .ics`);
}

/**
 * 日历服务是否**真的**可用（真实探测，而非只看环境变量）：
 * `/api/calendar` 在「未配置 CALDAV_URL」时返回 503、「配了但连不上」返回 502，
 * 两者都渲染不出月视图。需要真实日历服务的用例据此跳过——
 * 本地未起 Radicale（`docker start <容器>`）或 CI 未起服务时不再假红。
 * ⚠ 必须在登录后调用（该接口是站主专属，游客会得到 401）。
 */
async function calendarAvailable(page: Page) {
  const r = await page.request.get(
    "/api/calendar?start=2026-01-01&end=2026-01-02",
  );
  return r.status() === 200;
}

/** 整页导航到站内页面（`[locale]` 下的页面）并等待可交互 = goto + hydration。 */
async function gotoReady(page: Page, path: string) {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await waitForHydration(page);
}

async function expectPageOk(page: Page, path: string, heading?: string) {
  const res = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(res?.status(), `${path} 应返回 200`).toBe(200);
  if (heading) {
    await expect(
      page.getByRole("heading", { name: heading, level: 1 }),
      `${path} 应渲染 h1: ${heading}`,
    ).toBeVisible();
  }
  // 「可达」= 服务端 200 + 客户端已 hydration（其后往往紧跟交互断言）
  await waitForHydration(page);
}

/**
 * 量当前页面「顶栏容器 / 页脚容器 / 页面容器」的宽度与左缘。
 * 三者必须同宽同左缘——页面容器是站点唯一标准列（`max-w-6xl`），
 * 宽出或窄出都会让跳转时的标题（视觉锚点）左右横移。
 */
async function measureColumns(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.x), w: Math.round(b.width) };
    };
    return {
      header: box(document.querySelector(".site-header > div")),
      footer: box(document.querySelector("footer > div")),
      container: box(document.querySelector("main > div")),
    };
  });
}

/** 收集页面 console 错误 / 未捕获异常 */
function collectPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

// 测试密钥：优先取环境变量（CI 注入），否则读本地 .env
// CI 未注入时跳过——登录/主人功能由本地 E2E 与人工验证覆盖
const totpSecret = (() => {
  if (process.env.TOTP_SECRET) return process.env.TOTP_SECRET;
  try {
    const env = readFileSync(join(process.cwd(), ".env"), "utf8");
    return env.match(/^TOTP_SECRET=(.+)$/m)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
})();

/** 用 TOTP 码登录，成功后落在首页 */
async function loginWithCode(page: Page, code: string) {
  await gotoReady(page, "/login");
  await page.locator("#auth-code").fill(code);
  await expect(page).toHaveURL(/\/$/);
}

test.describe("页面可达性", () => {
  test("首页：200 + 中文内容", async ({ page }) => {
    await expectPageOk(page, "/", "YU Shaoyuan");
    await expect(page.getByText("你好，我是")).toBeVisible();
  });

  test("英文首页：200", async ({ page }) => {
    await expectPageOk(page, "/en", "YU Shaoyuan");
  });

  test("核心子页面：200", async ({ page }) => {
    for (const path of ["/publications", "/talks", "/projects", "/blog", "/ccf", "/cas", "/nav", "/deadlines", "/venues"]) {
      await expectPageOk(page, path);
    }
  });

  test("博客文章页：200 + 渲染标题", async ({ page }) => {
    await expectPageOk(page, "/blog/welcome", "欢迎来到我的博客");
  });

  test("博客文章页：TOC 锚点 + 阅读时间", async ({ page }) => {
    await expectPageOk(page, "/blog/welcome");
    // 目录侧栏存在且含文章标题锚点
    const tocLink = page.locator('nav[aria-label="目录"] a[href="#欢迎"]');
    await expect(tocLink).toBeVisible();
    // 阅读时间显示
    await expect(page.getByText(/阅读 \d+ 分钟|min read/)).toBeVisible();
    // 点击目录锚点后 URL 带 hash（中文会被 URL 编码，先解码再断言）
    await tocLink.click();
    await expect
      .poll(() => decodeURIComponent(page.url()))
      .toContain("#欢迎");
  });

  test("博客多语言：/blog 与 /en/blog 列出同一批文章", async ({ page }) => {
    const notice = page.locator('[data-slot="blog-fallback-notice"]');

    // ⚠ 先测无前缀（中文）路径，再测 /en 路径：访问过 /en/* 后 next-intl 会写入
    // NEXT_LOCALE=en cookie，之后同一 context 内的无前缀路径会被重定向到 /en。
    await page.context().clearCookies();

    // 仅英文版的文章在中文列表下同样可见（回退显示英文原文）
    await expectPageOk(page, "/blog");
    await expect(page.getByText("Notes on Interpreting LLMs")).toBeVisible();
    await expectPageOk(
      page,
      "/blog/llm-interpretability-notes",
      "Notes on Interpreting LLMs",
    );
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("本文暂无中文版本");

    // 反向：仅中文版的文章在英文列表下同样可见，详情页回退显示中文原文
    await expectPageOk(page, "/en/blog");
    await expect(page.getByText("欢迎来到我的博客")).toBeVisible();
    await expectPageOk(page, "/en/blog/welcome", "欢迎来到我的博客");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(/isn't available in English/);

    // 文章在两种语言下成对存在（语言切换不会 404）；双语文章各显示对应版本、
    // 不显示回退提示的行为由构建期「全部文章 × 全部语言」路由 + 手动验证覆盖
    // （见 CLAUDE.md 博客一节）。
  });
});

test.describe("旧链接与 SEO 资源", () => {
  test("/zh 及 /zh/* 301 重定向到无前缀路径", async ({ request }) => {
    for (const [from, to] of [
      ["/zh", "/"],
      ["/zh/publications", "/publications"],
      ["/zh/blog/welcome", "/blog/welcome"],
    ] as const) {
      const res = await request.get(from, { maxRedirects: 0 });
      expect(res.status(), `${from} 应为 301`).toBe(301);
      expect(res.headers()["location"], `${from} 的 Location`).toBe(to);
    }
  });

  test("RSS feed 可用且为 XML", async ({ request }) => {
    const res = await request.get("/feed.xml");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/rss+xml");
    expect(await res.text()).toContain("<rss version=\"2.0\"");
  });

  test("sitemap 不含 /zh 前缀 URL", async ({ request }) => {
    const res = await request.get("/sitemap.xml");
    expect(res.status()).toBe(200);
    expect(await res.text()).not.toContain("/zh");
  });

  test("文章 OG 图：200 + PNG", async ({ request }) => {
    const res = await request.get("/blog/welcome/opengraph-image");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/png");
  });

  test("站点 OG 图：200 + PNG", async ({ request }) => {
    const res = await request.get("/opengraph-image");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/png");
  });
});

/**
 * 字体策略（见 CLAUDE.md「字体策略」与 app/globals.css）：
 * **按「角色」分派，与页面语言无关** —— 同一元素在中/英页面必然同族。
 * 对齐 Anthropic 官网范式（实测：其 `body`/`main` 默认即衬线，无衬线是覆盖层）：
 * - 无衬线（默认，约 90% 文本）：全部页面标题（h1）、功能 UI、说明文字、
 *   元数据（日期/计数）、**外部专名（会议/期刊全名、外链名）**
 * - 有衬线：**两个角色** —— ① 连续阅读的长正文（≥16px + 行高 ≥1.6，载体带
 *   `data-longform`）；② **首页 hero 的展示标题块**（人名 + 职务行，载体带
 *   `data-display-serif`，对应 Anthropic 首页 `.big-cta_title` 的 68px 衬线）
 * - 等宽：标识符与数字（缩写/ISSN/年份/日期）、逐字代码、品牌 Logo，
 *   以及 `.eyebrow-label` 全大写技术眉标
 *
 * ⚠ 判据是「衬线**单义**」：长正文的衬线 = 「你在读一段正文」，展示标题块的
 *   衬线 = 「这是身份/品牌签名」。两者都不得降级去承担小字说明——一旦衬线
 *   同时是大标题又是小字说明，sans/serif 的对比就不再指向任何语义。
 *
 * 旧范式（按页面语言切字体 / 衬线覆盖说明文字与专名）已废弃。
 */
test.describe("字体策略（按角色）", () => {
  /** 读取元素解析后的 font-family 声明值 */
  async function family(page: Page, selector: string) {
    return page
      .locator(selector)
      .first()
      .evaluate((el) => getComputedStyle(el).fontFamily);
  }

  const SERIF = /Tinos/i; // 有衬线栈首族——**仅长正文（data-longform）合法**
  const MONO = /Noto Sans Mono CJK SC/i; // 等宽栈首族（自托管分片）

  /**
   * 一次导航内抓取多个选择器的解析字体族（元素不存在 → null，**不等待**）。
   *
   * ⚠ 不要用 `locator.evaluate` 做这件事：元素缺失时它会一直等到**用例超时**
   *   （30s）才抛错，在跨海 CI 上会把「选择器写错」伪装成「用例超时」。
   */
  async function families(page: Page, selectors: readonly string[]) {
    return page.evaluate((sels) => {
      const out: Record<string, string | null> = {};
      for (const s of sels) {
        const el = document.querySelector(s);
        out[s] = el ? getComputedStyle(el).fontFamily : null;
      }
      return out;
    }, selectors as string[]);
  }

  /**
   * 核心不变式：同一元素在中文页与英文页必须解析到同一个字体族。
   *
   * ⚠ 成本：跨 3 对页面。若「每个选择器各走一轮」（原始的 3 × 5 写法），仅 5 个
   *   选择器就要 **30 次整页导航** —— 本地够快、CD 上必碰 30s 超时。
   *   故改为**每对页面各导航一次、一次抓完全部选择器**（6 次导航）。
   */
  test("同一元素跨中/英页面同族（核心不变式）", async ({ page }) => {
    test.slow();
    const pairs: [string, string][] = [
      ["/", "/en"],
      ["/ccf", "/en/ccf"],
      ["/venues", "/en/venues"],
    ];
    const selectors = [
      "h1",
      "main p",
      ".site-header a[data-slot='button']",
      "footer p",
      ".font-mono",
    ] as const;

    for (const [zh, en] of pairs) {
      // ⚠ 先中文再英文：访问 /en/* 会写 NEXT_LOCALE=en cookie，
      // 其后的无前缀路径会被重定向到 /en，导致「中文页」其实测的是英文页。
      await page.context().clearCookies();
      await page.goto(zh, { waitUntil: "domcontentloaded" });
      const zhFonts = await families(page, selectors);
      await page.goto(en, { waitUntil: "domcontentloaded" });
      const enFonts = await families(page, selectors);

      let compared = 0;
      for (const sel of selectors) {
        const zhFont = zhFonts[sel];
        const enFont = enFonts[sel];
        if (zhFont === null || enFont === null) continue;
        compared++;
        expect(enFont, `${sel} 在 ${zh} 与 ${en} 应同族`).toBe(zhFont);
      }
      // 防假绿：选择器全部失效（类名改动、元素被移除）时上面会全部 continue 掉，
      // 用例「通过」却什么都没测。故要求每对页面至少比较到一个元素。
      expect(compared, `${zh} 与 ${en} 未比较到任何元素，选择器可能已失效`).toBeGreaterThan(0);
    }
  });

  test("功能性 UI 一律无衬线（顶部栏/页脚/区块标题/徽章/分段控件）", async ({ page }) => {
    const probes: [string, string][] = [
      ["/ccf", ".site-header a[data-slot='button']"],
      ["/ccf", "footer p"],
      ["/ccf", "h2"],
      ["/ccf", "[data-slot='badge']"],
      ["/ccf", "[data-slot='toggle-group-item']"],
      ["/venues", "[data-slot='badge']"],
    ];
    for (const [path, sel] of probes) {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      const loc = page.locator(sel).first();
      await expect(loc, `${path} 应存在 ${sel}`).toBeVisible();
      const f = await loc.evaluate((el) => getComputedStyle(el).fontFamily);
      expect(f, `${path} 的 ${sel} 属功能 UI，应为无衬线，实际: ${f}`).not.toMatch(SERIF);
    }
  });

  /**
   * ★ 核心不变式：衬线只有两个合法角色，且都有显式标记：
   *   a. `[data-longform]` —— 长正文（博客/速记正文）
   *   b. `[data-display-serif]` —— 首页 hero 的人名/职务展示标题块
   * 其余任何地方解析到衬线栈都是违规。
   * 这条断言把「衬线语义单义」变成机器可校验的约束，防止后续新增页面时回退。
   */
  test("衬线只出现在长正文或首页展示标题块内", async ({ page }) => {
    test.slow(); // 16 条路由整页导航，见文件顶部「超时预算」
    for (const path of [
      "/",
      "/publications",
      "/talks",
      "/projects",
      "/blog",
      "/blog/welcome",
      "/blog/llm-interpretability-notes",
      "/nav",
      "/ccf",
      "/cas",
      "/deadlines",
      "/venues",
      "/login",
      "/en",
      "/en/venues",
      "/en/ccf",
    ]) {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      const offenders = await page.locator("main *").evaluateAll((els) =>
        els
          .filter((el) => {
            const s = getComputedStyle(el);
            if (!s.fontFamily.includes("Tinos")) return false;
            return !el.closest("[data-longform]") && !el.closest("[data-display-serif]");
          })
          .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 48)}`)
          .slice(0, 6),
      );
      expect(offenders, `${path} 在长正文与展示标题块之外使用了衬线`).toEqual([]);
    }
  });

  /**
   * h1 默认无衬线（Anthropic 范式：衬线不承担页面标题）。
   * 唯一例外：首页 hero 的人名 —— 它是「展示标题块」（data-display-serif），
   * 对应 Anthropic 首页 `.big-cta_title` 的大字衬线写法。
   */
  test("h1 无衬线（首页人名除外）", async ({ page }) => {
    test.slow(); // 14 条路由整页导航，见文件顶部「超时预算」
    for (const path of [
      "/publications",
      "/talks",
      "/projects",
      "/blog",
      "/blog/welcome",
      "/nav",
      "/ccf",
      "/cas",
      "/deadlines",
      "/venues",
      "/login",
      "/en/venues",
    ]) {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      const f = await family(page, "h1");
      expect(f, `${path} 的页面主标题应为无衬线，实际: ${f}`).not.toMatch(SERIF);
    }

    // 首页 hero：人名是唯一合法的「衬线 h1」，且必须带 data-display-serif 标记
    for (const path of ["/", "/en"]) {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      const marked = await page
        .locator("main h1")
        .first()
        .evaluate((el) => !!el.closest("[data-display-serif]"));
      expect(marked, `${path} 的衬线 h1 必须位于 [data-display-serif] 内`).toBe(true);
    }
  });

  test("等宽：Logo / 标识符 / 逐字代码统一走 Noto Sans Mono CJK SC", async ({ page }) => {
    await page.goto("/blog/welcome", { waitUntil: "domcontentloaded" });
    expect(await family(page, ".prose code"), "代码块应等宽").toMatch(MONO);
    expect(await family(page, ".site-header a.font-mono"), "Logo 应等宽").toMatch(MONO);

    await page.goto("/ccf", { waitUntil: "domcontentloaded" });
    expect(await family(page, "li span.font-mono"), "CCF 缩写应等宽").toMatch(MONO);
  });

  /**
   * 字阶下限：全站最小字号 12px（不再出现 10/11px 的「看不清」小字）。
   * 字阶为 12/14/16/18/20/24/30/48（长正文 17px 除外）。
   * ⚠ 排除 REUI 日历（安装产物，内部 11px 事件 chip 属第三方样式）。
   */
  test("正文文本不小于 12px", async ({ page }) => {
    for (const path of ["/", "/ccf", "/cas", "/venues", "/deadlines", "/nav", "/blog"]) {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      const offenders = await page.locator("main *").evaluateAll((els) =>
        els
          .filter((el) => {
            if (el.closest("[data-slot^='event-calendar']")) return false;
            const own = [...el.childNodes]
              .filter((n) => n.nodeType === 3)
              .map((n) => (n.textContent ?? "").trim())
              .join("")
              .trim();
            if (!own) return false;
            const s = getComputedStyle(el);
            if (s.visibility === "hidden" || s.display === "none") return false;
            return parseFloat(s.fontSize) < 12;
          })
          .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} @${getComputedStyle(el).fontSize}`)
          .slice(0, 6),
      );
      expect(offenders, `${path} 存在小于 12px 的正文文本`).toEqual([]);
    }
  });

  /**
   * 等宽眉标（.eyebrow-label）：全大写 + 等宽，用于数据卡片的短标签。
   * 这是 Anthropic 范式的第三种语气（技术性标注），必须落在等宽族。
   */
  test("等宽眉标走等宽字体", async ({ page }) => {
    await page.goto("/ccf", { waitUntil: "domcontentloaded" });
    const badge = page.locator(".eyebrow-label").first();
    await expect(badge).toBeVisible();
    expect(await badge.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(MONO);
    expect(await badge.evaluate((el) => getComputedStyle(el).textTransform)).toBe("uppercase");
  });

  /**
   * 客户端切换语言（不刷新）时字体**不应变化**——角色制下字体与语言无关。
   * 用客户端点击而非直接 goto（直接 goto 走完整 SSR，绕过客户端渲染路径）。
   */
  test("客户端切换语言：字体不变", async ({ page }) => {
    await page.context().clearCookies();
    await gotoReady(page, "/venues");
    const body = page.locator("main p").first();
    const font = () => body.evaluate((el) => getComputedStyle(el).fontFamily);
    const before = await font();

    await page.getByRole("button", { name: "Switch language" }).click();
    await page.getByRole("menuitem", { name: /English/i }).first().click();
    await expect(page).toHaveURL(/\/en\/venues$/);

    // URL 先于 RSC 提交落地，故 poll 等字体稳定
    await expect
      .poll(font, { message: "切换语言后字体不应变化（角色制与语言无关）" })
      .toBe(before);
  });

  test("未匹配路由渲染站内 404（无衬线主标题 + 语言化文案 + 返回入口）", async ({ page }) => {
    const res = await page.goto("/no-such-page");
    expect(res?.status()).toBe(404);

    // 2026-09 前项目缺根级 not-found.tsx，未匹配 URL 会落到 Next 内置 404
    // （h1 class=next-error-h1、字体 system-ui、英文硬编码），现改为站内 404
    const h1 = page.locator("h1");
    await expect(h1).toBeVisible();
    const f = await family(page, "h1");
    expect(f, "404 主标题应为无衬线栈").not.toMatch(SERIF);
    await expect(page.getByText("页面不存在")).toBeVisible();
    await expect(page.getByRole("link", { name: "首页" })).toBeVisible();

    // 英文语境下渲染英文文案、返回链接带 /en 前缀（字体与中文页一致）
    const enRes = await page.goto("/en/no-such-page");
    expect(enRes?.status()).toBe(404);
    await expect(page.getByText("Page not found")).toBeVisible();
    await expect(page.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/en");
    expect(await family(page, "h1")).not.toMatch(SERIF);
  });
});

/**
 * 排版与可访问性规格（WCAG AA 对比度 / 卡片内边距 / 字阶）
 *
 * 本项目没有视觉回归基线，故把「程序化取证」的结论固化成断言。
 *
 * ⚠ 颜色换算必须交给浏览器自己：Tailwind v4 下 `getComputedStyle` 返回的是
 *   `lab(...)` / `oklab(...)`（不是 rgb），**手写换算极易算错并给出「全部通过」的假结果**
 *   （项目曾据此误判浅色徽章达标，实际只有 4.35:1）。这里用 canvas 作精确转换器：
 *   连续两次赋值 `fillStyle`（先非法哨兵、再目标值），随后 `getImageData` 得到
 *   浏览器自己的非预乘 sRGB。暗色主题必须真测——半透明底只有合成后才知道实际对比度。
 */
test.describe("排版与可访问性规格", () => {
  /** WCAG 相对亮度 */
  const relLum = (c: number[]) => {
    const f = (v: number) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a: number[], b: number[]) => {
    const [x, y] = [relLum(a), relLum(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const flatten = (fg: number[], bg: number[]) => {
    const a = fg[3] ?? 1;
    return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
  };

  /** 收集 main 内所有「有自有文本节点」的元素的颜色 / 祖先背景链 / 字号字重 */
  async function collectText(page: Page) {
    return page.evaluate(() => {
      type Item = {
        txt: string;
        color: string;
        chain: string[];
        fs: number;
        fw: number;
        cls: string;
      };
      const out: Item[] = [];
      const walk = (el: Element) => {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0")
          return;
        const own = [...el.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => (n.textContent ?? "").trim())
          .join("")
          .trim();
        if (own && el.getBoundingClientRect().width > 0) {
          const chain: string[] = [];
          let cur: Element | null = el;
          while (cur) {
            chain.push(getComputedStyle(cur).backgroundColor);
            cur = cur.parentElement;
          }
          out.push({
            txt: own.slice(0, 24),
            color: cs.color,
            chain,
            fs: parseFloat(cs.fontSize),
            fw: parseFloat(cs.fontWeight),
            cls: String(el.className).slice(0, 48),
          });
        }
        for (const c of el.children) walk(c);
      };
      const root = document.querySelector("main");
      if (root) walk(root);
      return out;
    });
  }

  /** 用 canvas 把任意 CSS 颜色（lab / oklab / 带 alpha）换成精确 sRGB */
  async function toSrgb(page: Page, colors: string[]) {
    return page.evaluate((list: string[]) => {
      const cv = document.createElement("canvas");
      cv.width = cv.height = 1;
      const cx = cv.getContext("2d")!;
      return list.map((v) => {
        cx.fillStyle = "#123456"; // 哨兵：v 非法时保持不变，可据此判断
        cx.fillStyle = v;
        cx.clearRect(0, 0, 1, 1);
        cx.fillRect(0, 0, 1, 1);
        const d = cx.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2], d[3] / 255] as number[];
      });
    }, colors);
  }

  /** 返回该页面所有未达 WCAG AA 的文本（正文 4.5:1 / 大字 3:1） */
  async function contrastFailures(page: Page, path: string, dark?: boolean) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    if (dark !== undefined)
      await page.waitForFunction(
        (d) => document.documentElement.classList.contains("dark") === d,
        dark,
      );
    const items = await collectText(page);
    const all = [...new Set(items.flatMap((i) => [i.color, ...i.chain]))];
    const conv = await toSrgb(page, all);
    const byColor = new Map(all.map((v, i) => [v, conv[i]]));
    const bad: string[] = [];
    for (const it of items) {
      const fg = byColor.get(it.color);
      if (!fg) continue;
      let bg: number[] | null = null;
      for (const c of it.chain) {
        const p = byColor.get(c);
        if (p && p[3] > 0.99) {
          bg = p;
          break;
        }
      }
      if (!bg) bg = [255, 255, 255, 1];
      const r = ratio(fg[3] < 1 ? flatten(fg, bg) : fg, bg);
      const large = it.fs >= 24 || (it.fs >= 18.66 && it.fw >= 700);
      const need = large ? 3 : 4.5;
      if (r < need)
        bad.push(`"${it.txt}" ${r.toFixed(2)}:1（需 ${need}）fg=${it.color} ${it.cls}`);
    }
    return bad;
  }

  const AA_ROUTES = [
    "/",
    "/blog/welcome",
    "/ccf",
    "/cas",
    "/deadlines",
    "/venues",
    "/nav",
    "/login",
  ];

  test("正文文本对比度达 WCAG AA（浅色 + 深色）", async ({ page }) => {
    test.slow(); // 8 条路由 × 2 主题 = 16 次导航，见文件顶部「超时预算」
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const path of AA_ROUTES) {
        const bad = await contrastFailures(page, path, scheme === "dark");
        expect(bad, `${scheme} 主题下 ${path} 存在未达 WCAG AA 的文本`).toEqual([]);
      }
    }
  });

  /**
   * 卡片内边距四边必须对称。
   *
   * ⚠ 陷阱：`ui/card.tsx` 的 `Card` 自带 `py-(--card-spacing)`（16px），而 `CardContent`
   *   基础类只有 `px-*`。故在 `CardContent` 上写 `p-3` / `py-4` / `pb-3` **只改水平方向**，
   *   垂直方向会变成 `16 + N`（曾出现 28:12、32:16 的「上下发空」）。
   *   正确写法是同时给 `Card` 加 `py-0`，让 CardContent 独自掌控内边距。
   */
  test("卡片内边距四边对称", async ({ page }) => {
    for (const path of ["/", "/blog", "/nav", "/ccf", "/cas", "/deadlines", "/venues", "/publications"]) {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      const bad = await page.evaluate(() => {
        const out: string[] = [];
        for (const card of document.querySelectorAll("[data-slot=card]")) {
          const cr = card.getBoundingClientRect();
          const provs = [...card.children].filter((c) =>
            /card-(header|content|footer)/.test(c.getAttribute("data-slot") ?? ""),
          );
          if (!provs.length) continue;
          let t = Infinity;
          let b = -Infinity;
          let l = Infinity;
          let r = -Infinity;
          let measurable = false;
          for (const pv of provs) {
            const pcs = getComputedStyle(pv);
            const pb = pv.getBoundingClientRect();
            if (pb.width <= 0) continue;
            measurable = true;
            t = Math.min(t, pb.top + parseFloat(pcs.paddingTop));
            b = Math.max(b, pb.bottom - parseFloat(pcs.paddingBottom));
            l = Math.min(l, pb.left + parseFloat(pcs.paddingLeft));
            r = Math.max(r, pb.right - parseFloat(pcs.paddingRight));
          }
          if (!measurable || !isFinite(t)) continue;
          // 排除被 grid 拉伸到等高的卡片：内容顶对齐 → 底部留白属布局而非内边距
          const ccs = getComputedStyle(card);
          const gap = parseFloat(ccs.rowGap) || 0;
          const inner = provs.reduce((s, x) => s + x.getBoundingClientRect().height, 0);
          const natural =
            parseFloat(ccs.paddingTop) +
            parseFloat(ccs.paddingBottom) +
            inner +
            gap * Math.max(0, provs.length - 1);
          if (cr.height > natural + 2) continue;

          const vals = {
            t: Math.round(t - cr.top),
            b: Math.round(cr.bottom - b),
            l: Math.round(l - cr.left),
            r: Math.round(cr.right - r),
          };
          if (Math.abs(vals.t - vals.b) > 2 || Math.abs(vals.t - vals.l) > 2)
            out.push(`上${vals.t} 下${vals.b} 左${vals.l} 右${vals.r} ${String(card.className).slice(0, 40)}`);
        }
        return out.slice(0, 6);
      });
      expect(bad, `${path} 存在内边距不对称的卡片（Card 与 CardContent 内边距叠加？）`).toEqual([]);
    }
  });

  /**
   * 字阶：只允许体系内的值。30/36 用于页面主标题，48/60 用于首页展示标题块。
   * 防的是 `text-[0.8rem]`（12.8px）这类非体系、非整数的「看起来差不多」尺寸。
   */
  test("字阶只用体系内的值", async ({ page }) => {
    const ALLOWED = [12, 14, 16, 17, 18, 20, 24, 30, 36, 48, 60];
    for (const path of ["/", "/blog/welcome", "/ccf", "/cas", "/deadlines", "/venues", "/nav"]) {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      const bad = await page.evaluate(
        (allowed: number[]) => {
          const out = new Set<string>();
          const walk = (el: Element) => {
            if (el.closest("[data-slot^='event-calendar']")) return; // 第三方日历内部样式
            const cs = getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden") return;
            const own = [...el.childNodes]
              .filter((n) => n.nodeType === 3)
              .map((n) => (n.textContent ?? "").trim())
              .join("")
              .trim();
            if (own && el.getBoundingClientRect().width > 0) {
              const px = parseFloat(cs.fontSize);
              if (!allowed.some((a) => Math.abs(a - px) < 0.01)) out.add(cs.fontSize);
            }
            for (const c of el.children) walk(c);
          };
          const root = document.querySelector("main");
          if (root) walk(root);
          return [...out];
        },
        ALLOWED,
      );
      expect(bad, `${path} 出现体系外的字号`).toEqual([]);
    }
  });

  /**
   * 最窄视口下页面内容不得横向溢出（中英文各一遍）。
   *
   * 顶部栏另有一条断言；这里防的是**内容区**的溢出——英文字段名比中文长得多，
   * 单个 `shrink-0` 的筛选 chip 就能宽过 360px 视口（`/en/ccf` 曾溢出 64px）。
   */
  test("窄屏（360px）无横向溢出", async ({ page }) => {
    test.slow(); // 8 条路由 × 2 语言 = 16 次导航，见文件顶部「超时预算」
    const routes = ["/", "/publications", "/blog", "/ccf", "/cas", "/deadlines", "/venues", "/nav"];
    await page.setViewportSize({ width: 360, height: 900 });

    const overflowAt = async (path: string) => {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      return page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
    };

    // ⚠ 先中文再英文：访问 /en/* 会写 NEXT_LOCALE=en cookie，
    // 之后无前缀路径会被重定向到 /en，导致「中文页」其实测的是英文页。
    await page.context().clearCookies();
    for (const path of routes)
      expect(await overflowAt(path), `${path} 在 360px 下横向溢出`).toBeLessThanOrEqual(0);

    await page.context().clearCookies();
    for (const path of routes) {
      const en = path === "/" ? "/en" : `/en${path}`;
      expect(await overflowAt(en), `${en} 在 360px 下横向溢出`).toBeLessThanOrEqual(0);
    }
  });

  /**
   * 页面容器 = 站点唯一标准列（`max-w-6xl`）：与顶栏 / 页脚同宽同左缘。
   *
   * 全站所有「有标题的页面」共用一个列宽——宽度不一致时，跳转会让标题（视觉锚点）
   * 左右横移，观感最差（用户 2026-10 反馈：`/mail/compose` 曾单独用 `max-w-3xl`，
   * 与 `/mail` 之间往返时宽度从 768 跳到 1152）。
   * `/login` 的登录卡片是组件宽度（`max-w-sm`）、页面无标题，但页面容器同样在标准列内。
   * ⚠ owner 页面（`/mail` 全系列、`/calendar`、`/ideas`）在「站内邮件」describe 的
   *   「容器宽度」用例里覆盖（需要登录态）。
   */
  test("页面容器与站点头栏同宽同左缘（全站唯一标准列）", async ({ page }) => {
    test.slow(); // 12 条路由整页导航，见文件顶部「超时预算」
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const path of [
      "/",
      "/publications",
      "/blog",
      "/blog/welcome",
      "/talks",
      "/projects",
      "/nav",
      "/ccf",
      "/cas",
      "/deadlines",
      "/venues",
      "/login",
    ]) {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      const m = await measureColumns(page);
      expect(m.container, `${path} 应有页面根容器`).not.toBeNull();
      expect(m.header, `${path} 应有顶栏容器`).not.toBeNull();
      expect(m.container!.w, `${path} 的页面容器必须与顶栏同宽（max-w-6xl）`).toBe(m.header!.w);
      expect(m.container!.w, `${path} 的页面容器必须与页脚同宽`).toBe(m.footer!.w);
      expect(m.container!.x, `${path} 的页面容器必须与顶栏左缘对齐`).toBe(m.header!.x);
    }
    // 复位视口，避免影响后续用例
    await page.setViewportSize({ width: 1280, height: 720 });
  });
});

test.describe("空态与可点区域（防「看不见的文案」「点不动的卡片」）", () => {
  /**
   * ⚠ 系统性缺陷回归：`<Empty title={t("…")} />` 里的文案会落成 DOM 的 `title`
   *   属性（只有鼠标悬浮提示），**页面上一个字都不显示** —— 用户搜不到结果时
   *   只看见一个空的虚线框。当时 8 处（publications / talks / projects / blog /
   *   nav / ccf / cas / deadlines）全部如此，而既有用例只断言 h1，谁也发现不了。
   *   这里统一断言「空态容器里必须有可见文字」。
   */
  test("空态容器内必须有可见文案（多个页面）", async ({ page }) => {
    test.slow(); // 9 条路由整页导航 + 其中 6 条要填搜索框，见文件顶部「超时预算」
    const cases: { path: string; search?: string }[] = [
      { path: "/publications" },
      { path: "/talks" },
      { path: "/projects" },
      { path: "/blog", search: "zzzz-not-exist" },
      { path: "/nav", search: "zzzz-not-exist" },
      { path: "/ccf", search: "zzzz-not-exist" },
      { path: "/cas", search: "zzzz-not-exist" },
      { path: "/deadlines", search: "zzzz-not-exist" },
      { path: "/venues", search: "zzzz-not-exist" },
    ];
    for (const c of cases) {
      await gotoReady(page, c.path);
      if (c.search) {
        await page.locator("main input").first().fill(c.search);
        await page.waitForTimeout(400);
      }
      const empty = page.locator('[data-slot="empty"]').first();
      await expect(empty, `${c.path} 应出现空态`).toBeVisible();
      const visible = (await empty.innerText()).replace(/\s+/g, "");
      expect(visible.length, `${c.path} 的空态文案必须可见（不能只放在 title 属性里）`).toBeGreaterThan(0);
      // 空态文字不应只存在于 title 属性
      expect(
        await empty.locator('[data-slot="empty-title"], [data-slot="empty-description"]').count(),
        `${c.path} 空态应使用 EmptyTitle / EmptyDescription 渲染文字`,
      ).toBeGreaterThan(0);
    }
  });

  test("/deadlines 会议卡片可键盘打开（整卡可点）", async ({ page }) => {
    await gotoReady(page, "/deadlines");
    const card = page.locator(".grid.grid-cols-1 [data-slot=card]").first();
    // 卡片铺有一个覆盖整卡的按钮，供键盘到达（鼠标点击走 Card 的 onClick）
    const opener = card.locator("[data-slot=deadline-card-open]");
    await expect(opener).toHaveCount(1);

    // 聚焦后卡片必须有可见的焦点指示（环画在 Card 的 focus-within 上：
    // Card 自带 overflow-hidden，覆盖层上的外扩 ring 会被裁掉）
    const ring = () => card.evaluate((el) => getComputedStyle(el).boxShadow);
    const before = await ring();
    await opener.focus();
    expect(await ring(), "卡片获得焦点后应有可见的焦点环").not.toBe(before);

    await page.keyboard.press("Enter");
    const dialog = page.locator("[data-slot=dialog-content]");
    await expect(dialog.locator("[data-slot=dialog-title]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("/nav 链接卡整卡可点（悬停反馈与真实可点区域一致）", async ({ page }) => {
    await gotoReady(page, "/nav");
    // 每张链接卡都被 <a>/<Link> 包裹，且卡内不再有嵌套链接
    const wrappers = page.locator("main a.group.block");
    expect(await wrappers.count()).toBeGreaterThan(10);
    expect(await page.locator("main a.group.block a[href]").count()).toBe(0);

    // 采样卡片的四边与中心：每一点都应命中该卡片的 <a> 内部
    // （此前只有标题文字可点，卡片的 hover:border 反馈是「空头支票」）
    const misses = await page.evaluate(() => {
      const anchors = [...document.querySelectorAll<HTMLAnchorElement>("main a.group.block")];
      const bad: string[] = [];
      for (const a of anchors.slice(0, 12)) {
        const r = a.getBoundingClientRect();
        if (r.width === 0) continue;
        const pts: [number, number][] = [
          [r.left + r.width / 2, r.top + 6],
          [r.left + r.width / 2, r.top + r.height / 2],
          [r.left + r.width / 2, r.bottom - 6],
          [r.left + 6, r.top + r.height / 2],
          [r.right - 6, r.top + r.height / 2],
        ];
        for (const [x, y] of pts) {
          if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
          const hit = document.elementFromPoint(x, y);
          if (!hit || !a.contains(hit)) {
            bad.push(`${a.textContent?.trim().slice(0, 12)} @${Math.round(x)},${Math.round(y)}`);
            break;
          }
        }
      }
      return bad;
    });
    expect(misses, "这些卡片的可点区域没有覆盖整卡").toEqual([]);
  });
});

test.describe("主题切换（顶部栏）", () => {
  /**
   * 触发按钮显示的是「**所选设置**」（浅色/深色/跟随系统），与下拉菜单选项一一
   * 对应，**不是**「当前生效主题」。
   *
   * 背景（曾看起来像 bug）：next-themes（`attribute="class"` + `enableSystem`）
   * 只把**解析后**的主题写进 DOM——选「跟随系统」时它先读 `prefers-color-scheme`，
   * 把结果写成 `.dark`，**「system」这个设置值在 DOM 里根本不存在**（只活在
   * `localStorage["theme"]` 与 React state）。此前触发按钮按 `.dark` 判断
   * （`dark:hidden` / `hidden dark:block`），于是「跟随系统 + 系统为浅色」时显示
   * 太阳，看似设置未生效。现由 `app/layout.tsx` 的内联 script 在首帧 paint 前
   * 标记 `<html class="theme-{light,dark,system}">`，按钮据此以 CSS 择一显示
   * 太阳 / 月亮 / 半日半夜（`data-theme-icon`，见 globals.css）。
   */
  test("按钮图标反映「所选设置」（跟随系统 ≠ 当前生效的浅/深色）", async ({ page }) => {
    const html = page.locator("html");
    const trigger = page.getByRole("button", { name: "切换主题" });
    const icon = (name: string) => trigger.locator(`[data-theme-icon="${name}"]`);
    // next-themes 写的 .dark 才是「当前生效主题」，与设置标记是两回事
    const effectiveDark = () => html.evaluate((el) => el.classList.contains("dark"));

    // 默认（新 context，无 localStorage["theme"]）= 跟随系统
    await gotoReady(page, "/");
    await expect(html).toHaveClass(/theme-system/);
    await expect(icon("system")).toBeVisible();
    await expect(icon("light")).toBeHidden();
    await expect(icon("dark")).toBeHidden();

    // ★ 关键回归：系统为深色时「跟随系统」仍显示半日半夜图标（而非月亮），
    //   与此同时生效主题确实是深色
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(effectiveDark).toBe(true);
    await expect(html).toHaveClass(/theme-system/);
    await expect(icon("system")).toBeVisible();
    await expect(icon("dark")).toBeHidden();

    // 手动选「深色」→ 月亮
    await trigger.click();
    await page.getByRole("menuitem", { name: "深色" }).click();
    await expect(html).toHaveClass(/theme-dark/);
    await expect(icon("dark")).toBeVisible();
    await expect(icon("system")).toBeHidden();
    await expect.poll(effectiveDark).toBe(true);

    // 手动选「浅色」→ 太阳（系统此时仍是深色，说明确实按设置而非按系统）
    await trigger.click();
    await page.getByRole("menuitem", { name: "浅色" }).click();
    await expect(html).toHaveClass(/theme-light/);
    await expect(icon("light")).toBeVisible();
    await expect(icon("system")).toBeHidden();
    await expect.poll(effectiveDark).toBe(false);

    // 回到「跟随系统」→ 半日半夜，生效主题跟随系统回到深色
    await trigger.click();
    await page.getByRole("menuitem", { name: "跟随系统" }).click();
    await expect(html).toHaveClass(/theme-system/);
    await expect(icon("system")).toBeVisible();
    await expect.poll(effectiveDark).toBe(true);
  });
});

test.describe("关键资源", () => {
  /**
   * 等宽字体的缓存头 + **中英双语可用性**（回归点）。
   *
   * 背景一（缓存）：字体最初放在 `public/fonts/`，而 Next.js 对 `public/` 下的文件
   * 默认发 `Cache-Control: public, max-age=0`——**每次访问都要发一次条件请求
   * revalidate**（304 不重传 body，但多一次网络往返）。改到 `app/fonts/` + CSS
   * 相对 url() 后由 webpack 接管：加内容哈希、输出到 `_next/static/media/`、
   * 发 immutable 长缓存。⚠ 若有人把脚本改回 `public/` 或把 url() 改回绝对路径
   * `/fonts/…`，此用例会失败。
   *
   * 背景二（不分片）：早期版本按 unicode-range 切成 latin + cjk 两个分片，
   * 于是「等宽族里有没有汉字」变成了性能开关。现已改为**单文件覆盖拉丁 +
   * 常用汉字**（Regular / Bold 各一个，那是**字重**而非覆盖分片），
   * 代码注释里的中文必须是等宽、且不能触发额外的文件下载。
   * ⚠ 若有人改回 unicode-range 分片，此用例的「恰好 2 个 URL 且均无
   * unicode-range」断言会失败。
   */
  test("等宽字体：内容哈希 + immutable 长缓存，且单文件覆盖中英、无 unicode-range", async ({
    page,
    request,
  }) => {
    await page.goto("/ccf", { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);

    // 收集该字体族的全部 @font-face 规则（Regular + Bold → 两条）
    const faces = await page.evaluate(() => {
      const out: { url: string | undefined; unicodeRange: string }[] = [];
      for (const sheet of document.styleSheets) {
        let list: CSSRuleList;
        try {
          list = sheet.cssRules;
        } catch {
          continue; // 跨域表读不到，跳过
        }
        for (const rule of Array.from(list)) {
          if (
            rule instanceof CSSFontFaceRule &&
            rule.style.fontFamily.includes("Noto Sans Mono CJK SC")
          ) {
            const url = rule.cssText.match(/url\(["']?([^"')]+)["']?\)/)?.[1];
            // unicode-range 未设置时 cssText 里不出现该属性 → 取空串
            const ur = rule.cssText.match(/unicode-range:\s*([^;]+);/)?.[1]?.trim() ?? "";
            out.push({ url, unicodeRange: ur });
          }
        }
      }
      return out;
    });

    expect(faces.length, `应为 Regular + Bold 两条 @font-face，实际: ${faces.length}`).toBe(2);
    for (const f of faces) {
      // ⚠ 不再有 unicode-range —— 单文件覆盖中英文，不存在「汉字触发大文件下载」
      expect(f.unicodeRange, `${f.url} 不应带 unicode-range（已取消分片）`).toBe("");
      const u = f.url ?? "";
      expect(u, `字体 URL 应为构建产物路径（带内容哈希）: ${u}`).toMatch(
        /^\/_next\/static\/media\/noto-sans-mono-cjk-sc(-bold)?\.[0-9a-f]{8}\.woff2$/,
      );
      const res = await request.get(u);
      expect(res.status(), `${u} 应可访问`).toBe(200);
      const cc = res.headers()["cache-control"] ?? "";
      expect(cc, `${u} 应发 immutable 长缓存（原 public/ 方案是 max-age=0）`).toContain(
        "immutable",
      );
      expect(cc).toContain("max-age=31536000");
    }
  });

  test("等宽字体含汉字：中文按 2:1 倍宽渲染（等宽列对齐）", async ({ page }) => {
    await page.goto("/ccf", { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);

    // 探针：拉丁 1 字 vs 汉字 1 字。Noto Sans Mono CJK SC 的度量是
    // 拉丁 0.5em / 汉字 1.0em，故一个汉字必须恰好等于两个拉丁字符宽。
    const r = await page.evaluate(() => {
      const el = document.createElement("span");
      el.style.cssText =
        "position:absolute;visibility:hidden;white-space:pre;font-family:var(--font-mono);font-size:100px";
      document.body.appendChild(el);
      const w = (t: string) => {
        el.textContent = t;
        return el.getBoundingClientRect().width;
      };
      const oneLatin = w("i");
      const oneHan = w("中");
      el.remove();
      return { oneLatin, oneHan };
    });

    expect(r.oneLatin, "拉丁字符宽应约为 0.5em = 50px").toBeCloseTo(50, 0);
    expect(r.oneHan, "汉字宽应约为 1em = 100px（等宽字体已生效，未回退系统字体）").toBeCloseTo(
      100,
      0,
    );
    expect(r.oneHan / r.oneLatin, "汉字应恰好是 2 倍拉丁宽（2:1 对齐）").toBeCloseTo(2, 1);
  });

  test("学术导航页图标（自托管 favicon）可用", async ({ page }) => {
    await expectPageOk(page, "/nav");
    // 等待所有图片加载 / fallback 完成后再检查
    await page.waitForLoadState("networkidle");
    // 至少一个自托管 favicon 应加载成功
    const broken = await page
      .locator('img[src^="/favicons/"]')
      .evaluateAll((imgs) =>
        imgs
          .map((img) => (img as HTMLImageElement).naturalWidth === 0)
          .filter(Boolean).length,
      );
    expect(broken, `导航页应有加载失败的图标（实际 ${broken} 个）`).toBe(0);
  });

  test("CCF 目录条目带 DBLP 外链", async ({ page }) => {
    await expectPageOk(page, "/ccf");
    // 绝大多数条目应有 DBLP 链接
    const dblpLinks = page.locator('a[aria-label$=" on DBLP"]');
    const count = await dblpLinks.count();
    expect(count, `DBLP 链接数应足够多（实际 ${count} 个）`).toBeGreaterThan(100);
    // 抽查：ASPLOS 行应直链到其 DBLP venue 页
    const asplosRow = page.locator("li", { hasText: "ASPLOS" }).first();
    await expect(asplosRow.locator('a[aria-label="ASPLOS on DBLP"]')).toHaveAttribute(
      "href",
      /dblp\.org\/db\/conf\/asplos/,
    );
    // 外链应新窗口打开
    await expect(asplosRow.locator('a[aria-label="ASPLOS on DBLP"]')).toHaveAttribute(
      "target",
      "_blank",
    );
  });

  test("CAS 分区表：分区徽章 + 筛选", async ({ page }) => {
    await expectPageOk(page, "/cas", "中科院 SCI 分区表");
    // 分区徽章（1-4 区）存在
    for (const zone of ["1", "2", "3", "4"]) {
      await expect
        .poll(
          async () => page.getByLabel(`${zone} 大类分区`).count(),
          `应有 ${zone} 区徽章`,
        )
        .toBeGreaterThan(0);
    }
    // 默认排序：IEEE Communications Surveys and Tutorials 大类排名第 1 应在首屏
    await expect(
      page.locator("li", { hasText: "IEEE Communications Surveys and Tutorials" }),
    ).toBeVisible();
    // 搜索过滤后列表变短（行内第二行固定含「排名 x/y」文本，用它定位行）
    const before = await page.locator("li", { hasText: "排名" }).count();
    await page.getByLabel("搜索刊名、缩写或 ISSN…").fill("pattern analysis");
    await expect(
      page.getByText("IEEE TRANSACTIONS ON PATTERN ANALYSIS AND MACHINE INTELLIGENCE"),
    ).toBeVisible();
    const after = await page.locator("li", { hasText: "排名" }).count();
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
  });

  test("页面无控制台错误", async ({ page }) => {
    const errors = collectPageErrors(page);
    await expectPageOk(page, "/");
    expect(errors, `首页控制台错误: ${errors.join("; ")}`).toEqual([]);
  });
});

test.describe("Venue Explorer（期刊会议速查）", () => {
  test("页面 200 + 默认态热门速查区", async ({ page }) => {
    await expectPageOk(page, "/venues", "期刊会议速查");
    // 默认不铺开列表：引导 + 热门速查区（标题常驻，chips 数据驱动）
    await expect(
      page.getByRole("heading", { name: "即将截稿的 CCF-A 会议" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /双顶期刊/ }),
    ).toBeVisible();
  });

  test("搜索 CVPR：会议栏命中 + A 徽章 + 详情 Dialog", async ({ page }) => {
    await expectPageOk(page, "/venues");
    await page.getByLabel("搜索缩写、名称、ISSN 或领域…").fill("CVPR");
    await expect(page).toHaveURL(/q=CVPR/);

    const confRegion = page.getByRole("region", { name: "会议" });
    const card = confRegion
      .locator("li")
      .filter({ hasText: "IEEE/CVF Computer Vision and Pattern Recognition Conference" });
    await expect(card).toBeVisible();
    await expect(card.getByLabel("CCF A")).toBeVisible();

    // 点击卡片打开详情：全称 + 年份数据区
    await card.locator("button").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      "IEEE/CVF Computer Vision and Pattern Recognition Conference",
    );
    await expect(dialog).toContainText(/20\d\d/);
  });

  test("搜索 TPAMI：期刊栏双评级徽章对照", async ({ page }) => {
    await expectPageOk(page, "/venues");
    await page.getByLabel("搜索缩写、名称、ISSN 或领域…").fill("TPAMI");

    const jourRegion = page.getByRole("region", { name: "期刊" });
    const card = jourRegion
      .locator("li")
      .filter({ hasText: "IEEE Transactions on Pattern Analysis and Machine Intelligence" });
    await expect(card).toBeVisible();
    // CCF-A（药丸）+ 中科院 1 区（方徽）双评级并排
    await expect(card.getByLabel("CCF A")).toBeVisible();
    await expect(card.getByLabel("中科院 1 区")).toBeVisible();

    // 清空按钮恢复默认态
    await page.getByLabel("清除搜索").click();
    await expect(
      page.getByRole("heading", { name: "即将截稿的 CCF-A 会议" }),
    ).toBeVisible();
  });
});

/**
 * 论文（手工维护）
 *
 * 数据源是 `content/publications.yaml`（纯手工维护，无任何自动同步 —— arXiv /
 * Semantic Scholar 的脚本与工作流已于 2026-09 全部移除）。当前数据为空，故这里
 * 锁住的是**工具栏契约**，它曾被踩中过：schema 允许 `thesis`，而筛选档位只有
 * 「会议/期刊/预印本」三档 → 数据合法却筛不出来（静默漂移）。
 *
 * 档位现由 `lib/publications/constants.ts` 的 `PUBLICATION_TYPES` 单一来源生成，
 * 本用例即该来源的回归：**schema 有几个类型，页面就必须有几个档位**。
 */
test.describe("论文（手工维护）", () => {
  test("类型筛选档位与 PUBLICATION_TYPES 一致，且空态有可见文案", async ({ page }) => {
    await expectPageOk(page, "/publications", "论文");

    // 「全部」+ 四种类型（conference / journal / preprint / thesis）
    const chips = page.locator('[data-slot="toggle-group-item"]');
    await expect(chips).toHaveCount(5);
    for (const label of ["全部", "会议", "期刊", "预印本", "学位论文"]) {
      await expect(
        chips.filter({ hasText: new RegExp(`^${label}$`) }),
        `筛选档位缺「${label}」`,
      ).toHaveCount(1);
    }

    // 切到「学位论文」档不应报错，空态文案仍可见（数据为空属预期）
    await chips.filter({ hasText: /^学位论文$/ }).click();
    const empty = page.locator('[data-slot="empty"]');
    await expect(empty).toContainText("暂无论文");
    await expect(empty).toContainText("论文整理中");
  });

  /**
   * 首页论文区块是**动态**的：置顶优先，无置顶则最新 N 篇，**完全没有论文时整块不渲染**
   * （不显示空状态）。提交版本的论文数据为空列表，故这里锁住的就是「不渲染」这条
   * 分支 —— 有数据的分支（置顶/最新 N 篇）需临时塞样例验证，见 CLAUDE.md。
   */
  test("首页：没有论文时不渲染论文区块", async ({ page }) => {
    await gotoReady(page, "/");
    await expect(page.locator('[data-slot="home-publications"]')).toHaveCount(0);
  });
});

test.describe("主人登录（TOTP）", () => {
  test.skip(!totpSecret, "未配置 TOTP_SECRET，跳过登录测试");

  test("登录页 200 + 表单可见", async ({ page }) => {
    await expectPageOk(page, "/login");
    await expect(page.locator("#auth-code")).toBeVisible();
    // 游客提示：无需登录
    await expect(page.getByText("游客无需登录")).toBeVisible();
    // 限定在表单内：导航栏也有游客态「登录」入口
    await expect(
      page.locator("form").getByRole("button", { name: /登录|Sign in/ }),
    ).toBeVisible();
  });

  test("错误验证码被拒绝且不设会话", async ({ page }) => {
    await gotoReady(page, "/login");
    await page.locator("#auth-code").fill("000000");
    // 限定在表单内：避免命中 Next.js 路由播报器（role=alert，shadow root）
    await expect(page.locator("form").getByRole("alert")).toBeVisible();
    const cookies = await page.context().cookies();
    expect(cookies.some((c) => c.name === "owner_session")).toBe(false);
  });

  /**
   * ⚠ 登录限流（此前完全没有用例，且实际是坏的）：
   *   限流计数器曾是模块级 `new Map`，而 **Next.js 会逐请求重新求值模块**，
   *   于是每个请求都拿到空表 —— 实测连试 12 次都不锁（CLAUDE.md 却写着
   *   「每 IP 5 次失败锁 15 分钟」）。修法：状态挂 `globalThis`
   *   （见 `lib/utils/global-state.ts`），并修正 IP 取值（原先取
   *   `x-forwarded-for` 首段，而 nginx 用 `$proxy_add_x_forwarded_for` 是**追加**，
   *   首段是客户端可伪造值 → 攻击者换个假头就绕过限流）。
   *
   * 用例用一个**独立的伪造 IP** 分桶，避免把跑测试的机器自己的 IP 锁 15 分钟
   * （那会让同一轮里其它登录用例全部收到 429）。
   */
  test("登录限流：同一 IP 连续 5 次失败后锁定（429 + 限流文案）", async ({ request }) => {
    // ⚠ 对生产跑冒烟时跳过：生产经 nginx，`x-real-ip` 会被**覆盖**成 runner 的真实
    //   IP（无法伪造分桶），锁定后同一轮里后续所有登录用例都会收到 429。
    //   本地跑（无 nginx）时该头原样传入，可安全分桶。
    test.skip(!!process.env.E2E_BASE_URL, "远端冒烟跳过：限流按真实 IP 分桶，会锁住 runner");
    const ip = "203.0.113.7"; // TEST-NET-3，仅用于分桶
    const post = (code: string) =>
      request.post("/api/auth/totp", {
        data: { code },
        headers: { "x-real-ip": ip },
      });

    // 前 5 次：都是「验证码无效」
    for (let i = 0; i < 5; i += 1) {
      const r = await post(String(100000 + i));
      expect(r.status(), `第 ${i + 1} 次失败应为 401`).toBe(401);
      expect((await r.json()).error).toBe("invalid_code");
    }
    // 第 6 次：锁定（修 bug 前这里是 401 —— 限流静默失效）
    const locked = await post("999999");
    expect(locked.status(), "第 6 次应返回 429（此前是静默失效的 401）").toBe(429);
    expect((await locked.json()).error).toBe("rate_limited");

    // 换一个分桶：不受影响，仍然可以正常登录（限流不误伤其它 IP）
    const code = new TOTP({ secret: totpSecret! }).generate();
    const ok = await request.post("/api/auth/totp", {
      data: { code },
      headers: { "x-real-ip": "203.0.113.99" },
    });
    expect(ok.status(), "限流不应误伤其它 IP").toBe(200);
  });

  test("正确 TOTP 码登录成功并设置会话", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);
    const cookies = await page.context().cookies();
    expect(cookies.some((c) => c.name === "owner_session")).toBe(true);
  });

  test("已登录访问 /login 重定向回首页", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);
    await page.goto("/login");
    await expect(page).toHaveURL(/\/$/);
  });

  test("登出后会话被清除", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);
    await page.request.post("/api/auth/logout");
    const cookies = await page.context().cookies();
    expect(cookies.some((c) => c.name === "owner_session")).toBe(false);
  });

  test("我的菜单：通过导航退出登录", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);

    // 桌面视口下：高频功能「速记」单列入口 +「我的」菜单
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole("link", { name: "速记" })).toBeVisible();
    await expect(page.getByRole("button", { name: "我的" })).toBeVisible();

    // 菜单仅含「退出登录」（权限类操作）
    await page.getByRole("button", { name: "我的" }).click();
    await expect(page.getByRole("menuitem", { name: /退出登录/ })).toBeVisible();
    await page.getByRole("menuitem", { name: /退出登录/ }).click();

    // 等导航刷新为「登录」（= 登出请求完成 + 登录态查询完成），再断言会话清除，
    // 避免登出 fetch 与 cookie 读取之间的竞态
    await expect(page.getByRole("link", { name: "登录" })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    const cookies = await page.context().cookies();
    expect(cookies.some((c) => c.name === "owner_session")).toBe(false);
  });

  /**
   * 顶部栏响应式：断点 lg（1024）——<lg 收进汉堡 Sheet，≥lg 内联展开。
   * 回归背景：英文文案（Publications / Scratchpad / Calendar）比中文长两倍以上，
   * 登录态在 768~1023 区间内联导航放不下（实测 768px 需 910px、可用仅 705px），
   * 曾横向溢出把「我的/主题/语言」挤出视口。此处锁定「任一视口/语言/登录态下
   * 都不溢出」+「断点两侧入口均可达」。
   */
  test("响应式：多视口 × 中英文的顶部栏均不横向溢出", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);

    // 768/820：中宽度（iPad 竖屏等）；1024/1280/1440：内联导航展开后
    for (const width of [768, 820, 1024, 1280, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      for (const path of ["/", "/en"]) {
        await page.goto(path, { waitUntil: "domcontentloaded" });
        const { headerOverflow, docOverflow } = await page
          .locator(".site-header > div")
          .evaluate((el) => ({
            headerOverflow: el.scrollWidth - el.clientWidth,
            // scrollbar-gutter: stable 会预留滚动条宽度，故此值为 0 或负
            docOverflow:
              document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
          }));
        expect(
          headerOverflow,
          `${path} @ ${width}px：顶部栏内容（登录态）不应横向溢出`,
        ).toBeLessThanOrEqual(0);
        expect(
          docOverflow,
          `${path} @ ${width}px：页面不应出现横向滚动（登录态）`,
        ).toBeLessThanOrEqual(0);
      }
    }
  });

  test("响应式：断点两侧入口都可达（<1024 汉堡菜单 / ≥1024 内联导航）", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);
    const desktopNav = page.locator(".site-header nav");

    // <lg：内联导航收起，汉堡菜单出现，且 Sheet 内提供完整入口
    // （主人专属「速记/日历」也必须在此可达，否则中宽度下功能真空）
    await page.setViewportSize({ width: 768, height: 800 });
    await gotoReady(page, "/");
    await expect(desktopNav).toBeHidden();
    await page.getByRole("button", { name: "菜单" }).click();
    const sheetNav = page.locator(".sheet-nav");
    for (const name of ["首页", "博客", "速记", "日历", "导航", "邮箱"]) {
      await expect(
        sheetNav.getByRole("link", { name, exact: true }),
        `768px 汉堡菜单应含入口「${name}」`,
      ).toBeVisible();
    }
    // 移动端 Sheet 内不再渲染分隔竖线（纵向列表）
    await expect(sheetNav.locator("span.bg-border\\/60")).toBeHidden();

    // ≥lg：内联导航展开，汉堡菜单消失（不再有收起的入口）
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoReady(page, "/");
    await expect(desktopNav).toBeVisible();
    for (const name of ["首页", "博客", "速记", "日历", "导航", "邮箱"]) {
      await expect(
        desktopNav.getByRole("link", { name, exact: true }),
        `1280px 内联导航应含入口「${name}」`,
      ).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "菜单" })).toBeHidden();
  });
});

test.describe("Idea 速记（主人专属）", () => {
  test.skip(!totpSecret, "未配置 TOTP_SECRET，跳过登录测试");

  test("游客访问 /ideas 被重定向到登录页", async ({ page }) => {
    await page.goto("/ideas");
    await expect(page).toHaveURL(/\/login/);
  });

  test("游客调用 ideas API 返回 401", async ({ request }) => {
    const res = await request.get("/api/ideas");
    expect(res.status()).toBe(401);
  });

  test("登录后页面 200 + 速记表单可见", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);
    await expectPageOk(page, "/ideas", "Idea 速记");
    await expect(page.getByLabel(/记录一个 Idea/)).toBeVisible();
  });

  test("创建 → 标记完成 → 编辑 → 删除", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);
    await gotoReady(page, "/ideas");

    const marker = String(Date.now());
    const origin = `E2E 测试 Idea ${marker}：对比学习中的灾难性遗忘`;
    const edited = `E2E 测试 Idea ${marker}（已编辑）：换个研究方向`;

    // 创建
    await page.getByLabel(/记录一个 Idea/).fill(origin);
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByText(origin)).toBeVisible();

    // 标记完成 → 出现「已完成」徽标
    await page.getByRole("button", { name: "标记为已完成" }).click();
    await expect(page.getByText(origin).locator("..")).toContainText("已完成");

    // 行内编辑：改内容后保存（保存按钮在列表项内，避免与顶部表单按钮歧义）
    await page.getByRole("button", { name: "编辑" }).first().click();
    const editBox = page.locator("textarea").last();
    await editBox.fill(edited);
    await page.locator("li").getByRole("button", { name: "保存" }).click();
    await expect(page.getByText(edited)).toBeVisible();

    // 删除：站内自绘确认弹窗（**不再用原生 window.confirm**——原生弹窗不随主题、
    // 样式与站内脱节、移动端观感突兀且阻塞主线程）→ 确认后条目消失
    const nativeDialogs: string[] = [];
    page.on("dialog", (d) => void nativeDialogs.push(d.type()));
    await page.getByRole("button", { name: "删除" }).first().click();
    const confirm = page.locator('[data-slot="confirm-dialog"]');
    await expect(confirm).toBeVisible();
    await expect(confirm.locator("[data-slot=dialog-title]")).toBeVisible();
    // 取消不删除
    await confirm.getByRole("button", { name: "取消" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByText(edited)).toBeVisible();
    // 再次打开并确认删除
    await page.getByRole("button", { name: "删除" }).first().click();
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "删除" }).click();
    await expect(page.getByText(edited)).toHaveCount(0);
    expect(nativeDialogs, "不应弹出原生 confirm").toEqual([]);
  });
});

test.describe("主人偏好持久化（服务器）", () => {
  test.skip(!totpSecret, "未配置 TOTP_SECRET，跳过登录测试");

  test("游客访问偏好 API 返回 401", async ({ request }) => {
    const get = await request.get("/api/preferences");
    expect(get.status()).toBe(401);
    const patch = await request.patch("/api/preferences", {
      data: { "ccf:filters": {} },
    });
    expect(patch.status()).toBe(401);
  });

  test("登录后：未知 key 与非法值被拒绝", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);

    const unknown = await page.request.patch("/api/preferences", {
      data: { "unknown:key": 1 },
    });
    expect(unknown.status()).toBe(400);

    const invalid = await page.request.patch("/api/preferences", {
      data: { "ccf:filters": { level: "X" } },
    });
    expect(invalid.status()).toBe(400);
  });

  test("登录后：写入 → 读取 → 删除", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);

    const payload = {
      "ccf:filters": { fields: ["人工智能"], type: "conf", level: "A", q: "" },
    };
    const r = await page.request.patch("/api/preferences", { data: payload });
    expect(r.status()).toBe(200);
    const body = (await r.json()) as { preferences: Record<string, unknown> };
    expect(body.preferences["ccf:filters"]).toEqual(payload["ccf:filters"]);

    // 读取验证
    const g = await page.request.get("/api/preferences");
    const got = (await g.json()) as { preferences: Record<string, unknown> };
    expect(got.preferences["ccf:filters"]).toEqual(payload["ccf:filters"]);

    // 删除（null）后 key 不存在
    const d = await page.request.patch("/api/preferences", {
      data: { "ccf:filters": null },
    });
    const after = (await d.json()) as { preferences: Record<string, unknown> };
    expect(after.preferences["ccf:filters"]).toBeUndefined();
  });

  test("登录后 CCF 页面从服务器恢复领域筛选", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);

    // 服务器写入「人工智能 + A 级会议」偏好（模拟另一台设备的选择）
    const payload = {
      "ccf:filters": { fields: ["人工智能"], type: "conf", level: "A", q: "" },
    };
    const r = await page.request.patch("/api/preferences", { data: payload });
    expect(r.status()).toBe(200);

    // 无 URL 参数访问 /ccf：应恢复服务器偏好，只显示人工智能分组
    await gotoReady(page, "/ccf");
    await expect(
      page.getByRole("heading", { name: "人工智能", level: 2 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "计算机体系结构", level: 2 }),
    ).toHaveCount(0);

    // 清理服务器偏好（用例自清理，保持本地数据干净）
    await page.request.patch("/api/preferences", {
      data: { "ccf:filters": null },
    });
  });
});

test.describe("Deadline 手动同步（主人专属）", () => {
  test.skip(!totpSecret, "未配置 TOTP_SECRET，跳过登录测试");

  test("游客访问 /deadlines：无同步按钮", async ({ page }) => {
    await gotoReady(page, "/deadlines");
    await expect(
      page.getByRole("button", { name: "立即同步" }),
    ).toHaveCount(0);
  });

  test("登录后访问 /deadlines：同步按钮可见", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);

    await gotoReady(page, "/deadlines");
    await expect(
      page.getByRole("button", { name: "立即同步" }),
    ).toBeVisible();
  });

  test("游客调用 CalDAV API 返回 401", async ({ request }) => {
    const r = await request.post("/api/deadlines/caldav", {
      data: {
        a: "TEST",
        n: "Test",
        year: 2027,
        label: "Paper",
        utc: 1759363199000,
      },
    });
    expect(r.status()).toBe(401);
  });

  test("游客：日历动作只有 Google 日历 / 下载 .ics（卡片菜单 + 弹窗下拉）", async ({
    page,
  }) => {
    const card = page.locator(".grid.grid-cols-1 [data-slot=card]").first();
    await gotoReady(page, "/deadlines");

    // 卡片右下角：选项式下拉
    await card.getByRole("button", { name: "加入日历" }).click();
    await expect(
      page.getByRole("menuitem", { name: "添加到我的日历" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("menuitem", { name: "Google 日历" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "下载 .ics" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    // 点卡片 → 普通详情（无勾选、无「添加选中的 N 个」），右下角同样是选项式下拉
    await card.locator("[data-slot=deadline-card-title]").click();
    const dialog = page.locator("[data-slot=dialog-content]");
    await expect(dialog.locator("[data-slot=dialog-title]")).toBeVisible();
    await expect(dialog.locator("input[type=checkbox]")).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: /添加选中的/ }),
    ).toHaveCount(0);
    await dialog.getByRole("button", { name: "加入日历" }).click();
    await expect(
      page.getByRole("menuitem", { name: "下载 .ics" }),
    ).toBeVisible();
  });

  test("站主：图标进勾选态；点卡片进普通详情（再点「添加到我的日历」才勾选）", async ({
    page,
  }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);
    await gotoReady(page, "/deadlines");

    const card = page.locator(".grid.grid-cols-1 [data-slot=card]").first();
    const dialog = page.locator("[data-slot=dialog-content]");
    const boxes = dialog.locator("input[type=checkbox]");
    const submit = dialog.getByRole("button", { name: /添加选中的/ });

    // ① 点卡片右下角日历图标 → 直接进勾选态（默认全选、含已过节点）
    const icon = card.getByRole("button", { name: "添加到我的日历" });
    await expect(icon).not.toHaveAttribute("aria-haspopup", "menu");
    await icon.click();
    await expect(dialog.locator("[data-slot=dialog-title]")).toBeVisible();
    expect(await boxes.count()).toBeGreaterThan(0);
    for (const box of await boxes.all()) {
      await expect(box).toBeChecked();
    }
    await expect(submit).toBeEnabled();
    await boxes.first().uncheck();
    await expect(submit).toContainText(String((await boxes.count()) - 1));
    await dialog.getByRole("button", { name: "清空" }).click();
    await expect(submit).toBeDisabled();
    await page.keyboard.press("Escape");

    // ② 点卡片 → 普通详情：没有复选框，右下角是「添加到我的日历」
    await card.locator("[data-slot=deadline-card-title]").click();
    await expect(dialog.locator("[data-slot=dialog-title]")).toBeVisible();
    await expect(boxes).toHaveCount(0);
    await expect(submit).toHaveCount(0);
    await dialog.getByRole("button", { name: "添加到我的日历" }).click();
    await expect(boxes.first()).toBeChecked();
  });

  test("提交勾选：成功后关闭弹窗，且 toast 图层在弹窗之上", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    // ⚠ 打桩写入 API：本用例只验证交互与图层，不碰真实日历
    await page.route("**/api/deadlines/caldav", (route) =>
      route.fulfill({ json: { ok: true, added: 2, failed: 0 } }),
    );
    await loginWithCode(page, code);
    await gotoReady(page, "/deadlines");

    const card = page.locator(".grid.grid-cols-1 [data-slot=card]").first();
    await card.getByRole("button", { name: "添加到我的日历" }).click();
    const dialog = page.locator("[data-slot=dialog-content]");
    const submit = dialog.getByRole("button", { name: /添加选中的/ });
    await expect(submit).toBeEnabled();

    // 弹窗打开时断言图层：toast 视口必须高于弹窗。
    // ⚠ 曾两者同为 z-50，而弹窗门户在 DOM 中排在 toast 门户之后 → 成功提示被
    //   弹窗遮罩整个盖住（toast 项自身的 z-1000 只在视口层叠上下文内有效）。
    const z = await page.evaluate(() => ({
      toast: getComputedStyle(
        document.querySelector("[data-slot=toast-viewport]")!,
      ).zIndex,
      dialog: getComputedStyle(
        document.querySelector("[data-slot=dialog-content]")!,
      ).zIndex,
    }));
    expect(Number(z.toast)).toBeGreaterThan(Number(z.dialog));

    await submit.click();
    // 成功后弹窗关闭（用户指定：勾选窗口职责已完成，不该继续挡着）
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("[data-slot=toast-title]")).toContainText(
      "已添加 2 个日程",
    );
    // toast 未被遮挡：其中心点命中的元素仍属于 toast 自身
    const coveredBy = await page.evaluate(() => {
      const t = document.querySelector("[data-slot=toast-title]")!;
      const r = t.getBoundingClientRect();
      const el = document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2,
      );
      if (el?.closest("[data-slot=toast]")) return null;
      return el?.getAttribute("data-slot") ?? el?.tagName ?? null;
    });
    expect(coveredBy).toBeNull();
  });

  test("批量写入会议节点：同届同类型不同日期各自独立（UID 消歧）", async ({
    page,
  }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);

    // 用虚构会议（API 不校验是否在会议数据里）验证两件事：
    // ① 一次请求写入多个节点；② 同届同类型但日期不同的节点 UID 不冲突——
    //    旧 UID 方案（缩写-年份-类型[-轮次]）下两条会撞成同一个键、只剩一条
    //    （ccfddl 的轮次备注 61% 为空，NSDI/FAST 的一年两轮正是这种情况）。
    const nodes = [
      { utc: Date.UTC(2099, 0, 5, 15, 59, 59), labelKey: "paper", day: "2099-01-05" },
      { utc: Date.UTC(2099, 5, 5, 15, 59, 59), labelKey: "paper", day: "2099-06-05" },
    ];
    const r = await page.request.post("/api/deadlines/caldav", {
      data: {
        a: "ZZTEST",
        n: "E2E Test Conference",
        year: 2099,
        // 带逗号的地点：用于验证原始 ICS 里**不做** `\,` 转义（见下方断言）
        place: "Providence, RI, USA",
        nodes,
      },
    });
    test.skip(r.status() === 503, "未配置 CalDAV 凭证");
    expect(r.status()).toBe(200);
    expect(((await r.json()) as { added: number }).added).toBe(2);

    // 原始 ICS 里的**地点**：逗号已改写为中点，且**完整未被截断**。
    // 两个雷区都在这一行上：
    //   ① Radicale 用 vobject 校验并**重新序列化** item，而 vobject 把裸逗号当列表
    //      分隔符只保留第一项 → `LOCATION:Providence, RI, USA` 会静默变成
    //      `LOCATION:Providence`（丢数据）；所以逗号必须转义成 `\,`；
    //   ② 但**不做反转义的客户端**（手机端华为/鸿蒙日历）会把 `\,` 原样显示出来
    //      （用户报障）——网页端与桌面客户端都会反转义，故只有手机端暴露。
    // 两头夹住 → 地点必须**不含逗号**（改写为中点，与站内 `ADMA 2026 · 全文` 一致）。
    const rawIcs = readRawIcs("zztest-2099");
    expect(rawIcs, "地点的逗号应改写为中点").toContain(
      "LOCATION:Providence · RI · USA",
    );
    expect(
      rawIcs,
      "地点里不得留下 `\\,` / `\\;`（不做反转义的手机端客户端会原样显示）",
    ).not.toMatch(/LOCATION:.*\\[,;]/);
    expect(rawIcs, "事件其余字段不得被截断/改写").toContain(
      "SUMMARY:ZZTEST 2099 · Full Paper",
    );

    const list = await page.request.get(
      "/api/calendar?start=2099-01-01&end=2099-07-01",
    );
    const uids: string[] = (
      ((await list.json()) as { events?: { uid: string }[] }).events ?? []
    )
      .map((e) => e.uid)
      .filter((u) => u.startsWith("zztest"));
    expect(uids).toHaveLength(2);

    // 用例自清理（失败残留时：删 <uid>.ics，或在日历页手动删除）
    for (const uid of uids) {
      await page.request.delete(`/api/calendar/events/${encodeURIComponent(uid)}`);
    }
  });
});

test.describe("我的日历（主人专属）", () => {
  test.skip(!totpSecret, "未配置 TOTP_SECRET，跳过登录测试");

  test("游客访问 /calendar 被重定向到登录页", async ({ page }) => {
    await page.goto("/calendar");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("游客调用日历 API 返回 401", async ({ request }) => {
    const r = await request.get("/api/calendar?start=2026-01-01&end=2026-02-01");
    expect(r.status()).toBe(401);
  });

  test("游客删除日历日程返回 401", async ({ request }) => {
    const r = await request.delete("/api/calendar/events/test-uid-401");
    expect(r.status()).toBe(401);
  });

  test("登录后未配置凭证时删除日历日程返回 503", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);

    const r = await page.request.delete("/api/calendar/events/test-uid-503");
    // 本地 e2e 无凭证 → 503（CalDAV 服务未配置）；
    // 生产冒烟有凭证 → 按 UID 查无此事件 → 404（删除流程走到位）
    expect([503, 404]).toContain(r.status());
  });

  test("登录后顶部导航显示「日历」入口", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole("link", { name: "速记" })).toBeVisible();
    await expect(page.getByRole("link", { name: "日历" })).toBeVisible();
    // 未登录时导航栏无「日历」入口
  });

  test("游客导航栏无「日历」入口", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await expect(page.getByRole("link", { name: "日历" })).toHaveCount(0);
  });

  test("登录后访问 /calendar：页面 200 + 月视图可见", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);
    test.skip(!(await calendarAvailable(page)), "日历服务不可用（本地需先 docker start <radicale 容器>）");

    const res = await page.goto("/calendar", { waitUntil: "domcontentloaded" });
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "我的日历", level: 1 })).toBeVisible();
    // 月视图工具栏：跳转按钮 + 月份标题 + 周表头
    await expect(page.getByRole("button", { name: "今日" })).toBeVisible();
    await expect(page.getByRole("button", { name: "本月" })).toBeVisible();
    await expect(page.getByRole("button", { name: "上个月" })).toBeVisible();
    await expect(page.getByRole("button", { name: "下个月" })).toBeVisible();
    // 周表头（默认统一周日开始）——限定在月视图网格内（下方事件列表日期块也有「周日」字样）
    await expect(
      page
        .locator("[data-slot=event-calendar-month-header]")
        .getByText("周日", { exact: true }),
    ).toBeVisible();
  });

  test("加载态：数据到达前给出可见提示（网格降透明度 + 「正在读取日程…」）", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);
    test.skip(!(await calendarAvailable(page)), "日历服务不可用（本地需先 docker start <radicale 容器>）");
    // 人为延迟日历接口，观察中间态（6s 足够宽：hydration 后才发请求，断言在其后立刻执行）
    await page.route("**/api/calendar?*", async (route) => {
      await new Promise((r) => setTimeout(r, 6000));
      await route.continue();
    });
    await page.goto("/calendar", { waitUntil: "domcontentloaded" });
    await waitForHydration(page);

    // ① 月视图网格：REUI 用 data-loading + 降透明度表示加载中
    const grid = page.locator("[data-slot=event-calendar-content]");
    await expect(grid).toHaveAttribute("data-loading", "true");
    const dimmed = await grid.evaluate((el) => Number(getComputedStyle(el).opacity));
    expect(dimmed, "加载中网格应被压暗（避免看起来像「本月没有日程」）").toBeLessThan(1);
    // ② 列表区：spinner + 本地化文案（曾硬编码英文 aria-label="Loading"）
    await expect(page.getByText("正在读取日程…").first()).toBeVisible();
    const spinner = page.locator('[data-slot="spinner"][role="status"]').first();
    await expect(spinner).toHaveAttribute("aria-label", "正在读取日程…");

    // ③ 加载完成后提示消失，且不残留 data-loading
    await expect(page.getByText("正在读取日程…")).toHaveCount(0, { timeout: 20_000 });
    await expect(grid).not.toHaveAttribute("data-loading", "true");
  });

  test("周起始日设置：默认周日，可切换为周一并实时生效", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);
    test.skip(!(await calendarAvailable(page)), "日历服务不可用（本地需先 docker start <radicale 容器>）");
    // 重置为默认周日（防御上次运行残留的 monday 偏好）
    await page.request.patch("/api/preferences", {
      data: { "calendar:weekStart": "sunday" },
    });
    await gotoReady(page, "/calendar");

    const header = page.locator("[data-slot=event-calendar-month-header]");
    // 第一列表头即每周起始日（zh/en 默认统一周日）。注意 cell 内含窄屏缩写
    // span（display:none），toHaveText 会拼上缩写（「周日日」），须用按可见
    // 文本匹配的 getByText（旧断言「周一」表头同款写法）
    const firstHeader = header.getByText("周日", { exact: true }).first();
    await expect(firstHeader).toBeVisible();

    // 设置中切换为周一 → 表头实时更新（偏好广播，无需刷新）。
    // 周起始控件是 shadcn Tabs（Base UI），触发项可访问性 role 为 tab
    // ⚠ 关闭入口只有弹窗右上角的 X（`[data-slot=dialog-close]`）——底部那个与 X
    // 重复的「关闭」按钮已删除（用户指定），勿改回 `getByRole("button", { name: "关闭" })`
    const closeDialog = page.locator("[data-slot=dialog-close]");
    await page.getByRole("button", { name: "设置" }).click();
    await expect(page.getByRole("button", { name: "关闭" })).toHaveCount(0);
    await page.getByRole("tab", { name: "周一" }).click();
    await closeDialog.click();
    await expect(
      header.getByText("周一", { exact: true }).first(),
    ).toBeVisible();

    // 恢复默认周日（用例自清理，避免影响其他用例的默认断言）。
    // UI 切换只改本地状态，防抖 PATCH 可能未落盘测试就结束，
    // 显式 API 写入确保服务器数据干净
    await page.getByRole("button", { name: "设置" }).click();
    await page.getByRole("tab", { name: "周日" }).click();
    await closeDialog.click();
    await expect(firstHeader).toBeVisible();
    const reset = await page.request.patch("/api/preferences", {
      data: { "calendar:weekStart": "sunday" },
    });
    expect(reset.status()).toBe(200);
  });

  test("点击日期格聚焦：下方联动显示当天日程，可返回总览", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);
    test.skip(!(await calendarAvailable(page)), "日历服务不可用（本地需先 docker start <radicale 容器>）");
    await gotoReady(page, "/calendar");

    // 动态取「当月某日」（20 号，避免硬编码日期跨月失效）；
    // 日历页默认显示当前月（今天所在月）。REUI 标题格式 zh: yyyy年M月
    const now = new Date();
    const clickDay = now.getDate() <= 20 ? 20 : 15;
    const clickedDate = `${now.getFullYear()}年${now.getMonth() + 1}月${clickDay}日`;

    // 默认未聚焦：下方显示本月及未来日程总览
    await expect(
      page.getByRole("heading", { name: "本月及未来日程" }),
    ).toBeVisible();

    // 日期格用 dispatchEvent 派发（REUI cell 的可操作性检查会超时），必须在
    // hydration 完成后才能命中 onSlotClick——上面的 gotoReady 已确保
    // （原实现是这里 `waitForTimeout(1000)` 定时等待）

    /** 点击当月某日日期格（聚焦/取消聚焦）——REUI 月视图 cell：非当月带
        data-outside，日期号在 [data-slot=event-calendar-month-day-number] */
    const clickCell = () =>
      page.evaluate((day) => {
        const cells = Array.from(
          document.querySelectorAll("[data-slot=event-calendar-month-cell]"),
        );
        const cell = cells.find(
          (x) =>
            !x.hasAttribute("data-outside") &&
            x.querySelector("[data-slot=event-calendar-month-day-number]")
              ?.textContent === String(day),
        );
        cell?.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      }, clickDay);

    await clickCell();

    // 下方切换为当天日程 + 显示全部按钮（双向联动）
    await expect(
      page.getByRole("heading", { name: new RegExp(clickedDate) }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "显示全部" })).toBeVisible();

    // 再次点击同一日期格 → 取消聚焦，回到总览
    await clickCell();
    await expect(
      page.getByRole("heading", { name: "本月及未来日程" }),
    ).toBeVisible();

    // 「显示全部」按钮同样可返回总览
    await clickCell();
    await page.getByRole("button", { name: "显示全部" }).click();
    await expect(
      page.getByRole("heading", { name: "本月及未来日程" }),
    ).toBeVisible();

    // 翻月联动（bug 回归）：聚焦某天后点「下个月」→ 列表联动取消聚焦，
    // 切回「本月及未来日程」总览（曾停留在原日期列表不联动）
    await clickCell();
    await expect(
      page.getByRole("heading", { name: new RegExp(clickedDate) }),
    ).toBeVisible();
    await page.getByRole("button", { name: "下个月" }).click();
    await expect(
      page.getByRole("heading", { name: "本月及未来日程" }),
    ).toBeVisible();
  });

  /**
   * 手机端月视图 = 「颜色点」密度。
   *
   * 窄屏格宽只有约 45~49px（桌面 139px），同一个 chip 里的标题只会剩下两三个字
   * 加一个截断号，既读不出信息又白占一行高度 → 窄屏把日程退化为**类别色圆点**，
   * 文字整体隐藏，但 chip 由 REUI 生成的 `aria-label`（含完整标题与时间）保留，
   * 点圆点仍打开详情弹窗。跨天/全天条同理去掉文字、压扁成色条（跨度本身就是信息）。
   *
   * 这条用例锁三件事（都做过反向验证）：
   *   ① 圆点尺寸/形状/颜色与图例同色，且**完全落在格子内容区内**、不与日号重叠
   *      ——「跨天条车道占位 + 圆点行 + 「+N」行」的纵向预算曾算错两次（溢出 3px
   *      / 360px 视口溢出 12px），两次都是靠断言里的 `overflow` 抓出来的；
   *   ② 「+N 更多」在窄屏是「+N」（完整文案会超出格宽被截断），但可访问名仍是
   *      `labels.more` 的完整文案（REUI 在消费方自定义指示器时补 aria-label）；
   *   ③ 桌面端**不受影响**：chip 仍是带标题的完整胶囊、跨天条仍显示文字、高度 640。
   *
   * 数据用 `page.route` 打桩（不写真实日历数据）：某天 5 条不同类别的日程
   * （→ 3 个圆点 + 「+N」），外加一条跨天全天条与落在条下方的一条定时日程。
   */
  test("手机端月视图：日程退化为颜色点；桌面端仍显示标题", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);
    test.skip(!(await calendarAvailable(page)), "日历服务不可用（本地需先 docker start <radicale 容器>）");

    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dayStr = (d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
    const at = (d: number, h: number) => Date.UTC(y, m, d, h, 0, 0);
    const mk = (
      uid: string,
      summary: string,
      categories: string[],
      startUtc: number | null,
      endUtc: number | null,
      extra: Record<string, unknown> = {},
    ) => ({ uid, summary, categories, startUtc, endUtc, ...extra });

    const events = [
      // 同一天 5 条（不同类别 → 3 个圆点 + 「+N」）
      // ⚠ 不给 `confTitle`：chip 的可访问名取「洁净标题」优先，给了它就不再是 summary，
      //   下面的 `aria-label^=` 选择器会全都不中
      ...["abstract", "paper", "registration", "camera", "notification"].map((c, i) =>
        mk(`e2e-mobile-${c}`, `E2E MOBILE ${i}`, [c], at(12, 4 + i), at(12, 5 + i)),
      ),
      // 跨天全天条（5→7 日：allDayDate 首日 + start/end 定天数）
      mk("e2e-mobile-bar", "E2E MOBILE BAR", ["paper"], Date.UTC(y, m, 5), Date.UTC(y, m, 7), {
        allDayDate: dayStr(5),
      }),
      // 落在条下方的那一天（车道占位 + 圆点行必须同时装进内容区）
      mk("e2e-mobile-bar-day", "E2E MOBILE BAR DAY", ["camera"], at(6, 6), at(6, 7)),
    ];
    await page.route("**/api/calendar?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ events }),
      });
    });

    /** 圆点几何：尺寸/形状/是否落在内容区内/是否压到日号 */
    const dotGeometry = (page: Page, selector: string) =>
      page.locator(selector).first().evaluate((el) => {
        const content = el.parentElement as HTMLElement;
        const cell = el.closest("[data-slot=event-calendar-month-cell]")!;
        const r = el.getBoundingClientRect();
        const cr = content.getBoundingClientRect();
        const dr = cell
          .querySelector("[data-slot=event-calendar-month-day-number]")!
          .getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          w: Math.round(r.width),
          h: Math.round(r.height),
          radius: cs.borderRadius,
          bg: cs.backgroundColor,
          childDisplay: getComputedStyle(el.firstElementChild!).display,
          insideContent: r.top >= cr.top - 1 && r.bottom <= cr.bottom + 1,
          clearOfDayNumber: r.bottom <= dr.top + 0.5 || r.right <= dr.left + 0.5,
          contentOverflow: content.scrollHeight - content.clientHeight,
          label: el.getAttribute("aria-label"),
        };
      });

    await page.setViewportSize({ width: 390, height: 844 });
    await gotoReady(page, "/calendar");

    // ① 圆点：8px（size-2）才在 360px 视口（内容区 33~37px）里同行放得下 3 枚
    //    （曾用 10px → 360px 下换行并溢出 12px）
    const dot = await dotGeometry(
      page,
      '[data-slot=event-calendar-month-cell] [data-slot=event-calendar-event][aria-label^="E2E MOBILE 0"]',
    );
    expect(dot.w, "圆点应为 8px（size-2，与图例同尺寸）").toBe(8);
    expect(dot.h).toBe(8);
    expect(dot.radius).toBe("9999px");
    expect(dot.childDisplay, "圆点内不该再渲染图标/标题").toBe("none");
    expect(dot.insideContent, "圆点必须完整落在格子内容区内").toBe(true);
    expect(dot.clearOfDayNumber, "圆点不得压到日号").toBe(true);
    expect(dot.contentOverflow, "格子内容不得溢出（会静默裁掉圆点）").toBeLessThanOrEqual(1);
    // 视觉退化不影响读屏：可访问名仍是完整标题 + 时间
    expect(dot.label).toMatch(/^E2E MOBILE \d, .+/);

    // ② 跨天条：压扁为无文字色条；同一天的定时日程（条下方）同样放得下
    const bar = await page
      .locator("[data-slot=event-calendar-month-bar-overlay] [data-slot=event-calendar-event]")
      .first()
      .evaluate((el) => ({
        h: Math.round(el.getBoundingClientRect().height),
        childDisplay: getComputedStyle(el.firstElementChild!).display,
      }));
    expect(bar.h, "窄屏条带应压扁（桌面 26px）").toBeLessThanOrEqual(20);
    expect(bar.childDisplay, "窄屏条带不显示文字（跨度本身即信息）").toBe("none");
    const underBar = await dotGeometry(
      page,
      '[data-slot=event-calendar-month-cell] [data-slot=event-calendar-event][aria-label^="E2E MOBILE BAR DAY"]',
    );
    expect(underBar.insideContent, "条带车道下方的圆点仍须落在内容区内").toBe(true);
    expect(underBar.contentOverflow).toBeLessThanOrEqual(1);

    // ③ 「+N 更多」：窄屏显示「+N」，可访问名仍是完整文案
    //    （限定在含第 12 日圆点的那一格，「+N」计数才确定 = 5 − 3）
    const more = page
      .locator('[data-slot=event-calendar-month-cell]:has([aria-label^="E2E MOBILE 0"])')
      .locator("[data-slot=event-calendar-more]");
    await expect(more).toHaveAttribute("aria-label", "还有 2 个");
    const visibleMoreText = await more.evaluate((el) =>
      [...el.children]
        .filter((c) => getComputedStyle(c).display !== "none")
        .map((c) => c.textContent)
        .join(""),
    );
    expect(visibleMoreText, "窄屏用紧凑的「+N」标签").toBe("+2");

    // ④ 图例与网格同色（颜色是窄屏唯一的类别索引）
    const colors = await page.evaluate(() => ({
      dots: [...document.querySelectorAll("[data-slot=event-calendar-month-cell] [data-slot=event-calendar-event]")].map(
        (el) => getComputedStyle(el).backgroundColor,
      ),
      legend: [...document.querySelectorAll("[data-slot=calendar-legend-dot]")].map(
        (el) => getComputedStyle(el).backgroundColor,
      ),
    }));
    expect(colors.legend.length).toBe(6);
    for (const c of new Set(colors.dots)) {
      expect(colors.legend, `圆点色 ${c} 必须能在图例里找到`).toContain(c);
    }

    // ⑤ 桌面端不受影响：完整胶囊（标题可见）、条带带文字、高度 640
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoReady(page, "/calendar");
    const desktopDot = await dotGeometry(
      page,
      '[data-slot=event-calendar-month-cell] [data-slot=event-calendar-event][aria-label^="E2E MOBILE 0"]',
    );
    expect(desktopDot.w, "桌面端仍是完整 chip").toBeGreaterThan(60);
    expect(desktopDot.childDisplay).toBe("flex");
    const desktopBar = await page
      .locator("[data-slot=event-calendar-month-bar-overlay] [data-slot=event-calendar-event]")
      .first()
      .evaluate((el) => getComputedStyle(el.firstElementChild!).display);
    expect(desktopBar, "桌面端条带仍显示文字").toBe("flex");
    expect(
      await page.locator("[data-slot=event-calendar]").evaluate((el) => Math.round(el.getBoundingClientRect().height)),
      "桌面月视图高度保持 640",
    ).toBe(640);
  });

  test("会议节点日程弹窗：显示该届会议时间线，可跳转同届其它节点日程", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);
    test.skip(!(await calendarAvailable(page)), "日历服务不可用（本地需先 docker start <radicale 容器>）");

    // 找一对「同一届会议的节点日程」（时间线跳转需要成对数据），且该届**同时含
    // 已过与尚未发生的节点**（线段深浅断言需要两类线段才能比对）：
    // 取本月 1 日 ~ 之后 7 个月末（与页面下方列表同范围）
    const now = new Date();
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const res = await page.request.get(
      `/api/calendar?start=${fmt(new Date(now.getFullYear(), now.getMonth(), 1))}&end=${fmt(new Date(now.getFullYear(), now.getMonth() + 7, 0))}&v=e2e-timeline`,
    );
    const events = (
      (await res.json()) as {
        events?: Array<{
          uid: string;
          summary: string;
          confTitle?: string;
          startUtc?: number | null;
          conference?: { abbr: string; year: number; nodes: { utc: number }[] };
        }>;
      }
    ).events ?? [];
    const target = events.find(
      (ev) =>
        ev.conference &&
        ev.conference.nodes.length >= 2 &&
        ev.conference.nodes.some((n) => n.utc <= now.getTime()) &&
        ev.conference.nodes.some((n) => n.utc > now.getTime()) &&
        events.some(
          (other) =>
            other.uid !== ev.uid &&
            other.conference?.abbr === ev.conference!.abbr &&
            other.conference.year === ev.conference!.year,
        ),
    );
    test.skip(
      !target,
      "当前日历里没有「同一届会议有多条节点日程且跨已过/未发生」的数据",
    );
    // 各节点是否已过（用于线段深浅比对；与组件内 `utc <= now` 同一判据）
    const nodeStates = target!.conference!.nodes.map((n) => n.utc <= now.getTime());
    // 目标筛选已保证两类节点都存在，分界列必落在 (0, n) 开区间内
    expect(nodeStates).toContain(true);
    expect(nodeStates).toContain(false);

    await gotoReady(page, "/calendar");

    // 下方「本月及未来日程」的行与「当天日程」一致：点击直接打开详情弹窗
    // （曾为跳转语义：聚焦该日、再点当天那行）
    const confTitle = target!.confTitle ?? target!.summary;
    await page
      .locator("main button:not([data-slot])")
      .filter({ hasText: confTitle })
      .first()
      .click();

    const timeline = page.locator("[data-slot=appointment-timeline]");
    await expect(timeline).toBeVisible();
    // 关闭入口只有一个（右上角 X）：底部那个与 X 重复的「关闭」按钮已删除（用户指定）
    await expect(page.getByRole("button", { name: "关闭" })).toHaveCount(0);
    await expect(timeline.getByText("会议时间线")).toBeVisible();
    // 节点列数与会议数据一致（另有恰好一个「今天」列）；「当前节点」有且只有一个
    await expect(timeline.locator("[data-slot=timeline-node]")).toHaveCount(
      target!.conference!.nodes.length,
    );
    await expect(timeline.locator("[data-slot=timeline-today]")).toHaveCount(1);
    await expect(timeline.locator("[aria-current=true]")).toHaveCount(1);

    // **竖向**时间线：各行（节点行 + 「今天」行）左缘对齐、top 递增；
    // 每个节点行都带悬浮详情（title）
    const columns = await timeline.locator("li").evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return {
          top: Math.round(r.top),
          left: Math.round(r.left),
          isToday: el.getAttribute("data-slot") === "timeline-today",
          title:
            el.getAttribute("data-slot") === "timeline-today"
              ? "（今天列无需悬浮详情）"
              : (el.querySelector("button, div")?.getAttribute("title") ?? ""),
        };
      }),
    );
    expect(new Set(columns.map((c) => c.left)).size).toBe(1);
    expect(columns.every((c, i) => i === 0 || c.top > columns[i - 1].top)).toBe(true);
    expect(columns.every((c) => c.title.length > 0)).toBe(true);
    expect(columns.filter((c) => c.isToday)).toHaveLength(1);

    // 回归：轴线深浅的判据是**「今天」标记的位置**——标记左侧一律浅、右侧一律深；
    // 且轴线**不得被所在列的 `opacity` 淡化**（曾把「已发生」的淡化下在整列 `opacity-55` 上，
    // 祖先 opacity 衰减了列内轴线半段，导致同一线段一半正常一半变淡）。故同时断三件事：
    //   ① 今天列自身：左半段比右半段亮（深度翻转点就在标记处）；
    //   ② 其它每个半段：在标记左侧的与「今天列左半段」同色、右侧的与「右半段」同色；
    //   ③ 从半段到 `ol`（不含 `ol`）的祖先 opacity 乘积恒为 1（没有列级淡化）。
    // ⚠ 不把弹窗自身的 opacity 计入——弹窗入场动画会让整棵树 opacity=0，那样断言会被空过；
    //   也不要用 `Math.max` 统计③（反向验证时实测会漏过「个别列被淡化」）。
    const toneAudit = await timeline.locator("ol").evaluate((ol) => {
      /** 合成到白底后的亮度（0-255）：越大越浅 */
      const lumOf = (css: string) => {
        const c = document.createElement("canvas");
        c.width = 1;
        c.height = 1;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = "#ffffff"; // 哨兵：非法颜色不会改变 fillStyle
        ctx.fillRect(0, 0, 1, 1);
        ctx.fillStyle = css;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ancestorOpacity = (el: Element) => {
        let a = 1;
        for (let p = el.parentElement; p && p !== ol; p = p.parentElement) {
          a *= Number(getComputedStyle(p).opacity || 1);
        }
        return a;
      };
      const cols = Array.from(ol.children);
      // 竖向：轴线列的直接子元素里，除圆（带 data-slot）以外的两个半段（上/下）。
      // ⚠ 不能按宽度过滤：虚线半段是 `w-0 border-l`（宽度 0），横向版的 `h-px` 过滤法会漏掉它。
      const halves = cols.map(
        (col) =>
          Array.from(col.querySelector("span[aria-hidden]")?.children ?? []).filter(
            (s) => !s.hasAttribute("data-slot"),
          ) as HTMLElement[],
      );
      const todayIdx = cols.findIndex(
        (c) => c.getAttribute("data-slot") === "timeline-today",
      );
      const isDashed = (el: HTMLElement) =>
        getComputedStyle(el).borderLeftStyle === "dashed";
      const lumOfHalf = (el: HTMLElement) =>
        lumOf(getComputedStyle(el).backgroundColor);
      const problems: string[] = [];
      let minAncestorOpacity = 1;
      let lightMax = -1;
      let darkMax = -1;
      // ① 同一线段由相邻两列的半段拼成：必须「同为虚线」或「同为实线且亮度相同」
      //    （曾因「整列 opacity 衰减轴线半段」出现一个线段两种颜色）
      for (let i = 0; i < halves.length - 1; i++) {
        const left = halves[i][1]; // 本行**下半段**
        const right = halves[i + 1][0]; // 下一行**上半段**
        if (!left || !right) continue;
        if (isDashed(left) !== isDashed(right)) {
          problems.push(`线段 ${i}-${i + 1}：虚/实线不一致`);
        } else if (
          !isDashed(left) &&
          Math.abs(lumOfHalf(left) - lumOfHalf(right)) > 0.5
        ) {
          problems.push(`线段 ${i}-${i + 1}：实线亮度不一致`);
        }
      }
      // ② 实线以「今天」标记为界：左侧浅、右侧深；③ 轴线不得被列级 opacity 淡化
      halves.forEach(([left, right], i) => {
        for (const [el, expectDark] of [
          [left, i > todayIdx],
          [right, i >= todayIdx],
        ] as const) {
          if (!el) continue;
          minAncestorOpacity = Math.min(minAncestorOpacity, ancestorOpacity(el));
          if (isDashed(el)) continue; // 虚线（同一天的两端）不参与深浅判定
          const lum = lumOfHalf(el);
          if (lum >= 254) continue; // 最外侧透明段（合成到白底后即白）
          if (expectDark) darkMax = Math.max(darkMax, lum);
          else lightMax = Math.max(lightMax, lum);
        }
      });
      return {
        problems,
        // 任一侧没有实线段时不做深浅比较（理论上是空过，避免误红）
        lightIsLighter:
          lightMax < 0 || darkMax < 0 ? true : lightMax > darkMax,
        minAncestorOpacity,
        hasDashed: halves.some(
          ([l, r]) => (l && isDashed(l)) || (r && isDashed(r)),
        ),
      };
    });
    expect(toneAudit.problems).toEqual([]);
    expect(toneAudit.lightIsLighter).toBe(true);
    expect(toneAudit.minAncestorOpacity).toBe(1);

    // 同一天的节点之间（含「今天」与其同天的节点）线段用**虚线**表示「零时间间隔」
    const localDayKey = (d: Date) =>
      `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    const dashesExpected = await timeline.locator("ol").evaluate(
      (ol, arg: { nodeUtcs: number[]; todayKey: string }) => {
        // ⚠ 辅助函数必须定义在 evaluate 内部（浏览器侧），不能引用测试作用域的闭包
        const dayKey = (d: Date) =>
          `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
        // 与组件同一规则：节点列按顺序对应 nodes，「今天」列即今天
        const cols = Array.from(ol.children);
        let nodeCursor = 0;
        const days = cols.map((col) =>
          col.getAttribute("data-slot") === "timeline-today"
            ? arg.todayKey
            : dayKey(new Date(arg.nodeUtcs[nodeCursor++] ?? 0)),
        );
        let expected = 0;
        for (let i = 0; i < days.length - 1; i++) {
          if (days[i] === days[i + 1]) expected++;
        }
        return expected;
      },
      {
        nodeUtcs: target!.conference!.nodes.map((n) => n.utc),
        todayKey: localDayKey(new Date()),
      },
    );
    // 每个「同一天」的线段贡献两个虚线半段
    const dashedHalfCount = await timeline
      .locator("ol")
      .evaluate(
        (ol) =>
          Array.from(ol.querySelectorAll("span[aria-hidden] > span")).filter(
            (s) => getComputedStyle(s).borderLeftStyle === "dashed",
          ).length,
      );
    expect(dashedHalfCount).toBe(dashesExpected * 2);
    expect(toneAudit.hasDashed).toBe(dashesExpected > 0);

    // 视觉语义（用户指定，**两条独立通道**）：
    //   ① 光晕（圆外那圈更大更淡的圆环）= **正在查看的那一天**的全部节点（日粒度），
    //      与时间无关；`aria-current` 仍只标记**精确命中**的那一个（a11y 的「当前项」唯一）；
    //   ② 时间通道：今天之前淡化、今天日期加重（高亮）、今天之后正常。
    // 两者可同时生效（看的这条在今天之前 = 有光晕 + 已淡化），故分开断言。
    const daySeqOf = (utc: number) => {
      const d = new Date(utc);
      return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    };
    const todaySeq = daySeqOf(now.getTime());
    const nodeDaySeq = target!.conference!.nodes.map((n) => daySeqOf(n.utc));
    // ① 光晕只给**点开的那一个**节点（用户指定）——「我在看哪条」必须唯一；
    //    同日多条节点日程（Poster / Encore）的区分靠**轮次名文字**，不靠光晕。
    //    淡化则下在**圆**上。
    const dots = await timeline
      .locator("[data-slot=timeline-node]")
      .evaluateAll((els) =>
        els.map((el) => {
          const dot = el.querySelector('[data-slot="timeline-node-dot"]');
          return {
            current: el.getAttribute("aria-current") === "true",
            halo: dot ? getComputedStyle(dot).boxShadow !== "none" : false,
            dimmed: dot ? Number(getComputedStyle(dot).opacity) < 1 : false,
          };
        }),
      );
    expect(dots.map((d) => d.halo)).toEqual(dots.map((d) => d.current));
    expect(dots.filter((d) => d.halo)).toHaveLength(1);
    expect(dots.filter((d) => d.current)).toHaveLength(1);
    // ② 淡化 ⟺ 节点日期早于今天（含当前查看的那条，不享豁免）
    expect(dots.map((d) => d.dimmed)).toEqual(
      nodeDaySeq.map((s) => s < todaySeq),
    );
    // ③「今天」的节点日期加重（时间通道的高亮），与「打开哪条」无关；今天列不参与
    await expect(
      timeline.locator("[data-slot=timeline-node][data-highlighted=true]"),
    ).toHaveCount(nodeDaySeq.filter((s) => s === todaySeq).length);
    await expect(
      timeline.locator("[data-slot=timeline-today][data-highlighted]"),
    ).toHaveCount(0);
    await expect(
      timeline.locator("[data-slot=timeline-node][aria-current=true]"),
    ).toHaveCount(1);
    // 「今天」列：空心圆 + 轴线**上方**「今天在上、日期在下」（与事件列同一行流）
    const todayColumn = timeline.locator("[data-slot=timeline-today]");
    await expect(todayColumn.locator("[data-slot=timeline-today-dot]")).toHaveCount(1);
    await expect(todayColumn.locator("[data-slot=timeline-today-date]")).toBeVisible();
    await expect(
      todayColumn.locator("[data-slot=timeline-today-label]").getByText("今天"),
    ).toBeVisible();

    // 时间线节点视觉（用户指定方案）：轴线上的**大圆**内嵌该节点类别的图标，
    // 名称只在列宽放得下时显示（与组件内 `TIMELINE_LABEL_EXTRA_PX` 同一语义）。
    // 四条不变式（与具体数据无关）：
    // ① 每个节点都有「大圆 + 圆内图标」——图标永远在，不会「两样都空」；
    // ② 列宽足够（≥ 100px）时必须显示名称——100px 覆盖中英最长的节点名
    //    （`camera` 的 "Camera-ready"，中英两版都是这串英文，约 62px）；
    // ③ 名称不得超出列宽、也不得被截断（放不下应当整条不渲染）；
    // ④ 各列的名称槽 / 日期 / 圆必须同一水平线——名称不显示时槽位也要占位，
    //    否则该列元素会整体上移、与相邻列错位。
    const nodeAudit = await timeline
      .locator("[data-slot=timeline-node]")
      .evaluateAll((els) =>
        els.map((el) => {
          const dot = el.querySelector('[data-slot="timeline-node-dot"]');
          const label = el.querySelector('[data-slot="timeline-node-label"]');
          const top = (e: Element | null) =>
            e ? Math.round(e.getBoundingClientRect().top) : null;
          const left = (e: Element | null) =>
            e ? Math.round(e.getBoundingClientRect().left) : null;
          const h = (e: Element | null) =>
            e ? Math.round(e.getBoundingClientRect().height) : null;
          const colW = el.getBoundingClientRect().width;
          return {
            colW,
            dotW: dot ? dot.getBoundingClientRect().width : 0,
            dotHasIcon: dot
              ? dot.querySelector('[data-slot="timeline-node-icon"]') !== null
              : false,
            hasLabel: label !== null,
            labelOverflow: label
              ? label.getBoundingClientRect().width - colW
              : 0,
            // 名称是单行 `truncate`：被截断体现在 scrollWidth 上
            // （保留纵向判断：将来若名称改回多行，这条仍能抓到截断）
            labelClipped: label
              ? label.scrollHeight > label.clientHeight + 1 ||
                label.scrollWidth > label.clientWidth + 1
              : false,
            rowH: h(el),
            rowLeft: left(el),
            rowTop: top(el),
          };
        }),
      );
    expect(nodeAudit.length).toBeGreaterThan(0);
    // ① 大圆（≥ 20px，区分于旧的小圆点 10px）+ 圆内图标
    expect(nodeAudit.every((b) => b.dotW >= 20 && b.dotHasIcon)).toBe(true);
    // ② 列宽足够 → 必须显示名称
    expect(nodeAudit.every((b) => b.colW < 100 || b.hasLabel)).toBe(true);
    // ③ 名称不超出列宽、不被截断
    expect(nodeAudit.every((b) => b.labelOverflow <= 0.5)).toBe(true);
    expect(nodeAudit.every((b) => !b.labelClipped)).toBe(true);
    // ④ 竖向布局的三条不变式：各行**左缘一致**、行高统一（`h-12`）、top 严格递增。
    //    ⚠ 先确认真的取到了几何值——若选择器失效会全是 null，而 Set{null}.size 也是 1（假绿）
    expect(nodeAudit.every((b) => b.rowLeft !== null && b.rowH !== null)).toBe(true);
    expect(new Set(nodeAudit.map((b) => b.rowLeft)).size).toBe(1);
    expect(new Set(nodeAudit.map((b) => b.rowH)).size).toBe(1);
    expect(
      nodeAudit.every((b, i) => i === 0 || b.rowTop! > nodeAudit[i - 1].rowTop!),
    ).toBe(true);
    // 今天行与事件行的圆：同尺寸、**同一竖轴**（圆串在一条线上）
    const todayDotBox = (await todayColumn
      .locator("[data-slot=timeline-today-dot]")
      .boundingBox())!;
    const firstDotBox = (await timeline
      .locator("[data-slot=timeline-node-dot]")
      .first()
      .boundingBox())!;
    expect(Math.abs(todayDotBox.width - firstDotBox.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(todayDotBox.x - firstDotBox.x)).toBeLessThanOrEqual(1);


    // 竖向布局的几何回归：「今天」行的圆、名称、日期**在同一行**——
    // 圆在该行**垂直居中**（上下留白相等 ≤1px），水平顺序 = 圆 → 名称 → 日期。
    const todayGeometry = await todayColumn.evaluate((el) => {
      const box = (sel: string) =>
        el.querySelector(sel)!.getBoundingClientRect();
      const row = el.querySelector("div")!.getBoundingClientRect();
      const dot = box("[data-slot=timeline-today-dot]");
      const date = box("[data-slot=timeline-today-date]");
      const label = box("[data-slot=timeline-today-label]");
      const vc = (r: DOMRect) => r.top + r.height / 2;
      return {
        dotVCentered: Math.abs(dot.top - row.top - (row.bottom - dot.bottom)) <= 1,
        labelOnSameRow: Math.abs(vc(dot) - vc(label)) <= 1,
        dateOnSameRow: Math.abs(vc(dot) - vc(date)) <= 1,
        order: dot.right <= label.left + 1 && label.right <= date.left + 1,
      };
    });
    expect(todayGeometry.dotVCentered).toBe(true);
    expect(todayGeometry.labelOnSameRow).toBe(true);
    expect(todayGeometry.dateOnSameRow).toBe(true);
    expect(todayGeometry.order).toBe(true);

    // 布局两档（响应式）：默认视口（≥1024）是**左右分栏**；缩到 <1024 应变成**上下堆叠**
    // （时间线占满内容宽）。两档都得验证——只测一档会漏掉另一半逻辑。
    const gridCols = () =>
      timeline.locator("ol").evaluate((ol) => {
        const grid = ol.closest("div.grid") as HTMLElement | null;
        return grid
          ? getComputedStyle(grid).gridTemplateColumns.split(" ").length
          : -1;
      });
    expect(await gridCols()).toBe(2);
    await page.setViewportSize({ width: 900, height: 800 });
    await page.waitForTimeout(400);
    expect(await gridCols()).toBe(1);
    // 堆叠档下时间线仍完整可用：行数不变、各行左缘一致 + top 递增
    const stacked = await timeline.locator("li").evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), left: Math.round(r.left) };
      }),
    );
    expect(stacked).toHaveLength(target!.conference!.nodes.length + 1);
    expect(new Set(stacked.map((s) => s.left)).size).toBe(1);
    expect(
      stacked.every((s, i) => i === 0 || s.top > stacked[i - 1].top),
    ).toBe(true);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(400);

    // 点击另一个节点 → 弹窗原地切换到那条日程（标题里的节点词随之变化）
    const title = page.locator("[data-slot=dialog-title]");
    const before = await title.innerText();
    await timeline.locator("li button").first().click();
    await expect(title).not.toHaveText(before);
  });

  test("时间线：同一天有多个节点时，光晕只给点开的那一个、标题带轮次名加以区分", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);
    test.skip(!(await calendarAvailable(page)), "日历服务不可用（本地需先 docker start <radicale 容器>）");

    // 找一届「同一本地日有 ≥2 个节点」的会议（如 ADMA 2026 的 Poster / Encore 同在 9/12）
    const now = new Date();
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate(),
      ).padStart(2, "0")}`;
    const res = await page.request.get(
      `/api/calendar?start=${fmt(new Date(now.getFullYear(), now.getMonth(), 1))}&end=${fmt(new Date(now.getFullYear(), now.getMonth() + 7, 0))}&v=e2e-sameday`,
    );
    type Ev = {
      uid: string;
      summary: string;
      confTitle?: string;
      startUtc?: number | null;
      conference?: {
        abbr: string;
        year: number;
        nodes: { utc: number; comment?: string }[];
      };
    };
    const events = ((await res.json()) as { events?: Ev[] }).events ?? [];
    const dayKey = (utc: number) => {
      const d = new Date(utc);
      return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    };
    const target = events.find((ev) => {
      const days = (ev.conference?.nodes ?? []).map((n) => dayKey(n.utc));
      return days.length >= 2 && new Set(days).size < days.length;
    });
    test.skip(!target, "当前日历里没有「同一天有两个及以上节点」的会议");
    const days = target!.conference!.nodes.map((n) => dayKey(n.utc));
    const dupDay = days.find((d, i) => days.indexOf(d) !== i)!;
    const sameDayCount = days.filter((d) => d === dupDay).length;
    expect(sameDayCount).toBeGreaterThan(1);

    await gotoReady(page, "/calendar");
    const confTitle = target!.confTitle ?? target!.summary;
    // 与既有用例同一条路径：点总览行即直接打开详情弹窗
    await page
      .locator("main button:not([data-slot])")
      .filter({ hasText: confTitle })
      .first()
      .click();

    const timeline = page.locator("[data-slot=appointment-timeline]");
    await expect(timeline).toBeVisible();
    // 光晕（`ring-3` 编译成 box-shadow）**只给点开的那一个**节点（用户指定）：
    // 同一天就算有多个节点，指向也必须唯一；它们的区分靠**轮次名文字**。
    const haloFlags = await timeline.locator("ol").evaluate((ol) =>
      [...ol.querySelectorAll('[data-slot="timeline-node"]')].map(
        (li) =>
          getComputedStyle(
            li.querySelector('[data-slot="timeline-node-dot"]')!,
          ).boxShadow !== "none",
      ),
    );
    expect(haloFlags.filter(Boolean)).toHaveLength(1);
    expect(sameDayCount).toBeGreaterThan(1); // 这条用例的前提：当天确有多个节点

    // 轮次名：节点备注（如 "Poster Paper" / "Encore Paper"）去掉尾部 "Paper" 后
    // 进入弹窗标题，让同日同名的多条日程可区分（与组件内 `conferenceRoundLabel` 同规则）
    const hit = target!.conference!.nodes.find(
      (n) =>
        target!.startUtc != null && Math.abs(target!.startUtc - n.utc) <= 60_000,
    );
    const raw = hit?.comment?.trim();
    const round =
      raw && raw.length <= 40 && !/[.:;,]/.test(raw)
        ? raw.replace(/\s+Paper$/i, "")
        : null;
    expect(round, "用例依赖该节点带短轮次备注（如 Poster Paper）").toBeTruthy();
    await expect(page.locator("[data-slot=dialog-title]")).toContainText(round!);

    // 时间线节点名也用轮次短标签 → 同一天的多列名称**互不相同**（不再是两列都"全文"）
    const dupDayNames = await timeline.locator("ol").evaluate((ol) => {
      const byDate = new Map<string, (string | null)[]>();
      for (const li of ol.querySelectorAll('[data-slot="timeline-node"]')) {
        const date = li.querySelector("time")?.textContent ?? "";
        const label =
          li.querySelector('[data-slot="timeline-node-label"]')?.textContent ??
          null;
        byDate.set(date, [...(byDate.get(date) ?? []), label]);
      }
      return [...byDate.entries()]
        .map(([date, labels]) => [date, labels.filter(Boolean)] as const)
        .filter(([, labels]) => labels.length > 1);
    });
    expect(dupDayNames.length, "同一天应有 ≥2 列名称可见").toBeGreaterThan(0);
    for (const [, names] of dupDayNames) {
      expect(new Set(names).size).toBe(names.length);
    }

    // 竖向行宽充裕（宽屏分栏 297px）→ 显示**完整**轮次标签，而不是剥掉流程词的短标签
    // （应为 `Main Track` 而不是 `Main`）；只有极窄视口才会降级到短标签。
    const allNames = await timeline
      .locator('[data-slot="timeline-node-label"]')
      .allTextContents();
    expect(allNames.length).toBeGreaterThan(0);
    expect(allNames).toContain("Main Track");
    expect(allNames).not.toContain("Main");
  });

  test("游客调用凭证 API 返回 401", async ({ request }) => {
    const r = await request.get("/api/calendar/credentials");
    expect(r.status()).toBe(401);
    const r2 = await request.put("/api/calendar/credentials", {
      data: { user: "hacker", password: "x" },
    });
    expect(r2.status()).toBe(401);
  });

  test("日历设置：破坏性操作走站内自绘确认弹窗（不再用原生 confirm）", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);
    // 先确保有「网站内保存的凭证」，否则「清除凭证」按钮不出现
    await page.request.put("/api/calendar/credentials", {
      data: { user: "caladmin", password: "confirm-probe" },
    });
    const nativeDialogs: string[] = [];
    page.on("dialog", (d) => void nativeDialogs.push(d.type()));

    await gotoReady(page, "/calendar");
    await page.getByRole("button", { name: "设置" }).click();
    const settings = page.locator("[data-slot=dialog-content]").first();
    await expect(settings.getByRole("heading", { name: "日历设置" })).toBeVisible();

    const clear = settings.getByRole("button", { name: "清除保存的密码" });
    await expect(clear).toBeVisible();
    await clear.click();

    // 确认弹窗叠加在设置弹窗之上，且**确实可交互**（两层模态的图层/焦点不能被遮挡）
    const confirm = page.locator('[data-slot="confirm-dialog"]');
    await expect(confirm).toBeVisible();
    await expect(confirm.locator("[data-slot=dialog-title]")).toContainText("清除");
    const hitInside = await confirm.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 8);
      return !!hit && el.contains(hit);
    });
    expect(hitInside, "确认弹窗应位于最上层且未被设置弹窗遮挡").toBe(true);

    // 取消：弹窗关闭、设置弹窗仍在、凭证未被清除
    await confirm.getByRole("button", { name: "取消" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(settings.getByRole("heading", { name: "日历设置" })).toBeVisible();
    const stillThere = await page.request.get("/api/calendar/credentials");
    expect((await stillThere.json()).configured).toBe(true);
    expect(nativeDialogs, "不应弹出原生 confirm").toEqual([]);

    // 清理：删除网站内凭证，回退环境变量（与「设置凭证」用例一致的自清理约定）
    await page.request.delete("/api/calendar/credentials");
    // 同时清掉本次 PUT 登记的同步队列文件，避免残留影响后续用例
    const fs = await import("node:fs");
    fs.rmSync(join(STANDALONE_DATA_DIR, "caldav-reset.json"), { force: true });
  });

  test("登录后可在日历页设置 CalDAV 凭证", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);
    await gotoReady(page, "/calendar");

    // 工具栏有设置入口
    await page.getByRole("button", { name: "设置" }).click();
    await expect(
      page.getByRole("heading", { name: "日历设置" }),
    ).toBeVisible();

    // 填写用户名 / 密码并保存（服务器地址由部署环境决定，不在网站内配置）
    // ⚠ exact: 设置弹窗里还有「清除保存的密码」，getByRole 的 name 是子串匹配
    await page.getByLabel("用户名").fill("caladmin");
    await page.getByLabel("密码").fill("testpass123");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("密码已保存")).toBeVisible();

    // 状态查询：configured + 用户名 + 密码明文（站主专属接口，无泄露面）
    const r = await page.request.get("/api/calendar/credentials");
    expect(r.status()).toBe(200);
    const data = (await r.json()) as {
      configured: boolean;
      source: string;
      user: string | null;
      password: string | null;
      pending: boolean;
    };
    expect(data.configured).toBe(true);
    expect(data.source).toBe("file");
    expect(data.user).toBe("caladmin");
    expect(data.password).toBe("testpass123");
    // 保存的密码变更已登记重置队列（VPS crontab 待应用到 Radicale）
    expect(data.pending).toBe(true);

    // 凭证不合法校验：用户名缺失 → 400
    const bad = await page.request.put("/api/calendar/credentials", {
      data: { user: "", password: "x" },
    });
    expect(bad.status()).toBe(400);

    // 清理：删除网站内凭证，回退环境变量（用例自清理，保持本地数据干净）
    const del = await page.request.delete("/api/calendar/credentials");
    expect(del.status()).toBe(200);
    const after = await page.request.get("/api/calendar/credentials");
    const afterData = (await after.json()) as {
      configured: boolean;
      source: string | null;
    };
    // 文件凭证已删除（是否可用取决于服务器是否配置了环境变量）
    expect(afterData.source).not.toBe("file");
  });

  test("游客调用凭证重置 API 返回 401", async ({ request }) => {
    const r = await request.post("/api/calendar/credentials");
    expect(r.status()).toBe(401);
  });

  test("随机重置密码：生成强随机密码并登记同步队列", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);

    // 先保存凭证（用户名 caladmin）
    const put = await page.request.put("/api/calendar/credentials", {
      data: { user: "caladmin", password: "oldpass123" },
    });
    expect(put.status()).toBe(200);

    // 随机重置：返回新密码（与旧密码不同、长度足够）
    const reset = await page.request.post("/api/calendar/credentials");
    expect(reset.status()).toBe(200);
    const resetData = (await reset.json()) as {
      user: string;
      password: string;
    };
    expect(resetData.user).toBe("caladmin");
    expect(resetData.password).not.toBe("oldpass123");
    expect(resetData.password.length).toBeGreaterThanOrEqual(24);

    // 网站侧凭证已更新为新密码
    const status = await page.request.get("/api/calendar/credentials");
    const statusData = (await status.json()) as {
      password: string;
      pending: boolean;
    };
    expect(statusData.password).toBe(resetData.password);
    expect(statusData.pending).toBe(true);

    // 重置队列文件已写入（VPS crontab 每分钟读取并应用到 Radicale）
    const fs = await import("node:fs");
    const queue = (() => {
      try {
        return fs.readFileSync(join(STANDALONE_DATA_DIR, "caldav-reset.json"), "utf8");
      } catch {
        return null;
      }
    })();
    expect(queue).not.toBeNull();
    const queueData = JSON.parse(queue!) as { user: string; password: string };
    expect(queueData.user).toBe("caladmin");
    expect(queueData.password).toBe(resetData.password);

    // 清理：删除网站凭证与队列文件
    await page.request.delete("/api/calendar/credentials");
    fs.rmSync(join(STANDALONE_DATA_DIR, "caldav-reset.json"), { force: true });
  });
});

/* ============================================================
 * 站内邮件（/mail）
 * 前端 UI 用例对 /api/mail/* 打桩（webmaild 后端的集成测试在 webmail/ 包内，
 * 用真实 Dovecot 容器跑）；游客守卫用例不需要打桩（代理层先 401）。
 * ============================================================ */

const MAIL_ACCOUNTS = [
  {
    id: "acc1",
    displayName: "主账号",
    email: "me@mail.example.cn",
    provider: "test",
    color: "cyan",
    folders: ["INBOX", "Sent"],
    enabled: true,
    unread: 3,
    // 本地副本数（删除账号弹窗据此说明会清掉多少；2026-10-08）
    localMessages: 128,
    // 连接字段（账号管理编辑表单回填用；GET /accounts 返回，无密码）
    imapHost: "imap.example.cn",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.example.cn",
    smtpPort: 465,
    smtpSecure: true,
    username: "me@mail.example.cn",
    senderName: "",
  },
  {
    id: "acc2",
    displayName: "学校",
    email: "ysy@edu.example.cn",
    provider: "test",
    color: "violet",
    folders: ["INBOX", "Sent"],
    enabled: true,
    unread: 0,
    localMessages: 6,
    imapHost: "imap.edu.example.cn",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.edu.example.cn",
    smtpPort: 465,
    smtpSecure: true,
    username: "ysy@edu.example.cn",
    senderName: "",
  },
];

function mailItem(over: Record<string, unknown>) {
  return {
    messageId: "mid:w01@test.local",
    date: "2026-09-25T02:00:00.000Z",
    subject: "面试通知",
    fromAddr: "zhang@example.com",
    fromName: "张老师",
    to: [],
    snippet: "你好，你的面试的通知时间是周五下午三点",
    size: 300,
    truncated: false,
    seen: false,
    flagged: false,
    hasAttach: false,
    copies: [{ accountId: "acc1", folder: "INBOX", uid: 1 }],
    accounts: ["acc1"],
    ...over,
  };
}

const MAIL_LIST = [
  mailItem({
    messageId: "mid:w04@test.local",
    date: "2026-09-25T05:00:00.000Z",
    subject: "Report with attachment",
    fromAddr: "boss@example.com",
    fromName: "",
    snippet: "See attached report.",
    hasAttach: true,
  }),
  mailItem({
    messageId: "mid:w03@test.local",
    date: "2026-09-25T04:00:00.000Z",
    subject: "HTML Newsletter",
    fromAddr: "newsletter@example.com",
    fromName: "",
    snippet: "HTML newsletter body",
    seen: true,
  }),
  mailItem({
    messageId: "mid:w02@test.local",
    date: "2026-09-25T03:00:00.000Z",
    subject: "Weekly Digest",
    fromAddr: "newsletter@example.com",
    fromName: "",
    snippet: "This week in research",
    flagged: true,
    copies: [{ accountId: "acc2", folder: "INBOX", uid: 2 }],
    accounts: ["acc2"],
  }),
  mailItem({
    messageId: "mid:w01@test.local",
    date: "2026-09-25T02:00:00.000Z",
    copies: [
      { accountId: "acc1", folder: "INBOX", uid: 1 },
      { accountId: "acc2", folder: "INBOX", uid: 1 },
    ],
    accounts: ["acc1", "acc2"],
  }),
  // ⚠ 收件 / 发件区分（2026-10-04）的样本：副本只在「已发送」，且放在**数组末尾**
  //   （nth(0..3) 的既有断言全部不动）；已读、无星标、属 acc1——故各筛选计数不变，
  //   只有「全部」列表总数 4 → 5。folder 用中文名，同时验证 SENT_FOLDER_NAMES 的中文项。
  mailItem({
    messageId: "mid:s01@test.local",
    date: "2026-09-25T01:00:00.000Z",
    subject: "Re: 会议纪要",
    fromAddr: "me@mail.example.cn",
    fromName: "我",
    to: [{ name: "张老师", address: "zhang@example.com" }],
    snippet: "附件是本周的会议纪要，请查收。",
    seen: true,
    copies: [{ accountId: "acc1", folder: "已发送", uid: 9 }],
    accounts: ["acc1"],
  }),
];

/**
 * 文件夹清单桩（MAIL-AGENT.md 4.15，2026-10-07）：`GET/POST /api/mail/folders` 返回它。
 * 覆盖三种情形：INBOX、带特殊用途标志的「已发送 / 垃圾邮件」（阿里云靠本地化名字推断，
 * 见 webmail/src/folders.ts）、无标志的自定义文件夹「项目」。
 */
const MAIL_FOLDERS: Record<
  string,
  { path: string; name: string; delimiter: string; specialUse: string; specialUseSource: string; selectable: boolean }[]
> = {
  acc1: [
    { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "", specialUseSource: "", selectable: true },
    { path: "已发送", name: "已发送", delimiter: "/", specialUse: "\\Sent", specialUseSource: "name", selectable: true },
    { path: "垃圾邮件", name: "垃圾邮件", delimiter: "/", specialUse: "\\Junk", specialUseSource: "name", selectable: true },
    { path: "项目", name: "项目", delimiter: "/", specialUse: "", specialUseSource: "", selectable: true },
  ],
  acc2: [
    { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "", specialUseSource: "", selectable: true },
    { path: "Sent", name: "Sent", delimiter: "/", specialUse: "\\Sent", specialUseSource: "extension", selectable: true },
  ],
};

const MAIL_DETAIL_HTML = `<p>newsletter body</p>
<h2>newsletter heading</h2>
<ul><li>first item</li><li>second item</li></ul>
<table border="1"><tbody><tr><td>cell one</td><td>cell two</td></tr></tbody></table>
<div style="background-color:#1a1a1a;color:#ffffff">dark band</div>
<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/%3E" data-remote-src="https://tracker.example.com/pixel.png" />
<img src="https://pics.edu.cn/logo.png" />
<img src="/api/mail/message/mid%3Aw03%40test.local/attachment/0" />`;

/** 自动收录桩数据：通信过但未保存的地址（accounts = 出现在哪些账号的往来里，4.14） */
const KNOWN_SENDERS = [
  { name: "张老师", email: "zhang@example.com", times: 3, lastSeen: "2026-09-25T02:00:00.000Z", accounts: ["acc1"] },
  { name: "", email: "bob@example.com", times: 1, lastSeen: "2026-09-20T02:00:00.000Z", accounts: ["acc2"] },
];

/** 按 path 分发 /api/mail/** 的桩；写操作（flags/send/delete/contacts/accounts/whitelist）记录请求体供断言 */
const SENT_FOLDERS = new Set(["sent", "sent items", "sent messages", "已发送邮件", "已发送"]);

function stubMailApi(
  page: Page,
  calls: {
    flags: unknown[];
    send: unknown[];
    delete: unknown[];
    contacts?: unknown[];
    accounts?: unknown[];
    whitelist?: unknown[];
    drafts?: unknown[];
    /** 文件夹预览探测（POST /folders）与移动（POST /move）的请求体 */
    folders?: unknown[];
    move?: unknown[];
    /** 按需取原文（POST /message/:id/source）的调用记录 */
    source?: unknown[];
    /** 这些消息的详情按「只入库索引」（truncated）返回：正文/附件为空（4.15 的按需取原文） */
    truncatedIds?: string[];
    /**
     * 这些消息的详情按**精简原文**返回（2026-10-08 附件门控）：正文可读、附件标成
     * deferred（点了才去取）。与 truncatedIds 的区别正是「正文有没有」。
     */
    partialIds?: string[];
    /** 详情请求返回该状态码 + `{error:"webmaild_unreachable"}`（验证内部错误码不回显） */
    detailError?: number;
    /** 账号内存桩的实时引用（用例可改写 unread 等字段模拟新邮件 / 新账号） */
    accountStore?: Record<string, unknown>[];
    /** 「上次收到新邮件」信号（/health 的 lastNewMail）的可控引用：
     *  新邮件提醒器只认它前进（未读总数上升不弹——「标为未读」也是上升，是假信号） */
    healthStore?: { lastNewMail: string };
    /** 「垃圾」tab 用例：acc1 的「垃圾邮件」是否已在同步白名单里（GET /folders 的 synced） */
    junkSynced?: boolean;
    /** 「垃圾」tab 用例：带 folder 参数的列表请求返回一封落在「垃圾邮件」里的桩邮件 */
    junkFolderItems?: boolean;
    /** 列表桩的实时引用（用例可往里追加，验证「历史回填期间列表自动刷新」，2026-10-08） */
    listStore?: unknown[];
    /**
     * 列表分页（2026-10-09）：设了就按此页大小切片并给出游标（游标 = 数字偏移量），
     * 让「无限滚动自动续页 + 加载更多按钮」在 E2E 里真的能跑——此前恒 `next: null`，
     * 那枚按钮与哨兵**没有任何用例覆盖**，自动续页坏掉时全绿（2026-10-09 实测确曾如此）。
     */
    pageSize?: number;
    /** 列表响应延迟（毫秒）：让 `loadingMore` 的中间态可观测（按钮盒子稳定性断言用） */
    listDelayMs?: number;
  },
  // 状态条（5.5）的健康端点覆盖：默认全部健康；传 {status, body} 模拟告警/不可达
  health?: { mailagentd?: { status: number; body: unknown }; webmail?: { status: number; body: unknown } },
) {
  // 通讯录内存桩：POST/PATCH/DELETE 真实改这个数组，GET 反映最新状态。
  // ⚠ 预置一条「自己地址」的联系人：复现「账号重复」场景——它必须被界面过滤掉
  // （只出现在「我的账号」里，不再重复出现在联系人列表），保存自己的地址也会被拦下。
  let contactSeq = 0;
  const contactStore: { id: string; name: string; email: string; note: string }[] = [
    { id: "c-own", name: "Agent 信箱", email: "agent@mail.example.cn", note: "" },
  ];
  // 账号内存桩：POST/DELETE 真实增删，GET 反映最新状态（账号管理弹窗用）
  const accountStore: Record<string, unknown>[] = MAIL_ACCOUNTS.map((a) => ({ ...a }));
  calls.accountStore = accountStore;
  // 列表桩：默认是 MAIL_LIST 本身（不变）；用例要模拟「后台又抓进来一批」时
  // 把它换成自己的数组（见「历史回填」用例）
  calls.listStore = MAIL_LIST;
  // 「上次收到新邮件」桩（2026-10-06）：/health 的 lastNewMail。**默认固定值**（历次
  // 轮询不前进 → 不误报）；用例要模拟新邮件时改这个对象再触发 visibilitychange。
  // ⚠ 曾用「请求时刻」作值：每个轮询周期都会「前进」，提醒器会每 30s 弹一条假提醒。
  const healthStore = { lastNewMail: "2026-01-01T00:00:00.000Z" };
  calls.healthStore = healthStore;
  // 草稿内存桩（2026-10-06）：POST/PUT/DELETE 真实改数组，GET 反映最新状态
  let draftSeq = 0;
  const draftStore: Record<string, unknown>[] = [];
  // 远程图片白名单内存桩（4.4）：PUT 全量替换，GET 反映最新状态
  let domainStore = ["edu.cn"];
  return page.route("**/api/mail/**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api\/mail/, "");
    const json = (body: unknown) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/accounts" && route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { displayName?: string; email?: string; color?: string };
      calls.accounts?.push({ method: "POST", body });
      if (!body?.email?.includes("@")) {
        return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "邮箱地址非法" }) });
      }
      const created = {
        id: body.email!.split("@")[0]!,
        displayName: body.displayName ?? "",
        email: body.email!,
        provider: "test",
        // 颜色随请求落桩（与 webmail 一致：不传时才由服务端避让分配）
        color: body.color ?? "cyan",
        folders: ["INBOX"],
        enabled: true,
        unread: 0,
      };
      accountStore.push(created);
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(created) });
    }
    if (path === "/accounts") return json(accountStore);
    const accountMatch = path.match(/^\/accounts\/([^/]+)$/);
    if (accountMatch && route.request().method() === "DELETE") {
      calls.accounts?.push({ method: "DELETE", id: accountMatch[1] });
      const idx = accountStore.findIndex((a) => a.id === accountMatch[1]);
      if (idx < 0) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "账号不存在" }) });
      accountStore.splice(idx, 1);
      return json({ ok: true });
    }
    // 修改账号（2026-10-06）：字段合并后落桩，返回更新后的摘要
    if (accountMatch && route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      calls.accounts?.push({ method: "PUT", id: accountMatch[1], body });
      const idx = accountStore.findIndex((a) => a.id === accountMatch[1]);
      if (idx < 0) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "账号不存在" }) });
      accountStore[idx] = { ...accountStore[idx], ...body };
      return json(accountStore[idx]);
    }
    // ---- 草稿（2026-10-06）：写信页自动保存 / 草稿箱 ----
    if (path === "/drafts" && route.request().method() === "GET") {
      return json({ items: draftStore });
    }
    if (path === "/drafts" && route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      calls.drafts?.push({ method: "POST", body });
      const now = new Date().toISOString();
      const draft = {
        id: `draft-${++draftSeq}`,
        kind: (body.kind as string) ?? "new",
        kindRef: (body.kindRef as string) ?? "",
        accountId: (body.accountId as string) ?? "",
        to: (body.to as string) ?? "",
        cc: (body.cc as string) ?? "",
        bcc: (body.bcc as string) ?? "",
        subject: (body.subject as string) ?? "",
        body: (body.body as string) ?? "",
        readReceipt: body.readReceipt === true,
        inReplyTo: (body.inReplyTo as string) ?? "",
        references: (body.references as string[]) ?? [],
        createdAt: now,
        updatedAt: now,
      };
      draftStore.unshift(draft);
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(draft) });
    }
    const draftMatch = path.match(/^\/drafts\/([^/]+)$/);
    if (draftMatch && route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      calls.drafts?.push({ method: "PUT", id: draftMatch[1], body });
      const idx = draftStore.findIndex((d) => d.id === draftMatch[1]);
      if (idx < 0) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "草稿不存在" }) });
      draftStore[idx] = { ...draftStore[idx], ...body, updatedAt: new Date().toISOString() };
      return json(draftStore[idx]);
    }
    if (draftMatch && route.request().method() === "DELETE") {
      calls.drafts?.push({ method: "DELETE", id: draftMatch[1] });
      const idx = draftStore.findIndex((d) => d.id === draftMatch[1]);
      if (idx >= 0) draftStore.splice(idx, 1);
      return json({ ok: true });
    }
    // 远程图片白名单（4.4）：GET 返回当前列表，PUT 全量替换归一化后落盘；
    // 「bad-domain.invalid」触发 500，覆盖保存失败分支（toast + 本地态不变）
    if (path === "/remote-image-domains" && route.request().method() === "GET") {
      return json({ domains: domainStore });
    }
    if (path === "/remote-image-domains" && route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { domains?: string[] };
      calls.whitelist?.push(body);
      const next = (body.domains ?? []).map((d) => String(d).trim().toLowerCase()).filter(Boolean);
      if (next.includes("bad-domain.invalid")) {
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "mock: 写入失败" }) });
      }
      domainStore = next;
      return json({ domains: domainStore });
    }
    // 健康端点（5.5）：状态条每 60s 轮询这两个；默认全部健康（时间取请求时刻 → 显示「刚刚」）
    // lastNewMail = 上次抓进新邮件的时刻：acc1 用可控桩（见 healthStore，提醒器只认它前进）、acc2 从未收到（null）
    // ⚠ 账号列表取自 `accountStore`（真后端就是这样）：**刚添加的账号 `lastSync` 为 null**
    //   =「首轮同步还没跑完」——底栏据此显示「正在首次同步邮件…」（2026-10-08 用例用）
    if (path === "/health") {
      const now = new Date().toISOString();
      const body = health?.webmail?.body ?? {
        ok: true,
        accounts: accountStore.map((a) => ({
          id: a.id as string,
          enabled: true,
          lastSync: MAIL_ACCOUNTS.some((m) => m.id === a.id) ? now : null,
          lastError: null,
          lastNewMail: a.id === "acc1" ? healthStore.lastNewMail : null,
        })),
      };
      return route.fulfill({ status: health?.webmail?.status ?? 200, contentType: "application/json", body: JSON.stringify(body) });
    }
    if (path === "/agent/health") {
      const now = new Date().toISOString();
      const body = health?.mailagentd?.body ?? {
        ok: true,
        threshold: 3,
        accounts: [
          { id: "agent", displayName: "Agent 信箱", email: "agent@mail.example.cn", lastOk: now, failures: 0, lastError: null, connected: true, alert: false },
        ],
      };
      return route.fulfill({ status: health?.mailagentd?.status ?? 200, contentType: "application/json", body: JSON.stringify(body) });
    }
    if (path === "/folders" && route.request().method() === "GET") {
      const account = url.searchParams.get("account") ?? "";
      return json({
        folders: MAIL_FOLDERS[account] ?? [],
        suggested: ["INBOX", "已发送", "垃圾邮件"],
        // acc1 的「垃圾邮件」默认**不在**白名单里（`junkSynced` 打开它，见「垃圾」tab 用例）
        synced: calls.junkSynced ? ["INBOX", "垃圾邮件"] : ["INBOX"],
      });
    }
    if (path === "/folders" && route.request().method() === "POST") {
      calls.folders?.push(route.request().postDataJSON());
      return json({ folders: MAIL_FOLDERS.acc1, suggested: ["INBOX", "已发送", "垃圾邮件"] });
    }
    if (path === "/move") {
      const body = route.request().postDataJSON() as { copies?: unknown[] };
      calls.move?.push(body);
      // 服务端契约（2026-10-07）：`to` 可以是**特殊用途记号**（`\Junk`），由 webmaild 在
      // 该账号上探测真实文件夹；`affected` = 真正搬动的副本数、`skipped` = 目标不存在的
      // 账号。前端按这两个数决定提示与跳转（0 且无 skipped = 本来就在目标里）。
      return json({ affected: body.copies?.length ?? 0, skipped: [] });
    }
    if (path === "/messages") {
      const account = url.searchParams.get("account");
      const q = url.searchParams.get("q");
      const filter = url.searchParams.get("filter");
      const direction = url.searchParams.get("direction");
      // 文件夹筛选（4.15）：`folder=<账号id>|<路径>`，**可给多个**（并集，2026-10-08 起；
      // 每个参数自带账号）——与服务端 parseFolderParams / SQL 同口径。「垃圾」tab 用它一次
      // 筛出各账号的垃圾文件夹。
      const folderParams = url.searchParams.getAll("folder").map((v) => {
        const sep = v.indexOf("|");
        return sep <= 0 ? { account: "", path: v } : { account: v.slice(0, sep), path: v.slice(sep + 1) };
      });
      // 列表桩的实时引用（用例追加条目 = 后台又抓进来一批）
      let items = (calls.listStore as typeof MAIL_LIST | undefined) ?? MAIL_LIST;
      if (account) items = items.filter((m) => m.accounts.includes(account));
      if (folderParams.length && calls.junkFolderItems) {
        // 「垃圾」tab 的桩：带 folder 参数的请求直接给这封（真实服务端会按副本路径匹配）
        return json({
          items: [
            mailItem({
              messageId: "mid:junk1@test.local",
              date: "2026-09-25T06:00:00.000Z",
              subject: "中奖通知",
              fromAddr: "spam@example.net",
              snippet: "恭喜您中奖",
              copies: [{ accountId: "acc1", folder: "垃圾邮件", uid: 42 }],
            }),
          ],
          next: null,
        });
      }
      if (folderParams.length) {
        items = items.filter((m) =>
          m.copies.some((c) =>
            folderParams.some(
              (f) => c.folder === f.path && (!f.account || c.accountId === f.account),
            ),
          ),
        );
      }
      if (q) items = items.filter((m) => m.subject.includes(q) || m.snippet.includes(q));
      // 状态筛选（4.2）：与服务端 filter 参数同口径（2026-10-04 起支持逗号多值取交集）
      const filters = new Set((filter ?? "").split(",").filter(Boolean));
      if (filters.has("unseen")) items = items.filter((m) => !m.seen);
      if (filters.has("flagged")) items = items.filter((m) => m.flagged);
      // 方向筛选（4.9）：与服务端 direction 参数同口径，与状态互相独立可叠加
      //（判定与 lib/mail/kind.ts 的 isSentItem 一致：副本全在「已发送」类文件夹）
      if (direction === "received")
        items = items.filter((m) => m.copies.some((c) => c.folder.toUpperCase() === "INBOX"));
      if (direction === "sent")
        items = items.filter((m) => m.copies.every((c) => SENT_FOLDERS.has(c.folder.trim().toLowerCase())));
      // 分页桩（2026-10-09）：游标 = 「从第几条开始」的数字偏移（真实服务端是 IMAP 游标，
      // 这里只要契约形状对得上：`next` 非空 ⟹ 带上 `before=<next>` 能续下一页）
      const reply = async () => {
        if (calls.listDelayMs) await new Promise((r) => setTimeout(r, calls.listDelayMs));
        if (typeof calls.pageSize === "number") {
          const start = Number(url.searchParams.get("before") ?? 0) || 0;
          const slice = items.slice(start, start + calls.pageSize);
          const nextStart = start + calls.pageSize;
          return json({ items: slice, next: nextStart < items.length ? String(nextStart) : null });
        }
        return json({ items, next: null });
      };
      return reply();
    }
    if (path === "/flags") {
      calls.flags.push(route.request().postDataJSON());
      return json({ updated: 2 });
    }
    if (path === "/send") {
      calls.send.push(route.request().postDataJSON());
      return json({ messageId: "<new@local>", sentFolder: "Sent" });
    }
    if (path === "/delete") {
      calls.delete.push(route.request().postDataJSON());
      return json({ affected: 2 });
    }
    // 原始邮件（2026-10-07）：详情桩带 headers；truncated 由 calls/桩按需覆盖
    if (path.endsWith("/source") && route.request().method() === "POST") {
      calls.source?.push(path);
      return json({ fetched: true, size: 1234 });
    }
    if (path.endsWith("/source")) {
      return route.fulfill({
        contentType: "application/octet-stream",
        headers: { "content-disposition": 'attachment; filename="w04.eml"' },
        body: "Subject: raw\r\n\r\nbody\r\n",
      });
    }
    // 会话端点（4.7）：必须在 /message/:id 分发之前匹配，否则会被详情桩吞掉
    if (path.startsWith("/message/") && path.endsWith("/thread")) {
      if (path.includes("w03")) {
        return json({
          current: "mid:w03@test.local",
          items: [
            mailItem({
              messageId: "mid:w02@test.local",
              date: "2026-09-25T03:00:00.000Z",
              subject: "Weekly Digest",
              fromAddr: "newsletter@example.com",
              fromName: "",
              snippet: "This week in research",
              seen: true,
            }),
            mailItem({
              messageId: "mid:w03@test.local",
              date: "2026-09-25T04:00:00.000Z",
              subject: "HTML Newsletter",
              fromAddr: "newsletter@example.com",
              fromName: "",
              snippet: "HTML newsletter body",
            }),
          ],
        });
      }
      return json({ current: "mid:w01@test.local", items: [mailItem({})] });
    }
    // mailagentd 的只读视图：agent 信箱（通讯录「我的账号」用，4.10）
    if (path === "/agent/accounts") {
      return json({
        items: [
          {
            id: "agent",
            displayName: "Agent",
            email: "agent@mail.example.cn",
            isAgent: true,
            enabled: true,
          },
        ],
      });
    }
    // agent 只读页（/mail/agent）挂载即拉取 timeline / pending-sends 等端点。
    // ⚠ 必须返回「空结构」而不是落到末尾的 `{error}` 兜底：那个兜底是 **200 状态**，
    //   页面按 `res.ok` 判断后会去解构 `data.items`（undefined）→ 客户端崩溃整页白屏
    //   （容器宽度用例访问该页时实测到「Application error」）。
    //   真实环境端点是 502/503 时页面走 `!res.ok` 的错误分支，不存在这个问题。
    if (path.startsWith("/agent/")) {
      return json({ items: [], next: null });
    }
    // 附件字节：转发用例要把原附件装回写信页。⚠ 必须在 /message/ 详情分发之前，
    // 否则 /message/:id/attachment/:i 会被详情桩当成详情请求吞掉。
    if (path.includes("/attachment/")) {
      return route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        body: Buffer.from("%PDF-1.4 forwarded attachment"),
      });
    }
    if (path.startsWith("/message/")) {
      // 详情加载失败：代理层给的内部错误码（webmaild_unreachable）——UI 必须换成友好文案
      if (calls.detailError && !path.endsWith("/thread") && !path.endsWith("/source")) {
        return route.fulfill({
          status: calls.detailError,
          contentType: "application/json",
          body: JSON.stringify({ error: "webmaild_unreachable" }),
        });
      }
      // 精简原文（附件门控）：正文在、附件 delayed（2026-10-08）
      const partialHit = (calls.partialIds ?? []).find(
        (id) => path.includes(encodeURIComponent(id)) || path.includes(id),
      );
      if (partialHit && !path.endsWith("/thread") && !path.endsWith("/source")) {
        return json({
          ...mailItem({
            messageId: partialHit,
            subject: "带大附件的简报",
            fromAddr: "news@example.com",
            snippet: "本周要闻",
            copies: [{ accountId: "acc1", folder: "INBOX", uid: 9 }],
            accounts: ["acc1"],
          }),
          truncated: true,
          partial: true,
          text: "本周要闻：正文照常可读。",
          html: "<p>本周要闻：正文照常可读。</p>",
          cc: [],
          refs: [],
          remoteBlocked: 0,
          headers: [],
          attachments: [
            { index: 0, filename: "logo.png", contentType: "image/png", size: 2048, cid: "logo@x", inline: true, deferred: false },
            { index: 1, filename: "report.pdf", contentType: "application/pdf", size: 3145728, cid: null, inline: false, deferred: true },
          ],
        });
      }
      // 超大邮件（truncated）：只入库索引 → 正文/附件为空（详情页应给出提示与补取入口）
      const truncatedHit = (calls.truncatedIds ?? []).find((id) => path.includes(encodeURIComponent(id)) || path.includes(id));
      if (truncatedHit && !path.endsWith("/thread") && !path.endsWith("/source")) {
        return json({
          ...mailItem({
            messageId: truncatedHit,
            subject: "大附件邮件",
            fromAddr: "big@example.com",
            copies: [{ accountId: "acc2", folder: "INBOX", uid: 2 }],
            accounts: ["acc2"],
          }),
          truncated: true,
          snippet: "",
          text: "",
          html: "",
          attachments: [],
          cc: [],
          refs: [],
          headers: [
            { key: "From", line: "From: big@example.com" },
            { key: "Subject", line: "Subject: 大附件邮件" },
          ],
        });
      }
      // 按请求的消息 id 分发：w01 是多副本（删除用例）、s01 是发件样本
      //（「收件 / 发件区分」用例打开它，副本只在「已发送」），其余返回 w03 详情
      if (path.includes("s01")) {
        return json(
          mailItem({
            messageId: "mid:s01@test.local",
            date: "2026-09-25T01:00:00.000Z",
            subject: "Re: 会议纪要",
            fromAddr: "me@mail.example.cn",
            fromName: "我",
            snippet: "附件是本周的会议纪要，请查收。",
            seen: true,
            copies: [{ accountId: "acc1", folder: "已发送", uid: 9 }],
            accounts: ["acc1"],
            to: [{ name: "张老师", address: "zhang@example.com" }],
            cc: [],
            text: "附件是本周的会议纪要，请查收。",
            html: "",
            remoteBlocked: 0,
            attachments: [],
          }),
        );
      }
      const isShared = path.includes("w01");
      if (isShared) {
        return json(
          mailItem({
            messageId: "mid:w01@test.local",
            seen: false,
            copies: [
              { accountId: "acc1", folder: "INBOX", uid: 1 },
              { accountId: "acc2", folder: "INBOX", uid: 1 },
            ],
            accounts: ["acc1", "acc2"],
            to: [{ name: "", address: "me@mail.example.cn" }],
            cc: [],
            text: "你好，你的面试的通知时间是周五下午三点，请提前十分钟到。",
            html: "",
            remoteBlocked: 0,
            attachments: [],
          }),
        );
      }
      return json(
        mailItem({
          messageId: "mid:w03@test.local",
          subject: "HTML Newsletter",
          fromAddr: "newsletter@example.com",
          fromName: "",
          seen: false,
          to: [{ name: "", address: "me@mail.example.cn" }],
          cc: [],
          text: "",
          html: MAIL_DETAIL_HTML,
          remoteBlocked: 1,
          attachments: [
            {
              index: 0,
              filename: "logo.png",
              contentType: "image/png",
              size: 70,
              cid: "logo-inline",
              inline: true,
            },
            // 非内嵌附件：转发用例要把这个装回写信页（内嵌图不算附件）
            {
              index: 1,
              filename: "report.pdf",
              contentType: "application/pdf",
              size: 30,
              cid: null,
              inline: false,
            },
          ],
          // 原始邮件头（2026-10-07）：按原文顺序与折行
          headers: [
            { key: "From", line: "From: newsletter@example.com" },
            { key: "Subject", line: "Subject: HTML Newsletter" },
            { key: "Message-ID", line: "Message-ID: <w03@test.local>" },
          ],
        }),
      );
    }
    // 通讯录：CRUD + 自动收录 + 自动补全
    if (path === "/contacts" && route.request().method() === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const items = contactStore.filter(
        (c) =>
          !q ||
          c.name.toLowerCase().includes(q) ||
          c.email.toLowerCase().includes(q) ||
          c.note.toLowerCase().includes(q),
      );
      return json({ items });
    }
    if (path === "/contacts" && route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { name?: string; email?: string; note?: string };
      calls.contacts?.push({ method: "POST", body });
      if (!body.email?.includes("@")) {
        return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "邮箱地址格式非法" }) });
      }
      const created = { id: `c${++contactSeq}`, name: body.name ?? "", email: body.email!, note: body.note ?? "" };
      contactStore.push(created);
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(created) });
    }
    if (path === "/contacts/known") {
      const saved = new Set(contactStore.map((c) => c.email.toLowerCase()));
      return json({ items: KNOWN_SENDERS.filter((k) => !saved.has(k.email)) });
    }
    if (path === "/contacts/suggest") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      if (!q) return json({ contacts: [], known: [] });
      const contacts = contactStore.filter(
        (c) => c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q),
      );
      const saved = new Set(contactStore.map((c) => c.email.toLowerCase()));
      const known = KNOWN_SENDERS.filter(
        (k) =>
          !saved.has(k.email) &&
          (k.name.toLowerCase().includes(q) || k.email.toLowerCase().includes(q)),
      );
      return json({ contacts, known });
    }
    const contactMatch = path.match(/^\/contacts\/([^/]+)$/);
    if (contactMatch && route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      calls.contacts?.push({ method: "PATCH", id: contactMatch[1], body });
      const c = contactStore.find((x) => x.id === contactMatch[1]);
      if (!c) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "联系人不存在" }) });
      Object.assign(c, body);
      return json(c);
    }
    if (contactMatch && route.request().method() === "DELETE") {
      calls.contacts?.push({ method: "DELETE", id: contactMatch[1] });
      const idx = contactStore.findIndex((x) => x.id === contactMatch[1]);
      if (idx < 0) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "联系人不存在" }) });
      contactStore.splice(idx, 1);
      return json({ ok: true });
    }
    return json({ error: `未打桩的端点: ${path}` });
  });
}

test.describe("站内邮件（/mail）", () => {
  test("游客：页面重定向到登录页，API 一律 401", async ({ page }) => {
    await page.goto("/mail", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/login$/);
    const res = await page.request.get("/api/mail/messages");
    expect(res.status()).toBe(401);
    // 通讯录同样受守卫
    await page.goto("/mail/contacts", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/login$/);
    const res2 = await page.request.get("/api/mail/contacts");
    expect(res2.status()).toBe(401);
  });

  test.describe("登录态（API 打桩）", () => {
    test.skip(!totpSecret, "未配置 TOTP_SECRET，跳过登录测试");

    /**
     * 两栏外壳（MAIL-AGENT.md 4.12）：宽屏左列表 / 右内容，窄屏退化为单栏。
     * 关键不变式：列表挂在 layout 上，列表 ⇄ 详情之间导航**不重新挂载**——
     * 用「给列表打个测试标记，导航后标记还在」来锁定（重新挂载会丢失标记）。
     */
    test("宽屏分栏：左列表 / 右内容，窄屏退化为单栏", async ({ page }) => {
      const calls = { flags: [] as unknown[], send: [], delete: [] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      // ---- 宽屏（≥lg = 1024）：两栏并排 ----
      await page.setViewportSize({ width: 1280, height: 900 });
      await gotoReady(page, "/mail");
      const listPane = page.locator('[data-slot="mail-pane-list"]');
      const detailPane = page.locator('[data-slot="mail-pane-detail"]');
      await expect(listPane).toBeVisible();
      await expect(detailPane).toBeVisible();

      const listBox = (await listPane.boundingBox())!;
      const detailBox = (await detailPane.boundingBox())!;
      expect(listBox.x + listBox.width, "列表必须完全在内容左侧").toBeLessThanOrEqual(detailBox.x);

      // 未选中邮件时右栏是占位说明（不是空白）
      await expect(detailPane.getByText("从左侧列表选择一封邮件")).toBeVisible();

      const rows = page.locator('[data-slot="mail-list"] > li');
      await expect(rows).toHaveCount(4); // 默认视图 = 收件（s01 发件不在其中）

      // 给列表打标记 → 点开一封 → 标记必须还在（证明 layout 未重新挂载）
      await page.evaluate(() => {
        document.querySelector('[data-slot="mail-list"]')?.setAttribute("data-e2e-mark", "1");
      });
      await rows.nth(1).locator("[data-mail-row]").click();
      await expect(page).toHaveURL(/\/mail\/message\//);
      await expect(page.locator('[data-slot="mail-list"][data-e2e-mark="1"]')).toHaveCount(1);
      await expect(detailPane.getByRole("heading", { level: 2 }).first()).toBeVisible();
      // 详情页时间 = 具体发出时刻（绝对时间，含年份与时分），不是「N 天前」相对措辞
      const msgDate = detailPane.locator('[data-slot="mail-message-date"]');
      await expect(msgDate).toContainText("2026");
      await expect(msgDate).toContainText(/\d{1,2}:\d{2}/);
      await expect(msgDate).not.toContainText(/天前|ago/);
      // 当前打开的那封在列表里高亮（唯一）
      await expect(page.locator('[data-mail-row][aria-current="true"]')).toHaveCount(1);
      // 宽屏下「返回列表」让位给左栏列表；窄屏才需要
      await expect(page.getByRole("link", { name: "返回列表" })).toBeHidden();

      // ---- 窄屏（<lg）：单栏 ----
      await page.setViewportSize({ width: 420, height: 900 });
      await gotoReady(page, "/mail");
      await expect(listPane).toBeVisible();
      await expect(detailPane).toBeHidden();

      await page.locator('[data-slot="mail-list"] > li').nth(1).locator("[data-mail-row]").click();
      await expect(page).toHaveURL(/\/mail\/message\//);
      await expect(detailPane).toBeVisible();
      await expect(listPane).toBeHidden();
      await expect(page.getByRole("link", { name: "返回列表" })).toBeVisible();

      // 复位视口，避免影响后续用例
      await page.setViewportSize({ width: 1280, height: 720 });
    });

    /**
     * 面板高度固定（MAIL-AGENT.md 4.12）：宽屏下邮件面板铺满「视口 − 站点上下装饰」的
     * 剩余高度，与「全部 / 未读 / 星标」筛出多少封**无关**（此前「全部」会把页面撑长、
     * 未读/星标时又缩成一小条，用户反馈）。同时锁定：页面本身不滚（页脚收在折线处），
     * 长列表由面板内部滚动承接。
     */
    test("面板高度：宽屏下不随筛选结果多少而变（铺满剩余视口高度）", async ({ page }) => {
      const calls = { flags: [] as unknown[], send: [], delete: [] };
      await stubMailApi(page, calls);
      // ⚠ 覆盖桩：把 5 条样本复制成 20 条（内容高 ~1600px，远大于撑满后的滚区 ~394px）。
      //   原 5 条的内容高（405）与撑满值（394）几乎重合，「撑满」与「缩到内容高」两种状态
      //   无法区分——该用例 2026-10-04 因此误报过一次。20 条让判据有千像素级余量。
      //   ⚠ 覆盖桩要自己实现 filter / direction（2026-10-04 起默认视图 = 收件，会带 direction 参数），
      //   别把筛选也一并覆盖掉。
      const longList = [0, 1, 2, 3].flatMap((k) =>
        MAIL_LIST.map((m) => ({ ...m, messageId: `${m.messageId}~${k}` })),
      );
      await page.route("**/api/mail/messages*", (route) => {
        const sp = new URL(route.request().url()).searchParams;
        const filters = new Set((sp.get("filter") ?? "").split(",").filter(Boolean));
        const direction = sp.get("direction");
        let items = longList;
        if (filters.has("unseen")) items = items.filter((m) => !m.seen);
        if (filters.has("flagged")) items = items.filter((m) => m.flagged);
        if (direction === "received")
          items = items.filter((m) => m.copies.some((c) => c.folder.toUpperCase() === "INBOX"));
        if (direction === "sent")
          items = items.filter((m) => m.copies.every((c) => SENT_FOLDERS.has(c.folder.trim().toLowerCase())));
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ items, next: null }),
        });
      });
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await page.setViewportSize({ width: 1280, height: 900 });
      await gotoReady(page, "/mail");

      const rows = page.locator('[data-slot="mail-list"] > li');
      const snap = () =>
        page.evaluate(() => {
          const el = document.querySelector('[data-slot="mail-list-scroll"]')!;
          const pane = document.querySelector('[data-slot="mail-pane-list"]')!;
          const d = document.documentElement;
          return {
            pane: Math.round(pane.getBoundingClientRect().height),
            scroller: Math.round(el.getBoundingClientRect().height),
            overflowY: getComputedStyle(el).overflowY,
            pageOverflow: d.scrollHeight - d.clientHeight,
          };
        });

      // 各视图 / 筛选的条数各不相同（收件 16 / 收件∩未读 12 / 收件∩星标 4 / 全部 20），能真正区分
      // 「高度是否随内容变」。2026-10-05 微调后：全部 / 收件 / 发件是视图 tab（role=tab），
      // 「未读」「星标」是 tab 行右侧的独立开关（role=button）——不再有同名「全部」撞车的歧义。
      await expect(rows).toHaveCount(16); // 默认视图 = 收件
      const base = await snap();
      expect(base.overflowY, "长列表必须由面板内部滚动承接").toBe("auto");
      expect(base.pageOverflow, "页面本身不该被撑出滚动条（页脚收在折线处）").toBeLessThanOrEqual(1);
      // 判据：滚区被容器约束（远小于内容高），说明高度来自「面板 − 工具栏 − 底栏」。
      // 若回归成 shrink-to-fit，滚区会等于内容高 → 立刻红。
      const contentH = await page.evaluate(() => {
        const ul = document.querySelector('[data-slot="mail-list"]')!;
        return Math.round(ul.getBoundingClientRect().height);
      });
      expect(contentH, "桩数据应显著长于滚区（本判据的前提）").toBeGreaterThan(1000);
      expect(base.scroller, "面板必须撑满剩余高度，而不是缩到内容高").toBeLessThan(contentH - 200);

      const expectSameHeight = async (label: string, count: number) => {
        await expect(rows).toHaveCount(count);
        const now = await snap();
        expect(now.scroller, `切到「${label}」后面板高度不应变化`).toBe(base.scroller);
        expect(now.pane, `切到「${label}」后左栏高度不应变化`).toBe(base.pane);
        expect(now.pageOverflow).toBeLessThanOrEqual(1);
      };
      const unseenChip = page.getByRole("button", { name: "未读", exact: true });
      const flaggedChip = page.getByRole("button", { name: "星标", exact: true });
      await unseenChip.click();
      await expectSameHeight("收件∩未读", 12);
      await unseenChip.click(); // 关掉未读开关，避免与星标叠加
      await flaggedChip.click(); // 收件 ∩ 星标 = 4（星标是开关，与当前视图叠加）
      await expectSameHeight("收件∩星标", 4);
      await flaggedChip.click(); // 关掉星标再看全部
      await page.getByRole("tab", { name: "全部", exact: true }).click();
      await expectSameHeight("全部", 20);

      // 复位视口，避免影响后续用例
      await page.setViewportSize({ width: 1280, height: 720 });
    });

    /**
     * 容器宽度（MAIL-AGENT.md 4.12 / 4.13）：`/mail` 及三个子页面（compose / contacts / agent）
     * 的页面容器必须与站点标准列（顶栏 / 页脚）同宽同左缘。
     * 曾用 `max-w-7xl` 给两栏腾宽度（面板比顶栏 Logo 各多出一截）、`/mail/compose` 曾单独
     * 用 `max-w-3xl`（与 `/mail` 往返时标题左缘横移）——两处都被用户指出，2026-10 统一。
     * 一并覆盖 `/calendar`、`/ideas`：同为 owner 页面，跳转时标题位置同样不能晃。
     */
    test("容器宽度：与站点栏（顶栏 / 页脚）同一列宽，不比其它页面宽", async ({ page }) => {
      test.slow(); // 6 条 owner 路由整页导航，见文件顶部「超时预算」
      const calls = { flags: [] as unknown[], send: [], delete: [] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await page.setViewportSize({ width: 1280, height: 900 });
      for (const path of [
        "/mail",
        "/mail/compose",
        "/mail/contacts",
        "/mail/agent",
        "/calendar",
        "/ideas",
      ]) {
        await gotoReady(page, path);
        const m = await measureColumns(page);
        expect(m.container, `${path} 应有页面根容器`).not.toBeNull();
        expect(m.container!.w, `${path} 的页面容器必须与顶栏同宽（max-w-6xl）`).toBe(m.header!.w);
        expect(m.container!.w, `${path} 的页面容器必须与页脚同宽`).toBe(m.footer!.w);
        expect(m.container!.x, `${path} 的页面容器必须与顶栏左缘对齐`).toBe(m.header!.x);
      }

      // 复位视口，避免影响后续用例
      await page.setViewportSize({ width: 1280, height: 720 });
    });

    /**
     * 水合守卫（2026-10-07）：邮件页此前**没有任何控制台断言**（`collectPageErrors` 只用在
     * 首页），而 Base UI 的自动 id 一旦错位，唯一症状就是一条 hydration mismatch——没有
     * 任何用例会红。这条把「整页加载 + 水合」逐个邮件路由走一遍：
     * - 用 `gotoReady`（真实文档加载，真的走 SSR + hydration），不是 SPA 跳转；
     * - 断言没有水合不匹配、没有未捕获异常、没有其它 console 错误（`Failed to load
     *   resource` 网络噪音除外——桩里 agent 端点已有响应，真实环境缺 mailagentd 时才 502）。
     * ⚠ 已知的 dev-only 现象（**不是缺陷、不必追**）：改完 mail 相关文件而页面还开着时，
     *   旧 SSR HTML 与新客户端 chunk 会短暂错位，Base UI 的 useId 随之对不上 → 硬刷新即
     *   消失；生产构建 HTML/JS 同批产出，不会出现。见 CLAUDE.md。
     */
    test("水合守卫：各邮件路由整页加载无 console 错误 / 无水合不匹配", async ({ page }) => {
      test.slow();
      const calls = { flags: [] as unknown[], send: [], delete: [] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      const errors: string[] = [];
      const onConsole = (msg: ConsoleMessage) => {
        if (msg.type() === "error") errors.push(msg.text());
      };
      const onPageError = (err: Error) => errors.push(`pageerror: ${err.message}`);
      page.on("console", onConsole);
      page.on("pageerror", onPageError);

      try {
        for (const path of ["/mail", "/mail/compose", "/mail/contacts", "/mail/agent"]) {
          errors.length = 0;
          await gotoReady(page, path); // 含 waitForHydration → 水合确实跑过
          await page.waitForTimeout(800); // 让挂载后的轮询/取数也把话说出来
          const hydration = errors.filter((e) => /hydrat|didn'?t match|did not match/i.test(e));
          expect(hydration, `${path} 出现水合不匹配：${hydration.join(" | ")}`).toEqual([]);
          const rest = errors.filter((e) => !/Failed to load resource/i.test(e));
          expect(rest, `${path} 控制台错误：${rest.join(" | ")}`).toEqual([]);
        }
      } finally {
        page.off("console", onConsole);
        page.off("pageerror", onPageError);
      }
    });

    test("合并视图：跨账号副本聚合 + 账号筛选 + 搜索", async ({ page }) => {
      const calls = { flags: [], send: [], delete: [] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      const rows = page.locator('[data-slot="mail-list"] > li');
      await expect(rows).toHaveCount(4); // 默认视图 = 收件（s01 发件不在其中）
      // 多副本消息：账号色点 2 个，title 标注两个账号
      const shared = rows.nth(3).locator("span[title]");
      await expect(shared).toHaveAttribute("title", "主账号、学校");
      await expect(rows.nth(3).locator("span[title] > span")).toHaveCount(2);
      await expect(rows.nth(0)).toContainText("Report with attachment");

      // 账号筛选（2026-10-05 定稿 = 行 1 首个单选下拉）：开菜单选「学校」→ 只剩该账号 2 条；
      // 触发器常显当前账号（地址完整性的上限由菜单与底栏指示兜底）
      const accountTrigger = page.locator('button[aria-label="按账号筛选"]');
      await accountTrigger.click();
      await page.getByRole("menuitem", { name: /学校/ }).click();
      await expect(rows).toHaveCount(2);
      await expect(accountTrigger).toContainText("学校");

      // 搜索（2026-10-05 定稿 = 两段式：点搜索图标展开为输入框，300ms 防抖后发出 q 请求）
      await accountTrigger.click();
      await page.getByRole("menuitem", { name: /全部账号/ }).click();
      await page.getByRole("button", { name: "搜索", exact: true }).click();
      await page.getByPlaceholder("搜索邮件…").fill("面试");
      await expect(rows).toHaveCount(1);
      await expect(rows.nth(0)).toContainText("面试通知");
    });

    test("列表：视图切换 + 未读筛选 + 方向角标 + 行内快捷操作 + 键盘导航", async ({ page }) => {
      const calls = { flags: [] as unknown[], send: [], delete: [] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      const rows = page.locator('[data-slot="mail-list"] > li');
      await expect(rows).toHaveCount(4); // 默认视图 = 收件

      // 未读计数挂在「未读」开关上、不在「收件」tab（2026-10-05 用户定稿：发件不可能有
      // 未读，计数挂在方向 tab 上语义刻意）——acc1=3 + acc2=0，账号未读口径 = INBOX 未读。
      // 2026-10-05 二稿：计数改为「未读」文字右上角的无胶囊上标角标（不带括号）
      await expect(page.locator('[data-slot="unseen-count"]')).toHaveText("3");
      await expect(page.getByRole("tab", { name: "收件" })).not.toContainText("3");

      // Tab 顺序（2026-10-08 定稿）：全部 / 收件 / 发件 / 草稿 / 垃圾 = **5 个**
      // （草稿与垃圾都不算入「全部」——两者都是独立的固定用途，不是"随便挑一个文件夹看"；
      //   曾试过并已删除的是「任意文件夹」视图，原因见 mail-client.tsx 的 ViewFilter 注释）。
      // 未读、星标是右侧开关不是 tab。⚠ 中文下 5 个 tab 实测 232px、容器 234px，刚好放得下；
      // 英文放不下时「草稿/垃圾」会收进 chevron 下拉（另有用例锁定）。
      const viewTabs = page.locator('[aria-label="切换邮件视图"] [role="tab"]');
      await expect(viewTabs).toHaveCount(5);
      await expect(viewTabs.nth(0)).toHaveText("全部");
      await expect(viewTabs.nth(1)).toContainText("收件");
      await expect(viewTabs.nth(2)).toHaveText("发件");
      await expect(viewTabs.nth(3)).toHaveText("草稿");
      await expect(viewTabs.nth(4)).toHaveText("垃圾");
      // 方向配色：收件下划线 emerald / 发件 amber（与头像方向角标同色）
      await expect(viewTabs.nth(1)).toHaveClass(/data-active:after:bg-emerald-600/);
      await expect(viewTabs.nth(2)).toHaveClass(/data-active:after:bg-amber-600/);
      // ⚠ 行内不变量（2026-10-07 用户报）：右侧两个开关必须与 tab 条**同一行**。
      // 已删的第五个 tab 正是把「未读 / 星标」挤到了第二行，这条断言就是它的哨兵。
      // 判据用「垂直区间是否重叠」而非具体坐标——换字号 / 行高都不会误报。
      const tabsBox = (await viewTabs.first().boundingBox())!;
      const switchesBox = (await page.locator('[aria-label="快捷筛选（未读 / 星标）"]').boundingBox())!;
      const sameRow =
        tabsBox.y < switchesBox.y + switchesBox.height && switchesBox.y < tabsBox.y + tabsBox.height;
      expect(sameRow, "「未读 / 星标」开关被挤出了 tab 所在行").toBe(true);

      // 账号未读徽章（4.2）：2026-10-05 起在行 1 账号下拉的菜单里（acc1 = 3；acc2 = 0 不显示）
      const accountTrigger = page.locator('button[aria-label="按账号筛选"]');
      await accountTrigger.click();
      await expect(page.getByRole("menuitem", { name: /主账号/ })).toContainText("3");
      await expect(page.getByRole("menuitem", { name: /学校/ })).not.toContainText("0");
      await page.keyboard.press("Escape");

      // 附件指示（4.2）：第一行（w04）有回形针
      await expect(rows.nth(0).getByLabel("含附件")).toBeVisible();
      await expect(rows.nth(1).getByLabel("含附件")).toHaveCount(0);

      // 「未读」是独立开关（可与任意视图叠加）：收件 ∩ 未读 = 3 条（w03 已读被滤掉）
      const unseenChip = page.getByRole("button", { name: "未读", exact: true });
      const flaggedChip = page.getByRole("button", { name: "星标", exact: true });
      await unseenChip.click();
      await expect(rows).toHaveCount(3);
      // 「星标」同样是开关（2026-10-05 起不再是视图 tab）：收件 ∩ 星标 = 1 封
      await unseenChip.click();
      await flaggedChip.click();
      await expect(rows).toHaveCount(1);
      await expect(rows.nth(0)).toContainText("Weekly Digest");
      // 两个开关可同时开启（ToggleGroup 必须 multiple）：星标 ∩ 未读 = 1（Weekly Digest 未读）
      await unseenChip.click();
      await expect(unseenChip).toHaveAttribute("aria-pressed", "true");
      await expect(flaggedChip).toHaveAttribute("aria-pressed", "true");
      await expect(rows).toHaveCount(1);
      await unseenChip.click();
      await flaggedChip.click();

      // 方向视图（2026-10-04 改版为 Tabs）：「发件」= 副本全在「已发送」的（1 封 s01）；
      // 「收件」= 有 INBOX 副本的（4 封，s01 被排除）
      await page.getByRole("tab", { name: "发件", exact: true }).click();
      await expect(rows).toHaveCount(1);
      await expect(rows.nth(0)).toContainText("Re: 会议纪要");
      await page.getByRole("tab", { name: "收件", exact: true }).click();
      await expect(rows).toHaveCount(4);
      await expect(rows.nth(0)).not.toContainText("Re: 会议纪要");

      // 视图与未读开关互相独立、可叠加：停在「收件」时打开「未读」→ 未读的收件 3 封，
      // 收件 tab 保持选中（aria-selected）
      await unseenChip.click();
      await expect(rows).toHaveCount(3);
      await expect(page.getByRole("tab", { name: "收件" })).toHaveAttribute("aria-selected", "true");
      await unseenChip.click();
      await page.getByRole("tab", { name: "全部", exact: true }).click();
      await expect(rows).toHaveCount(5);

      // 未读角标：未读行（w04/w02/w01）的头像有蓝色角标，已读行（w03）没有
      await expect(rows.nth(0).locator('[data-slot="mail-unread-badge"]')).toHaveCount(1);
      await expect(rows.nth(1).locator('[data-slot="mail-unread-badge"]')).toHaveCount(0);
      await expect(rows.nth(2).locator('[data-slot="mail-unread-badge"]')).toHaveCount(1);
      // 方向角标（2026-10-04 双向标记，用户指定）：每行都有；收件 ↙ / 发件 ↗
      await expect(rows.locator('[data-slot="mail-direction-badge"]')).toHaveCount(5);
      await expect(rows.nth(0).locator('[data-slot="mail-direction-badge"]')).toHaveAttribute("data-direction", "received");
      await expect(rows.nth(4).locator('[data-slot="mail-direction-badge"]')).toHaveAttribute("data-direction", "sent");
      // 方向配色（2026-10-05 用户指定）：收件 ↙ emerald / 发件 ↗ amber（箭头着色，徽章底中性）
      await expect(rows.nth(0).locator('[data-slot="mail-direction-badge"] svg')).toHaveClass(/text-emerald-600/);
      await expect(rows.nth(4).locator('[data-slot="mail-direction-badge"] svg')).toHaveClass(/text-amber-600/);

      // 已读/未读视觉区分（勿改回 bg-primary 灰点、勿改回独立圆点列）：未读 = 头像蓝角标 + 发件人/主题加粗 + 前景色；
      // 已读 = 无角标 + 发件人/主题次要色（整行退到背景）
      await expect(rows.nth(0).locator('[data-slot="mail-unread-badge"]')).toHaveClass(/bg-blue-600/);
      // 每行都有头像（已读行不留空白槽）
      await expect(rows.locator('[data-slot="avatar"]')).toHaveCount(5);
      const rowStyle = (row: Locator) =>
        row.locator("[data-mail-row]").evaluate((el) => {
          const [sender, subject] = Array.from(el.querySelectorAll<HTMLElement>("span.truncate"));
          const cs = (n: HTMLElement) => getComputedStyle(n);
          return {
            senderWeight: cs(sender).fontWeight,
            senderColor: cs(sender).color,
            subjectWeight: cs(subject).fontWeight,
            subjectColor: cs(subject).color,
          };
        });
      const unreadStyle = await rowStyle(rows.nth(0));
      const readStyle = await rowStyle(rows.nth(1));
      expect(Number(unreadStyle.senderWeight)).toBeGreaterThanOrEqual(600);
      expect(Number(unreadStyle.subjectWeight)).toBeGreaterThanOrEqual(600);
      expect(Number(readStyle.senderWeight)).toBeLessThan(600);
      expect(Number(readStyle.subjectWeight)).toBeLessThan(600);
      // 已读行发件人与主题同为次要色；未读行同为前景色（颜色本身随主题变，只比行内一致性）
      expect(readStyle.senderColor).toBe(readStyle.subjectColor);
      expect(unreadStyle.senderColor).toBe(unreadStyle.subjectColor);
      expect(readStyle.senderColor).not.toBe(unreadStyle.senderColor);

      // 行内快捷操作（4.9）：hover 显现；点星标 → POST flags 乐观更新
      await rows.nth(0).hover();
      await rows.nth(0).getByRole("button", { name: "加星标" }).click();
      await expect.poll(() => calls.flags.length).toBe(1);
      expect(calls.flags[0]).toEqual({ messageId: "mid:w04@test.local", flagged: true });
      await expect(rows.nth(0).getByRole("button", { name: "取消星标" })).toHaveCount(1);
      // 星标是前景色（黑/白，shadcn 风格；2026-10-04 用户反馈「应该是黑的」），不再是琥珀色：
      // 已加星的星 svg fill 与页面前景色一致（amber-500 时二者不等）
      const starFill = await rows
        .nth(0)
        .getByRole("button", { name: "取消星标" })
        .locator("svg")
        .evaluate((el) => getComputedStyle(el).fill);
      const foreground = await page.evaluate(() => getComputedStyle(document.body).color);
      expect(starFill, "已加星的星标应为前景色（黑/白），而非琥珀色").toBe(foreground);

      // 键盘导航（4.9）：j 下移一行，k 回移
      await rows.nth(0).locator("[data-mail-row]").focus();
      await page.keyboard.press("j");
      await expect(rows.nth(1).locator("[data-mail-row]")).toBeFocused();
      await page.keyboard.press("k");
      await expect(rows.nth(0).locator("[data-mail-row]")).toBeFocused();
    });

    /**
     * 无限滚动续页 + 「加载更多」兜底按钮（4.9，2026-10-09）。
     *
     * 此前列表桩恒 `next: null`，这枚按钮与底部哨兵**一条用例都没覆盖**——而我实测把
     * 「后台又抓进来一批」的自动刷新改坏时，行数一次都不涨、界面全绿（哨兵观察的是被
     * 卸载重建的旧节点）。故这里给桩加**分页能力**，锁两条：
     *   ① 哨兵进视口 → 自动续页（不点按钮行数就涨）；
     *   ② 加载中那枚按钮的**盒子一格不动**（旧实现条件插入 Spinner：78 → 98px、居中后
     *      x 左跳 10px，配上 `transition-all` + `disabled:opacity-50` 就是用户报的
     *      「深黑与浅灰同屏叠加」）。
     * ⚠ 不断言具体页数/行数：视口高度决定自动续几页，那是布局的函数，不是契约。
     */
    test("列表：哨兵自动续页 + 「加载更多」按钮盒子在加载态不动", async ({ page }) => {
      const many = [
        ...MAIL_LIST,
        ...Array.from({ length: 25 }, (_, i) =>
          mailItem({
            messageId: `mid:page${i}@test.local`,
            date: `2026-09-2${i % 9}T0${i % 9}:00:00.000Z`,
            subject: `分页样本 ${i + 1}`,
            fromAddr: "page@example.com",
            fromName: "分页",
          }),
        ),
      ];
      const calls = {
        flags: [] as unknown[],
        send: [] as unknown[],
        delete: [] as unknown[],
        listStore: many,
        pageSize: 3,
        listDelayMs: 400,
      };
      await stubMailApi(page, calls);
      // ⚠ 必须在打桩**之后**换：`stubMailApi` 自己会把 `calls.listStore` 重置成 MAIL_LIST
      calls.listStore = many;
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      const rows = page.locator('[data-slot="mail-list"] > li');
      const more = page.locator('[data-slot="mail-load-more"]');
      await expect(rows.first()).toBeVisible();

      // ① 自动续页：首屏只取一页（3 条），哨兵落在视口余量里 → 行数自己涨过第一页
      const pageOne = 3;
      await expect
        .poll(async () => rows.count(), { message: "哨兵进视口应自动续页（不点按钮）" })
        .toBeGreaterThan(pageOne);
      // 30 条 ÷ 3 一页，自动续页永远吃不完（哨兵会被新行推出余量）→ 兜底按钮必须在
      await expect(more).toBeVisible();

      // ② 按钮盒子稳定：加载态与空闲态逐像素同框
      const idleBox = (await more.boundingBox())!;
      const before = await rows.count();
      await more.click();
      await expect(more).toHaveAttribute("aria-busy", "true");
      const busyBox = (await more.boundingBox())!;
      expect(Math.abs(busyBox.x - idleBox.x), "加载态按钮不许位移（旧实现 x 左跳 10px）").toBeLessThanOrEqual(1);
      expect(Math.abs(busyBox.width - idleBox.width), "加载态按钮不许变形（旧实现宽 78→98px）").toBeLessThanOrEqual(1);
      await expect(more).not.toHaveAttribute("aria-busy", "true");
      await expect.poll(async () => rows.count(), { message: "点按钮必须真的续上一页" }).toBeGreaterThan(before);
    });

    /**
     * 「垃圾」tab（2026-10-08 用户要求新增）。
     * 契约：① 文件夹路径**由服务端探测**（`GET /folders` 的 `specialUse = \Junk`），前端
     * 只按账号拼 `folder=<账号>|<路径>`；② 只有**在同步白名单里**的垃圾文件夹才查得到，
     * 没同步时必须说清原因（否则「垃圾」页永远空白且没有解释）。
     */
    test("「垃圾」tab：按账号探测 \\Junk 后按文件夹筛；未同步时说明原因", async ({ page }) => {
      const calls = {
        flags: [] as unknown[],
        send: [],
        delete: [] as unknown[],
        junkSynced: true,
        junkFolderItems: true,
      };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      const listRequests: string[] = [];
      page.on("request", (r) => {
        if (r.url().includes("/api/mail/messages")) listRequests.push(decodeURIComponent(r.url()));
      });

      await gotoReady(page, "/mail");
      await page.getByRole("tab", { name: "垃圾", exact: true }).click();
      const rows = page.locator('[data-slot="mail-list"] > li');
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText("中奖通知");
      // 请求带上了「账号|路径」——账号维度不能丢（多账号下各自探测各自的垃圾文件夹）
      expect(listRequests.some((u) => u.includes("folder=acc1|垃圾邮件"))).toBe(true);
      // 垃圾不算入任何方向视图：切回「全部」时它不在
      await page.getByRole("tab", { name: "全部", exact: true }).click();
      await expect(page.locator('[data-slot="mail-list"] > li')).toHaveCount(5);

      // 文件夹存在但没进同步白名单：显示原因而不是「暂无邮件」
      calls.junkSynced = false;
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("tab", { name: "垃圾", exact: true }).click();
      await expect(page.getByText(/「垃圾邮件」还不在同步范围里/)).toBeVisible();
      await expect(page.getByText("「垃圾」中暂无邮件")).toHaveCount(0);
    });

    /**
     * 展开「快速回复」不应该让整个右栏变成可滚动的（2026-10-08 用户报）：
     * 正文是那一列里**唯一可伸缩**的项，多出来的高度由它让出（内部滚动），外层保持不滚。
     * 用例给一封超长正文的邮件（详情桩局部覆盖），断言展开前后外层都没有可滚动的余量。
     */
    test("快速回复：展开后由正文让出高度（正文内部滚动），外层不出现滚动", async ({ page }) => {
      const calls = { flags: [] as unknown[], send: [], delete: [] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      // 这封的正文足够长（远超右栏高度）：局部覆盖详情桩（/thread 仍走通用桩）。
      // ⚠ 必须自己拼响应，**不能 `route.fetch()` 再改**——`route.fetch()` 是绕过所有桩
      //   真发一次请求（E2E 环境里 webmaild 根本没起），拿不到通用桩的数据。
      await page.route("**/api/mail/message/*", async (route) => {
        if (route.request().url().endsWith("/thread")) return route.fallback();
        return route.fulfill({
          json: {
            ...mailItem({
              messageId: "mid:long@test.local",
              subject: "长正文邮件",
              fromAddr: "long@example.com",
              to: [{ name: "", address: "me@mail.example.cn" }],
            }),
            cc: [],
            refs: [],
            headers: [{ key: "From", line: "From: long@example.com" }],
            text: "",
            html: Array.from(
              { length: 40 },
              (_, i) => `<p>第 ${i + 1} 行长正文，用于把右栏高度占满。</p>`,
            ).join(""),
            remoteBlocked: 0,
            attachments: [],
          },
        });
      });

      await gotoReady(page, "/mail");
      await page.locator('[data-slot="mail-list"] > li').nth(0).locator("[data-mail-row]").click();
      await expect(page).toHaveURL(/\/mail\/message\//);
      const pane = page.locator('[data-slot="mail-pane-detail"] > div');
      const overflow = () =>
        pane.evaluate((el) => el.scrollHeight - el.clientHeight);

      expect(await overflow(), "展开前右栏就不该有滚动余量").toBeLessThanOrEqual(1);
      const bodyHeightBefore = (await page.locator(".mail-body").boundingBox())!.height;
      await page.getByRole("button", { name: "快速回复" }).click();
      await expect(page.locator('[data-slot="mail-quick-reply"]')).toHaveAttribute("data-open", "true");
      await expect(page.getByRole("button", { name: "发送" })).toBeVisible();
      expect(await overflow(), "展开快速回复后右栏不该出现滚动").toBeLessThanOrEqual(1);
      const bodyHeightAfter = (await page.locator(".mail-body").boundingBox())!.height;
      expect(bodyHeightAfter, "正文应该变矮，把高度让给快速回复").toBeLessThan(bodyHeightBefore);
      // 正文自己是可以滚的（内容没被裁掉）
      const bodyScrolls = await page
        .locator(".mail-body")
        .evaluate((el) => el.scrollHeight - el.clientHeight);
      expect(bodyScrolls).toBeGreaterThan(0);
    });

    test("详情页：会话区块 + 上一封/下一封 + 页内快速回复", async ({ page }) => {
      const calls = { flags: [] as unknown[], send: [] as unknown[], delete: [] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      // 打开 w03（列表第 2 条；sessionStorage 列表序已写入）
      await page.locator('[data-slot="mail-list"] > li').nth(1).locator("[data-mail-row]").click();
      await expect(page).toHaveURL(/\/mail\/message\//);

      // 会话区块（4.7）：2 封，当前封带「当前」徽章且不跳转
      // ⚠ 2026-10-09 起 `data-slot="mail-thread"` 挂在**外层 section**（可折叠），行在
      //   `[data-slot="mail-thread-list"]` 里；且正文装不下时会话默认折叠 → 断言行之前先展开
      const thread = page.locator('[data-slot="mail-thread"]');
      const threadToggle = thread.locator('[data-slot="mail-thread-toggle"]');
      const threadList = thread.locator('[data-slot="mail-thread-list"]');
      await expect(thread).toBeVisible();
      // ⚠ 展开会话必须"点到为真为止"（2026-10-09 全量跑偶发红两次后定稿）：
      //   自动折叠的**复量**发生在挂载后 360ms（图片/字体迟到时首次量不到溢出），所以
      //   「读一眼 data-open 再决定点不点」会与它抢跑——读到 true 不点，随后被它收起来；
      //   读到 true 后连点两次，中间那一瞬间被它收起就会把状态点反。
      //   任何一次点击都会置 `threadTouched` ⇒ 自动折叠从此停手（effect 重跑直接 return，
      //   已排队的定时器被 cleanup 清掉），所以"先点一下定住、再点到展开"是与时序无关的写法。
      await threadToggle.click();
      for (let i = 0; i < 3 && (await thread.getAttribute("data-open")) !== "true"; i++) {
        await threadToggle.click();
      }
      await expect(thread).toHaveAttribute("data-open", "true");
      await expect(threadToggle).toHaveAttribute("aria-expanded", "true");
      await expect(threadList.locator("> li")).toHaveCount(2);
      await expect(thread.getByText("This week in research")).toBeVisible();
      const currentRow = thread.locator('[aria-current="true"]');
      await expect(currentRow).toContainText("当前");
      await expect(currentRow).toBeDisabled();

      // 折叠/滚动的契约（4.7，2026-10-09）：手动展开保底 ~3 行（120px）、列表自己滚；
      // 收起只剩标题行（28px）、列表被网格轨道压成 0
      await expect(threadToggle).toHaveAttribute("aria-expanded", "true");
      expect(
        (await thread.boundingBox())!.height,
        "手动展开后会话要保底 ~3 行（否则在空间紧张时点了像没反应）",
      ).toBeGreaterThanOrEqual(118);
      expect(await threadList.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
      await threadToggle.click();
      await expect(thread).toHaveAttribute("data-open", "false");
      await expect(threadToggle).toHaveAttribute("aria-expanded", "false");
      expect((await thread.boundingBox())!.height, "收起态只剩标题行").toBeLessThanOrEqual(40);
      // 收起的面板：整块被压平 + `inert`（键盘与读屏都进不去被折叠的内容）
      await expect(page.locator("#mail-thread-panel")).toHaveAttribute("inert", "");
      // ⚠ 量的是 **clientHeight（内容盒）而不是 getBoundingClientRect**（2026-10-09 全量跑连红
      //   两次后查清）：列表自己带 `border`，收起时内容盒为 0、但边框盒恒有 2px（上下各 1px
      //   边框），量边框盒永远等不到 0。另外点完立刻量会量到 300ms 轨道动画中途（实测 1px），
      //   所以用 poll 等稳态；容差 1px 是给分数布局取整留的（别写 `toBe(0)`）。
      await expect
        .poll(async () => threadList.evaluate((el) => el.clientHeight), {
          message: "收起后列表内容盒应当归零（等 300ms 轨道动画结束）",
        })
        .toBeLessThanOrEqual(1);
      await threadToggle.click();
      await expect(thread).toHaveAttribute("data-open", "true");

      // 上一封 / 下一封（按列表序：w04 ← w03 → w02）：**仅窄屏可见**——
      // 宽屏左栏就是列表，这两个按钮多余又占空间（2026-10-04 用户反馈），与「返回列表」同规则
      await expect(page.getByRole("link", { name: "上一封" })).toBeHidden();
      await expect(page.getByRole("link", { name: "下一封" })).toBeHidden();
      await page.setViewportSize({ width: 420, height: 900 });
      await expect(page.getByRole("link", { name: "上一封" })).toBeVisible();
      await expect(page.getByRole("link", { name: "下一封" })).toBeVisible();
      await page.setViewportSize({ width: 1280, height: 720 });

      // 页内快速回复（4.9）：**默认收起**（2026-10-06 用户要求），点标题行展开 → 续引用链发出
      const quick = page.locator('[data-slot="mail-quick-reply"]');
      await expect(quick).toHaveAttribute("data-open", "false");
      await quick.getByRole("button", { name: "快速回复" }).click();
      await expect(quick).toHaveAttribute("data-open", "true");
      await quick.locator("textarea").fill("收到，谢谢！");
      await quick.getByRole("button", { name: "发送" }).click();
      await expect.poll(() => calls.send.length).toBe(1);
      const sent = calls.send[0] as {
        accountId: string;
        to: string[];
        subject: string;
        inReplyTo?: string;
        references?: string[];
      };
      expect(sent.to).toEqual(["newsletter@example.com"]);
      expect(sent.subject).toBe("Re: HTML Newsletter");
      expect(sent.inReplyTo).toBe("<w03@test.local>");
      expect(sent.references).toContain("<w03@test.local>");
    });

    /**
     * 会话折叠的**空间优先级**（4.7，2026-10-09 用户要求）：
     *   ① 正文装不下 → 优先自动折叠会话（而不是让正文变滚动）；
     *   ② 展开会话后正文不够 → 先让会话收缩、列表内部滚；
     *   ③ 会话压到底还不够 → 才让正文也滚。
     *
     * 这里只锁**两端**（装得下必须展开 / 装不下必须折叠）与「窄屏不参与」——
     * 中间态（②）的连续收缩量测起来依赖字体与桩内容的像素，属于易碎断言，写在
     * MAIL-AGENT.md 4.7 里由人工取证（真实邮箱 940/1000/1060/1120 四档已量过）。
     */
    test("详情页：会话折叠优先于正文滚动（空间不够时先收会话）", async ({ page }) => {
      const calls = { flags: [] as unknown[], send: [] as unknown[], delete: [] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      // 视口在导航**之前**定好：自动折叠只收不放，先在大视口加载才能观察到"装得下就展开"
      await page.setViewportSize({ width: 1280, height: 1400 });
      await gotoReady(page, "/mail");
      await page.locator('[data-slot="mail-list"] > li').nth(1).locator("[data-mail-row]").click();
      await expect(page).toHaveURL(/\/mail\/message\//);

      const thread = page.locator('[data-slot="mail-thread"]');
      const threadToggle = thread.locator('[data-slot="mail-thread-toggle"]');
      const threadList = thread.locator('[data-slot="mail-thread-list"]');
      const body = page.locator(".mail-body");
      const bodyScrolls = () => body.evaluate((el) => el.scrollHeight - el.clientHeight);

      // ① 空间充裕：会话保持展开，正文完整（没有滚动条被让出来）
      await expect(thread).toHaveAttribute("data-open", "true");
      await expect(threadToggle).toHaveAttribute("aria-expanded", "true");
      expect(await bodyScrolls(), "展开态下正文不该在滚（规则①：会话优先折叠）").toBeLessThanOrEqual(1);

      // ①（触发）：把窗口压到正文无论如何装不下 → 会话自动折叠，正文拿回空间
      await page.setViewportSize({ width: 1280, height: 480 });
      await expect(thread).toHaveAttribute("data-open", "false");
      await expect(threadToggle).toHaveAttribute("aria-expanded", "false");
      expect((await thread.boundingBox())!.height, "自动折叠后只剩标题行").toBeLessThanOrEqual(40);

      // ②/③ 用户自己点开：会话保底 ~3 行、列表内部滚（正文是否还滚取决于窗口有多小）
      await threadToggle.click();
      await expect(thread).toHaveAttribute("data-open", "true");
      expect((await thread.boundingBox())!.height, "手动展开要保底 ~3 行").toBeGreaterThanOrEqual(118);
      expect(await threadList.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");

      // 窄屏（<lg）：整页是文档流，没有"右栏高度"可让——不参与自动折叠，也不做嵌套滚动
      await page.setViewportSize({ width: 420, height: 900 });
      await page.reload();
      await page.waitForSelector('[data-slot="mail-thread"]');
      await expect(thread).toHaveAttribute("data-open", "true");
      expect(await threadList.evaluate((el) => getComputedStyle(el).overflowY)).toBe("visible");
    });

    test("回复/回复全部/转发：预填收件人、引用链、附件与「回复」的款式（同「写邮件」）", async ({ page }) => {
      const calls = { flags: [] as unknown[], send: [] as unknown[], delete: [] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      // 详情页：三个动作都在。「回复」是本页唯一带边框的、且放在**最右边**的主操作；
      // 「删除」无边框（2026-10 用户指定，勿改回）
      // ⚠ 判据必须是**边框颜色**而不是宽度：ghost 的边框宽度也是 1px，只是 transparent
      await gotoReady(page, "/mail");
      await page.locator('[data-slot="mail-list"] > li').nth(1).locator("[data-mail-row]").click();
      await expect(page).toHaveURL(/\/mail\/message\//);
      const bar = page.locator('[data-slot="message-actions"]');
      const reply = bar.getByRole("link", { name: "回复", exact: true });
      const forward = bar.getByRole("link", { name: "转发", exact: true });
      // 「回复全部」2026-10-07 起并进「回复」右侧的下拉（分裂按钮），不再是并排的链接
      const replyAll = bar.getByRole("button", { name: "回复全部", exact: true });
      const del = bar.getByRole("button", { name: "删除", exact: true });
      await expect(reply).toBeVisible();
      await expect(replyAll).toBeVisible();
      await expect(forward).toBeVisible();
      // 「回复」与「写邮件」**同款式**（2026-10-07 用户指定：「同等重要」）——判据是
      // 两者的背景 / 前景 / 高度逐项相等（此前「回复」是 outline 描边款）
      const styleOf = (el: Element) => {
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, color: s.color, height: s.height };
      };
      const replyStyle = await reply.evaluate(styleOf);
      const composeStyle = await page.getByRole("link", { name: "写邮件" }).evaluate(styleOf);
      expect(replyStyle.bg, "背景应与「写邮件」同色").toBe(composeStyle.bg);
      expect(replyStyle.color, "前景应与「写邮件」同色").toBe(composeStyle.color);
      expect(replyStyle.height, "高度应与「写邮件」一致").toBe(composeStyle.height);
      // 安静动作仍然是透明边框（ghost）
      const borderColor = (el: Element) => getComputedStyle(el).borderTopColor;
      expect(await forward.evaluate(borderColor)).toMatch(/rgba\(0, 0, 0, 0\)/);
      expect(await del.evaluate(borderColor)).toMatch(/rgba\(0, 0, 0, 0\)/);
      // 分裂按钮：两半共边（右半的左边 = 左半的右边），整体贴在最右缘；菜单展开见下
      const [replyBox, caretBox, delBox, forwardBox] = await Promise.all([
        reply.boundingBox(),
        replyAll.boundingBox(),
        del.boundingBox(),
        forward.boundingBox(),
      ]);
      expect(replyBox!.x).toBeGreaterThan(delBox!.x);
      expect(replyBox!.x).toBeGreaterThan(forwardBox!.x);
      expect(caretBox!.x, "caret 必须紧贴「回复」右缘（共边，中间不留缝）").toBe(
        replyBox!.x + replyBox!.width,
      );

      // caret 菜单里就是「回复全部」，点了走 ?all=1（原收件人 me@ 是自己 → 剔除；Cc 同口径）
      await replyAll.click();
      const replyMenu = page.locator('[data-slot="dropdown-menu-content"]');
      await expect(replyMenu.getByRole("menuitem", { name: "回复全部" })).toBeVisible();
      await replyMenu.getByRole("menuitem", { name: "回复全部" }).click();
      await expect(page).toHaveURL(/\/mail\/compose\?replyTo=.+&all=1$/);
      await expect(page.locator("#mail-to")).toHaveValue("newsletter@example.com");
      // ⚠ 抄送行默认收起（2026-10-06 表单头重设计）：cc 为空时该行不渲染（不是隐藏）。
      //   展开后应仍为空（自己不进 Cc）——语义与旧断言一致，只是要先把行打开
      await expect(page.locator("#mail-cc")).toHaveCount(0);
      await page.getByRole("button", { name: "抄送", exact: true }).click();
      await expect(page.locator("#mail-cc")).toHaveValue("");

      // 收件人补全把「我的账号」排在最前（含 agent 信箱）
      await gotoReady(page, "/mail/compose");
      await page.locator("#mail-to").fill("me@");
      const suggestions = page.locator('[data-slot="recipient-suggestions"]');
      await expect(suggestions).toBeVisible();
      await expect(suggestions.getByRole("option").first()).toContainText("me@mail.example.cn");
      await expect(suggestions.getByRole("option").first()).toContainText("我的");

      // 转发：主题加 Fwd:、正文带引用头块、原附件随转发带走、不续引用链
      await gotoReady(page, "/mail/compose?forward=mid%3Aw03%40test.local");
      await expect(page.locator("#mail-subject")).toHaveValue("Fwd: HTML Newsletter");
      await expect(page.locator("#mail-body")).toHaveValue(/-------- 转发邮件 --------/);
      await expect(page.locator("#mail-body")).toHaveValue(/发件人: newsletter@example.com/);
      await expect(page.getByText("report.pdf")).toBeVisible();

      await page.locator("#mail-to").fill("someone@example.org");
      await page.getByRole("button", { name: "发送" }).click();
      await expect.poll(() => calls.send.length).toBe(1);
      const sent = calls.send[0] as {
        attachments: { filename: string }[];
        inReplyTo?: string;
        references?: string[];
      };
      expect(sent.attachments.map((a) => a.filename)).toEqual(["report.pdf"]);
      expect(sent.inReplyTo).toBeUndefined();
      expect(sent.references).toBeUndefined();
    });

    test("写邮件：草稿自动保存到服务器（刷新恢复），发送后清除", async ({ page }) => {
      const calls = { flags: [], send: [] as unknown[], delete: [], drafts: [] as unknown[] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail/compose");
      await page.locator("#mail-to").fill("draft@example.org");
      await page.locator("#mail-subject").fill("草稿主题");
      // 500ms 防抖后落盘（服务器端草稿，2026-10-06：首次保存 POST 创建，之后 PUT 整体替换）
      await expect.poll(() => calls.drafts.length).toBeGreaterThan(0);
      expect(calls.drafts[0]).toMatchObject({
        method: "POST",
        body: expect.objectContaining({ subject: "草稿主题", to: "draft@example.org" }),
      });
      // 草稿状态带相对时间（2026-10-06 用户定稿：「草稿自动保存于 X 秒/分钟前」，5s 一跳）——
      // 刚落盘必然落在「秒」档
      await expect(page.locator('[data-slot="mail-draft-status"]')).toHaveText(
        /草稿自动保存于 \d+ 秒前/,
      );

      // 刷新后从服务器恢复草稿（按归属键找最近更新的「新建」草稿）
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForHydration(page);
      await expect(page.locator("#mail-to")).toHaveValue("draft@example.org");
      await expect(page.locator("#mail-subject")).toHaveValue("草稿主题");

      // 发送时带上草稿 id（webmaild 发送成功后删除草稿）
      await page.locator("#mail-body").fill("草稿正文");
      await page.getByRole("button", { name: "发送" }).click();
      await expect(page).toHaveURL(/\/mail$/);
      await expect.poll(() => calls.send.length).toBe(1);
      expect((calls.send[0] as { draftId?: string }).draftId).toBe("draft-1");
    });

    test("草稿箱：tab 显示服务器草稿 → 点击进入编辑 → 行内删除", async ({ page }) => {
      const calls = { flags: [], send: [], delete: [], drafts: [] as unknown[] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      // 预置一封草稿（页面内 fetch 走桩；page.request 不受 page.route 拦截）
      await page.evaluate(() =>
        fetch("/api/mail/drafts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "new",
            accountId: "acc1",
            to: "a@b.example",
            subject: "草稿一",
            body: "半截正文",
          }),
        }),
      );

      await gotoReady(page, "/mail");
      await page.getByRole("tab", { name: "草稿", exact: true }).click();
      const rows = page.locator('[data-slot="mail-draft-list"] > li');
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText("a@b.example");
      await expect(rows.first()).toContainText("草稿一");

      // 点击进入编辑：草稿内容恢复到写信表单
      await rows.first().locator("[data-mail-row]").click();
      await expect(page).toHaveURL(/\/mail\/compose\?draft=draft-1/);
      await expect(page.locator("#mail-to")).toHaveValue("a@b.example");
      await expect(page.locator("#mail-subject")).toHaveValue("草稿一");
      await expect(page.locator("#mail-body")).toHaveValue("半截正文");

      // 返回邮箱 → 草稿箱 → 行内删除（ConfirmDialog 确认；不用原生 confirm）
      await page.getByRole("link", { name: "返回邮箱" }).click();
      await expect(page).toHaveURL(/\/mail$/);
      await page.getByRole("tab", { name: "草稿", exact: true }).click();
      await rows.first().hover();
      await page.getByRole("button", { name: "删除草稿" }).click();
      await page
        .locator('[data-slot="confirm-dialog"]')
        .getByRole("button", { name: "删除草稿" })
        .click();
      await expect(rows).toHaveCount(0);
      await expect(page.getByText("暂无草稿")).toBeVisible();
    });

    test("账号管理：编辑账号（备注名/发件人姓名/连接字段回填），保存发出 PUT", async ({ page }) => {
      const calls = { flags: [], send: [], delete: [], accounts: [] as unknown[] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      await page.getByRole("button", { name: "账号", exact: true }).click();
      // 第一行的编辑按钮（aria-label 带邮箱）
      await page.getByRole("button", { name: "编辑账号 me@mail.example.cn" }).click();

      // 表单回填：备注名 / 连接字段来自账号摘要；发件人姓名与密码为空
      await expect(page.locator("#acct-name")).toHaveValue("主账号");
      await expect(page.locator("#acct-sender-name")).toHaveValue("");
      await expect(page.locator("#acct-email")).toHaveValue("me@mail.example.cn");
      await expect(page.locator("#acct-imap-host")).toHaveValue("imap.example.cn");
      await expect(page.locator("#acct-username")).toHaveValue("me@mail.example.cn");
      await expect(page.locator("#acct-password")).toHaveValue("");

      // 账号颜色（2026-10-09）：色板反映账号当前色（acc1 = cyan），且**自己**的色不算撞色
      const swatch = (name: string) =>
        page.locator(`[data-slot="account-color-swatch"][data-color="${name}"]`);
      await expect(swatch("cyan")).toHaveAttribute("aria-pressed", "true");
      await expect(swatch("violet")).toHaveAttribute("aria-pressed", "false");
      await expect(page.locator('[data-slot="account-color-taken"]')).toHaveCount(0);
      // 选到另一个账号在用的色 → 提示（只提示不拦）
      await swatch("violet").click();
      await expect(swatch("violet")).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator('[data-slot="account-color-taken"]')).toBeVisible();

      // 改发件人姓名 → 保存（PUT；密码留空 = 不改，不下发）
      await page.locator("#acct-sender-name").fill("Shaoyuan Yu");
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await expect.poll(() => calls.accounts.length).toBe(1);
      const put = calls.accounts[0] as {
        method: string;
        id: string;
        body: Record<string, unknown>;
      };
      expect(put.method).toBe("PUT");
      expect(put.id).toBe("acc1");
      expect(put.body.senderName).toBe("Shaoyuan Yu");
      expect(put.body.displayName).toBe("主账号");
      expect(put.body.color, "颜色要随账号一起提交（旧实现根本不发这个字段）").toBe("violet");
      expect(put.body.password).toBeUndefined();
    });

    test("账号颜色：历史缺省色按色板渲染（不是原样内联），色板五色互不相同", async ({ page }) => {
      const calls = {
        flags: [] as unknown[],
        send: [] as unknown[],
        delete: [] as unknown[],
        accountStore: undefined as Record<string, unknown>[] | undefined,
      };
      await stubMailApi(page, calls);
      // 复现历史注册表：老版本 webmaild 给每个新账号填的是写死的 `#0ea5e9`
      calls.accountStore![0].color = "#0ea5e9";
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      await page.getByRole("button", { name: "账号", exact: true }).click();
      const dialog = page.locator('[data-slot="dialog-content"]');
      // 色板只在添加/编辑表单展开时在 → 点开「添加账号」
      await dialog.getByRole("button", { name: "添加账号" }).click();
      await expect(dialog.locator('[data-slot="account-color-swatch"]').first()).toBeVisible();

      const c = await colorProbe(page);
      // 五色互不相同：色板值的唯一来源是生成器，重复值意味着生成器坏了（用户最初报的就是"没有区别"）
      const swatchColors = Object.values(c.swatches);
      expect(swatchColors.length, "色板应有五格").toBe(5);
      expect(new Set(swatchColors).size, "色板五色必须互不相同").toBe(5);
      // 历史缺省色走别名渲染成色板 cyan，而不是把 `#0ea5e9` 原样内联（那会与同组色不是一套）
      expect(c.dialog["主账号"], "历史缺省色应渲染为色板 cyan").toBe(c.swatches.cyan);
      expect(c.dialog["主账号"], "不能是注册表里那个原样的 #0ea5e9").not.toBe("#0ea5e9");
      expect(c.bar["主账号"], "底栏同理（两处一致）").toBe(c.dialog["主账号"]);

      // 编辑表单里的选中态也按别名走：历史色要落在 cyan 那一格，否则看起来像"这个账号没有颜色"
      await dialog.getByRole("button", { name: "编辑账号 me@mail.example.cn" }).click();
      await expect(
        dialog.locator('[data-slot="account-color-swatch"][data-color="cyan"]'),
      ).toHaveAttribute("aria-pressed", "true");
      await dialog.getByRole("button", { name: "编辑账号 ysy@edu.example.cn" }).click();
      await expect(
        dialog.locator('[data-slot="account-color-swatch"][data-color="violet"]'),
      ).toHaveAttribute("aria-pressed", "true");
    });

    test("未读角标：大标题显示未读总数，收到新邮件弹提醒（toast + 动画）", async ({ page }) => {
      const calls = {
        flags: [],
        send: [],
        delete: [],
        accountStore: undefined as Record<string, unknown>[] | undefined,
        healthStore: undefined as { lastNewMail: string } | undefined,
      };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      // 角标 = 账号未读之和（acc1: 3 + acc2: 0）
      const badge = page.locator('[data-slot="mail-unread-count"]');
      await expect(badge).toHaveText("3");

      // 模拟「收到 2 封新邮件」：改桩的未读数 + 推进 /health 的 lastNewMail
      // （提醒器只认 lastNewMail 前进——未读总数上升本身不弹提醒，「标为未读」也会上升），
      // 然后触发 visibilitychange 立即重取
      calls.accountStore![0].unread = 5;
      calls.healthStore!.lastNewMail = new Date(Date.now() + 60_000).toISOString();
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      // 弹提醒（toast）+ 角标更新 + 弹跳动画
      // ⚠ toast 视口在 DOM 里有两个实例（严格模式冲突），断言标题节点
      await expect(page.locator('[data-slot="toast-title"]')).toContainText("收到 2 封新邮件");
      await expect(badge).toHaveText("5");
      await expect(badge).toHaveClass(/mail-unread-pop/);
    });

    test("列表：收件与发件都是我的账号时，方向角标显示双色双向箭头", async ({ page }) => {
      const calls = { flags: [], send: [], delete: [] };
      await stubMailApi(page, calls);
      // 覆盖 /messages（后注册的 route 优先）：一条「自己发给自己另一个账号」的邮件
      await page.route("**/api/mail/messages*", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            items: [
              mailItem({
                messageId: "mid:dual@test.local",
                subject: "自己发给自己",
                fromAddr: "me@mail.example.cn",
                fromName: "我",
                to: [{ name: "", address: "ysy@edu.example.cn" }],
                copies: [
                  { accountId: "acc1", folder: "Sent", uid: 2 },
                  { accountId: "acc2", folder: "INBOX", uid: 3 },
                ],
                accounts: ["acc1", "acc2"],
              }),
            ],
            next: null,
          }),
        }),
      );
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      const badge = page
        .locator('[data-slot="mail-list"] [data-slot="mail-direction-badge"]')
        .first();
      await expect(badge).toHaveAttribute("data-direction", "both");
      // 双色双向箭头：同一图标叠两份、按横向中线切 + 整体 -45° 斜过来——
      // 转后 = 绿 ↙ 收件（emerald）+ 橙 ↗ 发件（amber），与单箭头角标同斜向
      const svgs = badge.locator("svg");
      await expect(svgs).toHaveCount(2);
      await expect(svgs.nth(0)).toHaveClass(/text-emerald-600/);
      await expect(svgs.nth(1)).toHaveClass(/text-amber-600/);
    });

    test("写邮件左栏：联系人行归属色点 + 底栏颜色图例", async ({ page }) => {
      const calls = { flags: [], send: [], delete: [] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail/compose");
      // 自动收录区（虚线卡片）：每行名字后有归属账号色点（zhang → acc1）
      const knownRow = page.locator('[data-slot="contacts-pane-known"] li').first();
      await expect(knownRow).toContainText("张老师");
      await expect(knownRow.locator('[data-slot="contact-account-dots"] span')).toHaveCount(1);
      // 底栏颜色图例：账号名 + 本地联系人（解释色点含义）
      const legend = page.locator('[data-slot="mail-contacts-legend"]');
      await expect(legend).toContainText("主账号");
      await expect(legend).toContainText("本地联系人");
    });

    test("详情页：远程图片占位 + 「显示图片」逐封加载 + 打开即标已读", async ({ page }) => {
      const calls = { flags: [] as unknown[], send: [], delete: [] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      await page.locator('[data-slot="mail-list"] > li').nth(1).locator("[data-mail-row]").click();
      await expect(page).toHaveURL(/\/mail\/message\//);

      // 打开即标已读（对该消息所有副本）
      await expect.poll(() => calls.flags.length).toBe(1);
      expect(calls.flags[0]).toEqual({ messageId: "mid:w03@test.local", seen: true });

      // 远程内容提示条 + 占位图（白名单外的 tracker 被剥除、白名单内的 edu.cn 保留）
      await expect(page.getByText(/已拦截 1 张外部图片/)).toBeVisible();
      const body = page.locator(".mail-body");
      await expect(body.locator("img[data-remote-src]")).toHaveCount(1);
      await expect(body.locator('img[src="https://pics.edu.cn/logo.png"]')).toHaveCount(1);
      // cid 内联附件重写到附件端点
      await expect(
        body.locator('img[src^="/api/mail/message/"][src$="/attachment/0"]'),
      ).toHaveCount(1);

      // 「显示图片」：占位图换回原远程 URL，提示条消失
      await page.getByRole("button", { name: "显示图片" }).click();
      await expect(body.locator("img[data-remote-src]")).toHaveCount(0);
      await expect(body.locator('img[src="https://tracker.example.com/pixel.png"]')).toHaveCount(1);
      await expect(page.getByText(/已拦截 1 张外部图片/)).toHaveCount(0);
    });

    test("写邮件：表单提交发出正确请求体", async ({ page }) => {
      const calls = { flags: [], send: [] as unknown[], delete: [] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail/compose");
      // ⚠ 正文框高度：`rows={14}` 会被 Textarea 基础类的 `field-sizing-content` 覆盖
      //   （上游样式让高度随内容自适应，空内容时只剩 min-h-16 = 64px ≈ 2.5 行，用户反馈太小），
      //   必须靠 compose-form 里的 `min-h-[25vh]` 撑住（≈ 桌面视口下正文框下方空白的 55%~60%）。
      //   改 Textarea 或表单布局时别把它删掉。
      const bodyBox = await page.locator("#mail-body").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { h: r.height, vh: window.innerHeight };
      });
      expect(
        bodyBox.h,
        "正文框高度应约为视口 1/4（min-h-[25vh]），不能被 field-sizing-content 打回 64px",
      ).toBeGreaterThanOrEqual(bodyBox.vh * 0.22);
      await page.locator("#mail-to").fill("someone@example.org");
      await page.locator("#mail-subject").fill("测试主题");
      await page.locator("#mail-body").fill("正文内容");
      await page.getByRole("button", { name: "发送" }).click();

      await expect.poll(() => calls.send.length).toBe(1);
      const sent = calls.send[0] as {
        accountId: string;
        to: string[];
        subject: string;
        text: string;
      };
      expect(sent.accountId).toBe("acc1");
      expect(sent.to).toEqual(["someone@example.org"]);
      expect(sent.subject).toBe("测试主题");
      expect(sent.text).toBe("正文内容");
      await expect(page).toHaveURL(/\/mail$/);
    });

    test("删除：确认弹窗后对该消息的全部副本发出删除", async ({ page }) => {
      const calls = { flags: [] as unknown[], send: [], delete: [] as unknown[] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      // 打开多副本消息（第 4 条）
      await page.locator('[data-slot="mail-list"] > li').nth(3).locator("[data-mail-row]").click();
      await expect(page).toHaveURL(/\/mail\/message\//);
      await page.getByRole("button", { name: "删除" }).first().click();

      // 确认弹窗出现，确认后才真正删除
      const dialog = page.locator('[data-slot="confirm-dialog"]');
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "删除" }).click();

      await expect.poll(() => calls.delete.length).toBe(1);
      const body = calls.delete[0] as { copies: { accountId: string; folder: string; uid: number }[] };
      expect(body.copies.length).toBe(2);
      await expect(page).toHaveURL(/\/mail$/);
    });

    /**
     * 标为垃圾（2026-10-07 二次定稿、文案随后缩写）：文件夹视图删除后，详情页只留这一个
     * 整理动作——菜单式「移动」是盲选（搬过去再也看不见），而垃圾邮件有明确语义，且目标
     * 文件夹由服务端自己在该账号上探测（`to` 给的是特殊用途记号 `\Junk`，不是路径）。
     */
    test("标为垃圾：详情页只发一个 \\Junk 记号，服务端认文件夹", async ({ page }) => {
      const calls = { flags: [] as unknown[], send: [], delete: [] as unknown[], move: [] as unknown[] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      // 收件视图 4 行 = w04 / w03 / w02 / w01（按日期倒序），故 nth(3) = w01「面试通知」——
      // 它是**唯一在 acc1 / acc2 各有一份副本**的那封，正好验「所有副本一起交给后端」
      await page.locator('[data-slot="mail-list"] > li').nth(3).locator("[data-mail-row]").click();
      await expect(page).toHaveURL(/\/mail\/message\//);

      // 「移动」下拉已删（连同它的菜单项）；工具栏只有这一枚按钮
      await expect(page.getByRole("button", { name: "移动", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "标为垃圾", exact: true }).click();

      await expect.poll(() => calls.move.length).toBe(1);
      const body = calls.move[0] as { copies: { accountId: string; folder: string }[]; to: string };
      // 目标是**记号**而不是路径：前端不再需要知道各家的垃圾文件夹叫什么
      expect(body.to).toBe("\\Junk");
      // 一封邮件的**所有副本**原样交给后端（红线 8）——哪个账号没有垃圾文件夹，
      // 由服务端跳过并在 `skipped` 里回报 reason，不阻断另一个账号
      expect(body.copies.map((c) => c.accountId).sort()).toEqual(["acc1", "acc2"]);
      await expect(page).toHaveURL(/\/mail$/);
    });

    /**
     * 多选批量操作（2026-10-07）：此前只有「全部标为已读」一个批量动作，逐封操作在手机上
     * 尤其难（行内动作是 hover-only）。批量标记走 messageIds 口径，删除复用副本数组。
     * ⚠ 入口 = **行内悬浮气泡栏**里那枚「选择」（`aria-label="选择"`，2026-10-08 从工具栏
     *   行 1 搬过去的）；出口 = **批量条最右端**那枚 ✕「退出多选」（单实例），
     *   另有隐式出口：点列表空白处、按 Esc。
     * ⚠ 入口按钮**每行一枚**、且 hover 之前是 `display:none`（`group-hover/row:flex`）：
     *   必须 `hover()` 那一行、再在**该行内**取按钮。整页
     *   `getByRole("button", { name: "选择" })` 会命中多行（Playwright 严格模式直接报错），
     *   不 hover 就点则会因元素不可见而超时。
     * ⚠ 选中模式下**整条气泡栏不渲染**（2026-10-08 用户报障后定稿）——所以入口按钮在
     *   选中期间不可见，出口只认批量条那枚（行内挂「退出」会随行重复：桌面端焦点+悬停
     *   同时冒两枚、触屏端每行一枚）。
     */
    test("多选批量：状态化可用性 / 批量已读 / 全选 ⇄ 取消 / 批量删除（确认）/ 退出（批量条 ✕ 与点空白处）", async ({ page }) => {
      const calls = {
        flags: [] as unknown[],
        send: [],
        delete: [] as unknown[],
      };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      const rows = page.locator('[data-slot="mail-list"] > li');
      /** 进入选择模式：悬停该行 → 气泡栏现身 → 点里面的「选择」 */
      const enterSelectMode = async (li: Locator) => {
        await li.locator("[data-mail-row]").hover();
        await expect(li.locator('[data-slot="mail-row-actions"]')).toBeVisible();
        await li.getByRole("button", { name: "选择", exact: true }).click();
      };
      // 未进入选择模式：没有复选框、批量条不出现、气泡栏里是「选择」
      await expect(page.locator('[data-slot="mail-row-checkbox"]')).toHaveCount(0);
      await expect(page.locator('[data-slot="mail-batch-bar"]')).toHaveCount(0);
      await rows.first().locator("[data-mail-row]").hover();
      await expect(
        rows.first().getByRole("button", { name: "选择", exact: true }),
      ).toBeVisible();
      await expect(page.locator('[data-slot="mail-row-actions"]')).toHaveCount(4);

      await enterSelectMode(rows.first());
      const bar = page.locator('[data-slot="mail-batch-bar"]');
      await expect(bar).toBeVisible();
      await expect(bar).toContainText("已选 0 封");
      await expect(page.locator('[data-slot="mail-row-checkbox"]')).toHaveCount(4);
      // 选中模式下行内气泡栏**整体不渲染**（用户 2026-10-08 报障：行内挂「退出」会重复）
      await rows.nth(1).locator("[data-mail-row]").hover();
      await expect(page.locator('[data-slot="mail-row-actions"]')).toHaveCount(0);
      // 批量条里没有「移动」（用户指定删除）；出口是它最右端那枚 ✕，且只有一枚
      await expect(bar.getByRole("button", { name: "移动", exact: true })).toHaveCount(0);
      await expect(bar.getByRole("button", { name: "退出多选" })).toHaveCount(1);

      // 按主题取两行（不依赖数组顺序）：w04 未读、w03 已读
      const unreadRow = rows.filter({ hasText: "Report with attachment" }).locator("[data-mail-row]");
      const readRow = rows.filter({ hasText: "HTML Newsletter" }).locator("[data-mail-row]");

      // 点两行 = 勾选两行（不跳转），计数与 aria-pressed 同步
      await unreadRow.click();
      await readRow.click();
      await expect(page).toHaveURL(/\/mail$/);
      await expect(bar).toContainText("已选 2 封");
      await expect(unreadRow).toHaveAttribute("aria-pressed", "true");
      await expect(rows.nth(2).locator("[data-mail-row]")).toHaveAttribute("aria-pressed", "false");

      // 动作可用性跟着选中项的状态走（2026-10-07 用户指定）：全都已读 → 「标为已读」禁用，
      // 全都未读 → 「标为未读」禁用，混合选中 → 两个都可用
      const markRead = bar.getByRole("button", { name: "标为已读" });
      const markUnread = bar.getByRole("button", { name: "标为未读" });
      await expect(markRead).toBeEnabled(); // 此刻 = 未读 + 已读，混合
      await expect(markUnread).toBeEnabled();
      await unreadRow.click(); // 取消未读那封 → 只剩已读
      await expect(bar).toContainText("已选 1 封");
      await expect(markRead).toBeDisabled();
      await expect(markUnread).toBeEnabled();
      await unreadRow.click(); // 换回来
      await readRow.click(); // 取消已读那封 → 只剩未读
      await expect(markRead).toBeEnabled();
      await expect(markUnread).toBeDisabled();
      await readRow.click(); // 再选回已读那封 → 混合
      await expect(markRead).toBeEnabled();
      await expect(markUnread).toBeEnabled();

      // 批量标为已读：一次请求带两个 messageId（不是逐封两次）
      await markRead.click();
      await expect.poll(() => calls.flags.length).toBe(1);
      const flagsBody = calls.flags[0] as { messageIds: string[]; seen?: boolean };
      expect(flagsBody.messageIds.length).toBe(2);
      expect(flagsBody.seen).toBe(true);
      // 处理完清空选择
      await expect(bar).toContainText("已选 0 封");

      // 全选 → 计数 = 当前列表 4 封；再点一次 = 取消全选（同一个按钮，可访问名随状态变）
      await bar.getByRole("button", { name: "全选（当前列表）" }).click();
      await expect(bar).toContainText("已选 4 封");
      await bar.getByRole("button", { name: "取消全选" }).click();
      await expect(bar).toContainText("已选 0 封");
      await bar.getByRole("button", { name: "全选（当前列表）" }).click();
      await expect(bar).toContainText("已选 4 封");

      // 批量删除：确认弹窗 → 对该批全部副本发一次 delete
      await bar.getByRole("button", { name: "删除", exact: true }).click();
      const confirm = page.locator('[data-slot="confirm-dialog"]');
      await expect(confirm).toContainText("删除选中的 4 封邮件？");
      // 确认按钮文案 = 传入的 confirmLabel（「删除」，不是默认的「确定」）
      await confirm.getByRole("button", { name: "删除" }).click();
      await expect.poll(() => calls.delete.length).toBe(1);
      const delBody = calls.delete[0] as { copies: unknown[] };
      expect(delBody.copies.length).toBeGreaterThanOrEqual(4);

      // 出口一：批量条最右端那枚 ✕「退出多选」（唯一一枚，单实例）
      await bar.getByRole("button", { name: "退出多选" }).click();
      await expect(page.locator('[data-slot="mail-batch-bar"]')).toHaveCount(0);
      await expect(page.locator('[data-slot="mail-row-checkbox"]')).toHaveCount(0);
      // 退出后行内气泡栏回来了（4 行 = 4 条）
      await expect(page.locator('[data-slot="mail-row-actions"]')).toHaveCount(4);

      // 隐式出口：点左栏的空白处
      // ⚠ **不能假设「最后一行下方有空白」**（原断言实测就红：4 行数据 + 批量条占位时列表
      //   正好填满滚区，最后一行的底边比滚区底边还低 134px）。取「工具栏块与批量条之间的
      //   行间隙」——它永远在，且命中的是挂着 onClick 的列表栏根元素（`mail-list-column`；
      //   面板自己的 padding 在那个根**之外**，点它不触发，见 onListBlankClick 注释）
      await enterSelectMode(rows.first());
      await expect(bar).toBeVisible();
      const barBox = (await bar.boundingBox())!;
      const blank = { x: barBox.x + 40, y: barBox.y - 8 };
      const hit = await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return { tag: el?.tagName ?? "(无)", slot: el?.getAttribute("data-slot") ?? "" };
      }, blank);
      expect(hit.slot, `空白点应命中列表栏根元素，实际命中 ${hit.tag}[${hit.slot}]`).toBe("mail-list-column");
      await page.mouse.click(blank.x, blank.y);
      await expect(page.locator('[data-slot="mail-batch-bar"]')).toHaveCount(0);
      await expect(page.locator('[data-slot="mail-row-checkbox"]')).toHaveCount(0);
    });

    /**
     * 详情页操作栏（2026-10-07 用户验收反馈，两轮定稿）：
     * ① 低频的「原始邮件 / 打印」收进「更多」菜单，而**「更多」固定在这一行最左端**
     *    （用户明确否掉「放主题行那种别的行」；放最左还有个好处：宽屏下这一端本来是空的，
     *    不吃右组那 ~620px 的宽度预算）；
     * ② 「回复全部」并进「回复」右侧的下拉（分裂按钮，见回复用例）；
     * ③ 整行必须一行放下——加按钮前先量宽度。
     */
    test("详情页操作栏：1280 宽下一行放下；「更多」在最左、低频动作在菜单里", async ({ page }) => {
      const calls = { flags: [] as unknown[], send: [], delete: [] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await page.setViewportSize({ width: 1280, height: 900 });
      await gotoReady(page, "/mail");
      await page.locator('[data-slot="mail-list"] > li').nth(0).locator("[data-mail-row]").click();
      await expect(page).toHaveURL(/\/mail\/message\//);

      const bar = page.locator('[data-slot="message-actions"]');
      // 判据是「可见动作的垂直位置只有一组」（同排 = 一行），不锁具体坐标：
      // 换字号 / 换行高都不会误报，多摆一个按钮立刻红
      const tops = await bar.locator("a, button").evaluateAll((els) =>
        els.filter((el) => el.checkVisibility()).map((el) => Math.round(el.getBoundingClientRect().top)),
      );
      expect(tops.length, "操作栏应有动作").toBeGreaterThan(3);
      expect(new Set(tops).size, "操作栏应只有一行").toBe(1);

      // 两个低频动作不在操作栏里（它们是菜单项，不是按钮）
      await expect(bar.getByRole("button", { name: "打印" })).toHaveCount(0);
      await expect(bar.getByRole("button", { name: "原始邮件" })).toHaveCount(0);
      await expect(bar.getByRole("button", { name: "标为垃圾", exact: true })).toBeVisible();
      await expect(bar.getByRole("button", { name: "移动", exact: true })).toHaveCount(0);

      // 「更多」在操作栏里，且是这一行**最左**的可见动作（用户 2026-10-07 指定）
      const more = bar.getByRole("button", { name: "更多" });
      await expect(more).toHaveCount(1);
      const xs = await bar.locator("a, button").evaluateAll((els) =>
        els.filter((el) => el.checkVisibility()).map((el) => Math.round(el.getBoundingClientRect().x)),
      );
      const moreBox = (await more.boundingBox())!;
      expect(Math.round(moreBox.x), "「更多」应是最左端那个动作").toBe(Math.min(...xs));

      // 收在「更多」菜单里
      await more.click();
      const menu = page.locator('[data-slot="dropdown-menu-content"]');
      await expect(menu.getByRole("menuitem", { name: "原始邮件" })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "打印" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);

      // 空间不够时**只留图标**（2026-10-07 用户指定，容器查询 @min-[36rem]）：
      // 1024 视口下详情栏只有 ~494px，标签整条隐藏、按钮缩到 36px，但名字仍在 aria-label
      // 里（display:none 的文本不进可访问名），且整行必须仍是一行
      const seen = bar.getByRole("button", { name: "标为未读" });
      await expect(seen.locator("span")).toBeVisible(); // 宽窗：文字在
      await page.setViewportSize({ width: 1024, height: 900 });
      await expect(seen.locator("span")).toBeHidden(); // 窄窗：只剩图标
      await expect(seen, "图标态下按钮仍有可访问名").toBeVisible();
      const narrowTops = await bar.locator("a, button").evaluateAll((els) =>
        els.filter((el) => el.checkVisibility()).map((el) => Math.round(el.getBoundingClientRect().top)),
      );
      expect(new Set(narrowTops).size, "图标态也必须一行放下").toBe(1);
      await page.setViewportSize({ width: 1280, height: 900 });
    });

    test("打印：详情页有打印入口；打印规则只保留邮件本体", async ({ page }) => {
      const calls = { flags: [] as unknown[], send: [], delete: [] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      await page.locator('[data-slot="mail-list"] > li').nth(0).locator("[data-mail-row]").click();
      await expect(page).toHaveURL(/\/mail\/message\//);

      // 入口在「更多」菜单里（点击会调 window.print()——桩掉它，别真弹打印对话框）。
      // 桩里顺手记录 print() 那一刻的 DOM 状态：那就是浏览器拿去打印的快照
      // （`html.dark` 必须已被摘掉、标题必须是邮件主题，否则深色主题会印成白纸白字、
      //   存 PDF 的文件名会是「邮件」）。
      await page.evaluate(() => {
        (window as unknown as { __printed?: number }).__printed = 0;
        window.print = () => {
          const w = window as unknown as { __printed?: number; __snap?: unknown };
          w.__printed! += 1;
          const band = document.querySelector<HTMLElement>(".mail-body div[style]");
          w.__snap = {
            dark: document.documentElement.classList.contains("dark"),
            title: document.title,
            // 邮件自己画的深色块：不打印背景时白字会消失在白纸上，打印前必须就地改成浅底黑字
            band: band
              ? {
                  bg: getComputedStyle(band).backgroundColor,
                  fg: getComputedStyle(band).color,
                }
              : null,
          };
        };
      });
      await page.getByRole("button", { name: "更多" }).click();
      await page.getByRole("menuitem", { name: "打印" }).click();
      expect(await page.evaluate(() => (window as unknown as { __printed?: number }).__printed)).toBe(1);
      const snap = await page.evaluate(
        () =>
          (
            window as unknown as {
              __snap?: { dark: boolean; title: string; band: { bg: string; fg: string } | null };
            }
          ).__snap,
      );
      expect(snap?.dark, "打印快照不能带 dark 标记类（否则深色下印出白纸白字）").toBe(false);
      const subject = (await page.locator("h2").first().innerText()).trim();
      expect(snap?.title, "打印标题应换成邮件主题（打印页眉 / 存 PDF 的文件名）").toBe(subject);
      // 深色块就地改浅底黑字：判据用亮度（同样是 lab()/oklch() 解析问题，借 canvas 拿 sRGB）
      const bandLum = await page.evaluate((band) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d")!;
        const lumOf = (color: string) => {
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
          return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        };
        return { bg: lumOf(band!.bg), fg: lumOf(band!.fg) };
      }, snap?.band);
      expect(bandLum.bg, "深色底要改成浅色（否则关掉背景图形就是白纸白字）").toBeGreaterThan(0.8);
      expect(bandLum.fg, "浅底上的文字必须是深色").toBeLessThan(0.3);

      // 打印媒体的实际效果：工具栏 / 左栏列表 / 底栏 / 站点顶栏 / 「更多」按钮都不参与打印。
      // ⚠ 先把「更多」菜单在**屏幕媒体**下打开：菜单项是打印入口，而打印快照就发生在这个
      //   瞬间（菜单还没开始收起）——2026-10-08 用户正是这样在纸上印出了一份下拉菜单
      await page.getByRole("button", { name: "更多" }).click();
      await expect(page.locator('[data-slot="dropdown-menu-content"]')).toBeVisible();
      await page.emulateMedia({ media: "print" });
      await expect(page.locator('[data-slot="dropdown-menu-content"]')).toBeHidden();
      await expect(page.locator('[data-slot="message-actions"]')).toBeHidden();
      await expect(page.locator('[data-slot="mail-pane-list"]')).toBeHidden();
      await expect(page.locator('[data-slot="mail-statusbar"]')).toBeHidden();
      await expect(page.locator(".site-header")).toBeHidden();
      await expect(page.getByRole("button", { name: "更多" })).toBeHidden();
      // 正文仍然可见（打印的就是它）
      await expect(page.locator(".mail-body")).toBeVisible();
      // 被拦截的远程图片：纸上不留虚线空框；改成**打印用的**说明文案 + 去掉「显示图片」入口
      // （2026-10-08 用户报「打印渲染还有很多问题」后定的：读者要知道"这里少了几张图"）
      await expect(page.locator(".mail-body img[data-remote-src]")).toBeHidden();
      // 头像（含方向角标）是屏幕上的识别辅助，纸上没有交互与色彩语境（2026-10-08 排版轮）
      await expect(page.locator('[data-slot="mail-avatar"]')).toBeHidden();
      // 提示条在纸上压平成一行小字：虚线框印出来像一只"没填的输入框"
      const noticeBox = await page
        .locator('[data-slot="mail-remote-notice"]')
        .evaluate((el) => {
          const cs = getComputedStyle(el);
          return { border: parseFloat(cs.borderTopWidth), padding: parseFloat(cs.paddingLeft) };
        });
      expect(noticeBox.border, "拦截提示在纸上不要描边").toBe(0);
      expect(noticeBox.padding, "拦截提示在纸上不要内边距").toBe(0);
      await expect(page.getByRole("button", { name: "显示图片" })).toBeHidden();
      await expect(page.getByText(/已拦截 \d+ 张外部图片/)).toBeHidden();
      await expect(page.getByText(/\d+ 张外部图片未随打印件输出/)).toBeVisible();
      await page.emulateMedia({ media: "screen" });
      await page.keyboard.press("Escape");
      // 回到屏幕上：提示条恢复成"防追踪"那句 + 「显示图片」按钮可用
      await expect(page.getByRole("button", { name: "显示图片" })).toBeVisible();
      await expect(page.getByText(/已拦截 \d+ 张外部图片/)).toBeVisible();
      // 附件在纸上是「内容」不是「按钮」（描边 / 图标去掉，只留文件名 + 大小）
      await page.emulateMedia({ media: "print" });
      const attach = page.locator('[data-slot="mail-pane-detail"] a[data-slot="button"]').first();
      if (await attach.count()) {
        const box = await attach.evaluate((el) => {
          const cs = getComputedStyle(el);
          return {
            border: parseFloat(cs.borderTopWidth),
            padding: parseFloat(cs.paddingLeft),
            icon: el.querySelector("svg") ? getComputedStyle(el.querySelector("svg")!).display : "none",
          };
        });
        expect(box.border, "附件在纸上不要描边").toBe(0);
        expect(box.icon, "附件在纸上不要下载图标").toBe("none");
      }
      await page.emulateMedia({ media: "screen" });
    });

    /**
     * 邮件正文的结构（2026-10-08 打印打磨）：Tailwind preflight 是给应用 UI 写的，
     * 会把 `ol/ul` 的列表符号、标题字号、段落间距、`<table border>` 的框线全部清零——
     * 邮件靠这些元素表达结构，不还原的话打印出来就是"一整块文字"。
     */
    test("正文：HTML 邮件的段落 / 标题 / 列表 / 表格边框要还原", async ({ page }) => {
      const calls = { flags: [] as unknown[], send: [], delete: [] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      await page.locator('[data-slot="mail-list"] > li').nth(0).locator("[data-mail-row]").click();
      await expect(page).toHaveURL(/\/mail\/message\//);
      const shape = await page.evaluate(() => {
        const body = document.querySelector(".mail-body")!;
        const li = body.querySelector("li")!;
        const p = body.querySelector("p")!;
        const h2 = body.querySelector("h2")!;
        const td = body.querySelector("td")!;
        return {
          listStyle: getComputedStyle(li.parentElement!).listStyleType,
          listIndent: parseFloat(getComputedStyle(li.parentElement!).paddingInlineStart),
          // ⚠ 取 margin-block-**end**：首个子元素的 margin-block-start 被有意归零
          //   （容器自己有内边距，再叠一段外边距会显得上下不对称）
          pMargin: parseFloat(getComputedStyle(p).marginBlockEnd),
          h2Size: parseFloat(getComputedStyle(h2).fontSize),
          h2Weight: getComputedStyle(h2).fontWeight,
          pSize: parseFloat(getComputedStyle(p).fontSize),
          // `<table border="1">` 是「presentational hint」，权重低于任何作者样式：
          // preflight 的 `* { border: 0 solid }` 会把框线整片清掉
          tdBorder: parseFloat(getComputedStyle(td).borderTopWidth),
        };
      });
      expect(shape.listStyle, "列表符号不能被 preflight 清成 none").not.toBe("none");
      expect(shape.listIndent, "列表要有缩进").toBeGreaterThan(0);
      expect(shape.pMargin, "段落之间要有间距").toBeGreaterThan(0);
      expect(shape.h2Size, "邮件里的标题要比正文大").toBeGreaterThan(shape.pSize);
      expect(Number(shape.h2Weight), "标题要加粗").toBeGreaterThanOrEqual(600);
      expect(shape.tdBorder, "border=1 的数据表要有框线").toBeGreaterThan(0);
    });

    /**
     * 深色主题下打印（2026-10-08 用户报「打印渲染还有很多问题」）：
     * 浏览器默认不打印背景 → 深色下就是**白纸白字**；勾上「背景图形」则是一整页黑底。
     * 契约：打印一律走浅色（正文近黑、纸面近白）。判据用亮度阈值而非具体色值。
     */
    test("打印：深色主题下导出仍是浅色（不印黑底 / 白字）", async ({ page }) => {
      const calls = { flags: [] as unknown[], send: [], delete: [] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      await page.locator('[data-slot="mail-list"] > li').nth(0).locator("[data-mail-row]").click();
      await expect(page).toHaveURL(/\/mail\/message\//);
      // 深色主题（next-themes 把 dark 挂在 html 上）+ 打印媒体
      await page.evaluate(() => document.documentElement.classList.add("dark"));
      await page.emulateMedia({ media: "print" });
      const lum = await page.evaluate(() => {
        // ⚠ 不能直接解析 computed color：Chrome 现在给的是 `lab(100 0 0)` / `oklch(...)`，
        //   而 canvas 会把任何 CSS 颜色解析成 sRGB 像素——借它拿到真实亮度
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d")!;
        const lumOf = (color: string) => {
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
          return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        };
        const body = getComputedStyle(document.body);
        const text = getComputedStyle(
          document.querySelector(".mail-body")?.firstElementChild ?? document.body,
        );
        return { bg: lumOf(body.backgroundColor), fg: lumOf(text.color), fgBody: lumOf(body.color) };
      });
      expect(lum.bg, "打印时页面底色必须是浅色").toBeGreaterThan(0.85);
      expect(Math.min(lum.fg, lum.fgBody), "打印时文字必须是深色").toBeLessThan(0.25);
      await page.emulateMedia({ media: "screen" });
      await page.evaluate(() => document.documentElement.classList.remove("dark"));
    });

    test("详情加载失败：友好文案（不回显 webmaild_unreachable 这类内部错误码）", async ({ page }) => {
      const calls = {
        flags: [] as unknown[],
        send: [],
        delete: [] as unknown[],
        detailError: 502,
      };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      await page.locator('[data-slot="mail-list"] > li').nth(0).locator("[data-mail-row]").click();
      const detail = page.locator('[data-slot="mail-pane-detail"]');
      await expect(detail).toContainText("邮件服务暂时不可用");
      await expect(detail).not.toContainText("webmaild_unreachable");
    });

    /**
     * 取证能力（2026-10-07）：普通账号此前既看不到原始邮件头，也下载不到 .eml——
     * 只有 agent 只读页有。超大邮件（truncated）更是点开一片空白且无任何提示。
     */
    test("原始邮件：头部按原文展示 + .eml 下载；超大邮件给出补取入口", async ({ page }) => {
      const calls = {
        flags: [] as unknown[],
        send: [],
        delete: [] as unknown[],
        source: [] as unknown[],
        // w02（列表第 3 行「Weekly Digest」）按「只入库索引」返回：走界面自己的导航
        truncatedIds: ["mid:w02@test.local"] as string[],
      };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      // 普通邮件：原始邮件对话框（头部顺序与原文一致）+ .eml 下载链接
      await gotoReady(page, "/mail");
      await page.locator('[data-slot="mail-list"] > li').nth(0).locator("[data-mail-row]").click();
      await expect(page).toHaveURL(/\/mail\/message\//);
      // 入口在主题行右侧的「更多」菜单里（操作栏只放对信的动作）
      await page.getByRole("button", { name: "更多" }).click();
      await page.getByRole("menuitem", { name: "原始邮件" }).click();
      const rawDialog = page.locator('[data-slot="dialog-content"]');
      const headers = rawDialog.locator('[data-slot="mail-raw-headers"]');
      await expect(headers).toContainText("From: newsletter@example.com");
      await expect(headers).toContainText("Message-ID: <w03@test.local>");
      // 顺序 = 原文顺序（From 在 Subject 之前）
      const text = (await headers.textContent()) ?? "";
      expect(text.indexOf("From:")).toBeLessThan(text.indexOf("Subject:"));
      const eml = rawDialog.getByRole("link", { name: "下载 .eml 原件" });
      await expect(eml).toHaveAttribute("href", /\/api\/mail\/message\/.+\/source$/);
      // 没有「补取原文」提示（这封有原文）
      await expect(rawDialog.getByText(/只入库了索引/)).toHaveCount(0);
      await page.keyboard.press("Escape");

      // 超大邮件：正文区给出说明 + 「取回原文」按钮，点了才发 POST /source
      await page.locator('[data-slot="mail-list"] > li').nth(2).locator("[data-mail-row]").click();
      const notice = page.locator('[data-slot="mail-truncated-notice"]');
      await expect(notice).toBeVisible();
      await expect(notice).toContainText("正文与附件还没下载");
      // 文案不再写死阈值（2026-10-08 起缺省 1MB，可由 MAIL_AGENT_MAX_SOURCE_BYTES 调）
      await expect(notice).toContainText("正文与附件等点开再取");
      await notice.getByRole("button", { name: "取回原文" }).click();
      await expect.poll(() => calls.source?.length ?? 0).toBe(1);
      expect(String(calls.source?.[0])).toContain("/message/");
      await expect(page.getByText("已取回原文")).toBeVisible();
    });

    /**
     * 精简原文（附件门控，2026-10-08）：**正文照常可读**，只有附件没随同步下载；
     * 附件列表照常列出（标「未下载，点击取回」），点它由服务端按需取那一个部件。
     *
     * 与「超大邮件只存索引」的区别就在这里：那种情况正文也是空的（上一块提示管那个）。
     */
    test("精简原文：正文可读、附件标成按需取回（不是空邮件）", async ({ page }) => {
      const calls = { flags: [], send: [], delete: [], partialIds: ["mid:w02@test.local"] as string[] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);
      await gotoReady(page, "/mail");

      await page.locator('[data-slot="mail-list"] > li').nth(2).locator("[data-mail-row]").click();
      // 正文可读（这正是这个功能的要点）
      await expect(page.getByText("本周要闻：正文照常可读。")).toBeVisible();
      // 不是那块「正文与附件都没下载」的空态告警，而是一句轻提示
      await expect(page.locator('[data-slot="mail-truncated-notice"]')).toHaveCount(0);
      await expect(page.locator('[data-slot="mail-partial-notice"]')).toContainText("附件没有随同步下载");

      // 附件照常列出；未下载的那个带标记与悬浮说明
      const items = page.locator('[data-slot="mail-pane-detail"] a[download]');
      await expect(items).toHaveCount(1);
      await expect(items.first()).toContainText("report.pdf");
      await expect(items.first().locator('[data-slot="attachment-deferred"]')).toHaveText(
        "未下载，点击取回",
      );
      await expect(items.first()).toHaveAttribute("title", "未下载，点击取回");
      await expect(items.first()).toHaveAttribute(
        "href",
        /\/api\/mail\/message\/.+\/attachment\/1$/,
      );
    });

    test("通讯录：空态 → 新增 → 编辑 → 自动收录一键存入 → 删除", async ({ page }) => {
      const calls = { flags: [], send: [], delete: [], contacts: [] as unknown[] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail/contacts");
      // 页头（4.13）：左上角「返回邮件」（曾放右上角且叫「返回收件箱」，与 /mail 的 h1「邮件」对不上——用户 2026-10 反馈）
      const back = page.getByRole("link", { name: "返回邮件" });
      await expect(back).toBeVisible();
      const mainBox = (await page.locator("main").boundingBox())!;
      const backBox = (await back.boundingBox())!;
      const h1Box = (await page.getByRole("heading", { name: "通讯录", level: 1 }).boundingBox())!;
      expect(backBox.x, "返回入口必须在左半边，不能在右上角").toBeLessThan(mainBox.x + mainBox.width / 2);
      expect(backBox.y, "返回入口在标题上方").toBeLessThan(h1Box.y);

      // 空态有可见文案（stub 预置的「自己地址」联系人被过滤 → 可见联系人 = 0）；自动收录区有两条
      await expect(page.getByText("还没有联系人")).toBeVisible();
      await expect(page.locator('[data-slot="contact-list"]')).toHaveCount(0);

      // 我的账号（4.10）：webmail 账号（2 个）+ agent 信箱（1 个），且只读（没有编辑/删除）
      const ownRows = page.locator('[data-slot="own-address-list"] > li');
      await expect(ownRows).toHaveCount(3);
      await expect(ownRows.nth(0)).toContainText("me@mail.example.cn");
      await expect(ownRows.nth(2)).toContainText("agent@mail.example.cn");
      await expect(ownRows.nth(2)).toContainText("agent 信箱");
      await expect(page.locator('[data-slot="own-address-list"]').getByRole("button")).toHaveCount(0);
      // 「账号重复」锁定：agent@mail.example.cn 只在「我的账号」出现一次，联系人区没有第二份
      await expect(page.getByText("agent@mail.example.cn")).toHaveCount(1);
      const known = page.locator('[data-slot="known-sender-list"] > li');
      await expect(known).toHaveCount(2);

      // 拦截：把自己的地址存进通讯录会被拒绝（不发请求）
      await page.getByRole("button", { name: "新增联系人" }).click();
      const blockDialog = page.locator('[data-slot="dialog-content"]');
      await blockDialog.getByLabel("姓名").fill("自己");
      await blockDialog.getByLabel("邮箱").fill("agent@mail.example.cn");
      await blockDialog.getByRole("button", { name: "保存" }).click();
      await expect(page.getByText("已在「我的账号」中")).toBeVisible();
      expect(calls.contacts).toHaveLength(0);
      await page.keyboard.press("Escape");

      // 新增
      await page.getByRole("button", { name: "新增联系人" }).click();
      const dialog = page.locator('[data-slot="dialog-content"]');
      await dialog.getByLabel("姓名").fill("张老师");
      await dialog.getByLabel("邮箱").fill("zhang@example.com");
      await dialog.getByLabel("备注").fill("校友");
      await dialog.getByRole("button", { name: "保存" }).click();
      await expect.poll(() => calls.contacts.length).toBe(1);
      expect(calls.contacts[0]).toEqual({
        method: "POST",
        body: { name: "张老师", email: "zhang@example.com", note: "校友" },
      });
      const rows = page.locator('[data-slot="contact-list"] > li');
      await expect(rows).toHaveCount(1);
      await expect(rows.nth(0)).toContainText("张老师");
      await expect(rows.nth(0)).toContainText("zhang@example.com");
      await expect(rows.nth(0)).toContainText("校友");
      // 保存后自动收录区的同地址消失
      await expect(known).toHaveCount(1);

      // 编辑：改名
      await rows.nth(0).hover();
      await rows.nth(0).getByRole("button", { name: "编辑" }).click();
      await dialog.getByLabel("姓名").fill("张老師（改名）");
      await dialog.getByRole("button", { name: "保存" }).click();
      await expect.poll(() => calls.contacts.length).toBe(2);
      expect(calls.contacts[1]).toMatchObject({ method: "PATCH", id: "c1" });
      await expect(rows.nth(0)).toContainText("张老師（改名）");

      // 自动收录一键存入：bob@example.com 存入后收录区清空
      await known.nth(0).getByRole("button", { name: "存入通讯录" }).click();
      await expect.poll(() => calls.contacts.length).toBe(3);
      expect(calls.contacts[2]).toMatchObject({ method: "POST", body: { email: "bob@example.com" } });
      await expect(page.locator('[data-slot="known-sender-list"]')).toHaveCount(0);
      await expect(rows).toHaveCount(2);

      // 删除：确认弹窗 → 确认后才删
      await rows.nth(0).hover();
      await rows.nth(0).getByRole("button", { name: "删除" }).click();
      const confirm = page.locator('[data-slot="confirm-dialog"]');
      await expect(confirm).toBeVisible();
      await confirm.getByRole("button", { name: "删除" }).click();
      await expect.poll(() => calls.contacts.length).toBe(4);
      expect(calls.contacts[3]).toMatchObject({ method: "DELETE", id: "c1" });
      await expect(rows).toHaveCount(1);
    });

    /**
     * 读「同一个账号在两处显示的色点颜色」：底栏账号一览 vs 账号管理弹窗列表。
     *
     * ⚠ 断言方式是**两处互相比对**，不是比对具体色值（`rgb(30,175,213)` 这类）——色板值由
     *   `scripts/gen-account-colors.mjs` 算出、会随「柔和度」调整，锁死值只会换来假红。
     *   「同一个账号在两处必须是同一个色」才是契约（2026-10-09 用户报「账号管理页显示的账号颜色
     *   和底栏指示器有色差」：弹窗当年把色板名当 CSS 颜色内联，`pink` 被画成 #FFC0CB）。
     */
    const colorProbe = (page: Page) =>
      page.evaluate(() => {
        // ⚠ 计算样式可能是 lab()/oklch()，canvas 的 fillStyle **不会**归一成 rgb（只原样回显）→
        //   必须真画一个像素再 getImageData 读回
        const hex = (css: string) => {
          const ctx = document.createElement("canvas").getContext("2d")!;
          ctx.fillStyle = "#000000";
          ctx.fillStyle = css;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
          return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
        };
        // 条目里的 aria-hidden 有两个（色点 + 「·」分隔符）——取无文本的那个
        const dotOf = (row: Element) =>
          [...row.querySelectorAll("[aria-hidden]")].find((d) => !d.textContent) ?? null;
        const bar: Record<string, string> = {};
        document.querySelectorAll('[data-slot="mail-statusbar-accounts"] > span').forEach((el) => {
          const name = (el.textContent ?? "").replace(/^·/, "").trim();
          const dot = dotOf(el);
          if (name && dot) bar[name] = hex(getComputedStyle(dot).backgroundColor);
        });
        const dialog: Record<string, string> = {};
        document.querySelectorAll('[data-slot="account-list"] > li').forEach((li) => {
          const name = li.querySelector("p")?.textContent?.trim() ?? "";
          const dot = li.querySelector('span[aria-hidden]');
          if (name && dot) dialog[name] = hex(getComputedStyle(dot).backgroundColor);
        });
        const swatches: Record<string, string> = {};
        document.querySelectorAll('[data-slot="account-color-swatch"]').forEach((el) => {
          const name = el.getAttribute("data-color");
          if (name) swatches[name] = hex(getComputedStyle(el).backgroundColor);
        });
        return { bar, dialog, swatches };
      });

    test("账号管理：列出账号 → 新增（连接测试后落盘）→ 删除（确认弹窗）", async ({ page }) => {
      const calls = { flags: [], send: [], delete: [], accounts: [] as unknown[] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      // 入口在页面头部（与通讯录、agent 入口并列）
      await page.getByRole("button", { name: "账号", exact: true }).click();
      const dialog = page.locator('[data-slot="dialog-content"]');
      await expect(dialog.getByText("账号管理")).toBeVisible();

      // 已添加账号列表：两条桩数据
      const rows = dialog.locator('[data-slot="account-list"] > li');
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0)).toContainText("主账号");
      await expect(rows.nth(0)).toContainText("me@mail.example.cn");

      // 色点一致性（2026-10-09 用户报「账号管理页显示的账号颜色和底栏指示器有色差」）：
      // 同一个账号在弹窗列表与底栏必须逐字节同色。弹窗曾把色板名（cyan/pink/…）当 CSS 颜色
      // 内联 —— 它们恰好都是 CSS 具名颜色，`pink` 画出来是 #FFC0CB，而底栏走的是一套算出来的
      // 柔和色：**不报错，只是静默画出另一个色**（实测 ΔE 50）。
      const light = await colorProbe(page);
      expect(Object.keys(light.bar).length, "底栏应列出全部账号（宽度 ≥40rem）").toBe(2);
      for (const name of ["主账号", "学校"]) {
        expect(light.dialog[name], `「${name}」在弹窗与底栏必须同色`).toBe(light.bar[name]);
      }

      // 新增：展开表单 → 填写 → 提交（未填密码时后端 400 的分支不在此覆盖，由 webmail 单测锁定）
      await dialog.getByRole("button", { name: "添加账号" }).click();
      // 账号颜色（2026-10-09）：预选 = 第一个**没人用过**的色板色，顺序即色板声明顺序
      // （cyan→pink→violet→orange→teal）——acc1=cyan、acc2=violet 时缺的正是 pink
      const swatch = (name: string) =>
        dialog.locator(`[data-slot="account-color-swatch"][data-color="${name}"]`);
      await expect(swatch("pink")).toHaveAttribute("aria-pressed", "true");
      // 选到别人在用的色 → 有提示（不拦）；换一个没被占用的色 → 提示消失
      await swatch("cyan").click();
      await expect(dialog.locator('[data-slot="account-color-taken"]')).toBeVisible();
      await swatch("orange").click();
      await expect(dialog.locator('[data-slot="account-color-taken"]')).toHaveCount(0);
      await dialog.getByLabel("备注名").fill("镜像");
      await dialog.getByLabel("邮箱地址").fill("mirror@example.com");
      await dialog.getByLabel("密码 / 授权码").fill("secret");
      await dialog.getByLabel("主机").first().fill("imap.example.com");
      await dialog.getByLabel("主机").nth(1).fill("smtp.example.com");
      await dialog.getByRole("button", { name: "测试并保存" }).click();
      await expect.poll(() => calls.accounts?.length).toBe(1);
      expect(calls.accounts?.[0]).toMatchObject({
        method: "POST",
        body: { displayName: "镜像", email: "mirror@example.com", color: "orange" },
      });
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(2)).toContainText("mirror@example.com");

      // 删除：确认弹窗 → 确认后才删（取消不删）
      await rows.nth(2).getByRole("button", { name: "删除账号 mirror@example.com" }).click();
      const confirm = page.locator('[data-slot="confirm-dialog"]');
      await expect(confirm).toBeVisible();
      await confirm.getByRole("button", { name: "取消" }).click();
      await expect(confirm).toHaveCount(0);
      await expect(rows).toHaveCount(3);

      await rows.nth(2).getByRole("button", { name: "删除账号 mirror@example.com" }).click();
      await page.locator('[data-slot="confirm-dialog"]').getByRole("button", { name: "确定" }).click();
      await expect.poll(() => calls.accounts?.length).toBe(2);
      expect(calls.accounts?.[1]).toMatchObject({ method: "DELETE", id: "mirror" });
      await expect(rows).toHaveCount(2);

      // 只剩一个账号时删除按钮禁用（后端 409「至少保留一个」的前置拦截，避免点了才报错）
      await rows.nth(1).getByRole("button", { name: "删除账号 ysy@edu.example.cn" }).click();
      // 确认弹窗要说明会清掉多少本地副本（2026-10-08：删除曾卡 41 秒且无任何说明）
      await expect(page.getByText("及其已同步的 6 封邮件副本")).toBeVisible();
      await page.locator('[data-slot="confirm-dialog"]').getByRole("button", { name: "确定" }).click();
      await expect(rows).toHaveCount(1);
      await expect(rows.nth(0).getByRole("button", { name: /^删除账号/ })).toBeDisabled();
    });

    /**
     * 同步文件夹选择器（4.15，2026-10-07）：此前是手打的逗号字符串——写错（Sent vs
     * 「已发送」）会静默少同步一个文件夹，最典型的症状是新账号「发件」页永远为空。
     * 现在：探测（POST /folders，用表单里现填的连接参数）→ 勾选 → 随账号一起提交。
     */
    test("账号管理：文件夹选择器（探测 → 用推荐 → 随账号提交 folders）", async ({ page }) => {
      const calls = { flags: [], send: [], delete: [], accounts: [] as unknown[], folders: [] as unknown[] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      await page.getByRole("button", { name: "账号", exact: true }).click();
      const dialog = page.locator('[data-slot="dialog-content"]');
      await dialog.getByRole("button", { name: "添加账号" }).click();

      const pick = dialog.getByRole("button", { name: "选择文件夹" });
      // 未填密码时探测按钮禁用（新增模式拿不到已存凭据）
      await expect(pick).toBeDisabled();
      await dialog.getByLabel("备注名").fill("镜像");
      await dialog.getByLabel("邮箱地址").fill("mirror@example.com");
      await dialog.getByLabel("密码 / 授权码").fill("secret");
      await dialog.getByLabel("主机").first().fill("imap.example.com");
      await dialog.getByLabel("主机").nth(1).fill("smtp.example.com");
      await expect(pick).toBeEnabled();

      await pick.click();
      const picker = dialog.locator('[data-slot="folder-picker"]');
      await expect(picker).toBeVisible();
      // 探测请求带上了表单里的连接参数（没有账号 id 也能预览）
      await expect.poll(() => calls.folders?.length).toBe(1);
      expect(calls.folders?.[0]).toMatchObject({
        imapHost: "imap.example.com",
        email: "mirror@example.com",
        password: "secret",
      });
      const boxes = picker.locator('input[type="checkbox"]');
      await expect(boxes).toHaveCount(4);
      await expect(picker).toContainText("垃圾邮件");

      // 「用推荐的一组」= INBOX + 已发送 + 垃圾邮件 → 3 个 chips
      await picker.getByRole("button", { name: "用推荐的一组" }).click();
      await expect(dialog.locator('[data-slot="folder-chip"]')).toHaveCount(3);
      // 手动加一个自定义文件夹、去掉 INBOX
      await boxes.nth(3).check();
      await boxes.nth(0).uncheck();
      await expect(dialog.locator('[data-slot="folder-chip"]')).toHaveCount(3);
      await expect(dialog.locator('[data-slot="folder-chip"]').nth(0)).toHaveText("已发送");

      // 收起探测面板（按钮在展开态下位于对话框滚动区之外，真实使用也是先收起再保存）
      await dialog.getByRole("button", { name: "收起" }).click();
      await expect(dialog.locator('[data-slot="folder-picker"]')).toHaveCount(0);
      await dialog.getByRole("button", { name: "测试并保存" }).click();
      await expect.poll(() => calls.accounts?.length).toBe(1);
      expect(calls.accounts?.[0]).toMatchObject({
        method: "POST",
        body: { folders: ["已发送", "垃圾邮件", "项目"] },
      });
    });

    /**
     * 输入邮箱地址后自动填 IMAP / SMTP 主机（2026-10-08 用户要求）。
     * 契约：① 常见服务商给确定主机名；② 其余域名按 `imap.<域名>` / `smtp.<域名>` 约定猜；
     * ③ **用户手改过就不再覆盖**（"如果不对用户自己会改"）。
     */
    test("账号管理：输入邮箱后自动填主机；手改过的不再被覆盖", async ({ page }) => {
      const calls = { flags: [] as unknown[], send: [], delete: [] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      await page.getByRole("button", { name: "账号", exact: true }).click();
      const dialog = page.locator('[data-slot="dialog-content"]');
      await dialog.getByRole("button", { name: "添加账号" }).click();
      const imapHost = dialog.getByLabel("主机").first();
      const smtpHost = dialog.getByLabel("主机").nth(1);

      // 常见服务商：确定的两条主机名
      await dialog.getByLabel("邮箱地址").fill("someone@gmail.com");
      await expect(imapHost).toHaveValue("imap.gmail.com");
      await expect(smtpHost).toHaveValue("smtp.gmail.com");

      // 换域名 → 跟着变（仍是自动填的值，可以覆盖）
      await dialog.getByLabel("邮箱地址").fill("me@shaoyuanyu.cn");
      await expect(imapHost).toHaveValue("imap.shaoyuanyu.cn");
      await expect(smtpHost).toHaveValue("smtp.shaoyuanyu.cn");

      // 用户手改 IMAP 主机 → 再改邮箱域名时它不动，SMTP 仍随域名走
      await imapHost.fill("imap.qiye.aliyun.com");
      await dialog.getByLabel("邮箱地址").fill("me@example.org");
      await expect(imapHost, "手改过的主机不能被自动填覆盖").toHaveValue("imap.qiye.aliyun.com");
      await expect(smtpHost).toHaveValue("smtp.example.org");

      // 域名还没成形（没有 @ 后段）时不动表单
      await dialog.getByLabel("邮箱地址").fill("nobody");
      await expect(imapHost).toHaveValue("imap.qiye.aliyun.com");
      await expect(smtpHost).toHaveValue("smtp.example.org");
    });

    test("账号管理：远程图片白名单增删即时落盘，保存失败有提示（4.4）", async ({ page }) => {
      const calls = { flags: [], send: [], delete: [], whitelist: [] as unknown[] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      await page.getByRole("button", { name: "账号", exact: true }).click();
      const dialog = page.locator('[data-slot="dialog-content"]');
      const wl = dialog.locator('[data-slot="remote-image-whitelist"]');
      await expect(wl).toBeVisible();
      // 初始列表来自 GET /remote-image-domains
      await expect(wl).toContainText("edu.cn");

      // 新增：大小写归一化为小写，PUT 全量数组
      await wl.getByRole("textbox").fill("Springer.com");
      await wl.getByRole("button", { name: "添加", exact: true }).click();
      await expect.poll(() => calls.whitelist.length).toBe(1);
      expect(calls.whitelist[0]).toMatchObject({ domains: ["edu.cn", "springer.com"] });
      await expect(wl).toContainText("springer.com");

      // 移除：PUT 剩下的数组，chip 消失
      await wl.getByRole("button", { name: "移除 edu.cn" }).click();
      await expect.poll(() => calls.whitelist.length).toBe(2);
      expect(calls.whitelist[1]).toMatchObject({ domains: ["springer.com"] });
      await expect(wl.getByText("edu.cn", { exact: true })).toHaveCount(0);

      // 保存失败：chip 不进列表（本地态不变），toast 报错
      await wl.getByRole("textbox").fill("bad-domain.invalid");
      await wl.getByRole("button", { name: "添加", exact: true }).click();
      await expect.poll(() => calls.whitelist.length).toBe(3);
      // ⚠ toast 视口在 DOM 里有两个实例（严格模式冲突），断言标题节点
      await expect(page.locator('[data-slot="toast-title"]')).toContainText("白名单保存失败");
      await expect(wl).not.toContainText("bad-domain.invalid");
    });

    test("同步状态指示：贯通底栏（左统计 / 中账号指示 / 右状态）（5.5）", async ({ page }) => {
      const calls = { flags: [], send: [], delete: [] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      const statusbar = page.locator('[data-slot="mail-statusbar"]');
      const status = statusbar.locator('[data-slot="mail-sync-status"]');
      await expect(status.locator('[data-slot="mail-sync-dot"]')).toHaveClass(/bg-emerald-600/);
      await expect(status.locator('[data-slot="mail-sync-latest"]')).toContainText("上次收到新邮件");
      // 左侧统计：桩数据已加载 4 封（默认视图 = 收件，s01 发件不在其中）、未读共 3（acc1=3 + acc2=0）
      await expect(statusbar.locator('[data-slot="mail-list-stats"]')).toHaveText("已加载 4 封 · 未读 3");
      // 状态指示收在底栏（全页仅此一处，工具栏不承载）
      await expect(page.locator('[data-slot="mail-sync-status"]')).toHaveCount(1);
      // 正常态没有告警文案（底栏右侧只有圆点 + 上次收到新邮件）
      await expect(page.locator('[data-slot="mail-sync-alert-text"]')).toHaveCount(0);

      // ---- 贯通：底栏左右缘分别与两栏面板对齐（不是只在左半区）----
      const geo = await page.evaluate(() => {
        const bar = document.querySelector('[data-slot="mail-statusbar"]')!.getBoundingClientRect();
        const list = document.querySelector('[data-slot="mail-pane-list"]')!.getBoundingClientRect();
        const detail = document.querySelector('[data-slot="mail-pane-detail"]')!.getBoundingClientRect();
        const stats = document.querySelector('[data-slot="mail-list-stats"]')!.getBoundingClientRect();
        const sync = document.querySelector('[data-slot="mail-sync-status"]')!.getBoundingClientRect();
        return { bar, list, detail, stats, sync };
      });
      expect(Math.abs(geo.bar.left - geo.list.left), "底栏左缘应与列表栏对齐").toBeLessThanOrEqual(1);
      expect(Math.abs(geo.bar.right - geo.detail.right), "底栏右缘应与详情栏对齐（贯通）").toBeLessThanOrEqual(1);
      // 分区位置：统计在左半（列表正下方）、同步状态在右半
      expect(geo.stats.left + geo.stats.width / 2, "列表统计应在底栏左半").toBeLessThan(
        geo.bar.left + geo.bar.width / 2,
      );
      expect(geo.sync.left + geo.sync.width / 2, "同步状态应在底栏右半").toBeGreaterThan(
        geo.bar.left + geo.bar.width / 2,
      );

      // ---- 账号指示（只读，2026-10-05 定稿）：选「全部账号」时列出正在合并的账号 ----
      const indicator = statusbar.locator('[data-slot="mail-statusbar-accounts"]');
      const rows = page.locator('[data-slot="mail-list"] > li');
      await expect(rows).toHaveCount(4); // 默认视图 = 收件
      await expect(indicator).toBeVisible();
      await expect(indicator).toContainText("主账号");
      await expect(indicator).toContainText("学校");
      await expect(indicator.locator("button")).toHaveCount(0); // 只读：不含任何按钮

      // 账号筛选的唯一入口 = 行 1 的下拉：选「学校」→ 列表只剩 acc2 的 2 封；指示随之隐藏
      const accountTrigger = page.locator('button[aria-label="按账号筛选"]');
      await accountTrigger.click();
      await page.getByRole("menuitem", { name: /学校/ }).click();
      await expect(rows).toHaveCount(2);
      await expect(accountTrigger).toContainText("学校");
      await expect(statusbar.locator('[data-slot="mail-list-stats"]')).toHaveText("已加载 2 封 · 未读 0");
      await expect(indicator).toHaveCount(0); // 选中具体账号时指示不显示（触发器已表明当前账号）
      // 回到「全部账号」→ 指示恢复
      await accountTrigger.click();
      await page.getByRole("menuitem", { name: /全部账号/ }).click();
      await expect(rows).toHaveCount(4); // 收件视图下的合并
      await expect(indicator).toBeVisible();

      // ---- 窄屏：账号指示让位（<40rem 隐藏；当前账号由工具栏触发器常显），底栏仍在 ----
      await page.setViewportSize({ width: 420, height: 900 });
      await expect(statusbar).toBeVisible();
      await expect(indicator).toBeHidden();
      // 窄屏详情视图：底栏整体隐藏（与右栏同规则）
      await rows.nth(1).locator("[data-mail-row]").click();
      await expect(page).toHaveURL(/\/mail\/message\//);
      await expect(statusbar).toBeHidden();
      await page.setViewportSize({ width: 1280, height: 720 });
    });

    test("同步状态指示：同步连续失败与同步错误进入告警态（5.5）", async ({ page }) => {
      const calls = { flags: [], send: [], delete: [] };
      await stubMailApi(page, calls, {
        mailagentd: {
          status: 200,
          body: {
            ok: false,
            threshold: 3,
            accounts: [
              {
                id: "agent",
                displayName: "Agent 信箱",
                email: "agent@mail.example.cn",
                lastOk: null,
                failures: 3,
                lastError: "AUTH failed",
                connected: false,
                alert: true,
              },
            ],
          },
        },
        webmail: {
          status: 200,
          body: {
            ok: true,
            accounts: [
              { id: "acc1", enabled: true, lastSync: null, lastError: "IMAP 连接被重置" },
              { id: "acc2", enabled: true, lastSync: new Date().toISOString(), lastError: null },
            ],
          },
        },
      });
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      // 两类问题一起出现：mailagentd 连续失败达阈值（agent 子系统）+ webmaild acc1 同步报错
      // （邮件同步本身）。
      // 底栏右侧**只完整显示一条**（2026-10-08 用户定稿），且优先级刻意把 agent 排在最后：
      // **邮件同步自身的问题占文案位**（用户 2026-10-08 指定「agent 服务不可达」只做图标，
      // 它不阻塞收信；而同步真的坏了必须一眼看见）。
      const status = page.locator('[data-slot="mail-sync-status"]');
      const primary = status.locator('[data-slot="mail-sync-primary"]');
      const alertText = status.locator('[data-slot="mail-sync-alert-text"]');
      await expect(alertText).toHaveText("acc1 合并视图同步失败：IMAP 连接被重置");
      // 邮件同步的告警是主状态时视觉：琥珀（色调在主状态容器上）
      await expect(primary).toHaveClass(/text-amber-700/);
      // agent 的问题缩成一枚图标，文案在 aria-label / 悬浮弹窗里
      const issue = status.locator('[data-slot="mail-sync-issue"]');
      await expect(issue).toHaveCount(1);
      const label = await issue.getAttribute("aria-label");
      expect(label).toContain("Agent 信箱 连续 3 次同步失败");
      expect(label).toContain("从未成功");
      // 悬浮文字走**原生 title**（站内邮件界面通行的做法，2026-10-08 第二轮用户反馈）
      expect(await issue.getAttribute("title")).toContain("从未成功");
      // 不再有独立的展开告警条（顶部/上方都不该有）
      await expect(page.locator('[data-slot="mail-sync-alerts"]')).toHaveCount(0);
    });

    /**
     * 「邮件同步正常 + agent 后台不可达」——这是**最常见**的一屏（mailagentd 还没部署时
     * dev/生产都是这个样子，用户 2026-10-08 的截图就是它）。
     * 契约：文字位留给同步状态（绿点 + 上次收到新邮件），agent 只占一枚感叹号图标。
     */
    test("同步正常 + agent 告警：文字位留给同步状态，agent 只做图标", async ({ page }) => {
      const calls = { flags: [], send: [], delete: [] };
      await stubMailApi(page, calls, {
        mailagentd: {
          status: 200,
          body: {
            ok: false,
            threshold: 3,
            accounts: [
              {
                id: "agent",
                displayName: "Agent 信箱",
                email: "agent@mail.example.cn",
                lastOk: null,
                failures: 3,
                lastError: "AUTH failed",
                connected: false,
                alert: true,
              },
            ],
          },
        },
      });
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);
      await gotoReady(page, "/mail");

      const status = page.locator('[data-slot="mail-sync-status"]');
      // 主状态 = 同步正常（绿点 + 上次收到新邮件），**不是** agent 告警
      const primary = status.locator('[data-slot="mail-sync-primary"]');
      await expect(primary.locator('[data-slot="mail-sync-latest"]')).toContainText("上次收到新邮件");
      await expect(status.locator('[data-slot="mail-sync-alert-text"]')).toHaveCount(0);
      // agent 告警仍在（一枚琥珀感叹号），悬浮可看文案 —— 没有静默消失
      const issue = status.locator('[data-slot="mail-sync-issue"]');
      await expect(issue).toHaveCount(1);
      await expect(issue).toHaveClass(/text-amber-700/);
      await expect(issue).toHaveAttribute("aria-label", /Agent 信箱 连续 3 次同步失败/);
      // 主状态在前、图标在右
      const primaryBox = (await primary.boundingBox())!;
      const issueBox = (await issue.boundingBox())!;
      expect(primaryBox.x).toBeLessThan(issueBox.x);
    });

    /**
     * 历史回填的进度显示与自动刷新（2026-10-08）。
     *
     * 背景：新加一个邮箱时，首轮同步以前是「从小到大逐封抓、整箱抓完才可见」，界面
     * 上完全看不出在干活（用户报「加载很久、看不到新邮箱的邮件」）。现在首轮是
     * 「最新优先、按块推进」，并且：
     * 1. `/health` 带 `backfill` 进度 → 底栏显示「正在同步历史邮件 x/y」（而不是把
     *    首次同步误报成「从未成功」的告警）；
     * 2. 回填期间列表每 15 秒静默重取，新抓到的邮件自己冒出来。
     * 这里锁定这两条契约（文案 key `mail.sync.backfilling` 的取值形态 + 静默刷新）。
     */
    test("历史回填：底栏显示进度、不误报告警，且列表自动刷新", async ({ page }) => {
      const calls = {
        flags: [],
        send: [],
        delete: [],
        listStore: undefined as unknown[] | undefined,
      };
      // acc1 正在回填（lastSync 仍是 null——首轮还没跑完），acc2 正常
      await stubMailApi(page, calls, {
        webmail: {
          status: 200,
          body: {
            ok: true,
            accounts: [
              {
                id: "acc1",
                enabled: true,
                lastSync: null,
                lastError: null,
                lastNewMail: null,
                backfill: {
                  remaining: 400,
                  total: 500,
                  done: 100,
                  folder: "INBOX",
                  folders: [{ path: "INBOX", remaining: 400, total: 500 }],
                },
              },
              {
                id: "acc2",
                enabled: true,
                lastSync: new Date().toISOString(),
                lastError: null,
                lastNewMail: null,
                backfill: null,
              },
            ],
          },
        },
      });
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);
      await gotoReady(page, "/mail");

      // 进度显示在底栏右侧（状态唯一显示位置）
      const status = page.locator('[data-slot="mail-sync-status"]');
      await expect(status.locator('[data-slot="mail-sync-backfill"]')).toHaveText(
        "正在同步历史邮件 100/500",
      );
      // 首次同步没跑完 ≠ 告警：`lastSync === null` 不再被判成「从未成功」
      await expect(page.locator('[data-slot="mail-sync-alert-text"]')).toHaveCount(0);

      // ---- 回填期间列表自动刷新（15s 一拍）----
      const rows = page.locator('[data-slot="mail-list"] > li');
      const before = await rows.count();
      // 模拟「后台又抓进来一封」：换掉列表桩的实时引用（⚠ 不能原地改 MAIL_LIST——
      // 它是模块级常量，被同一文件里其它用例共享）
      calls.listStore = [
        mailItem({
          messageId: "mid:backfilled@test.local",
          date: "2026-10-08T02:00:00.000Z",
          subject: "回填进来的旧邮件",
          fromAddr: "old@example.net",
          snippet: "历史回填",
          copies: [{ accountId: "acc1", folder: "INBOX", uid: 9001 }],
        }),
        ...MAIL_LIST,
      ];
      // 不手动刷新、不点任何按钮：等自动刷新把它带进来
      await expect(rows).toHaveCount(before + 1, { timeout: 25_000 });
      await expect(page.getByText("回填进来的旧邮件")).toBeVisible();
    });

    /**
     * 底栏右侧**只完整显示一条**、其余状态缩成图标（2026-10-08 用户定稿）。
     *
     * 用户当时的截图是：「⟳ 正在同步历史邮件 382/6520　⚠ agent 服务不可达」两段完整文案
     * 并排，又长又吵。要求：只完整显示一条、用绿色；其余状态缩成一枚图标（悬浮看文字）。
     * 第二轮又定：主状态排在**最左**（第一条），图标排它**右边**——反过来的话右边那枚
     * 感叹号像是「在修饰」同步文案，容易被读成「同步出问题了」。
     * 这里锁定：主状态 = 同步进度（绿色、第一条）、告警只剩一枚图标（文案在 title/aria-label）。
     */
    test("同步进行中：主状态在前（绿）、次级告警缩成一枚图标（文案在 title）", async ({ page }) => {
      const calls = { flags: [], send: [], delete: [] };
      await stubMailApi(page, calls, {
        mailagentd: {
          status: 200,
          body: {
            ok: false,
            threshold: 3,
            accounts: [
              {
                id: "agent",
                displayName: "Agent 信箱",
                email: "agent@mail.example.cn",
                lastOk: null,
                failures: 3,
                lastError: "AUTH failed",
                connected: false,
                alert: true,
              },
            ],
          },
        },
        webmail: {
          status: 200,
          body: {
            ok: true,
            accounts: [
              {
                id: "acc1",
                enabled: true,
                lastSync: null,
                lastError: null,
                lastNewMail: null,
                backfill: {
                  remaining: 400,
                  total: 500,
                  done: 100,
                  folder: "INBOX",
                  folders: [{ path: "INBOX", remaining: 400, total: 500 }],
                },
              },
              { id: "acc2", enabled: true, lastSync: new Date().toISOString(), lastError: null },
            ],
          },
        },
      });
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);
      await gotoReady(page, "/mail");

      const status = page.locator('[data-slot="mail-sync-status"]');
      const primary = status.locator('[data-slot="mail-sync-primary"]');
      // 主状态 = 同步进度（完整文案），绿色
      await expect(primary.locator('[data-slot="mail-sync-backfill"]')).toHaveText(
        "正在同步历史邮件 100/500",
      );
      await expect(primary).toHaveClass(/text-emerald-700/);
      // 告警不再占一整行文字（缩成图标了）
      await expect(status.locator('[data-slot="mail-sync-alert-text"]')).toHaveCount(0);

      // 告警图标：文案在 title / aria-label 里（悬浮即可看到，站内通行做法）
      const issue = status.locator('[data-slot="mail-sync-issue"]');
      await expect(issue).toHaveCount(1);
      expect(await issue.getAttribute("aria-label"), "图标悬浮文案 = 完整告警").toContain(
        "Agent 信箱 连续 3 次同步失败",
      );
      expect(await issue.getAttribute("title")).toContain("Agent 信箱 连续 3 次同步失败");

      // 顺序：主状态在**最左**（第一条），图标在它右边——否则感叹号读起来像在修饰同步文案
      const issueBox = (await issue.boundingBox())!;
      const primaryBox = (await primary.boundingBox())!;
      expect(primaryBox.x, "主状态在次级图标左边").toBeLessThan(issueBox.x);
      // 整组仍然贴底栏右端（图标是最右的那个元素）
      const barBox = (await page.locator('[data-slot="mail-statusbar"]').boundingBox())!;
      expect(
        barBox.x + barBox.width - (issueBox.x + issueBox.width),
        "状态指示器贴住底栏右端",
      ).toBeLessThan(24);
    });

    /**
     * 新增账号后底栏**当场**显示「正在首次同步邮件…」（2026-10-08 用户要求）。
     *
     * 背景：加完邮箱，后端立刻起一轮同步（先钉水位线、再按块倒序回填），但这段时间
     * `/health` 的 `backfill` 还没有 x/y 数字（第一块还没落库）——旧实现下这一段在界面上
     * 完全不可见：① 平静期的状态轮询是 60s 一拍，加完账号最多要等一分钟才刷新；
     * ② `lastSync === null` 时底栏显示的是「上次收到新邮件 x 前」，与真相正好相反
     * （邮箱正在下载，界面却在说上一封信是什么时候到的）。
     * 这里锁定两条契约：加完账号立刻切到首次同步态，且抓取期间列表照常静默自动刷新。
     */
    test("新增账号：底栏立刻显示首次同步进度，列表自动刷新", async ({ page }) => {
      const calls = {
        flags: [],
        send: [],
        delete: [],
        accounts: [] as unknown[],
        listStore: undefined as unknown[] | undefined,
      };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);
      await gotoReady(page, "/mail");

      const status = page.locator('[data-slot="mail-sync-status"]');
      // 加账号之前：两个账号都同步过 → 正常态（绿点 + 上次收到新邮件）
      await expect(status.locator('[data-slot="mail-sync-latest"]')).toBeVisible();
      await expect(status.locator('[data-slot="mail-sync-first-sync"]')).toHaveCount(0);

      // 添加账号（与「账号管理」用例同一套操作）
      await page.getByRole("button", { name: "账号", exact: true }).click();
      const dialog = page.locator('[data-slot="dialog-content"]');
      await dialog.getByRole("button", { name: "添加账号" }).click();
      await dialog.getByLabel("备注名").fill("镜像");
      await dialog.getByLabel("邮箱地址").fill("mirror@example.com");
      await dialog.getByLabel("密码 / 授权码").fill("secret");
      await dialog.getByLabel("主机").first().fill("imap.example.com");
      await dialog.getByLabel("主机").nth(1).fill("smtp.example.com");
      await dialog.getByRole("button", { name: "测试并保存" }).click();
      await expect.poll(() => calls.accounts?.length).toBe(1);
      // 关掉弹窗腾出底栏（无需手动刷新页面、也不点任何同步按钮）
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);

      // ⚠ 关键断言：不等 60s 轮询，加完账号底栏立刻切到首次同步态
      await expect(status.locator('[data-slot="mail-sync-first-sync"]')).toHaveText(
        "正在首次同步邮件…",
      );
      // 首轮没跑完 ≠ 告警：不能显示「从未成功」那类故障文案
      await expect(status.locator('[data-slot="mail-sync-alert-text"]')).toHaveCount(0);
      // 也别再显示「上次收到新邮件 x 前」（此刻它读起来正好是反的）
      await expect(status.locator('[data-slot="mail-sync-latest"]')).toHaveCount(0);

      // ---- 抓取期间列表自动刷新（15s 一拍）----
      const rows = page.locator('[data-slot="mail-list"] > li');
      const before = await rows.count();
      calls.listStore = [
        mailItem({
          messageId: "mid:first-sync@test.local",
          date: "2026-10-08T03:00:00.000Z",
          subject: "新账号抓下来的第一封",
          fromAddr: "fresh@example.net",
          snippet: "首次同步",
          copies: [{ accountId: "mirror", folder: "INBOX", uid: 1 }],
        }),
        ...MAIL_LIST,
      ];
      // 不手动刷新、不点任何按钮：等自动刷新把它带进来
      await expect(rows).toHaveCount(before + 1, { timeout: 25_000 });
      await expect(page.getByText("新账号抓下来的第一封")).toBeVisible();
    });

    test("同步状态指示：两个后台服务都不可达时显示总告警（5.5）", async ({ page }) => {
      const calls = { flags: [], send: [], delete: [] };
      await stubMailApi(page, calls, {
        mailagentd: { status: 500, body: { error: "down" } },
        webmail: { status: 500, body: { error: "down" } },
      });
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      // 底栏右侧直接显示具体文案（2026-10-04 用户指定：把「同步异常」短标签换成
      // 「邮件后台服务不可达，新邮件同步已暂停」，底栏就是状态条、不再另开告警栏）
      const status = page.locator('[data-slot="mail-sync-status"]');
      await expect(status.locator('[data-slot="mail-sync-alert-text"]')).toHaveText(
        "邮件后台服务不可达，新邮件同步已暂停",
      );
      // 状态只在底栏：没有额外的告警条，也没有别处重复这句文案
      await expect(page.locator('[data-slot="mail-sync-alerts"]')).toHaveCount(0);
      await expect(page.getByText("邮件后台服务不可达，新邮件同步已暂停")).toHaveCount(1);
    });

    /**
     * 加载失败（2026-10-04 用户反馈）：列表接口 502 时只给友好文案 + 重试按钮，
     * **不回显 `webmaild_unreachable` 这类内部错误码**，也不能退化成「暂无邮件」空态
     * （那会让人以为真的没有邮件）。底栏统计同步隐藏（「已加载 0 封」同样是误导）。
     */
    test("列表加载失败：友好文案 + 重试，不回显内部错误码", async ({ page }) => {
      const calls = { flags: [], send: [], delete: [] };
      await stubMailApi(page, calls);
      // ⚠ 后注册的 route 优先：只拦 /messages（其余走 stubMailApi 的 fallback）
      let fail = true;
      await page.route("**/api/mail/messages*", (route) =>
        fail
          ? route.fulfill({
              status: 502,
              contentType: "application/json",
              body: JSON.stringify({ error: "webmaild_unreachable" }),
            })
          : route.fallback(),
      );
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      const empty = page.locator('[data-slot="mail-list-scroll"] [data-slot="empty"]');
      await expect(empty).toBeVisible();
      await expect(empty).toContainText("加载失败");
      await expect(empty).toContainText("邮件服务暂时不可用，请稍后重试");
      await expect(page.getByText("webmaild_unreachable")).toHaveCount(0);
      await expect(empty).not.toContainText("暂无邮件");
      // 底栏统计在失败态不显示（2026-10-05 起元素常驻占位、loading 时 invisible——
      // 卸载会让居中的账号指示横向抖动；断言「不可见」而非「不存在」）
      await expect(page.locator('[data-slot="mail-list-stats"]')).toBeHidden();

      // 重试：接口恢复后点「重试」→ 列表出现、统计回来（默认视图 = 收件，4 封）
      fail = false;
      await empty.getByRole("button", { name: "重试" }).click();
      await expect(page.locator('[data-slot="mail-list"] > li')).toHaveCount(4);
      await expect(page.locator('[data-slot="mail-list-stats"]')).toHaveText("已加载 4 封 · 未读 3");
    });

    /**
     * 收件 / 发件区分（2026-10-04 用户定稿）：列表首行名字位**永远是「对方」的纯名字**——
     * 收件显示发件人；发件（副本全在「已发送」类文件夹）显示收件人（多人补「等 N 人」），
     * 不带「发给 」前缀（用户反馈「文字前缀让列表密密麻麻」，改用视觉语言）。
     * 方向由头像右下角的箭头角标表达（↙ 收件 / ↗ 发件，双向都标）；「已发送」徽章已删，
     * 此用例锁定它不被加回。
     * 功能侧：发件邮件不显示「回复 / 回复全部 / 快速回复 / 存入通讯录」（对自己发出的邮件无意义，
     * 「转发」保留）。另外锁定「所在邮箱」一栏已删（用户反馈「没什么实际」）。
     */
    test("收件 / 发件区分：列表显示收件人 + 方向角标 + 动作差异", async ({ page }) => {
      const calls = { flags: [], send: [], delete: [] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      const rows = page.locator('[data-slot="mail-list"] > li');
      await expect(rows).toHaveCount(4); // 默认视图 = 收件（s01 发件不在其中）
      // 切到「全部」视图看发件行：末行（s01，副本只在「已发送」）名字位显示纯名字「张老师」、
      // 无「发给」前缀，角标 data-direction=sent；收件行角标 = received
      await page.getByRole("tab", { name: "全部", exact: true }).click();
      await expect(rows).toHaveCount(5);
      await expect(rows.nth(4)).toContainText("张老师");
      await expect(rows.nth(4)).not.toContainText("发给");
      await expect(rows.nth(4).locator('[data-slot="mail-direction-badge"]')).toHaveAttribute("data-direction", "sent");
      await expect(rows.nth(0).locator('[data-slot="mail-direction-badge"]')).toHaveAttribute("data-direction", "received");
      await expect(page.locator('[data-slot="mail-sent-badge"]')).toHaveCount(0);

      // 详情（发件邮件）：方向角标 = sent；回复 / 回复全部 / 快速回复全部不渲染；转发保留
      await rows.nth(4).locator("[data-mail-row]").click();
      await expect(page).toHaveURL(/\/mail\/message\//);
      const detail = page.locator('[data-slot="mail-pane-detail"]');
      const bar = page.locator('[data-slot="message-actions"]');
      await expect(detail.locator('[data-slot="mail-direction-badge"]')).toHaveAttribute("data-direction", "sent");
      await expect(bar.getByRole("link", { name: "转发", exact: true })).toBeVisible();
      await expect(bar.getByRole("link", { name: "回复", exact: true })).toHaveCount(0);
      // 「回复全部」现在是「回复」右侧那个 caret（分裂按钮）——发件邮件整组都不该出现
      await expect(bar.getByRole("button", { name: "回复全部", exact: true })).toHaveCount(0);
      // 回复组（官方 ButtonGroup）整体不该出现
      await expect(bar.locator('[data-slot="button-group"]')).toHaveCount(0);
      await expect(page.locator('[data-slot="mail-quick-reply"]')).toHaveCount(0);
      await expect(detail.locator('[data-slot="mail-sent-badge"]')).toHaveCount(0);
      // 「所在邮箱」一栏已删（勿加回）
      await expect(page.getByText("所在邮箱")).toHaveCount(0);
      // 未读/星标/删除仍在（发件邮件也是普通邮件）
      await expect(bar.getByRole("button", { name: "加星标" })).toBeVisible();
      await expect(bar.getByRole("button", { name: "删除", exact: true })).toBeVisible();

      // 收件邮件反过来：有回复、列表显示发件人、方向角标 = received
      await gotoReady(page, "/mail");
      await page.locator('[data-slot="mail-list"] > li').nth(1).locator("[data-mail-row]").click();
      await expect(
        page.locator('[data-slot="mail-pane-detail"] [data-slot="mail-direction-badge"]'),
      ).toHaveAttribute("data-direction", "received");
      await expect(
        page.locator('[data-slot="message-actions"]').getByRole("link", { name: "回复", exact: true }),
      ).toBeVisible();
      await expect(page.locator('[data-slot="mail-pane-detail"] [data-slot="mail-sent-badge"]')).toHaveCount(0);
    });

    test("写邮件：?to= 预填收件人 + 通讯录自动补全选中", async ({ page }) => {
      const calls = { flags: [], send: [], delete: [] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      // ?to= 预填
      await gotoReady(page, "/mail/compose?to=boss@example.com");
      const toInput = page.locator("#mail-to");
      await expect(toInput).toHaveValue("boss@example.com");

      // 自动补全：输入 zhang → 建议出现 → Enter 选中第一项
      await toInput.fill("zhang");
      const suggestions = page.locator('[data-slot="recipient-suggestions"]');
      await expect(suggestions).toBeVisible();
      await expect(suggestions.getByRole("option")).toHaveCount(1);
      await expect(suggestions).toContainText("张老师");
      await toInput.press("Enter");
      await expect(toInput).toHaveValue("zhang@example.com, ");
      await expect(suggestions).toHaveCount(0);
    });

    test("详情页：发件人一键存入通讯录，已存显示勾标", async ({ page }) => {
      const calls = { flags: [], send: [], delete: [], contacts: [] as unknown[] };
      await stubMailApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail");
      // 打开 w01（发件人张老师 <zhang@example.com>，未存通讯录）
      await page.locator('[data-slot="mail-list"] > li').nth(3).locator("[data-mail-row]").click();
      await expect(page).toHaveURL(/\/mail\/message\//);

      const saveBtn = page.getByRole("button", { name: "存入通讯录" });
      await expect(saveBtn).toBeVisible();
      await saveBtn.click();
      await expect.poll(() => calls.contacts.length).toBe(1);
      expect(calls.contacts[0]).toMatchObject({
        method: "POST",
        body: { name: "张老师", email: "zhang@example.com" },
      });
      // 存入后切换为「已在通讯录」勾标
      await expect(page.getByLabel("已在通讯录")).toBeVisible();
      await expect(page.getByRole("button", { name: "存入通讯录" })).toHaveCount(0);
    });
  });
});

// ---- /mail/agent 只读入口打桩（MAIL-AGENT.md 第八节第 5 步；数据形状对应 mailagentd /agent/* 端点）----

const AGENT_TIMELINE = [
  {
    messageId: "mid:agent-report-1@test.local",
    date: "2026-09-26T13:00:00.000Z",
    direction: "out",
    subject: "今日汇总",
    fromAddr: "agent@mail.example.cn",
    fromName: "agent",
    toJson: "[]",
    snippet: "重要 1 封，原信附后",
    truncated: false,
    folders: ["Sent"],
    seen: true,
  },
  {
    messageId: "mid:m1@test.local",
    date: "2026-09-25T01:00:00.000Z",
    direction: "in",
    subject: "面试通知",
    fromAddr: "hr@example.com",
    fromName: "HR",
    toJson: "[]",
    snippet: "周五下午三点",
    truncated: false,
    folders: ["INBOX"],
    seen: false,
  },
];

const AGENT_DETAIL = {
  headersRaw:
    "From: =?UTF-8?B?YWdlbnQ=?= <agent@mail.example.cn>\r\nMessage-ID: <agent-report-1@test.local>\r\nSubject: =?UTF-8?B?5pel5oql5Yy65aSA?=",
  subject: "今日汇总",
  from: "agent <agent@mail.example.cn>",
  date: "2026-09-26T13:00:00.000Z",
  messageId: "mid:agent-report-1@test.local",
  parts: [
    { kind: "text", contentType: "text/plain", size: 40 },
    { kind: "attachment", contentType: "message/rfc822", size: 900, filename: "original.eml" },
  ],
  text: "今日汇总：重要 1 封。原信附后，供核对。",
  rfc822: [{ index: 0, filename: "original.eml", size: 900 }],
  direction: "out",
  copies: [{ accountId: "agent", folder: "Sent", uid: 5, flags: "\\Seen" }],
  judgment: null,
  reasoningCount: 0,
};

const AGENT_RFC822 = {
  headersRaw: "From: 教授 <prof@example.edu>\r\nMessage-ID: <paper-invite@test.local>",
  subject: "特刊投稿邀请",
  from: "教授 <prof@example.edu>",
  date: "2026-09-26T01:30:00.000Z",
  messageId: "mid:paper-invite@test.local",
  parts: [
    { kind: "text", contentType: "text/plain", size: 30 },
    { kind: "html", contentType: "text/html", size: 120 },
  ],
  text: "下个月截止的特刊，欢迎你投稿。",
  rfc822: [],
};

function stubMailAgentApi(page: Page, calls: { pending: { id: number; action: string }[] }) {
  let pendingItems = [
    { id: 7, created_at: "2026-09-26T12:00:00.000Z", to_json: '["someone@example.org"]', subject: "代发确认", text: "请确认是否发出这封邮件。" },
  ];
  return page.route("**/api/mail/agent/**", (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname.replace(/^\/api\/mail\/agent/, ""));
    const json = (body: unknown) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/timeline") return json({ items: AGENT_TIMELINE, next: null });
    if (path === "/judgments") {
      return json({
        items: [
          {
            message_id: "mid:m1@test.local",
            verdict: "important",
            labels_json: '["todo"]',
            confidence: 0.9,
            model: "test-model",
            prompt_version: "judge-v1",
            judged_at: "2026-09-26T10:00:00.000Z",
            subject: "面试通知",
            from_addr: "hr@example.com",
            date: "2026-09-25T01:00:00.000Z",
          },
        ],
        next: null,
      });
    }
    if (path === "/reasoning") {
      return json({
        items: [
          {
            id: 1,
            run_kind: "run",
            trace: "真实推理过程",
            summary: "需要站主处理",
            model: "test-model",
            prompt_version: "judge-v1",
            tokens: 123,
            started_at: "2026-09-26T10:00:00.000Z",
            finished_at: "2026-09-26T10:00:02.000Z",
          },
        ],
      });
    }
    if (path === "/ledger") {
      return json({
        items: [
          { id: 3, ts: "2026-09-26T10:00:01.000Z", tool: "read_message", ok: 1, message_id: "mid:m1@test.local", detail_json: "{}", error: null },
        ],
      });
    }
    if (path === "/pending-sends") return json({ items: pendingItems });
    const pendingMatch = path.match(/^\/pending-sends\/(\d+)\/(confirm|discard)$/);
    if (pendingMatch && route.request().method() === "POST") {
      calls.pending.push({ id: Number(pendingMatch[1]), action: pendingMatch[2] });
      pendingItems = [];
      return json(pendingMatch[2] === "confirm" ? { ok: true, sent: 1 } : { discarded: true });
    }
    if (path === "/message/mid:agent-report-1@test.local") return json(AGENT_DETAIL);
    if (path === "/message/mid:agent-report-1@test.local/rfc822/0") return json(AGENT_RFC822);
    if (path === "/message/mid:agent-report-1@test.local/eml") {
      return route.fulfill({
        contentType: "message/rfc822",
        headers: { "content-disposition": 'attachment; filename="agent-report-1.eml"' },
        body: "From: agent <agent@mail.example.cn>\r\n\r\n今日汇总",
      });
    }
    return json({ error: `未打桩的端点: ${path}` });
  });
}

test.describe("agent 邮件入口（/mail/agent）", () => {
  test("游客：页面重定向到登录页，API 一律 401", async ({ page }) => {
    await page.goto("/mail/agent", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/login$/);
    const res = await page.request.get("/api/mail/agent/timeline");
    expect(res.status()).toBe(401);
  });

  test.describe("登录态（API 打桩）", () => {
    test.skip(!totpSecret, "未配置 TOTP_SECRET，跳过登录测试");

    test("时间线：方向徽章 + 详情弹窗（头部/结构/正文）+ rfc822 就地展开 + 无写入口", async ({ page }) => {
      const calls = { pending: [] as { id: number; action: string }[] };
      await stubMailAgentApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      // /mail 主页的专门入口链接（与页面 h1 同名，用户 2026-10 要求统一为「agent 邮件」）
      await gotoReady(page, "/mail");
      await page.getByRole("link", { name: "agent 邮件" }).click();
      await expect(page).toHaveURL(/\/mail\/agent$/);

      // 页头（4.13）：本次页 h1 + 左上角「返回邮件」（不是右上角、不叫「返回收件箱」）
      await expect(page.getByRole("heading", { name: "agent 邮件", level: 1 })).toBeVisible();
      const agentBack = page.getByRole("link", { name: "返回邮件" });
      await expect(agentBack).toBeVisible();
      const agentH1 = (await page.getByRole("heading", { level: 1 }).boundingBox())!;
      const agentBackBox = (await agentBack.boundingBox())!;
      expect(agentBackBox.y, "返回入口在标题上方").toBeLessThan(agentH1.y);

      // 时间线：收 + 发合并，方向徽章正确（4.9：按「今天/昨天/更早」分组，
      // 桩数据均为更早 → 同一组内顺序不变）
      const timeline = page.locator('[data-slot="agent-timeline"]');
      await expect(timeline).toContainText("更早");
      const rows = timeline.locator("li");
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0).locator('[data-slot="agent-dir-badge"]')).toContainText("发");
      await expect(rows.nth(1).locator('[data-slot="agent-dir-badge"]')).toContainText("收");
      await expect(rows.nth(1)).toContainText("面试通知");

      // 点开详情：完整头部原文 / MIME 结构 / 正文 / 下载链接
      await rows.nth(0).locator("button").click();
      const dialog = page.locator('[data-slot="dialog-content"]');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("Message-ID: <agent-report-1@test.local>");
      await expect(dialog.locator('[data-slot="agent-parts"]')).toContainText("message/rfc822");
      await expect(dialog).toContainText("今日汇总：重要 1 封");
      const download = dialog.getByRole("link", { name: "下载 .eml 原件" });
      await expect(download).toHaveAttribute(
        "href",
        `/api/mail/agent/message/${encodeURIComponent("mid:agent-report-1@test.local")}/eml`,
      );

      // rfc822 就地展开：内嵌邮件同构展示，且不出现任何远程内容
      await dialog.getByRole("button", { name: /展开内嵌邮件/ }).click();
      const inner = dialog.locator('[data-slot="agent-rfc822"]');
      await expect(inner).toContainText("特刊投稿邀请");
      await expect(inner).toContainText("prof@example.edu");
      await expect(inner).toContainText("欢迎你投稿");
      await expect(inner.locator("img")).toHaveCount(0);

      // 只读原则：整页没有任何写操作入口（无回复/无标记/无 compose）
      await expect(page.locator('a[href*="/mail/compose"]')).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: /回复|转发|标为/ })).toHaveCount(0);
    });

    test("台账：待确认 POST 确认、判定展开拉推理（两种文本分开）、工具调用台账", async ({ page }) => {
      const calls = { pending: [] as { id: number; action: string }[] };
      await stubMailAgentApi(page, calls);
      const code = new TOTP({ secret: totpSecret! }).generate();
      await loginWithCode(page, code);

      await gotoReady(page, "/mail/agent");
      await page.getByRole("tab", { name: "处理记录" }).click();

      // 台账三段 Card 分区（4.9）
      await expect(page.getByText("待确认外发", { exact: true })).toBeVisible();
      await expect(page.getByText("判定", { exact: true })).toBeVisible();
      await expect(page.getByText("工具调用记录", { exact: true })).toBeVisible();

      // 待确认队列：确认发出（页面唯二的 POST，人操作）
      const pending = page.locator('[data-slot="agent-pending"]');
      await expect(pending).toContainText("代发确认");
      await pending.getByRole("button", { name: "确认发出" }).click();
      await expect.poll(() => calls.pending).toEqual([{ id: 7, action: "confirm" }]);
      await expect(pending).toContainText("没有待确认的外发");

      // 判定列表：展开后才拉推理；trace 与 summary 分开展示并带 model/prompt_version
      const judgments = page.locator('[data-slot="agent-judgments"]');
      await judgments.getByRole("button").first().click();
      const reasoning = judgments.locator('[data-slot="agent-reasoning"]');
      await expect(reasoning).toContainText("模型推理");
      await expect(reasoning).toContainText("真实推理过程");
      await expect(reasoning).toContainText("处理说明（agent 自述，仅供参考）");
      await expect(reasoning).toContainText("需要站主处理");
      await expect(reasoning).toContainText("test-model · judge-v1");

      // 工具调用台账
      const ledger = page.locator('[data-slot="agent-ledger"]');
      await expect(ledger).toContainText("read_message");
      await expect(ledger).toContainText("mid:m1@test.local");
    });
  });
});
