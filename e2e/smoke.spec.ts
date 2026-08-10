import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { TOTP } from "otpauth";

/**
 * 全站冒烟测试：核心页面 200 + 关键内容渲染 + 旧链接 301 + 关键资源可用。
 * 通过 E2E_BASE_URL 在本地（localhost）或线上（https://shaoyuanyu.cn）运行。
 */

async function expectPageOk(page: Page, path: string, heading?: string) {
  const res = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(res?.status(), `${path} 应返回 200`).toBe(200);
  if (heading) {
    await expect(
      page.getByRole("heading", { name: heading, level: 1 }),
      `${path} 应渲染 h1: ${heading}`,
    ).toBeVisible();
  }
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
  await page.goto("/login");
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
    for (const path of ["/publications", "/talks", "/projects", "/blog", "/ccf", "/nav"]) {
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

test.describe("关键资源", () => {
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

  test("页面无控制台错误", async ({ page }) => {
    const errors = collectPageErrors(page);
    await expectPageOk(page, "/");
    expect(errors, `首页控制台错误: ${errors.join("; ")}`).toEqual([]);
  });
});

test.describe("主人登录（TOTP）", () => {
  test.skip(!totpSecret, "未配置 TOTP_SECRET，跳过登录测试");

  test("登录页 200 + 表单可见", async ({ page }) => {
    await expectPageOk(page, "/login");
    await expect(page.locator("#auth-code")).toBeVisible();
    // 限定在表单内：导航栏也有游客态「登录」入口
    await expect(
      page.locator("form").getByRole("button", { name: /登录|Sign in/ }),
    ).toBeVisible();
  });

  test("错误验证码被拒绝且不设会话", async ({ page }) => {
    await page.goto("/login");
    await page.locator("#auth-code").fill("000000");
    await expect(page.getByRole("alert")).toBeVisible();
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

  test("管理员菜单：通过导航退出登录", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);

    // 导航栏出现管理员菜单（桌面视口）
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole("button", { name: "管理员" })).toBeVisible();

    // 菜单含「速记」入口与「退出登录」项（nav.ideas 文案为「速记」）
    await page.getByRole("button", { name: "管理员" }).click();
    await expect(page.getByRole("menuitem", { name: /速记/ })).toBeVisible();
    await page.getByRole("menuitem", { name: /退出登录/ }).click();

    // 回到首页且会话被清除，导航恢复为「登录」
    await expect(page).toHaveURL(/\/$/);
    const cookies = await page.context().cookies();
    expect(cookies.some((c) => c.name === "owner_session")).toBe(false);
    await expect(page.getByRole("button", { name: "登录" })).toBeVisible();
  });
});

test.describe("想法速记（主人专属）", () => {
  test.skip(!totpSecret, "未配置 TOTP_SECRET，跳过登录测试");

  test("游客访问 /admin/ideas 被重定向到登录页", async ({ page }) => {
    await page.goto("/admin/ideas");
    await expect(page).toHaveURL(/\/login/);
  });

  test("游客调用 ideas API 返回 401", async ({ request }) => {
    const res = await request.get("/api/ideas");
    expect(res.status()).toBe(401);
  });

  test("登录后页面 200 + 速记表单可见", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);
    await expectPageOk(page, "/admin/ideas", "想法速记");
    await expect(page.getByLabel(/记录一个想法/)).toBeVisible();
  });

  test("创建 → 标记完成 → 编辑 → 删除", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);
    await page.goto("/admin/ideas");

    const marker = String(Date.now());
    const origin = `E2E 测试想法 ${marker}：对比学习中的灾难性遗忘`;
    const edited = `E2E 测试想法 ${marker}（已编辑）：换个研究方向`;

    // 创建
    await page.getByLabel(/记录一个想法/).fill(origin);
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
