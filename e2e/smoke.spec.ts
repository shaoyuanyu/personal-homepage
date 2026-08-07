import { expect, test, type Page } from "@playwright/test";

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

  test("页面无控制台错误", async ({ page }) => {
    const errors = collectPageErrors(page);
    await expectPageOk(page, "/");
    expect(errors, `首页控制台错误: ${errors.join("; ")}`).toEqual([]);
  });
});
