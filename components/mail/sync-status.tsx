"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { CircleAlertIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { MAIL_ACCOUNTS_CHANGED_EVENT } from "@/components/mail/accounts-dialog";

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

/** 一个文件夹的回填进度 */
interface BackfillFolder {
  path: string;
  remaining: number;
  total: number;
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
    /**
     * 历史回填进度（2026-10-08）：新加账号后的首轮抓取是「最新优先、按块推进」的
     * 倒序回填（见 webmail 仓库 fetcher.ts），这里给出还剩多少封。
     * `null` = 该账号没有待回填的历史（正常态）。
     */
    backfill: {
      remaining: number;
      total: number;
      done: number;
      folder: string;
      folders: BackfillFolder[];
    } | null;
  }[];
}

/** 各账号的回填进度汇总（前端据此显示进度 + 回填期间自动刷新列表） */
export interface BackfillState {
  accounts: { id: string; remaining: number; total: number; folder: string }[];
  remaining: number;
  total: number;
}

/** 轮询间隔：与 webmaild 的 60s 同步周期对齐 */
const POLL_MS = 60_000;
/**
 * **有抓取任务在跑**时的轮询间隔（2026-10-08）：进度条要动起来、列表要跟着刷新，
 * 60s 一跳太钝。两种情形都算「在跑」——① 有历史回填（`backfill`，进度是数字）；
 * ② 有账号首轮还没跑完（`lastSync === null`，进度还数不出来，但确实在下载）。
 * 平静期仍是 60s。
 */
const ACTIVE_POLL_MS = 5_000;
/**
 * 陈旧阈值：距上次成功抓取超过该时长视为异常。
 * mailagentd 兜底轮询 3 分钟一轮、webmaild 60 秒一轮，15 分钟足够宽松（只抓真卡死）。
 */
const STALE_MS = 15 * 60 * 1000;

interface Problem {
  key: string;
  text: string;
  /**
   * 问题来自哪条链路（2026-10-08）：
   * - `webmail` = 邮件同步本身（后台不可达 / 某账号同步失败 / 陈旧）——**可以**占底栏的完整文案位；
   * - `agent`   = mailagentd（agent 后台，另一个子系统）——**永远只做一枚图标**
   *   （用户 2026-10-08 指定：把「agent 服务不可达」缩写成一个感叹号图标）。
   */
  source: "webmail" | "agent";
}

export type SyncStatus =
  | { phase: "loading" }
  | { phase: "ok"; latestNew: string | null }
  // ⚠ 告警态也带上 latestNew（2026-10-08）：agent 后台出问题时**邮件同步本身是好的**，
  //   底栏的文字位显示「上次收到新邮件 x 前」才对（agent 只占一枚图标）；不带着它就只能
  //   在「同步正常」与「告警」里二选一。
  | { phase: "alert"; problems: Problem[]; latestNew: string | null };

export function useSyncStatus(): {
  status: SyncStatus;
  rel: (iso: string) => string;
  backfill: BackfillState | null;
  /** 有账号的首轮同步还没跑完（新加的邮箱正在下载，但还数不出进度） */
  firstSync: boolean;
} {
  const t = useTranslations("mail.sync");
  const [status, setStatus] = useState<SyncStatus>({ phase: "loading" });
  const [backfill, setBackfill] = useState<BackfillState | null>(null);
  const [firstSync, setFirstSync] = useState(false);

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
      setStatus({
        phase: "alert",
        problems: [{ key: "down", text: t("unreachable"), source: "webmail" }],
        latestNew: null,
      });
      return;
    }
    if (!mailagentdUp) problems.push({ key: "agent-down", text: t("agentDown"), source: "agent" });
    if (!webmailUp) problems.push({ key: "webmail-down", text: t("webmailDown"), source: "webmail" });

    // ⚠ 重复写完整条件而非用 mailagentdUp：TS 无法从独立 boolean 反推 PromiseSettledResult 的收窄
    if (mailagentdRes.status === "fulfilled" && mailagentdRes.value.ok) {
      const h = (await mailagentdRes.value.json()) as MailagentdHealth;
      for (const a of h.accounts) {
        if (a.alert) {
          problems.push({
            source: "agent",
            key: `mailagentd-${a.id}`,
            text: a.lastOk
              ? t("fetchFailures", { name: a.displayName, count: a.failures }) +
                ` · ${t("lastOkAt", { time: rel(a.lastOk) })}`
              : t("fetchFailures", { name: a.displayName, count: a.failures }) +
                ` · ${t("lastOkNever")}`,
          });
        } else if (isStale(a.lastOk)) {
          problems.push({
            source: "agent",
            key: `mailagentd-stale-${a.id}`,
            text: a.lastOk
              ? t("stale", { name: a.displayName, time: rel(a.lastOk) })
              : t("stale", { name: a.displayName, time: t("lastOkNever") }),
          });
        }
      }
    }
    let nextBackfill: BackfillState | null = null;
    /** 有账号的**首轮**同步还没跑完（`lastSync === null` 且没报错）——正在下载但数不出进度 */
    let nextFirstSync = false;
    if (webmailRes.status === "fulfilled" && webmailRes.value.ok) {
      const h = (await webmailRes.value.json()) as WebmailHealth;
      const pending: BackfillState["accounts"] = [];
      for (const a of h.accounts) {
        if (!a.enabled) continue;
        considerNew(a.lastNewMail);
        if (a.backfill) {
          pending.push({
            id: a.id,
            remaining: a.backfill.remaining,
            total: a.backfill.total,
            folder: a.backfill.folder,
          });
        }
        if (a.lastError) {
          problems.push({
            source: "webmail",
            key: `webmail-${a.id}`,
            text: t("syncFailed", { name: a.id, reason: a.lastError }),
          });
        } else if (a.lastSync === null) {
          // ⚠ 首次同步还没跑完（lastSync 为 null）**不是告警**（2026-10-08 修）：
          //   新加的账号正在倒序回填，底栏应显示进度（backfill / firstSync），而不是
          //   「已 从未成功 未能同步」这种读起来像故障的文案。真出错时 lastError 有值，
          //   上面那条分支会盖住这里；同步循环一旦跑过一轮，lastSync 就有值、走下面的陈旧判定。
          // ⚠ 新账号加进来的头几秒里 `backfill` 还没有数字（后端刚钉完水位线、第一块还没落库），
          //   但「正在下载」这件事此刻就得让用户看见——否则底栏显示的是「上次收到新邮件 x 前」，
          //   与真相完全相反（2026-10-08：用户加了账号后问「进度在哪」）。
          nextFirstSync = true;
          continue;
        } else if (isStale(a.lastSync)) {
          problems.push({
            source: "webmail",
            key: `webmail-stale-${a.id}`,
            text: t("stale", { name: a.id, time: rel(a.lastSync) }),
          });
        }
      }
      if (pending.length > 0) {
        nextBackfill = {
          accounts: pending,
          remaining: pending.reduce((sum, p) => sum + p.remaining, 0),
          total: pending.reduce((sum, p) => sum + p.total, 0),
        };
      }
    }

    setBackfill(nextBackfill);
    setFirstSync(nextFirstSync);
    if (problems.length > 0) {
      setStatus({ phase: "alert", problems, latestNew });
    } else {
      setStatus({ phase: "ok", latestNew });
    }
  }, [t, rel]);

  // 轮询：平静期 60s；**有抓取任务在跑时 5s**（进度条要动、列表要跟着刷新）
  const active = backfill !== null || firstSync;
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), active ? ACTIVE_POLL_MS : POLL_MS);
    return () => clearInterval(timer);
  }, [load, active]);

  /**
   * 账号增删 / 白名单变更后**立刻**重取一次状态（2026-10-08）。
   *
   * 新账号的首轮抓取进度必须当场出现在底栏——常规轮询是 60s 一拍，只靠它的话用户加完
   * 账号要干等一分钟才看到任何动静（正是「加了账号、不知道有没有在下载」的观感）。
   * 事件由账号管理弹窗在增删/编辑提交成功后广播。
   */
  useEffect(() => {
    const onAccountsChanged = () => void load();
    window.addEventListener(MAIL_ACCOUNTS_CHANGED_EVENT, onAccountsChanged);
    return () => window.removeEventListener(MAIL_ACCOUNTS_CHANGED_EVENT, onAccountsChanged);
  }, [load]);

  return { status, rel, backfill, firstSync };
}

/**
 * 底栏右侧的状态指示 —— **全站唯一的状态显示位置**（2026-10-04 用户指定：
 * 底栏已有状态条，不该再在别处（如面板顶部）新增一条告警栏）。
 *
 * ## 呈现规则（2026-10-08 用户定稿：只完整显示一个）
 *
 * 底栏右端**只把最重要的一条状态写成完整文案**，其余状态缩成一枚图标，鼠标悬浮
 * （或键盘聚焦）才弹出文字说明。起因是用户看到的是
 * 「⟳ 正在同步历史邮件 382/6520 ⚠ agent 服务不可达」两段完整文案并排——又长又吵，
 * 而当时最该看的只有进度。
 *
 * 优先级（`items` 的构造顺序即优先级，渲染时把次级图标排在最左、主状态贴最右）：
 *   1. **正在同步**（历史回填 / 首轮起步）——用户正等着它，且是暂时状态；
 *   2. **邮件同步自身的问题**（webmail：后台不可达 / 某账号同步失败 / 陈旧）
 *      ——第一条完整显示，其余合并进同一枚感叹号；
 *   3. **正常**（绿点 + 上次收到新邮件时间）/ 检查中；
 *   4. **agent 后台的问题**（mailagentd）——**永远只做图标**：它是另一个子系统、
 *      不阻塞收信（用户 2026-10-08 明确要求把「agent 服务不可达」缩成感叹号）。
 * ⚠ 告警即使被挤成图标也**始终可见**（琥珀色感叹号），只是不再占一整行文字。
 * ⚠ 区分「谁该占文字位」靠问题上的 `source` 字段（hook 里打标）。
 *
 * 色调：进行中 = 蓝（信息态、正在干活）、正常 = 绿、告警 = 琥珀、检查中 = 灰。
 * ⚠ 文案 <30rem 视口隐藏只留图标（手机上行宽不够）；`min-w-0` + `truncate`
 *    让长文案收缩而非把左侧统计/账号一览挤出底栏。
 */
type StatusTone = "muted" | "ok" | "info" | "warn";

/** 一条状态：底栏只给优先级最高的那条显示 `text`，其余只在悬停弹窗里给 `detail` */
interface StatusItem {
  key: string;
  tone: StatusTone;
  /** 主状态才显示文案；次级只显示图标 */
  text: string;
  /** 悬停弹窗内容（多条告警合并成一枚图标时是多行） */
  detail: string;
  /** 图标（圆点 / 转圈 / 感叹号） */
  glyph: ReactNode;
  /** 完整文案挂在哪个 data-slot 上（E2E 钩子，沿用历史名字） */
  slot?: string;
  /** 主状态的 `title`（不弹窗也要能 hover 看到细节） */
  title?: string;
}

const TONE_TEXT: Record<StatusTone, string> = {
  muted: "text-muted-foreground",
  // 「同步」相关的一律绿：正常态与进行中都是同一个绿色（用户 2026-10-08 第二轮指定
  // 「正在同步邮件改为绿色」）。区分靠图标（转圈 = 正在干活 / 绿点 = 已同步完），
  // 不靠颜色——绿=一切正常在同步，琥珀=出问题了，一眼就能分开。
  ok: "text-emerald-700 dark:text-emerald-400",
  info: "text-emerald-700 dark:text-emerald-400",
  warn: "text-amber-700 dark:text-amber-400",
};

/** 绿点 / 灰点（正常与检查中） */
function Dot({ tone }: { tone: "ok" | "muted" }) {
  return (
    <span
      data-slot="mail-sync-dot"
      className={cn(
        "size-2 shrink-0 rounded-full",
        tone === "ok" ? "bg-emerald-600 dark:bg-emerald-400" : "bg-muted-foreground/40",
      )}
      aria-hidden
    />
  );
}

export function SyncStatusIndicator({
  status,
  rel,
  backfill,
  firstSync,
  className,
}: {
  status: SyncStatus;
  rel: (iso: string) => string;
  backfill?: BackfillState | null;
  /** 有账号首轮同步还没跑完（进度数字还出不来）——见 useSyncStatus */
  firstSync?: boolean;
  className?: string;
}) {
  const t = useTranslations("mail.sync");

  // 按优先级构造（第 0 条 = 底栏完整显示的那条；其余都只做图标）
  //
  // 优先级（2026-10-08 用户定稿）：① 正在同步 → ② 邮件同步自身的问题（webmail）
  // → ③ 正常/检查中基线 → ④ agent 后台的问题（**永远只做图标**）。
  // ⚠ ④ 排最后是刻意的：用户明确要求把「agent 服务不可达」缩成一枚感叹号，
  //   而它也确实与「我的邮件在不在同步」无关（mailagentd 是另一个子系统）。
  const items: StatusItem[] = [];

  if (backfill) {
    // 历史回填进行中（2026-10-08）：数字比「同步正常」有用得多
    items.push({
      key: "backfill",
      tone: "info",
      glyph: <Spinner className="size-3 shrink-0" aria-hidden />,
      text: t("backfilling", {
        done: Math.max(0, backfill.total - backfill.remaining),
        total: backfill.total,
      }),
      detail: backfill.accounts.map((a) => `${a.id} · ${a.folder}`).join("\n"),
      slot: "mail-sync-backfill",
      title: backfill.accounts.map((a) => `${a.id} · ${a.folder}`).join("\n"),
    });
  } else if (firstSync) {
    // 首轮刚起步、还数不出 x/y：此刻显示「上次收到新邮件」正好与事实相反
    items.push({
      key: "first-sync",
      tone: "info",
      glyph: <Spinner className="size-3 shrink-0" aria-hidden />,
      text: t("firstSync"),
      detail: t("firstSync"),
      slot: "mail-sync-first-sync",
    });
  }

  const alerting = status.phase === "alert";
  const syncProblems = alerting ? status.problems.filter((p) => p.source === "webmail") : [];
  const agentProblems = alerting ? status.problems.filter((p) => p.source === "agent") : [];

  // 邮件同步自身的问题：没有同步在跑时占完整文案位（第一条 + 「+N」，完整列表在 title）
  if (syncProblems.length > 0) {
    const detail = syncProblems.map((p) => p.text).join("\n");
    items.push({
      key: "alert",
      tone: "warn",
      glyph: (
        <CircleAlertIcon data-slot="mail-sync-alert-icon" className="size-3.5 shrink-0" aria-hidden />
      ),
      text: `${syncProblems[0].text}${syncProblems.length > 1 ? ` +${syncProblems.length - 1}` : ""}`,
      detail,
      slot: "mail-sync-alert-text",
      title: detail,
    });
  }

  // 基线（正常 / 检查中）：判据是「**邮件同步链路**没有问题」——注意不是「没有任何问题」：
  // ⚠ agent 后台的问题不影响这里（它拿不到 latestNew 吗？拿得到，webmail 是好的），
  //   所以「agent 不可达 + 同步正常」时底栏照样显示「上次收到新邮件 x 前」，
  //   agent 那枚感叹号只是排在它左边（2026-10-08 用户要求）。
  // ⚠ 邮件后台不可达时还说「同步正常」是错的（历史实现也是这个口径），故排除。
  // ⚠ 正在同步时**也不放**这枚绿点：蓝色转圈已经说明「在干活」，再挂一个绿点只是噪音
  //   （2026-10-08 用户要的是「一屏只完整显示一条、其余最多一枚图标」）。
  const progressing = !!backfill || !!firstSync;
  if (syncProblems.length === 0 && !progressing) {
    if (status.phase === "loading") {
      items.push({
        key: "loading",
        tone: "muted",
        glyph: <Dot tone="muted" />,
        text: t("checking"),
        detail: t("checking"),
        // ⚠ 检查中**不占用** `mail-sync-latest`：那个 slot 的语义是「正常态文案」，
        //   复用它会让「正常态文案不出现」这类断言在检查中阶段假通过（2026-10-08）
        slot: "mail-sync-checking",
      });
    } else {
      const latestNew = "latestNew" in status ? status.latestNew : null;
      const text = latestNew ? t("lastNewMail", { time: rel(latestNew) }) : t("ok");
      items.push({
        key: "ok",
        tone: "ok",
        glyph: <Dot tone="ok" />,
        text,
        detail: text,
        slot: "mail-sync-latest",
      });
    }
  }

  // agent 后台的问题：只做图标（悬停/聚焦弹文字）——它不阻塞邮件同步，不该抢文案位
  if (agentProblems.length > 0) {
    const detail = agentProblems.map((p) => p.text).join("\n");
    items.push({
      key: "agent",
      tone: "warn",
      glyph: (
        <CircleAlertIcon data-slot="mail-sync-alert-icon" className="size-3.5 shrink-0" aria-hidden />
      ),
      text: detail,
      detail,
    });
  }

  const [primary, ...secondary] = items;
  if (!primary) return null;

  return (
    <span
      data-slot="mail-sync-status"
      className={cn("flex min-w-0 items-center gap-1.5 text-xs", className)}
    >
      {/* 主状态在前（**状态指示器从左往右第一条**）、次级图标排它右边（2026-10-08 第二轮
          用户定稿）：反过来的话，右边那枚感叹号看起来像在「修饰」左边那句同步文案，
          容易被读成「同步出问题了」。整组仍然贴底栏右端（`ml-auto` 在外层）。 */}
      <span
        data-slot="mail-sync-primary"
        className={cn("flex min-w-0 items-center gap-1.5", TONE_TEXT[primary.tone])}
      >
        {primary.glyph}
        <span
          data-slot={primary.slot}
          role="status"
          title={primary.title}
          className={cn(
            "hidden min-w-0 truncate min-[30rem]:inline",
            primary.tone === "info" || primary.tone === "warn" ? "tabular-nums" : undefined,
          )}
        >
          {primary.text}
        </span>
      </span>
      {/* 主状态与次级图标之间的**竖分隔线**（2026-10-08 第二轮用户要求「不同状态之间
          要有清晰的间隔」）：没有它时「⟳ 正在同步历史邮件 3072/6520 ⚠」读起来像一整句，
          感叹号容易被当成在修饰同步状态。沿用站内导航那条竖线的做法（`w-px bg-border`）。 */}
      {secondary.length > 0 && (
        <span
          data-slot="mail-sync-sep"
          aria-hidden
          className="mx-0.5 h-3 w-px shrink-0 self-center bg-border"
        />
      )}
      {/* 次级状态：**只显示图标**，鼠标悬浮看文字说明。
          ⚠ 用**原生 `title`**（2026-10-08 第二轮用户反馈「悬浮弹窗样式跟站内别处都不一样」）：
          站内邮件界面 42 处悬浮文字全是原生 title（只有 FAB / 日历 / CCF 目录三处用
          `components/ui/tooltip` 的深色气泡），底栏也用原生 title 才不突兀。
          `aria-label` 同时给读屏（原生 title 对键盘/读屏不可靠）。 */}
      {secondary.map((item) => (
        <span
          key={item.key}
          data-slot="mail-sync-issue"
          aria-label={item.detail}
          title={item.detail}
          className={cn("flex size-4 shrink-0 items-center justify-center", TONE_TEXT[item.tone])}
        >
          {item.glyph}
        </span>
      ))}
    </span>
  );
}
