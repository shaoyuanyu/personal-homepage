"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  ForwardIcon,
  MailOpenIcon,
  MailIcon,
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
import { MOTION_SIZE } from "@/components/mail/motion";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import type { MailAddress, MailDetail, MailListItem } from "@/lib/mail/types";

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
          {t("loadFailed")}：{error}
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

  return (
    <div className="flex flex-col gap-5">
      {/* 操作栏
          ⚠ 「返回列表」仅窄屏需要：宽屏下左栏就是列表（MAIL-AGENT.md 4.12）。
          ⚠ 按钮层级（2026-10 用户指定，勿改回）：「回复」是本页最重要的动作——
          唯一带边框、且放在**最右边**（主操作位）；「删除」去边框退为安静动作
          （有确认弹窗兜底，不需要边框强调）；其余全部 ghost。 */}
      <div className="flex flex-wrap items-center gap-2" data-slot="message-actions">
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
            不折行会把 7 个按钮挤出视口造成横向滚动 */}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={acting} onClick={() => postFlags({ seen: !detail.seen })}>
            {detail.seen ? <MailOpenIcon data-icon="default" /> : <MailIcon data-icon="default" />}
            {detail.seen ? t("markUnread") : t("markRead")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={acting}
            aria-pressed={detail.flagged}
            onClick={() => postFlags({ flagged: !detail.flagged })}
          >
            <StarIcon className={cn("size-4", detail.flagged && "fill-foreground")} data-icon={detail.flagged ? undefined : "default"} />
            {detail.flagged ? t("unflag") : t("flag")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={acting}
            className="hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2Icon data-icon="default" />
            {t("delete")}
          </Button>
          <Link
            href={`/mail/compose?forward=${encodeURIComponent(messageId)}`}
            data-slot="button"
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            <ForwardIcon data-icon="default" />
            {t("forward")}
          </Link>
          {/* 回复 / 回复全部：**仅收件邮件需要**——对已经发出的邮件回复自己没有意义
              （要补内容用「转发」），这是收件/发件的功能区分（2026-10-04 用户反馈）。
              ⚠ 「回复全部」必须紧挨「回复」（用户 2026-10-04 指定）且在其左侧；
              「回复」保持最右的主操作位（小范围里唯一带边框的那一个，2026-10 用户指定）。 */}
          {!sent && (
            <>
              <Link
                href={`/mail/compose?replyTo=${encodeURIComponent(messageId)}&all=1`}
                data-slot="button"
                className={buttonVariants({ variant: "ghost", size: "sm" })}
              >
                <ReplyAllIcon data-icon="default" />
                {t("replyAll")}
              </Link>
              {/*
               * 回复（本页最重要的动作，放在最右边的主操作位，是小范围里**有边框**的那一个）：
               * 它平时是裸 buttonVariants()，而裸字符串不经 cn 归并——基础类的
               * border-transparent 会盖掉 outline 的 border-border，所以想要边框只能
               * 显式补一个 border-border（勿改成 <Button render={<Link/>}>，会触发
               * Base UI 的 nativeButton 警告，见 CLAUDE.md 入口渲染那条）。
               */}
              <Link
                href={`/mail/compose?replyTo=${encodeURIComponent(messageId)}`}
                data-slot="button"
                className={cn(buttonVariants({ variant: "outline", size: "sm" }), "border-border")}
              >
                <ReplyIcon data-icon="default" />
                {t("reply")}
              </Link>
            </>
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
          <span className="relative mt-0.5 shrink-0">
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
                      className="ml-1.5 inline-block size-3.5 align-[-2px] text-muted-foreground"
                      aria-label={t("contacts.senderSaved")}
                    />
                  ) : (
                    <button
                      type="button"
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

      {/* 远程内容提示（4.4：默认剥除，显式点击逐封加载一次） */}
      {detail.remoteBlocked > 0 && !remoteShown && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
          <span>{t("remoteBlocked", { count: detail.remoteBlocked })}</span>
          <Button variant="outline" size="sm" onClick={showRemoteImages}>
            {t("showRemote")}
          </Button>
        </div>
      )}

      {/* 正文 */}
      {detail.html ? (
        <div
          ref={bodyRef}
          className="mail-body overflow-x-auto rounded-xl border border-border bg-background p-4 text-sm leading-relaxed"
          // webmaild 已做过 sanitize + 远程资源剥除（4.4）
          dangerouslySetInnerHTML={bodyInnerHtml}
        />
      ) : (
        <div className="whitespace-pre-wrap rounded-xl border border-border p-4 text-sm leading-relaxed">
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
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    <DownloadIcon data-icon="default" />
                    {a.filename}
                    <span className="text-xs text-muted-foreground tabular-nums">{fmtSize(a.size)}</span>
                  </a>
                </li>
              ))}
          </ul>
        </section>
      )}

      {/* 会话（4.7）：同一会话的其它邮件，按时间升序；当前封高亮不跳转 */}
      {thread && thread.length > 1 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            {t("threadTitle", { count: thread.length })}
          </h2>
          <ul className="divide-y divide-border rounded-xl border border-border" data-slot="mail-thread">
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
                      "flex w-full items-baseline gap-2 px-3 py-2 text-left text-sm transition-colors",
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
    </div>
  );
}
