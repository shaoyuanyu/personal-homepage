"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import {
  ArrowDownLeftIcon,
  ArrowLeftIcon,
  ArrowUpRightIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  DownloadIcon,
  FileCode2Icon,
  OctagonAlertIcon,
  ForwardIcon,
  MailOpenIcon,
  MailIcon,
  MoreHorizontalIcon,
  PrinterIcon,
  ReplyAllIcon,
  ReplyIcon,
  SendIcon,
  StarIcon,
  Trash2Icon,
  UserCheckIcon,
  UserPlusIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Link, useRouter } from "@/lib/i18n/navigation";
import { encodeMessageId, MAIL_LIST_ORDER_KEY } from "@/lib/mail/id";
import { isSentItem } from "@/lib/mail/kind";
import { mailNavOptions } from "@/lib/mail/nav";
import { MOTION_SIZE, TOOLBAR_MS } from "@/components/mail/motion";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ButtonGroup } from "@/components/ui/button-group";
import { buttonVariants } from "@/components/ui/button";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { mailErrorText } from "@/lib/mail/error-text";
import type {
  MailAddress,
  MailDetail,
  MailListItem,
} from "@/lib/mail/types";

/**
 * 会话列表「一行」的高度下限（px）：行是 `py-2` × 2 + `text-sm` 行高 20 + 1px 分隔线 ≈ 37。
 * 被压缩到不足一行时宁可整块折叠——露出半行文字的滚动条既看不清也点不准（见自动折叠）。
 */
const THREAD_ROW_MIN_PX = 36;

/**
 * 邮件状态变更广播（详情页 → 列表，2026-10-06 用户报障修复）。
 *
 * 根因：详情页的「标为未读」等操作只写服务器与右栏自己的状态，**左栏列表行与
 * 未读计数（h1 角标 / 未读开关上标 / 底栏）完全不知道**——于是在详情里标了未读，
 * 左栏同一行仍显示已读，看起来像「操作失效，实际效果还是已读」（用户原话）。
 * MailClient 监听本事件：刷新计数 + 更新/移除对应行（生效中的筛选相关时整表重取）。
 */
export const MAIL_ITEM_CHANGED_EVENT = "mail:item-changed";

export interface MailItemChange {
  messageId: string;
  seen?: boolean;
  flagged?: boolean;
  /** 删除：列表直接移除该行 */
  deleted?: boolean;
}

function broadcastItemChange(change: MailItemChange): void {
  window.dispatchEvent(new CustomEvent(MAIL_ITEM_CHANGED_EVENT, { detail: change }));
}

function fmtAddress(list: MailAddress[]): string {
  return list.map((a) => (a.name ? `${a.name} <${a.address}>` : (a.address ?? ""))).join(", ");
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 绝对日期时间（2026-10-04 用户指定）：详情页显示具体发出时间，
 * 不用「1 天前」这类相对措辞——读信场景要的是确切时间点。
 */
function absDateTime(dateIso: string | null, localeTag: string): string {
  if (!dateIso) return "";
  return new Date(dateIso).toLocaleString(localeTag, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 操作栏按钮的**可见标签**：外层容器（操作栏，`@container`）窄于 36rem 时整条标签隐藏、
 * 只留图标（2026-10-07 用户指定：「空间不够就只显示图标不显示文字」）。
 *
 * 36rem = 576px 是算出来的：右组带文字时要 540px，加上最左端那个「更多」（28px + gap）
 * 约 36px —— 容器一旦放不下就退成图标。实测容器宽：1024 视口 ≈ 494px（图标态）、
 * 1152 视口 ≈ 622px、≥1230 视口 ≈ 637px（文字态）。
 *
 * ⚠ 与标签一起给的还有 `aria-label` / `title`——`display:none` 的文本**不进可访问名**，
 * 没有 aria-label 的按钮在窄窗下会变成「没有名字的按钮」（读屏与 E2E 都会失明）。
 */
function ActionLabel({ children }: { children: ReactNode }) {
  return <span className="hidden @min-[36rem]:inline">{children}</span>;
}

/** 收件人 / 抄送行（4.9）：超过 2 个折叠为「等 N 人」，点击展开 / 收起 */
function AddressRow({ label, list }: { label: string; list: MailAddress[] }) {
  const t = useTranslations("mail");
  const [expanded, setExpanded] = useState(false);
  const collapsed = list.length > 2 && !expanded;
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all">
        {fmtAddress(collapsed ? list.slice(0, 2) : list)}
        {list.length > 2 && (
          <button
            type="button"
            className="ml-1.5 text-xs text-primary hover:underline"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? t("showLess") : t("andOthers", { count: list.length - 2 })}
          </button>
        )}
      </dd>
    </div>
  );
}

/** 单封邮件视图：详情 + 操作（回复 / 标记 / 删除）+ 远程图片逐封加载（4.4） */
export function MessageView({ messageId }: { messageId: string }) {
  const t = useTranslations("mail");
  const router = useRouter();

  const [detail, setDetail] = useState<MailDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [acting, setActing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  // 手动操作过 seen 的护栏（2026-10-06）：打开邮件时那次后台「标已读」的写回
  // 要连阿里云 IMAP（秒级），用户若在它落地前点了「标为未读」，这条晚到的响应
  // 会把刚设成未读的本地/列表状态覆写回已读——手动操作一旦发生，它就不再是
  // 状态的来源（服务端顺序上手动那次在后，最终状态本就是未读）。
  const seenTouchedRef = useRef(false);
  const [remoteShown, setRemoteShown] = useState(false);
  // 同会话邮件（4.7：元数据列表，按时间升序）
  const [thread, setThread] = useState<MailListItem[] | null>(null);
  // 「上一封 / 下一封」（4.9）：列表页写入 sessionStorage 的顺序，失配则隐藏
  const [siblings, setSiblings] = useState<{ prev?: string; next?: string }>({});
  // 页内快速回复（4.9）
  const [quickText, setQuickText] = useState("");
  const [quickSending, setQuickSending] = useState(false);
  // 快速回复折叠（2026-10-06 用户要求）：默认收起——常读信时不需要每封邮件底部
  // 都摊着一个输入框；展开后才显示输入框与发送行。状态是组件内存态，切走再回来
  // 回到收起位（有意如此，不持久化）。
  const [quickOpen, setQuickOpen] = useState(false);
  /**
   * 会话折叠 + 内部滚动（2026-10-09 用户要求）。
   *
   * 用户给的三条优先级（正文永远优先）：
   *   ① 正文装不下时，**先折叠「会话」**，而不是让正文变成滚动区；
   *   ② 用户主动展开会话后，若正文空间不够，**先让会话自己滚**（封顶、内部滚动）；
   *   ③ 连会话都压到下限还不够，才让正文也滚。
   *
   * 三条各自落在哪：
   *   ① = 下面这个 `useLayoutEffect`：量到正文要滚（`scrollHeight > clientHeight`）
   *       就把会话收起来（一帧都不闪，故用 layout effect）；列表被压得不足一行时
   *       同样收起来（半行文字的滚动条不如直接折叠干净）。
   *   ② = `lg:min-h-[7.5rem]`（仅「用户亲手展开」时挂）：给会话一个 ~3 行的下限，
   *       压缩到 7.5rem 就停下、列表自己滚（`overflow-y-auto`）；
   *   ③ = 会话的下限被占满后，剩余缺口才轮到正文（`lg:min-h-[6rem]` + 自身滚动），
   *       正文也到底了才退回外层（右栏 `overflow-y-auto`）滚动。
   *
   * ⚠ **「谁先让位」是靠 flex 收缩权重实现的，不是靠测量**：会话 `lg:shrink-[1000]`、
   *   正文保持默认的 1——缺口先被会话按权重吃掉（收到自己的 min-height 就冻结），
   *   冻结之后剩下的缺口才轮到正文。这样"让位"是连续的（会话高度 = 剩余空间），
   *   不依赖任何尺寸缓存，也不会在窗口缩放时算出过期结论。
   *   自动折叠只量一件事：正文最终是不是真的装不下——这正是用户的原话。
   *
   * ⚠ 自动折叠**只收不放**（一封信只判断一次，且用户碰过开关后完全不再插手）：
   *   若它还会自动展开，就与"用户手动展开 → 正文变挤 → 又自动收起"形成来回抖动。
   *   换一封信时回到默认展开（见下面的 thread 请求 effect）。
   */
  const [threadOpen, setThreadOpen] = useState(true);
  /** 用户是否亲手拨过会话开关；拨过之后自动折叠不再插手（用户意志优先） */
  const [threadTouched, setThreadTouched] = useState(false);
  const threadListRef = useRef<HTMLUListElement>(null);

  /** 这封信的副本分布在哪些账号（标为垃圾邮件后按账号各催一次同步） */
  const copyAccountIds = useMemo(
    () => [...new Set((detail?.copies ?? []).map((c) => c.accountId))],
    [detail?.copies],
  );

  /**
   * 标为垃圾邮件（2026-10-07 用户定稿：详情页只保留这一个整理动作）。
   *
   * - 目标给的是**特殊用途记号** `\Junk`，不是路径：各家叫法不同（阿里云「垃圾邮件」、
   *   Gmail `[Gmail]/Spam`），由 webmaild 在目标账号上探测（RFC 6154 标志位 → 常见名
   *   回退）。前端因此不必先 LIST 一遍文件夹，也不会因为清单过期而搬错地方——
   *   这正是原来的「移动」下拉被删掉后仍需保留的能力。
   * - 一封邮件可能在多个账号各有一份：服务端按账号分别处理（哪个账号没有垃圾文件夹就
   *   跳过它并记 `skipped`，不阻断其它账号）。
   * - `affected` = 真正搬动的副本数；0 且无 skipped = 它本来就在垃圾邮件里（不该报失败）。
   * - 成功后回列表：本地索引已把被搬走的副本按「源位置不存在」处理，目标文件夹的新副本
   *   要等下一轮同步才被发现——顺手催一次，让手机/网页端尽快看到。
   */
  const markJunk = useCallback(async () => {
    if (!detail) return;
    setActing(true);
    try {
      const res = await fetch("/api/mail/move", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ copies: detail.copies, to: "\\Junk" }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `${res.status}`);
      const data = (await res.json()) as { affected: number; skipped?: { reason: string }[] };
      const skipped = data.skipped ?? [];
      if (skipped.length > 0) {
        toast.add({ title: t("junkFailed"), description: skipped[0].reason, type: "error" });
      }
      if (data.affected === 0) {
        if (skipped.length === 0) toast.add({ title: t("moveSameFolder") });
        setActing(false);
        return;
      }
      broadcastItemChange({ messageId, deleted: true });
      toast.add({ title: t("junkDone"), type: "success" });
      for (const accountId of copyAccountIds) {
        void fetch("/api/mail/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountId }),
        }).catch(() => {});
      }
      router.push("/mail", mailNavOptions());
    } catch (err) {
      toast.add({
        title: t("junkFailed"),
        description: err instanceof Error ? err.message : String(err),
        type: "error",
      });
      setActing(false);
    }
  }, [detail, messageId, router, t, copyAccountIds]);

  /**
   * 原始邮件（2026-10-07，取证用）：工具栏「原始邮件」打开对话框，展示**原始头部行**
   * （按邮件里的顺序与折行）并提供 .eml 下载。普通账号此前完全没有这条路——只有 agent
   * 只读页能看原始邮件，而排查「这封信到底是谁发的、什么时候到的」必须看头部。
   */
  const [rawOpen, setRawOpen] = useState(false);
  /**
   * 超阈值邮件（truncated，>MAIL_AGENT_MAX_SOURCE_BYTES，2026-10-08 起缺省 1MB）的按需取原文：
   * 抓取器默认不下载这类邮件的原文（正文与附件都留到点开时再取）
   * 的原文（红线 12），于是站内点开是**空白**——此前连提示都没有。现在正文区上方给出
   * 说明 + 一个显式按钮，点了才取一次（webmaild `POST /message/:id/source`）。
   */
  const [fetchingSource, setFetchingSource] = useState(false);
  const fetchSourceNow = useCallback(async () => {
    setFetchingSource(true);
    try {
      const res = await fetch(`/api/mail/message/${encodeURIComponent(messageId)}/source`, {
        method: "POST",
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `${res.status}`);
      // 取回后重新拉详情：正文、附件、头部一次到位
      const detailRes = await fetch(`/api/mail/message/${encodeURIComponent(messageId)}`);
      if (detailRes.ok) setDetail((await detailRes.json()) as MailDetail);
      toast.add({ title: t("sourceFetched"), type: "success" });
    } catch (err) {
      toast.add({
        title: t("sourceFailed"),
        description: err instanceof Error ? err.message : String(err),
        type: "error",
      });
    } finally {
      setFetchingSource(false);
    }
  }, [messageId, t]);

  // ⚠ React 19 对 dangerouslySetInnerHTML 按「包装对象引用」比较（!==），
  // 每次渲染新建 {__html} 字面量都会触发 innerHTML 无条件重设，
  // 把「显示图片」对占位图的 DOM 改写冲掉。必须 memo 固定引用。
  const bodyInnerHtml = useMemo(
    () => (detail?.html ? { __html: detail.html } : undefined),
    [detail?.html],
  );

  useEffect(() => {
    let cancelled = false;
    seenTouchedRef.current = false; // 换了一封邮件，上一封的手动操作护栏随之复位
    fetch(`/api/mail/message/${encodeURIComponent(messageId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `${res.status}`);
        return res.json();
      })
      .then((data: MailDetail) => {
        if (cancelled) return;
        setDetail(data);
        // 正常 webmail 行为：打开即标已读（对该消息的所有副本一起写，红线 8）
        if (!data.seen) {
          fetch("/api/mail/flags", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ messageId, seen: true }),
          })
            .then((res) => {
              // ⚠ `seenTouchedRef` 护栏见 declarations：用户手动改过 seen 后，
              // 这条晚到的回填不得覆写（否则「标了未读还是已读」换个形式复发）
              if (res.ok && !cancelled && !seenTouchedRef.current) {
                setDetail((d) => (d ? { ...d, seen: true } : d));
                // 左栏该行退去加粗/蓝点、未读计数回正（否则列表停在已读前的旧态）
                broadcastItemChange({ messageId, seen: true });
              }
            })
            .catch(() => {});
        }
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  useEffect(() => {
    let cancelled = false;
    // 换一封信：会话回到「默认展开」，由下面的自动折叠按这封信的空间重新判断
    // （用户上一次拨动开关的意志不跨邮件延续）
    setThreadOpen(true);
    setThreadTouched(false);
    fetch(`/api/mail/message/${encodeURIComponent(messageId)}/thread`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { items: MailListItem[] } | null) => {
        if (!cancelled && d) setThread(d.items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  /**
   * 自动折叠「会话」（优先级 ①，见 threadOpen 的说明）。
   *
   * 判据就是用户的原话：**正文自己装不下**（`scrollHeight > clientHeight`，即正文
   * 正在滚动）→ 把会话收起来让位。外加一条：列表被压得不足一行时同样收起来。
   *
   * ⚠ 用 `useLayoutEffect`：测量必须在**绘制前**完成，否则用户会看见"正文先被挤扁、
   *   一帧后才折叠"的闪动。`setThreadOpen(false)` 只在真的需要时调用（值不变时
   *   React 直接跳过），不存在"收起 → 变宽 → 又展开"的循环。
   * ⚠ 门控 `detail.messageId !== messageId`：换邮件时详情是异步到的，那一刻 DOM 里
   *   可能还是上一封的正文/会话——量错了就会把新邮件的会话误折叠，而自动折叠只收不放，
   *   错了就再也回不来。
   */
  useLayoutEffect(() => {
    if (threadTouched || !detail || detail.messageId !== messageId) return;
    // 窄屏没有"右栏高度"这回事：整页是文档流，正文本来就不会被挤成滚动区
    if (!window.matchMedia("(min-width: 64rem)").matches) return;
    const decide = () => {
      const body = bodyRef.current;
      const list = threadListRef.current;
      const bodyOverflows = body ? body.scrollHeight - body.clientHeight > 1 : false;
      const listSqueezed = list ? list.clientHeight < THREAD_ROW_MIN_PX : false;
      if (bodyOverflows || listSqueezed) setThreadOpen(false);
    };
    decide();
    /**
     * ⚠ **必须再量一次**（动效落地后）：让出空间的常常是「快速回复」的 grid 轨道动画，
     *   而动画开始时那一刻量到的还是展开前的布局（正文没被挤、列表也没被压）——
     *   只量第一次会漏判，留下"开关说已展开、列表只剩两像素"的夹缝状态。
     *   用户在这 360ms 内自己拨了开关 → 依赖变化触发 cleanup，定时器被清掉（不会打架）。
     */
    const timer = window.setTimeout(decide, TOOLBAR_MS + 60);
    /**
     * ⚠ **窗口尺寸变化也要重判**（2026-10-09 补）：本体只靠 deps 触发，而拉小窗口不改任何
     *   deps——于是"正文已经在滚、会话却还说自己展开着"（列表被 flex 压成 0，开关是死的）。
     *   只监听 `resize` 而不上 `ResizeObserver`：观察正文盒子会在回调里改布局，浏览器会报
     *   「ResizeObserver loop」错误事件，而 E2E 有"整页加载零 console 错误"的守卫。
     *   仍然只收不放：把窗口拉回去不会自动展开（那会与"用户拨过开关"的语义打架）。
     */
    window.addEventListener("resize", decide);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", decide);
    };
  }, [detail, thread, quickOpen, threadTouched, messageId]);

  /** 会话开关：用户拨过之后自动折叠不再插手，且展开时给会话预留高度（优先级 ②） */
  const toggleThread = useCallback(() => {
    setThreadTouched(true);
    setThreadOpen((v) => !v);
  }, []);

  useEffect(() => {
    try {
      const order = JSON.parse(window.sessionStorage.getItem(MAIL_LIST_ORDER_KEY) ?? "[]") as string[];
      const idx = order.indexOf(messageId);
      setSiblings(idx >= 0 ? { prev: order[idx - 1], next: order[idx + 1] } : {});
    } catch {
      setSiblings({});
    }
  }, [messageId]);

  const postFlags = useCallback(
    (change: { seen?: boolean; flagged?: boolean }) => {
      if (!detail) return;
      /**
       * 状态操作（标为未读/已读、星标）：**乐观更新，不等服务器**。
       *
       * 真实写回要连阿里云 IMAP 走一整次往返（实测服务端 ~1.1 秒：建连 + 登录 +
       * 选夹 + STORE + 登出，两处副本；红线 10 不允许为省这 1 秒常开连接池），
       * 用户不该站在页面上干等（2026-10-06 用户报「标为未读延迟高」）。先改本地
       * 与左栏（列表行 / 计数立即正确），请求转后台；失败再回滚 + toast。
       * 与列表行内快捷操作同一套语义（见 mail-client 的 postFlags）。
       * ⚠ 成功后**再广播一次**：webmaild 的本地索引是在 IMAP 写成功后才更新的
       * （applyFlags 注释），第一次广播触发的计数/整表重取拿到的还是旧索引——
       * 「未读筛选下刚标未读的邮件要出现在列表里」依赖第二次广播。
       */
      const revert: { seen?: boolean; flagged?: boolean } = {};
      if (change.seen !== undefined) {
        revert.seen = detail.seen;
        seenTouchedRef.current = true; // 打开时「标已读」的回填随之作废（见护栏注释）
      }
      if (change.flagged !== undefined) revert.flagged = detail.flagged;

      setDetail((d) => (d ? { ...d, ...change } : d));
      // 左栏列表行与未读计数跟随（见 MAIL_ITEM_CHANGED_EVENT 注释）
      broadcastItemChange({ messageId, ...change });
      /**
       * 「标为未读」后离开详情页（2026-10-06 用户指定，勿改回停留）：
       * 1) 停留在「正在查看」页面上，读信页自身的语义（打开=已读）与「刚标成
       *    未读」直接矛盾——再点一次该行、或任何重新挂载都会立刻标回已读，
       *    用户看到的就是「标了未读还是已读」；
       * 2) 返回列表刚好让用户看到操作结果（该行蓝点/加粗已亮起）。
       * 乐观更新后立即返回（不再等写回落地）；
       * 「标为已读 / 星标」不改变浏览目标，留在原地。
       */
      if (change.seen === false) router.push("/mail");

      fetch("/api/mail/flags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId, ...change }),
      })
        .then((res) => {
          if (!res.ok) throw new Error();
          // 服务端写成功：DB 索引此时才更新，再广播一次让计数 / 筛选视图取准
          broadcastItemChange({ messageId, ...change });
        })
        .catch(() => {
          // 失败回滚：本地与左栏退回操作前的状态，并提示
          setDetail((d) => (d ? { ...d, ...revert } : d));
          broadcastItemChange({ messageId, ...revert });
          toast.add({ title: t("actionFailed"), type: "error" });
        });
    },
    [detail, messageId, t, router],
  );

  const doDelete = useCallback(async () => {
    if (!detail) return;
    setActing(true);
    try {
      const res = await fetch("/api/mail/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ copies: detail.copies }),
      });
      if (!res.ok) throw new Error();
      toast.add({ title: t("deleted"), type: "success" });
      // 左栏移除该行 + 未读计数回正（此前删完回列表，已删的行还留在列表上）
      broadcastItemChange({ messageId, deleted: true });
      router.push("/mail");
    } catch {
      toast.add({ title: t("actionFailed"), type: "error" });
      setActing(false);
    }
  }, [detail, messageId, router, t]);

  // 页内快速回复（4.9）：默认收件账号 = 副本所属账号，续引用链让回信入会话
  const quickSend = useCallback(async () => {
    if (!detail || !quickText.trim()) return;
    setQuickSending(true);
    try {
      const rawMid = detail.messageId.startsWith("mid:") ? `<${detail.messageId.slice(4)}>` : "";
      const res = await fetch("/api/mail/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: detail.copies[0]?.accountId,
          to: [detail.fromAddr],
          subject: /^re:/i.test(detail.subject) ? detail.subject : `Re: ${detail.subject}`,
          text: quickText,
          inReplyTo: rawMid || undefined,
          references: rawMid
            ? [...(detail.refs ?? []).map((r) => (r.startsWith("mid:") ? `<${r.slice(4)}>` : r)), rawMid]
            : undefined,
        }),
      });
      if (!res.ok) throw new Error();
      toast.add({ title: t("sent"), type: "success" });
      setQuickText("");
    } catch {
      toast.add({ title: t("sendFailed"), type: "error" });
    } finally {
      setQuickSending(false);
    }
  }, [detail, quickText, t]);

  /** 发件人一键存入通讯录（姓名用邮件头里的显示名预填） */
  const saveSender = useCallback(async () => {
    if (!detail || detail.fromContactId) return;
    try {
      const res = await fetch("/api/mail/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: detail.fromName, email: detail.fromAddr }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `${res.status}`);
      toast.add({ title: t("contacts.savedToast"), type: "success" });
      setDetail({ ...detail, fromContactId: (data as { id?: string })?.id ?? "saved" });
    } catch (err) {
      toast.add({
        title: t("contacts.saveFailed"),
        description: err instanceof Error ? err.message : String(err),
        type: "error",
      });
    }
  }, [detail, t]);

  // 「显示图片」：把占位图换回原远程 URL（4.4：逐封、一次性）
  const showRemoteImages = useCallback(() => {
    bodyRef.current
      ?.querySelectorAll("img[data-remote-src]")
      .forEach((img) => {
        const el = img as HTMLImageElement;
        el.src = el.dataset.remoteSrc!;
        el.removeAttribute("data-remote-src");
      });
    setRemoteShown(true);
  }, []);

  /**
   * 打印前的「深底浅字」就地修正（2026-10-08）。
   *
   * 问题：发件人常把整块内容做成深色底 + 白字（页脚、按钮条、活动横幅），屏幕上没问题；
   * 但浏览器**默认不打印背景色**——到了纸上就是「白纸白字」，整块内容凭空消失
   * （勾上「背景图形」则相反：白字黑底能印出来，可它跟整页浅色不搭）。
   *
   * 做法：遍历正文，只挑**自己画了深色底**的元素（计算样式的 backgroundColor 亮度偏低），
   * 打印期间就地改成浅底 + 黑字——两种情况都能读：
   *   · 不打印背景 → 白底黑字（与全文一致）；
   *   · 打印背景   → 浅灰底黑字（一眼还能看出"这里原本是深色块"）。
   * ⚠ 只碰"深底"元素：发件人用颜色表达的语义（红色强调、绿色按钮文字）不受影响。
   * ⚠ 与 `html.dark` 的摘除一样属于**临时改动**，`afterprint` 里逐条还原。
   */
  const normalizePrintColors = (): (() => void) => {
    const host = bodyRef.current;
    if (!host) return () => {};
    /** 感知亮度（0=黑 1=白）；非不透明背景返回 null（透明 = 它自己没画底） */
    const bgLuminance = (el: Element): number | null => {
      const bg = window.getComputedStyle(el).backgroundColor;
      const parts = bg.match(/^rgba?\(([^)]+)\)$/)?.[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      if (!parts || parts.length < 3) return null;
      const [r, g, b, a = 1] = parts;
      if (a < 0.5) return null;
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    };
    const patched: { el: HTMLElement; color: string; bg: string }[] = [];
    for (const el of [host, ...host.querySelectorAll<HTMLElement>("*")]) {
      const lum = bgLuminance(el);
      if (lum === null || lum >= 0.55) continue;
      patched.push({
        el,
        color: el.style.getPropertyValue("color"),
        bg: el.style.getPropertyValue("background-color"),
      });
      el.style.setProperty("color", "#000", "important");
      el.style.setProperty("background-color", "#f2f2f2", "important");
    }
    return () => {
      for (const { el, color, bg } of patched) {
        if (color) el.style.setProperty("color", color);
        else el.style.removeProperty("color");
        if (bg) el.style.setProperty("background-color", bg);
        else el.style.removeProperty("background-color");
      }
    };
  };

  /**
   * 打印（2026-10-08 重做）。
   *
   * 打印准备挂在**浏览器事件**上，而不是只挂在「打印」菜单项上：
   * `beforeprint` / `afterprint` 对 `window.print()` 与用户直接按 Ctrl+P **都会派发**，
   * 于是「菜单打印」和「快捷键打印」走同一份准备与还原逻辑（此前只有菜单那条路有准备，
   * Ctrl+P 拿到的是深色主题的「白纸白字」）。
   *
   * 准备做三件事：
   *  1. 摘掉 `html.dark`——深色主题下页面近黑、文字近白，而浏览器默认**不打印背景**，
   *     印出来就是「白纸白字」（勾上「背景图形」则是一整页黑底，同样不可接受）。
   *     摘掉标记类后 `:root` 的浅色变量与所有 `dark:` 变体同时失效。
   *  2. 把 `document.title` 临时换成主题——浏览器打印页眉/页脚与「另存为 PDF」的默认
   *     文件名都取自它，否则导出的文件一律叫「邮件」。
   *  3. `normalizePrintColors()`（见上）：把邮件**自己**的深底浅字块就地改成浅底黑字。
   *
   * ⚠ 准备/还原都必须**幂等**：`printMessage()` 先手工准备一次（保证快照定型前 DOM 一定
   *   已经改好），紧接着浏览器又会为这次打印派发 `beforeprint`（第二次是空转）；
   *   `afterprint` 可能不来（部分环境），故另设 120s 兜底——用「代次」令牌防止**上一次**
   *   打印的兜底定时器把**下一次**打印的准备状态提前还原。
   */
  const printStateRef = useRef<{ gen: number; restore: () => void } | null>(null);
  const printGenRef = useRef(0);

  const preparePrint = () => {
    // 详情还没到手（加载/出错态）时没什么可准备的
    if (printStateRef.current || !detail) return;
    const root = document.documentElement;
    const wasDark = root.classList.contains("dark");
    const prevTitle = document.title;
    const restoreColors = normalizePrintColors();
    if (wasDark) root.classList.remove("dark");
    document.title = detail.subject || t("noSubject");
    printStateRef.current = {
      gen: ++printGenRef.current,
      restore: () => {
        restoreColors();
        if (wasDark) root.classList.add("dark");
        document.title = prevTitle;
      },
    };
  };

  const restorePrint = () => {
    const state = printStateRef.current;
    if (!state) return;
    printStateRef.current = null;
    state.restore();
  };

  const printMessage = () => {
    preparePrint();
    window.print();
    // 兜底：个别环境不派发 afterprint（打印快照在对话框打开时就已定格，晚还原无影响）
    const gen = printGenRef.current;
    window.setTimeout(() => {
      if (printGenRef.current === gen) restorePrint();
    }, 120_000);
  };

  // 监听器只注册一次；具体行为从 ref 里取最新闭包（主题/主题词变了也不会用到旧值）
  const printHandlersRef = useRef({ prepare: () => {}, restore: () => {} });
  printHandlersRef.current = { prepare: preparePrint, restore: restorePrint };
  useEffect(() => {
    const onBefore = () => printHandlersRef.current.prepare();
    const onAfter = () => printHandlersRef.current.restore();
    window.addEventListener("beforeprint", onBefore);
    window.addEventListener("afterprint", onAfter);
    return () => {
      window.removeEventListener("beforeprint", onBefore);
      window.removeEventListener("afterprint", onAfter);
    };
  }, []);

  if (error) {
    return (
      <div className="flex flex-col items-start gap-4">
        <Link
          href="/mail"
          data-slot="button"
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "lg:hidden")}
        >
          <ArrowLeftIcon data-icon="default" />
          {t("backToList")}
        </Link>
        <p className="flex items-center gap-2 text-sm text-destructive">
          <CircleAlertIcon className="size-4" aria-hidden />
          {mailErrorText(error, t)}
        </p>
      </div>
    );
  }

  if (!detail) {
    return (
      <p className="flex items-center gap-2 py-12 justify-center text-sm text-muted-foreground">
        <Spinner label={t("loading")} />
        {t("loading")}
      </p>
    );
  }

  // 收件 / 发件区分（2026-10-04 用户反馈）：副本全在「已发送」类文件夹 = 我发出的邮件。
  // 发件邮件隐藏「回复 / 回复全部 / 快速回复 / 存入通讯录」（这是功能侧的区分），见下方各处。
  const sent = isSentItem(detail.copies);

  // 两个状态化动作的文案：可见标签与 aria-label / title 共用同一个字符串
  // （窄容器下可见标签被隐藏，名字只剩 aria-label——见 ActionLabel）
  const seenLabel = detail.seen ? t("markUnread") : t("markRead");
  const flagLabel = detail.flagged ? t("unflag") : t("flag");

  return (
    <div className="flex flex-col gap-5 lg:min-h-0 lg:flex-1">
      {/* 操作栏
          ⚠ 「返回列表」仅窄屏需要：宽屏下左栏就是列表（MAIL-AGENT.md 4.12）。
          ⚠ 按钮层级（2026-10 用户指定，勿改回）：「回复」是本页最重要的动作——
          唯一带边框、且放在**最右边**（主操作位）；「删除」去边框退为安静动作
          （有确认弹窗兜底，不需要边框强调）；其余全部 ghost。
          ⚠ **这一行只放「对信的动作」、且必须一行放下（2026-10-07 用户验收反馈）**：
          低频的「原始邮件 / 打印」收进最左端的「更多」菜单（见下）、「回复全部」并进
          「回复」的下拉（见行末）。再往这里加按钮前先量宽度——右组可用宽只有 ~620px
          （容器 max-w-6xl 下的详情栏），加一个四字按钮就把「转发 / 回复」顶到第二行。 */}
      <div className="@container flex flex-wrap items-center gap-2" data-slot="message-actions" data-print="hide">
        {/* 更多（原始邮件 / 打印）：**第一行最左**（2026-10-07 用户指定——放主题行那种
            「别的行」不合格）。放最左有个额外好处：宽屏下这一端本来是空的，不吃右组的
            宽度预算 */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("more")}
                title={t("more")}
                data-print="hide"
                className="shrink-0"
              >
                <MoreHorizontalIcon />
              </Button>
            }
          />
          {/* ⚠ 菜单宽度要显式给：DropdownMenuContent 缺省是 w-(--anchor-width)，
              锚点是个 28px 的图标按钮，不给 min-w 菜单会窄成一条 */}
          <DropdownMenuContent align="start" className="w-auto min-w-36">
            {/* 原始邮件（2026-10-07）：原始头部 + .eml 下载——普通账号的取证入口 */}
            <DropdownMenuItem onClick={() => setRawOpen(true)}>
              <FileCode2Icon />
              {t("rawMessage")}
            </DropdownMenuItem>
            {/* 打印：printMessage()（浅色快照 + 临时换标题）+ globals.css 的打印规则
                （只留邮件本体，顶栏/页脚/左栏列表/工具栏/底栏/快速回复全部隐藏） */}
            <DropdownMenuItem onClick={printMessage}>
              <PrinterIcon />
              {t("print")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Link
          href="/mail"
          data-slot="button"
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "lg:hidden")}
        >
          <ArrowLeftIcon data-icon="default" />
          {t("backToList")}
        </Link>
        {/* 上一封 / 下一封（列表序，4.9）：**仅窄屏需要**——宽屏左栏就是列表，
            这两个按钮既多余又占空间（2026-10-04 用户反馈），与「返回列表」同规则（lg 隐藏） */}
        {(siblings.prev || siblings.next) && (
          <span className="flex items-center gap-0.5 lg:hidden" data-slot="mail-siblings">
            {siblings.prev && (
              <Link
                href={`/mail/message/${encodeMessageId(siblings.prev)}`}
                data-slot="button"
                aria-label={t("prevMessage")}
                title={t("prevMessage")}
                className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
              >
                <ChevronLeftIcon data-icon="default" />
              </Link>
            )}
            {siblings.next && (
              <Link
                href={`/mail/message/${encodeMessageId(siblings.next)}`}
                data-slot="button"
                aria-label={t("nextMessage")}
                title={t("nextMessage")}
                className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
              >
                <ChevronRightIcon data-icon="default" />
              </Link>
            )}
          </span>
        )}
        {/* ⚠ 内组也要 flex-wrap + justify-end：窄屏折行后仍右对齐，
            不折行会把按钮挤出视口造成横向滚动
            ⚠ 每个动作都带 `aria-label` + `title` = 它的文案：容器窄到 36rem 以下时
            可见标签被 ActionLabel 隐藏、只剩图标，名字就只能靠 aria-label（见 ActionLabel） */}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            disabled={acting}
            aria-label={seenLabel}
            title={seenLabel}
            onClick={() => postFlags({ seen: !detail.seen })}
          >
            {detail.seen ? <MailOpenIcon data-icon="default" /> : <MailIcon data-icon="default" />}
            <ActionLabel>{seenLabel}</ActionLabel>
          </Button>
          {/* 标为垃圾（2026-10-07 用户定稿）：文件夹视图删除后，菜单式「移动」等于盲选
              （搬过去再也看不见），只留这一个语义明确的整理动作；目标文件夹由服务端自己
              在账号里探测（见 markJunk 注释），前端不再需要文件夹清单。
              ⚠ 文案 2026-10-07 用户缩写为「标为垃圾」（原「标为垃圾邮件」）——
              主栏要在一行内放下，见同文件顶部与 MAIL-AGENT.md 4.9 的动作分级。
              ⚠ 图标 2026-10-07 用户反馈后由 `FolderInputIcon` 换成 `OctagonAlertIcon`：
              文件夹 + 入箭头读起来就是「移进某个文件夹」（被删掉的「移动」那套语义），
              而八边形 + 感叹号在邮件客户端里就是「垃圾邮件」（Gmail 的举报垃圾邮件同形）。
              候选对比图见 .acceptance/12-icon-options.png 与 MAIL-AGENT.md 4.9 */}
          <Button
            variant="ghost"
            size="sm"
            disabled={acting}
            aria-label={t("moveToJunk")}
            title={t("moveToJunk")}
            onClick={() => void markJunk()}
          >
            <OctagonAlertIcon data-icon="default" />
            <ActionLabel>{t("moveToJunk")}</ActionLabel>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={acting}
            aria-pressed={detail.flagged}
            aria-label={flagLabel}
            title={flagLabel}
            onClick={() => postFlags({ flagged: !detail.flagged })}
          >
            <StarIcon className={cn("size-4", detail.flagged && "fill-foreground")} data-icon={detail.flagged ? undefined : "default"} />
            <ActionLabel>{flagLabel}</ActionLabel>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={acting}
            aria-label={t("delete")}
            title={t("delete")}
            className="hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2Icon data-icon="default" />
            <ActionLabel>{t("delete")}</ActionLabel>
          </Button>
          <Link
            href={`/mail/compose?forward=${encodeURIComponent(messageId)}`}
            data-slot="button"
            aria-label={t("forward")}
            title={t("forward")}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            <ForwardIcon data-icon="default" />
            <ActionLabel>{t("forward")}</ActionLabel>
          </Link>
          {/* 回复 / 回复全部：**仅收件邮件需要**——对已经发出的邮件回复自己没有意义
              （要补内容用「转发」），这是收件/发件的功能区分（2026-10-04 用户反馈）。
              ⚠ **2026-10-07 用户验收后合并成一个「分裂按钮」**（原先是并排两个 ghost
              按钮，共 166px）：左边「回复」= 主操作（一次点击直达），右边一个 28px 的
              caret = 下拉，菜单里放「回复全部」。合并后从 166px 降到 ~96px。
              为什么不用「点开菜单再选」的单按钮：回复是本页最频繁的动作，多一次点击
              不值当；这正是 Gmail / Apple Mail 的分裂按钮形态。
              ⚠ **样式 = 「写邮件」那一个（2026-10-07 用户指定：「回复」与「写邮件」同等重要）**：
              `buttonVariants({ size: "sm" })` 不带 variant = 默认的实心 primary，与
              `mail-client.tsx` 的写邮件按钮同一个调用形态（此前是 outline）。
              ⚠ **形态用官方 `ButtonGroup`（vendored `components/ui/button-group.tsx`）**，
              与 shadcn 官方的「With Dropdown」示例同构：`ButtonGroup` 内放主 `Button` +
              一个 `DropdownMenuTrigger`。圆角合并、`border-l-0`、焦点环 `z-10` 全部由
              ButtonGroup 自己的 CSS 负责（`[&>[data-slot]~[data-slot]]:rounded-l-none
              border-l-0`、最后一个 `rounded-r-lg!`）——**不要再手写圆角与边框的补丁**：
              2026-10-07 第一版手写这些补丁时漏了两侧朝内的透明边框，`bg-clip-padding` 下
              那 1px 不画背景 → 实心黑块中间出现一条 2px 亮的竖缝，被用户当场打回（「太丑了」）。
              ⚠ 唯一额外补的一条是 `[&>*:first-child]:border-r-0`：官方 CSS 只清后续项的
              `border-l`，而首项那条朝内的透明右边框同样会漏出底色（实心填充才看得出来）。 */}
          {!sent && (
            // `[&>*:first-child]:border-r-0` 见上条注释：官方 CSS 只清后续项的 border-l
            <ButtonGroup className="[&>*:first-child]:border-r-0">
              <Link
                href={`/mail/compose?replyTo=${encodeURIComponent(messageId)}`}
                data-slot="button"
                aria-label={t("reply")}
                title={t("reply")}
                className={buttonVariants({ size: "sm" })}
              >
                <ReplyIcon data-icon="default" />
                <ActionLabel>{t("reply")}</ActionLabel>
              </Link>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button size="icon-sm" aria-label={t("replyAll")} title={t("replyAll")}>
                      <ChevronDownIcon />
                    </Button>
                  }
                />
                {/* 菜单项用 router.push 而不是 <Link>：Base UI 的 Menu.Item 渲染成
                    role="menuitem"，塞个 <a> 进去会让「菜单项」与「链接」两套语义打架
                    （站内其它菜单项也都是 onClick） */}
                <DropdownMenuContent align="end" className="w-auto min-w-36">
                  <DropdownMenuItem
                    onClick={() =>
                      router.push(`/mail/compose?replyTo=${encodeURIComponent(messageId)}&all=1`)
                    }
                  >
                    <ReplyAllIcon />
                    {t("replyAll")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </ButtonGroup>
          )}
        </div>
      </div>

      {/* 头部（4.9：发件人 Avatar + 相对时间，绝对时间放 title）
          ⚠ 主题用 h2：页面 h1 是外壳的「邮件」，一封邮件是它下面的一块内容 */}
      <header className="flex flex-col gap-3">
        <h2 className="text-2xl font-bold tracking-tight">
          {detail.subject || t("noSubject")}
        </h2>
        <div className="flex items-start gap-3">
          {/* data-slot="mail-avatar"：打印规则按它把头像连同方向角标一起去掉——
              纸上没有交互也没有色彩语境，一个首字母圆圈只是噪音 */}
          <span data-slot="mail-avatar" className="relative mt-0.5 shrink-0">
            <Avatar size="lg">
              <AvatarFallback>
                {(detail.fromName || detail.fromAddr || "?").trim().charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            {/* 方向角标（与列表行同一套视觉语言）：↙ 收件 / ↗ 发件，
                箭头按方向着色（收件 emerald / 发件 amber） */}
            <span
              data-slot="mail-direction-badge"
              data-direction={sent ? "sent" : "received"}
              role="img"
              aria-label={sent ? t("filterSent") : t("filterReceived")}
              className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full border border-border bg-background text-muted-foreground"
            >
              {sent ? (
                <ArrowUpRightIcon className="size-3 text-amber-600 dark:text-amber-400" aria-hidden />
              ) : (
                <ArrowDownLeftIcon className="size-3 text-emerald-600 dark:text-emerald-400" aria-hidden />
              )}
            </span>
          </span>
          <dl className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-muted-foreground">{t("fieldFrom")}</dt>
              <dd className="min-w-0 break-all font-medium">
                {detail.fromName ? `${detail.fromName} <${detail.fromAddr}>` : detail.fromAddr}
                {/* 通讯录联动：未保存的收件人给「存入」入口，已保存的给勾标。
                    发件邮件不显示——发件人是自己，本就在「我的账号」里，点了也会被拦下 */}
                {detail.fromAddr && !sent && (
                  detail.fromContactId ? (
                    <UserCheckIcon
                      data-print="hide"
                      className="ml-1.5 inline-block size-3.5 align-[-2px] text-muted-foreground"
                      aria-label={t("contacts.senderSaved")}
                    />
                  ) : (
                    <button
                      type="button"
                      data-print="hide"
                      className="ml-1.5 inline-flex align-[-2px] text-muted-foreground transition-colors hover:text-foreground"
                      aria-label={t("contacts.addSender")}
                      title={t("contacts.addSender")}
                      onClick={saveSender}
                    >
                      <UserPlusIcon className="size-3.5" aria-hidden />
                    </button>
                  )
                )}
              </dd>
            </div>
            <AddressRow label={t("fieldTo")} list={detail.to} />
            {detail.cc.length > 0 && <AddressRow label={t("fieldCc")} list={detail.cc} />}
          </dl>
          <span data-slot="mail-message-date" className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {absDateTime(detail.date, t("localeTag"))}
          </span>
        </div>
      </header>

      {/* 远程内容提示（4.4：默认剥除，显式点击逐封加载一次）
          ⚠ 2026-10-08：这一条**要印到纸上**——打印规则会隐藏被拦截的图片本身
          （纸上留虚线空框只是一个个"原本有图"的空洞），读者的知情权靠这行文字。
          屏幕上那句（含"防止被追踪已读"的原因）与纸面上那句（说明图片不在打印件里）
          是两条文案：入口「显示图片」在纸上没有意义，用 `data-print="hide"` 去掉。 */}
      {detail.remoteBlocked > 0 && !remoteShown && (
        <div
          data-slot="mail-remote-notice"
          className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground"
        >
          <span className="print:hidden">{t("remoteBlocked", { count: detail.remoteBlocked })}</span>
          <span className="hidden print:inline">
            {t("remoteBlockedPrint", { count: detail.remoteBlocked })}
          </span>
          <Button data-print="hide" variant="outline" size="sm" onClick={showRemoteImages}>
            {t("showRemote")}
          </Button>
        </div>
      )}

      {/* 正文
          ⚠ 宽屏下**正文是这一列里唯一可伸缩的项**（2026-10-08 用户反馈：展开「快速回复」
          后整个邮件窗口变成可滚动，正文却不缩）。机制：本列 `lg:min-h-0 lg:flex-1` 撑满右栏，
          正文给 `lg:min-h-[6rem] lg:overflow-y-auto` —— 其余兄弟节点（头部 / 附件 / 会话 /
          快速回复）的 `min-height:auto` 让它们**不会**被压到内容以下，于是需要让出的高度
          全部由正文承担，正文内部滚动、外层不滚。`min-h-[6rem]`（96px）是下限：真到 96px
          还不够（附件很多 + 会话很长 + 快速回复展开）时，才退回外层滚动。
          ⚠ 下限不能取大：实测一封普通邮件（正文 236px、面板 550px）展开快速回复需要正文缩到
          112px，取 160px 时外层就还会多出 16px 滚动——正是用户报的那个毛病。 */}
      {/* 精简原文（附件门控，2026-10-08）：正文与内嵌图都在，只是附件没下载——
          一句话说明 + 取回入口（点单个附件也会各取各的） */}
      {detail.partial && (
        <p
          data-slot="mail-partial-notice"
          className="rounded-xl border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
        >
          {t("partialHint")}
        </p>
      )}
      {/* 只入库了索引（超大邮件 / 结构解析失败的兜底）：正文与附件都没有。给出说明与
          唯一的补救入口，否则这一页看起来就是「一封空邮件」（2026-10-07） */}
      {detail.truncated && !detail.partial && (
        <div
          data-slot="mail-truncated-notice"
          className="flex flex-col items-start gap-2 rounded-xl border border-amber-600/40 bg-amber-600/5 p-4 text-sm dark:border-amber-400/40 dark:bg-amber-400/10"
        >
          <p className="flex items-center gap-2 font-medium">
            <CircleAlertIcon className="size-4 text-amber-600 dark:text-amber-400" aria-hidden />
            {t("truncatedTitle")}
          </p>
          <p className="text-muted-foreground">{t("truncatedHint")}</p>
          <Button data-print="hide" size="sm" variant="outline" disabled={fetchingSource} onClick={() => void fetchSourceNow()}>
            {fetchingSource ? <Spinner /> : <DownloadIcon data-icon="default" />}
            {fetchingSource ? t("sourceFetching") : t("sourceFetch")}
          </Button>
        </div>
      )}

      {detail.html ? (
        <div
          ref={bodyRef}
          className="mail-body overflow-x-auto rounded-xl border border-border bg-background p-4 text-sm leading-relaxed lg:min-h-[6rem] lg:overflow-y-auto"
          // webmaild 已做过 sanitize + 远程资源剥除（4.4）
          dangerouslySetInnerHTML={bodyInnerHtml}
        />
      ) : (
        <div
          ref={bodyRef}
          data-slot="mail-text-body"
          className="whitespace-pre-wrap rounded-xl border border-border p-4 text-sm leading-relaxed lg:min-h-[6rem] lg:overflow-y-auto"
        >
          {detail.text || detail.snippet}
        </div>
      )}

      {/* 附件 */}
      {detail.attachments.filter((a) => !a.inline).length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            {t("attachments", { count: detail.attachments.filter((a) => !a.inline).length })}
          </h2>
          <ul className="flex flex-wrap gap-2">
            {detail.attachments
              .filter((a) => !a.inline)
              .map((a) => (
                <li key={a.index}>
                  <a
                    href={`/api/mail/message/${encodeURIComponent(messageId)}/attachment/${a.index}`}
                    download={a.filename}
                    data-slot="button"
                    // 推迟的附件：点下去服务端会先向邮箱取这一个部件（几秒），再回传
                    title={a.deferred ? t("attachmentDeferred") : undefined}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    <DownloadIcon data-icon="default" />
                    {a.filename}
                    <span className="text-xs text-muted-foreground tabular-nums">{fmtSize(a.size)}</span>
                    {a.deferred && (
                      <span
                        data-slot="attachment-deferred"
                        className="text-xs text-muted-foreground"
                      >
                        {t("attachmentDeferred")}
                      </span>
                    )}
                  </a>
                </li>
              ))}
          </ul>
        </section>
      )}

      {/* 会话（4.7）：同一会话的其它邮件，按时间升序；当前封高亮不跳转。
          可折叠 + 可滚动（2026-10-09 用户要求）——优先级规则与实现见 `threadOpen` 的注释。
          ⚠ `data-slot="mail-thread"` 挂在**外层 section** 上（此前挂在里面的 ul）：
            打印规则按它整块隐藏（纸面上「会话」只是导航、没有内容），折叠态也由这个
            section 承载，E2E 的 `data-open` 与开关都在这一层读。
          ⚠ 折叠用 grid 轨道 1fr↔0fr（与「快速回复」同一套做法与曲线），收起时内容
            保持挂载但 `inert`：列表里没有输入态要保全，但这样键盘焦点不会落进
            一个高度为 0 的滚动容器里。 */}
      {thread && thread.length > 1 && (
        <section
          data-slot="mail-thread"
          data-open={threadOpen ? "true" : "false"}
          className={cn(
            // 让位顺序：会话先被压缩（shrink 权重 1000 vs 正文 1），压到 min-height 冻结，
            // 之后剩下的缺口才轮到正文。`overflow-hidden` 保证压缩时列表被裁而不是顶开。
            "flex flex-col gap-2 lg:shrink-[1000] lg:overflow-hidden",
            // min-height = 折叠态的「一行标题」：压缩到底就只剩标题行（= 视觉上的折叠），
            // 且标题不会被 overflow-hidden 裁掉。用户亲手展开时抬到 7.5rem（≈3 行），
            // 让「我要看会话」这个意志真的看得见——代价是正文让出这些高度（优先级 ②）。
            threadOpen && threadTouched ? "lg:min-h-[7.5rem]" : "lg:min-h-7",
          )}
        >
          <h2 className="text-sm font-medium text-muted-foreground">
            <button
              type="button"
              onClick={toggleThread}
              aria-expanded={threadOpen}
              aria-controls="mail-thread-panel"
              data-slot="mail-thread-toggle"
              className="group/thread flex w-full items-center justify-between gap-2 rounded-md text-left focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <span className="truncate">{t("threadTitle", { count: thread.length })}</span>
              <ChevronDownIcon
                className={cn(
                  "size-4 shrink-0 transition-[color,transform] group-hover/thread:text-foreground",
                  MOTION_SIZE,
                  threadOpen && "rotate-180",
                )}
                aria-hidden
              />
            </button>
          </h2>
          <div
            id="mail-thread-panel"
            className={cn(
              "grid lg:min-h-0",
              // 轨道动画与「快速回复」同规格（MOTION_SIZE = 300ms ease-out）
              "transition-[grid-template-rows]",
              MOTION_SIZE,
              threadOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
            )}
            inert={threadOpen ? undefined : true}
          >
            {/* `-mx-1 px-1`：滚动容器的裁剪边界就在列表左右边框上，行按钮的聚焦光圈
                会往左右各扩 3px 而被剪掉（与「快速回复」同一个坑）。负外边距把裁剪框
                向外扩 4px、内边距再放回原位——列表位置与宽度分毫不动 */}
            <div className="-mx-1 min-h-0 overflow-hidden px-1">
              <ul
                ref={threadListRef}
                data-slot="mail-thread-list"
                // 列表自己滚（优先级 ②）：高度由外层 flex 缺口决定，`max-h-full` 只做封顶，
                // 超过就内部滚动而不是把正文继续顶小。`lg:` 前缀与正文同一处理——
                // 窄屏是整页文档流，那里不需要嵌套滚动区。
                className="divide-y divide-border rounded-xl border border-border lg:max-h-full lg:overflow-y-auto"
              >
                {thread.map((m) => {
                  const current = m.messageId === messageId;
                  return (
                    <li key={m.messageId}>
                      <button
                        type="button"
                        disabled={current}
                        aria-current={current || undefined}
                        onClick={() => router.push(`/mail/message/${encodeMessageId(m.messageId)}`, mailNavOptions())}
                        className={cn(
                          // 聚焦反馈用底色而不是描边（与左栏列表行同一套）：列表现在是
                          // 滚动容器，行上的外扩光圈会被它裁掉上下两边
                          "flex w-full items-baseline gap-2 px-3 py-2 text-left text-sm transition-colors",
                          "focus-visible:bg-accent/50 focus-visible:outline-none",
                          current ? "bg-accent/50" : "hover:bg-accent/50",
                        )}
                      >
                        <span className={cn("shrink-0", !m.seen && !current && "font-semibold")}>
                          {m.fromName || m.fromAddr}
                        </span>
                        {current && (
                          <Badge variant="outline" className="shrink-0">
                            {t("threadThis")}
                          </Badge>
                        )}
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{m.snippet}</span>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {absDateTime(m.date, t("localeTag"))}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </section>
      )}

      {/* 页内快速回复（4.9）：默认收件账号 = 副本所属账号；
          需要换账号或附件时跳完整编辑器。
          ⚠ 仅收件邮件显示（2026-10-04）：它就是「回复」的简化版，对自己发出的邮件无意义
          折叠（2026-10-06 用户要求）：**默认收起**，点标题行展开/收起；收起时内容
          保持挂载但 `inert`（不可聚焦、不进读屏，输入到一半的文字不丢），展开高度
          用 grid 轨道 1fr↔0fr 过渡（与工具栏「写邮件」文字段同一套做法与曲线）。 */}
      {!sent && (
        <section
          className="rounded-xl border border-border p-3"
          data-slot="mail-quick-reply"
          data-open={quickOpen ? "true" : "false"}
        >
          <button
            type="button"
            onClick={() => setQuickOpen((v) => !v)}
            aria-expanded={quickOpen}
            aria-controls="mail-quick-reply-panel"
            className="group/quick flex w-full items-center justify-between gap-2 rounded-md text-left focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {/* 标题用常规前景色（2026-10-06 用户指定，勿改回 text-muted-foreground）：
                它是这一块的标题而非辅助文案；悬浮反馈改由右侧箭头变深承担 */}
            <span className="text-sm font-medium">{t("quickReply")}</span>
            <ChevronDownIcon
              className={cn(
                "size-4 text-muted-foreground transition-[color,transform] group-hover/quick:text-foreground",
                MOTION_SIZE,
                quickOpen && "rotate-180",
              )}
              aria-hidden
            />
          </button>
          <div
            id="mail-quick-reply-panel"
            className={cn(
              "grid transition-[grid-template-rows]",
              MOTION_SIZE,
              quickOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
            )}
            inert={quickOpen ? undefined : true}
          >
            {/* -mx-1 + px-1：overflow-hidden 的裁剪区是 padding box，而输入框
                （w-full）左右边缘恰好贴住裁剪边界——聚焦光晕圈往左右外扩的 3px 会
                被剪掉，上下却画得出来，渲染成「上下有圈、左右没有」的怪样子
                （2026-10-06 用户报，逐像素取证确认）。负外边距把裁剪框向左右各
                扩 4px（伸进卡片的 p-3 空隙），内边距再把内容放回原位——输入框
                位置/宽度分毫不动，光晕圈四边都能画出来 */}
            <div className="-mx-1 min-h-0 overflow-hidden px-1">
              <div className="flex flex-col gap-2 pt-2">
                {/* 聚焦样式 = 全站输入框规范（2026-10-06 用户定稿：边框 2px +
                    只加光晕、不给边框换深色；样式在 ui/textarea）。此前查障记录：
                    曾怀疑本卡片半像素坐标导致光晕渲染异常而加过 transform 补偿，
                    实测是反向优化已移除——Chrome 自己会把边框/光晕圈对齐整数像素 */}
                <Textarea
                  value={quickText}
                  onChange={(e) => setQuickText(e.target.value)}
                  rows={3}
                  placeholder={t("quickReplyPlaceholder", { name: detail.fromName || detail.fromAddr })}
                />
                {/* 两个动作**整体靠右**（2026-10-06 用户指定，勿改回左对齐 + 单个 ml-auto）：
                    主操作「发送」贴最右，次要动作「进入完整编辑器回复」紧挨其左；
                    次要链接字号比按钮小一档（12px） */}
                <div className="flex items-center justify-end gap-2">
                  <Link
                    href={`/mail/compose?replyTo=${encodeURIComponent(messageId)}`}
                    data-slot="button"
                    className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "text-xs")}
                  >
                    {t("openComposer")}
                  </Link>
                  <Button size="sm" onClick={quickSend} disabled={quickSending || !quickText.trim()}>
                    {quickSending ? <Spinner /> : <SendIcon data-icon="default" />}
                    {quickSending ? t("sending") : t("send")}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("deleteConfirmTitle")}
        description={t("deleteConfirmBody")}
        confirmLabel={t("delete")}
        pending={acting}
        onConfirm={doDelete}
      />

      {/* 原始邮件（2026-10-07）：头部按原文顺序与折行原样展示；可下载 .eml 原件 */}
      <Dialog open={rawOpen} onOpenChange={setRawOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("rawMessage")}</DialogTitle>
            <DialogDescription>{t("rawMessageHint")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <pre
              data-slot="mail-raw-headers"
              className="max-h-80 overflow-auto rounded-xl border border-border bg-muted/40 p-3 text-xs leading-relaxed break-all whitespace-pre-wrap"
            >
              {(detail.headers ?? []).map((h) => h.line).join("\n")}
            </pre>
            {detail.truncated ? (
              <p className="text-sm text-muted-foreground">{t("rawMessageTruncated")}</p>
            ) : (
              <a
                href={`/api/mail/message/${encodeURIComponent(messageId)}/source`}
                download
                data-slot="button"
                className={cn(buttonVariants({ variant: "outline", size: "sm" }), "self-start border-border")}
              >
                <DownloadIcon data-icon="default" />
                {t("downloadEml")}
              </a>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
