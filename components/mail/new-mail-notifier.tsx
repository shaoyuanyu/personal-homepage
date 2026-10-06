"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import { OWNER_AUTH_CHANGED_EVENT, OWNER_CACHE_KEY } from "@/lib/auth/events";
import { toast } from "@/components/ui/toast";

/**
 * 新邮件到达的全局提醒（2026-10-06 用户需求）。
 *
 * 两个协作组件 + 两个 window 事件（同页组件解耦）：
 * - `MailNewMailWatcher`（挂在 `Providers`，**全站**）：每 30s 拉一次
 *   `/api/mail/accounts` 汇总未读；与上次基线相比有新增 → toast 弹窗提醒
 *   （于是在写邮件页、博客等任何页面都能收到提醒）+ 广播 `mail:new-mail`；
 *   每次拉取都广播 `mail:unread`（未读总数）供角标订阅。
 * - `MailUnreadBadge`（/mail 的 h1 右上角）：订阅上述事件，显示未读总数，
 *   新邮件到达时播放一次「弹跳」动画（重挂载触发 CSS keyframes 重播）。
 *
 * ⚠ 游客**一个请求都不发**（2026-10-06 修复）：先用 localStorage 缓存
 *   （`OWNER_CACHE_KEY`，与首帧内联脚本/OwnerNavItem 同一份）判定身份，
 *   非站主直接不启动轮询；登录/登出由 `owner-auth-changed` 事件重启判定。
 *   **勿改回「先请求、收到 401 再停」**——那两个 401 会在游客浏览器的
 *   控制台留下 Failed to load resource 错误（E2E「页面无控制台错误」变红）。
 * ⚠ 轮询是**本机回环**请求（Next 路由 → webmaild），成本极低；30s 与 webmaild
 *   的 60s 同步周期配合，新邮件最迟约 1 分半内弹提醒。
 */
export const MAIL_UNREAD_EVENT = "mail:unread";
export const MAIL_NEW_MAIL_EVENT = "mail:new-mail";

/** 轮询间隔（webmaild 同步周期 60s 的一半，保证提醒即使隔一轮也有存在感） */
const POLL_MS = 30_000;

/** 是否已知为站主：读与首帧内联脚本、OwnerNavItem 同一份 localStorage 缓存 */
const isKnownOwner = () => {
  try {
    return window.localStorage.getItem(OWNER_CACHE_KEY) === "1";
  } catch {
    return false; // localStorage 不可用（隐私模式等）：按游客处理，宁可不轮询
  }
};

/**
 * 「真·新邮件」信号 = webmaild /health 的每账号 `lastNewMail`（同步器**实际抓进
 * 新邮件**才推进的时刻）。
 *
 * ⚠ 勿改回「未读总数上升就提示」——未读总数会因为**任何**未读操作上升，最典型的是
 * 用户自己点「标为未读」（列表行内与详情页都有），于是每标一次就弹一条假的
 * 「收到 N 封新邮件」（2026-10-06 用户实测时页面上叠了三条假提醒）。
 * `lastNewMail` 只在同步抓到新邮件时前进，标未读/读信等 flag 变更不触发它。
 */
interface HealthAccount {
  id: string;
  enabled: boolean;
  lastNewMail: string | null;
}
interface HealthResponse {
  ok: boolean;
  accounts: HealthAccount[];
}

export function MailNewMailWatcher() {
  const t = useTranslations("mail");

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    /** 上次的未读基线：null = 尚未建立（首次拉取只做基线，不提示）；只用于提醒文案里的封数 */
    let lastTotal: number | null = null;
    /** 各账号上次看到的 lastNewMail（真·新邮件信号；首轮只建基线不提示） */
    let lastNewMailSeen: Map<string, string | null> | null = null;

    const clearTimer = () => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };

    const poll = async () => {
      if (disposed) return;
      // 游客不发请求（见文件头 ⚠）：宁可不轮询，也不留 401 控制台错误
      if (!isKnownOwner()) return;
      let data: unknown;
      let health: HealthResponse | null = null;
      try {
        // /accounts = 未读总数（角标）；/health =「真·新邮件」信号（见上方注释）。
        // health 失败不影响未读广播（角标仍要更新），只是本轮不做新邮件判定。
        const [accountsRes, healthRes] = await Promise.all([
          fetch("/api/mail/accounts", { cache: "no-store" }),
          fetch("/api/mail/health", { cache: "no-store" }).catch(() => null),
        ]);
        if (disposed) return;
        // 游客 / 会话过期：停止轮询（登录后由 auth 事件重启）
        if (accountsRes.status === 401) {
          clearTimer();
          return;
        }
        if (!accountsRes.ok) return; // 服务暂不可用：静默，下轮再试
        data = await accountsRes.json();
        if (healthRes?.ok) health = (await healthRes.json()) as HealthResponse;
      } catch {
        return; // 网络失败：静默，下轮再试
      }
      if (disposed) return;
      const total = (Array.isArray(data) ? data : [])
        .filter((a) => (a as { enabled?: boolean }).enabled !== false)
        .reduce((sum, a) => sum + ((a as { unread?: number }).unread ?? 0), 0);

      window.dispatchEvent(new CustomEvent(MAIL_UNREAD_EVENT, { detail: { total } }));

      if (health) {
        const nextSeen = new Map<string, string | null>();
        let advanced = false;
        for (const a of health.accounts ?? []) {
          if (a.enabled === false) continue;
          nextSeen.set(a.id, a.lastNewMail ?? null);
          const prev = lastNewMailSeen?.get(a.id);
          // 只在两边都有时间戳、且严格前进时才判定（null → 时间的首次建立不算）
          if (prev && a.lastNewMail && a.lastNewMail > prev) advanced = true;
        }
        const hadBaseline = lastNewMailSeen !== null; // 首轮只建基线不提示
        lastNewMailSeen = nextSeen;
        if (hadBaseline && advanced) {
          const delta = lastTotal !== null && total > lastTotal ? total - lastTotal : 1;
          window.dispatchEvent(new CustomEvent(MAIL_NEW_MAIL_EVENT, { detail: { delta } }));
          toast.add({ title: t("newMailToast", { count: delta }), type: "info" });
        }
      }
      lastTotal = total;
    };

    const start = () => {
      clearTimer();
      if (!isKnownOwner()) return; // 游客：连轮询都不启动（登录后由 auth 事件重启）
      void poll();
      timer = window.setInterval(() => void poll(), POLL_MS);
    };

    start();
    // 切回标签页立即重取（用户回来第一眼就看到最新未读，不用等下个轮询周期；
    // E2E 也借它触发「模拟新邮件到达 → 提醒」的时序）
    const onVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    // 登录 / 登出后重新判定（游客期间停掉的轮询在登录后必须复活）
    const onAuth = () => {
      lastTotal = null; // 重建基线（登录后首次拉取不误报）
      start();
    };
    window.addEventListener(OWNER_AUTH_CHANGED_EVENT, onAuth);
    return () => {
      disposed = true;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(OWNER_AUTH_CHANGED_EVENT, onAuth);
    };
  }, [t]);

  return null;
}

/**
 * `/mail` 大标题右上角的未读角标（上标形态）。数据 = `mail:unread` 事件的未读总数
 * （watcher 轮询 / MailClient 读信后的广播都会更新它）；0 或未知时不渲染。
 * 新邮件（`mail:new-mail`）到达时重挂载一次元素，让 CSS 弹跳动画重播
 * （动画本身在 globals.css 的 `.mail-unread-pop`）。
 */
export function MailUnreadBadge() {
  const t = useTranslations("mail");
  const [total, setTotal] = useState<number | null>(null);
  const [popKey, setPopKey] = useState(0);

  useEffect(() => {
    const onUnread = (e: Event) => {
      const value = (e as CustomEvent<{ total?: unknown }>).detail?.total;
      if (typeof value === "number") setTotal(value);
    };
    const onNewMail = () => setPopKey((k) => k + 1);
    window.addEventListener(MAIL_UNREAD_EVENT, onUnread);
    window.addEventListener(MAIL_NEW_MAIL_EVENT, onNewMail);
    return () => {
      window.removeEventListener(MAIL_UNREAD_EVENT, onUnread);
      window.removeEventListener(MAIL_NEW_MAIL_EVENT, onNewMail);
    };
  }, []);

  if (total === null || total <= 0) return null;
  return (
    <span
      key={popKey}
      data-slot="mail-unread-count"
      aria-label={t("unreadBadge", { count: total })}
      className={cn(
        "ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-600 px-1.5 align-super text-xs font-medium text-white tabular-nums dark:bg-blue-400 dark:text-blue-950",
        popKey > 0 && "mail-unread-pop",
      )}
    >
      {total}
    </span>
  );
}
