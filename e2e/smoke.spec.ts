import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
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
 */
async function waitForHydration(page: Page) {
  await page.waitForFunction(
    () => document.documentElement.dataset.hydrated === "true",
    undefined,
    { timeout: 20_000 },
  );
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
    for (const name of ["首页", "博客", "速记", "日历", "导航"]) {
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
    for (const name of ["首页", "博客", "速记", "日历", "导航"]) {
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

    // 删除（确认弹窗 → 接受）→ 条目消失
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "删除" }).first().click();
    await expect(page.getByText(edited)).toHaveCount(0);
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

  test("卡片日历菜单：游客无 CalDAV 项，登录后可见", async ({ page }) => {
    const openMenu = async () => {
      await page
        .locator(".grid.grid-cols-1 [data-slot=card]")
        .first()
        .getByRole("button", { name: "加入日历" })
        .click();
    };

    await gotoReady(page, "/deadlines");
    await openMenu();
    await expect(
      page.getByRole("menuitem", { name: "添加到我的日历" }),
    ).toHaveCount(0);

    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);
    await gotoReady(page, "/deadlines");
    await openMenu();
    await expect(
      page.getByRole("menuitem", { name: "添加到我的日历" }),
    ).toBeVisible();
    // 点击菜单项不应打开会议详情 Dialog（React 合成事件按组件树冒泡，需 stopPropagation）
    await page.getByRole("menuitem", { name: "添加到我的日历" }).click();
    await expect(page.locator("[data-slot=dialog-title]")).toHaveCount(0);
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

  test("周起始日设置：默认周日，可切换为周一并实时生效", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);
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
    await page.getByRole("button", { name: "设置" }).click();
    await page.getByRole("tab", { name: "周一" }).click();
    await page.getByRole("button", { name: "关闭" }).click();
    await expect(
      header.getByText("周一", { exact: true }).first(),
    ).toBeVisible();

    // 恢复默认周日（用例自清理，避免影响其他用例的默认断言）。
    // UI 切换只改本地状态，防抖 PATCH 可能未落盘测试就结束，
    // 显式 API 写入确保服务器数据干净
    await page.getByRole("button", { name: "设置" }).click();
    await page.getByRole("tab", { name: "周日" }).click();
    await page.getByRole("button", { name: "关闭" }).click();
    await expect(firstHeader).toBeVisible();
    const reset = await page.request.patch("/api/preferences", {
      data: { "calendar:weekStart": "sunday" },
    });
    expect(reset.status()).toBe(200);
  });

  test("点击日期格聚焦：下方联动显示当天日程，可返回总览", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);
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

  test("会议节点日程弹窗：显示该届会议时间线，可跳转同届其它节点日程", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);

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

    // 下方「本月及未来日程」的行是**跳转**语义（聚焦该日，不打开弹窗），
    // 「当天日程」的行才是打开详情弹窗——故先跳转、再点当天那行
    const confTitle = target!.confTitle ?? target!.summary;
    await page
      .locator("main button:not([data-slot])")
      .filter({ hasText: confTitle })
      .first()
      .click();

    const dayRow = page.locator(`main button[title^="${confTitle}"]`).first();
    await dayRow.waitFor({ state: "visible" });
    await dayRow.click();

    const timeline = page.locator("[data-slot=appointment-timeline]");
    await expect(timeline).toBeVisible();
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
    // 与既有用例同一条路径：先点总览行跳转聚焦，再点当天行打开详情弹窗
    await page
      .locator("main button:not([data-slot])")
      .filter({ hasText: confTitle })
      .first()
      .click();
    const dayRow = page.locator(`main button[title^="${confTitle}"]`).first();
    await dayRow.waitFor({ state: "visible" });
    await dayRow.click();

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
    await page.getByLabel("用户名").fill("caladmin");
    await page.getByLabel("密码").fill("testpass123");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByText("凭证已保存")).toBeVisible();

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
        return fs.readFileSync(
          "/home/ysy/Projects/ysy-personal-homepage/.next/standalone/data/caldav-reset.json",
          "utf8",
        );
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
    fs.rmSync(
      "/home/ysy/Projects/ysy-personal-homepage/.next/standalone/data/caldav-reset.json",
      { force: true },
    );
  });
});
