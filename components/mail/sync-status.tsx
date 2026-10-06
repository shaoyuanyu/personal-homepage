"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { CircleAlertIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * 同步健康状态（MAIL-AGENT.md 5.5）：列表底栏内的紧凑指示。
 *
 * 后台批处理最怕安静失效——专用密码过期、服务商改 IMAP 策略，表现都是
 * 「没报错但也收不到信」。这里合并两条链路的健康数据：
 *   - mailagentd `GET /api/mail/agent/health`：IDLE 抓取链（上次成功 / 连续失败 / 连接状态）
 *   - webmaild `GET /api/mail/health`：合并视图同步链（lastSync / lastError / lastNewMail）
 *
 * 呈现（2026-10-04 定稿，先后两版被用户打回：页顶独立横条太突兀、
 * 工具栏账号行右侧在账号多时挤 chips；随后确定底栏贯通、统计在左/状态在右）：
 *   - 底栏右侧 = 小圆点 + 「上次收到新邮件 x 前」（12px muted；从未收到 = 「同步正常」）；
 *     窄屏只留圆点。⚠ 显示的时间是「抓进新邮件」的时刻（webmaild lastNewMail），
 *     不是同步心跳（60s 一轮恒新鲜，显示它永远「刚刚」无信息量）。
 *   - 底栏左侧 = 列表统计（已加载 / 未读），由 MailStatusbar 渲染。
 *   - 异常态 = 指示变告警图标 + 「同步异常」，底栏上方展开**无边框**告警行
 *     （沿用加载错误行的版式），逐条列出问题。
 * 告警通道刻意不依赖邮件（凭据失效时邮件通道自己也坏了）。
 *
 * 拆成 hook + 两个展示组件的原因：指示在底栏内、告警行在底栏上方，
 * 两处 DOM 位置不同但必须共享同一份轮询状态（各 poll 一份会双倍请求且互相打架）。
 */

interface MailagentdHealth {
  ok: boolean;
  threshold: number;
  accounts: {
    id: string;
    displayName: string;
    email: string;
    lastOk: string | null;
    failures: number;
    lastError: string | null;
    connected: boolean;
    alert: boolean;
  }[];
}

interface WebmailHealth {
  ok: boolean;
  accounts: {
    id: string;
    enabled: boolean;
    lastSync: string | null;
    lastError: string | null;
    /** 上次实际抓进新邮件的时刻（安静期不变，可能为 null） */
    lastNewMail: string | null;
  }[];
}

/** 轮询间隔：与 webmaild 的 60s 同步周期对齐 */
const POLL_MS = 60_000;
/**
 * 陈旧阈值：距上次成功抓取超过该时长视为异常。
 * mailagentd 兜底轮询 3 分钟一轮、webmaild 60 秒一轮，15 分钟足够宽松（只抓真卡死）。
 */
const STALE_MS = 15 * 60 * 1000;

interface Problem {
  key: string;
  text: string;
}

export type SyncStatus =
  | { phase: "loading" }
  | { phase: "ok"; latestNew: string | null }
  | { phase: "alert"; problems: Problem[] };

export function useSyncStatus(): { status: SyncStatus; rel: (iso: string) => string } {
  const t = useTranslations("mail.sync");
  const [status, setStatus] = useState<SyncStatus>({ phase: "loading" });

  const rel = useCallback(
    (iso: string): string => {
      const diff = Math.max(0, Date.now() - new Date(iso).getTime());
      const minutes = Math.floor(diff / 60_000);
      if (minutes < 1) return t("justNow");
      if (minutes < 60) return t("minutesAgo", { count: minutes });
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return t("hoursAgo", { count: hours });
      return t("daysAgo", { count: Math.floor(hours / 24) });
    },
    [t],
  );

  const load = useCallback(async () => {
    const problems: Problem[] = [];
    // 全部源里最近的一次「抓进新邮件」（ISO Z 结尾，字典序即时间序）。
    // ⚠ 显示时间只取 lastNewMail：lastSync/lastOk 是 60s/3min 一轮的同步心跳，
    // 恒新鲜、永远显示「刚刚」没有信息量（2026-10-04 用户反馈）；心跳仍用于
    // 下面的陈旧/失败判定（那才是它的职责）。
    let latestNew: string | null = null;
    const considerNew = (iso: string | null) => {
      if (iso && (!latestNew || iso > latestNew)) latestNew = iso;
    };
    const isStale = (iso: string | null): boolean =>
      !iso || Date.now() - new Date(iso).getTime() > STALE_MS;

    const [mailagentdRes, webmailRes] = await Promise.allSettled([
      fetch("/api/mail/agent/health", { cache: "no-store" }),
      fetch("/api/mail/health", { cache: "no-store" }),
    ]);
    const mailagentdUp = mailagentdRes.status === "fulfilled" && mailagentdRes.value.ok;
    const webmailUp = webmailRes.status === "fulfilled" && webmailRes.value.ok;

    if (!mailagentdUp && !webmailUp) {
      setStatus({ phase: "alert", problems: [{ key: "down", text: t("unreachable") }] });
      return;
    }
    if (!mailagentdUp) problems.push({ key: "agent-down", text: t("agentDown") });
    if (!webmailUp) problems.push({ key: "webmail-down", text: t("webmailDown") });

    // ⚠ 重复写完整条件而非用 mailagentdUp：TS 无法从独立 boolean 反推 PromiseSettledResult 的收窄
    if (mailagentdRes.status === "fulfilled" && mailagentdRes.value.ok) {
      const h = (await mailagentdRes.value.json()) as MailagentdHealth;
      for (const a of h.accounts) {
        if (a.alert) {
          problems.push({
            key: `mailagentd-${a.id}`,
            text: a.lastOk
              ? t("fetchFailures", { name: a.displayName, count: a.failures }) +
                ` · ${t("lastOkAt", { time: rel(a.lastOk) })}`
              : t("fetchFailures", { name: a.displayName, count: a.failures }) +
                ` · ${t("lastOkNever")}`,
          });
        } else if (isStale(a.lastOk)) {
          problems.push({
            key: `mailagentd-stale-${a.id}`,
            text: a.lastOk
              ? t("stale", { name: a.displayName, time: rel(a.lastOk) })
              : t("stale", { name: a.displayName, time: t("lastOkNever") }),
          });
        }
      }
    }
    if (webmailRes.status === "fulfilled" && webmailRes.value.ok) {
      const h = (await webmailRes.value.json()) as WebmailHealth;
      for (const a of h.accounts) {
        if (!a.enabled) continue;
        considerNew(a.lastNewMail);
        if (a.lastError) {
          problems.push({
            key: `webmail-${a.id}`,
            text: t("syncFailed", { name: a.id, reason: a.lastError }),
          });
        } else if (isStale(a.lastSync)) {
          problems.push({
            key: `webmail-stale-${a.id}`,
            text: a.lastSync
              ? t("stale", { name: a.id, time: rel(a.lastSync) })
              : t("stale", { name: a.id, time: t("lastOkNever") }),
          });
        }
      }
    }

    if (problems.length > 0) {
      setStatus({ phase: "alert", problems });
    } else {
      setStatus({ phase: "ok", latestNew });
    }
  }, [t, rel]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  return { status, rel };
}

/**
 * 底栏右侧的状态指示 —— **全站唯一的状态显示位置**（2026-10-04 用户指定：
 * 底栏已有状态条，不该再在别处（如面板顶部）新增一条告警栏）。
 *
 * 三态：圆点（绿=正常 / 灰=检查中）+ 上次抓取时间；异常时琥珀图标 +
 * **第一条（最严重）告警的完整文案**（不再是「同步异常」这类短标签——
 * 用户 2026-10-04 指定直接用具体文案，如「邮件后台服务不可达，新邮件抓取已暂停」）。
 * 多条告警时显示第一条 + 「+N」，完整列表在 `title`（hover 可见）。
 * ⚠ 文案 <30rem 视口隐藏只留图标（手机上行宽不够）；`min-w-0` + `truncate`
 *    让长文案收缩而非把左侧统计/账号一览挤出底栏。
 */
export function SyncStatusIndicator({
  status,
  rel,
  className,
}: {
  status: SyncStatus;
  rel: (iso: string) => string;
  className?: string;
}) {
  const t = useTranslations("mail.sync");
  return (
    <span
      data-slot="mail-sync-status"
      className={cn("flex min-w-0 items-center gap-1.5 text-xs", className)}
    >
      {status.phase === "loading" && (
        <>
          <span
            data-slot="mail-sync-dot"
            className="size-2 rounded-full bg-muted-foreground/40"
            aria-hidden
          />
          <span className="hidden text-muted-foreground min-[30rem]:inline">{t("checking")}</span>
        </>
      )}
      {status.phase === "ok" && (
        <>
          <span
            data-slot="mail-sync-dot"
            className="size-2 rounded-full bg-emerald-600 dark:bg-emerald-400"
            aria-hidden
          />
          <span
            data-slot="mail-sync-latest"
            className="hidden tabular-nums text-muted-foreground min-[30rem]:inline"
          >
            {status.latestNew ? t("lastNewMail", { time: rel(status.latestNew) }) : t("ok")}
          </span>
        </>
      )}
      {status.phase === "alert" && (
        <>
          <CircleAlertIcon
            className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden
          />
          <span
            data-slot="mail-sync-alert-text"
            role="status"
            title={status.problems.map((p) => p.text).join("\n")}
            className="hidden min-w-0 truncate text-amber-700 min-[30rem]:inline dark:text-amber-400"
          >
            {status.problems[0].text}
            {status.problems.length > 1 ? ` +${status.problems.length - 1}` : ""}
          </span>
        </>
      )}
    </span>
  );
}
