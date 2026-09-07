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
    for (const path of ["/publications", "/talks", "/projects", "/blog", "/ccf", "/cas", "/nav", "/deadlines"]) {
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
    await page.goto("/login");
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
    await page.goto("/ideas");

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
    await page.goto("/ccf");
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
    await page.goto("/deadlines");
    await expect(
      page.getByRole("button", { name: "立即同步" }),
    ).toHaveCount(0);
  });

  test("登录后访问 /deadlines：同步按钮可见", async ({ page }) => {
    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);

    await page.goto("/deadlines");
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

    await page.goto("/deadlines");
    await openMenu();
    await expect(
      page.getByRole("menuitem", { name: "添加到我的日历" }),
    ).toHaveCount(0);

    const code = new TOTP({ secret: totpSecret! }).generate();
    await loginWithCode(page, code);
    await page.goto("/deadlines");
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
    await page.goto("/calendar");

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
    await page.goto("/calendar");

    // 动态取「当月某日」（20 号，避免硬编码日期跨月失效）；
    // 日历页默认显示当前月（今天所在月）。REUI 标题格式 zh: yyyy年M月
    const now = new Date();
    const clickDay = now.getDate() <= 20 ? 20 : 15;
    const clickedDate = `${now.getFullYear()}年${now.getMonth() + 1}月${clickDay}日`;

    // 默认未聚焦：下方显示本月及未来日程总览
    await expect(
      page.getByRole("heading", { name: "本月及未来日程" }),
    ).toBeVisible();

    // 等待客户端 hydration 完成（heading 是 SSR 渲染的，此时 React 事件
    // 可能尚未挂载；dispatchEvent 需在 hydration 后才能命中 onSlotClick）
    await page.waitForTimeout(1000);

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
    await page.goto("/calendar");

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
