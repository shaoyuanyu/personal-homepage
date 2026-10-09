"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { ArrowLeftIcon, PaperclipIcon, SendIcon, XIcon } from "lucide-react";

import { Link, useRouter } from "@/lib/i18n/navigation";
import { useOwnAddresses } from "@/lib/mail/use-own-addresses";
import { cn } from "@/lib/utils";
import { usePublishDraftBar, type MailDraftBarState } from "@/components/mail/mail-statusbar";
import { senderLabel } from "@/components/mail/account-label";
import { RecipientInput } from "@/components/mail/recipient-input";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import type { MailAccount, MailAddress, MailDetail, MailDraft, SendAttachmentInput } from "@/lib/mail/types";

/** 服务器端草稿变更广播（写信页保存/删除后；草稿箱列表据此刷新） */
export const MAIL_DRAFTS_CHANGED_EVENT = "mail:drafts-changed";

/** 自动保存提交的载荷（写信页 → webmaild /drafts；地址串保原文） */
interface DraftPayload {
  kind: MailDraft["kind"];
  kindRef: string;
  accountId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  readReceipt: boolean;
  inReplyTo: string;
  references: string[];
}

/** 附件大小上限（与 webmaild 的 40MB body 上限配套，留 base64 膨胀余量） */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** 表单头（2026-10-06 重设计）行：标签固定 3.5rem 列 + 控件占满剩余
 *  （minmax(0,1fr)：长地址不撑破行；3.5rem 容得下「发件人」3 字） */
const HEADER_ROW = "grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-2 px-3.5 py-1";

/** 表单头行内控件的「无边框」覆写：描边属于外层容器，控件只保留自身焦点环。
 *  ⚠ `-mx-1.5` 抵消 `px-1.5`：文字位置与其它行对齐，同时给焦点环留出余量
 *  ⚠ 这个聚焦规范（ring-2 ring-ring/40、不改边框色）2026-10-06 起已推广为
 *    全站输入框的聚焦样式（CLAUDE.md「输入框边框」）——本组件即标准样板 */
const BARE_CONTROL =
  "border-0 bg-transparent px-1.5 -mx-1.5 shadow-none focus-visible:ring-2 focus-visible:ring-ring/40 dark:bg-transparent";

/** 选项 chip（表单头底部）：收起 = 灰描边 + 次要色；开启 = 主色淡底 */
const OPTION_CHIP =
  "h-7 rounded-full border-border px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:border-primary/30 aria-pressed:bg-primary/10 aria-pressed:text-primary";

/** 地址串里的地址个数（分隔符口径与发送解析一致），选项 chip 的上标计数用 */
function countAddrs(value: string): number {
  return value.split(/[,;，；]/).filter((s) => s.trim()).length;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** base64 长度 → 原始字节数（附件条上显示大小用） */
function base64Bytes(contentBase64: string): number {
  return Math.round((contentBase64.length * 3) / 4);
}

/** 字节 → base64（转发时把原附件装回附件列表；FileReader 那条路只适用于用户拖进来的 File） */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000; // 分块拼接：一次 apply 太多参数会爆栈
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 去重（大小写不敏感、保序）——回复全部的收件人/抄送合并用 */
function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((a) => {
    const k = a.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function fmtAddress(a: MailAddress): string {
  return a.name ? `${a.name} <${a.address ?? ""}>` : (a.address ?? "");
}

/** 写邮件：选发件身份；回复 / 回复全部 / 转发时带入原信内容；
 *  草稿自动保存到服务器（2026-10-06，500ms 防抖；草稿箱在 /mail 的「草稿」tab） */
export function ComposeForm() {
  const t = useTranslations("mail");
  const router = useRouter();
  const searchParams = useSearchParams();
  const replyTo = searchParams.get("replyTo");
  const replyAll = searchParams.get("all") === "1";
  const forwardId = searchParams.get("forward");
  // 通讯录「写信」入口预填收件人
  const toParam = searchParams.get("to");
  /** 从草稿箱进入（?draft=<id>）：显式编辑该草稿（只加载它的内容，不做回复/转发预填） */
  const urlDraftId = searchParams.get("draft");
  // 自己的地址（4.10）：补全第一位用，回复全部时还要据此把自己的地址从收件人里剔掉
  const { ready: ownReady, own, emails: ownEmails } = useOwnAddresses();

  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [fromId, setFromId] = useState("");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  // 抄送 / 密送行默认收起（2026-10-06 重设计），由选项条 chips 展开；
  // 草稿恢复时若对应字段有内容则自动展开（见恢复 effect）
  const [ccShown, setCcShown] = useState(false);
  const [bccShown, setBccShown] = useState(false);
  /** 邮件回执（MDN）：请求对方阅读后发送回执，写 Disposition-Notification-To 头 */
  const [readReceipt, setReadReceipt] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [attachments, setAttachments] = useState<SendAttachmentInput[]>([]);
  const [sending, setSending] = useState(false);
  const [replyRef, setReplyRef] = useState<{ inReplyTo: string; references: string[] } | null>(null);
  const [dragging, setDragging] = useState(false);
  /** 草稿落盘状态（底栏展示）：null = 尚无内容；saved = 已自动保存（附时刻，底栏显示相对时间）；
   *  error = 服务器写入失败 */
  const [draftState, setDraftState] = useState<MailDraftBarState | null>(null);
  /**
   * 这封草稿在服务器上带的附件（2026-10-10）。
   * 站内还不能编辑草稿附件，但**保存时后端会把它们原样带过去**（draft-mirror 的
   * readKeptAttachments），这里只做只读告知——否则用户会以为附件被弄丢了。
   */
  const [keptAttachments, setKeptAttachments] = useState<{ filename: string; size: number }[]>([]);
  // 底栏（MailShell 的贯通状态栏）在撰写路由显示草稿状态：挂载即标记撰写模式（左区换成
  // 草稿状态、中区账号指示隐藏），离开路由自动还原成列表统计
  usePublishDraftBar(draftState);
  const fileRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // ---- 服务器端草稿（2026-10-06，替换 localStorage 单草稿）----
  /** 当前草稿 id（服务器）；null = 尚未创建（首次保存时 POST）——只存 ref（无渲染点） */
  const draftIdRef = useRef<string | null>(null);
  /** 恢复流程完成前抑制自动保存（异步拉草稿期间，空白初值不得把服务器草稿冲掉） */
  const restoreDoneRef = useRef(false);
  /**
   * 「恢复草稿引起的那一次状态变化不算用户改动」。
   *
   * ⚠ 必须挡住（2026-10-10）：恢复草稿会 set 一串 state（正文/收件人/发件账号/replyRef…），
   * 而自动保存的 effect 就盯这些 state——不挡的话"打开一封草稿"＝"立刻把它重存一遍"：
   * 服务器上的那份会被替换（新 UID、时间变成"刚刚"），用户只是看了一眼却看到"最近修改时间
   * 变成了现在"，草稿箱里的排序也被搅乱。草稿改为以服务商草稿文件夹为唯一事实源之后，
   * 每一次这样的重存都是一次真实的服务器写入，代价更明确。
   */
  const skipNextAutosaveRef = useRef(false);
  /** 自上次成功保存后有修改（卸载 flush 只补有修改的草稿） */
  const dirtyRef = useRef(false);
  /** 已发送（防卸载 flush 在发送成功后又新建一封草稿） */
  const sentRef = useRef(false);
  /** 组件已卸载（异步回调不再 setState） */
  const unmountedRef = useRef(false);
  /** 保存串行链：请求按提交顺序落地（last-write-wins，避免乱序覆盖） */
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  /** 保存载荷镜像：自动保存 / 卸载 flush 从 ref 读最新值（不受 effect 闭包时序影响） */
  const payloadRef = useRef<DraftPayload>({
    kind: "new",
    kindRef: "",
    accountId: "",
    to: "",
    cc: "",
    bcc: "",
    subject: "",
    body: "",
    readReceipt: false,
    inReplyTo: "",
    references: [],
  });
  // 附件入列时要看「当前已有多少字节」；预填附件的 effect 不能把 attachments 写进 deps
  // （否则每加一个附件就重新拉一次原信），故用 ref 镜像最新值。
  const attachmentsRef = useRef<SendAttachmentInput[]>([]);

  // 草稿键（旧版 localStorage 草稿的一次性迁移用）：回复 / 转发按原信分键，新信共用一个键
  const draftKey = replyTo
    ? `mail:draft:reply:${replyTo}`
    : forwardId
      ? `mail:draft:forward:${forwardId}`
      : "mail:draft:new";
  /** 草稿归属（服务器端找回键）：新建 / 回复（同一原信）/ 转发（同一原信）各自找最近更新的草稿 */
  const draftKind: MailDraft["kind"] = replyTo ? "reply" : forwardId ? "forward" : "new";
  const draftKindRef = replyTo ?? forwardId ?? "";
  // 保存载荷镜像（每次 render 更新；卸载 flush 也能读到最新值）
  payloadRef.current = {
    kind: draftKind,
    kindRef: draftKindRef,
    accountId: fromId,
    to,
    cc,
    bcc,
    subject,
    body,
    readReceipt,
    inReplyTo: replyRef?.inReplyTo ?? "",
    references: replyRef?.references ?? [],
  };

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    fetch("/api/mail/accounts")
      .then((r) => (r.ok ? r.json() : []))
      .then((data: MailAccount[]) => {
        const enabled = data.filter((a) => a.enabled);
        setAccounts(enabled);
        // 草稿恢复可能已选了发件账号：只在未选时给默认（勿覆盖）
        if (enabled.length > 0) setFromId((prev) => prev || enabled[0].id);
      })
      .catch(() => {});
  }, []);

  /** 草稿内容应用（「非空才覆盖」：空字段留给回复 / 转发预填，不清掉已有值；
   *  带内容的抄送 / 密送行自动展开，否则内容会藏在收起行里） */
  const applyDraft = useCallback(
    (d: {
      to?: string;
      cc?: string;
      bcc?: string;
      subject?: string;
      body?: string;
      receipt?: boolean;
      accountId?: string;
      inReplyTo?: string;
      references?: string[];
    }) => {
      if (d.to) setTo(d.to);
      if (d.cc) {
        setCc(d.cc);
        setCcShown(true);
      }
      if (d.bcc) {
        setBcc(d.bcc);
        setBccShown(true);
      }
      if (d.subject) setSubject(d.subject);
      if (d.body) setBody(d.body);
      if (d.receipt) setReadReceipt(true);
      if (d.accountId) setFromId(d.accountId);
      if (d.inReplyTo) setReplyRef({ inReplyTo: d.inReplyTo, references: d.references ?? [] });
    },
    [],
  );

  /**
   * 草稿恢复（2026-10-06 服务器端草稿，替换 localStorage 单草稿）：
   * - `?draft=<id>`：从草稿箱进入——加载该草稿（不做回复 / 转发预填）；
   * - 否则按「归属键」找最近更新的同源草稿（列表按 updatedAt 倒序取第一条）——
   *   写一半离开后再从同一邮件点回复 / 转发，能继续写；新建写信恢复最近的新建草稿。
   *
   * 恢复完成前 `restoreDoneRef` 未置位 → 自动保存被抑制（异步拉取期间，空白初值
   * 不得把服务器草稿冲掉）。找不到服务器草稿时尝试一次性迁移旧版 localStorage 草稿
   * （恢复内容并删除本地键，之后由自动保存落成服务器草稿）。
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let restored = false;
      try {
        // ⚠ 取草稿分两步（2026-10-10 草稿改为"服务商草稿文件夹 = 唯一事实源"之后）：
        //   ① 先定位是哪一封（`?draft=<id>` 直接取；否则按归属键按 kind/kindRef 从**本地缓存**里找
        //      ——不发 IMAP，写信页是高频入口）；
        //   ② 再按 id 取单封：服务器草稿的正文/附件在**服务端按需抓原文解析**，列表那一步只有
        //      envelope（主题/收件人/时间）。漏了这一步就会出现"草稿有内容，写信页却是空白"。
        let hit: MailDraft | null = null;
        if (urlDraftId) {
          const res = await fetch(`/api/mail/drafts/${encodeURIComponent(urlDraftId)}`);
          if (res.ok) hit = (await res.json()) as MailDraft;
        } else {
          const params = new URLSearchParams({ kind: draftKind, kindRef: draftKindRef });
          const res = await fetch(`/api/mail/drafts?${params}`);
          if (res.ok) {
            const data = (await res.json()) as { items?: MailDraft[] };
            const first = data.items?.[0];
            if (first) {
              const one = await fetch(`/api/mail/drafts/${encodeURIComponent(first.id)}`);
              if (one.ok) hit = (await one.json()) as MailDraft;
            }
          }
        }
        {
          if (hit && !cancelled) {
            draftIdRef.current = hit.id;
            applyDraft({
              to: hit.to,
              cc: hit.cc,
              bcc: hit.bcc,
              subject: hit.subject,
              body: hit.body,
              receipt: hit.readReceipt,
              accountId: hit.accountId,
              inReplyTo: hit.inReplyTo,
              references: hit.references,
            });
            // 底栏直接进「已保存」态：显示的是这封草稿上次保存的时刻
            if (hit.to || hit.subject || hit.body) {
              setDraftState({ status: "saved", at: new Date(hit.updatedAt).getTime() || Date.now() });
            }
            // 服务商草稿里带的附件：站内不显示也不支持编辑，但保存时会由后端原样保留
            // （draft-mirror 的 readKeptAttachments），这里只如实告知，别让用户以为丢了
            setKeptAttachments(hit.attachments ?? []);
            // 下面这串 setState 触发的自动保存要跳过（见 skipNextAutosaveRef）
            skipNextAutosaveRef.current = true;
            restored = true;
          }
        }
      } catch {
        // 网络失败：按无草稿处理（写信照常可用，首次保存会重试创建）
      }
      if (cancelled) return;
      if (!restored) {
        // 旧版 localStorage 草稿迁移（一次性）
        try {
          const raw = window.localStorage.getItem(draftKey);
          if (raw) {
            const d = JSON.parse(raw) as {
              to?: string;
              cc?: string;
              bcc?: string;
              subject?: string;
              body?: string;
              receipt?: boolean;
            };
            applyDraft(d);
            window.localStorage.removeItem(draftKey);
          }
        } catch {
          // 草稿损坏或存储不可用：忽略
        }
      }
      restoreDoneRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [urlDraftId, draftKind, draftKindRef, draftKey, applyDraft]);

  /**
   * 草稿落盘（服务器端，串行链保证请求按提交顺序落地 / last-write-wins）：
   * - 无草稿且有内容 → POST 创建（拿到 id 后走 PUT）；
   * - 有草稿 → PUT 整体替换；
   * - 内容被清空（全字段空）→ DELETE 删除草稿（清空 = 放弃这封）；
   * - 成功后广播 `mail:drafts-changed`（草稿箱列表刷新）、底栏进「已保存」态。
   */
  const flushDraft = useCallback(() => {
    const run = async () => {
      const payload = payloadRef.current;
      const id = draftIdRef.current;
      const empty = !payload.to && !payload.cc && !payload.bcc && !payload.subject && !payload.body;
      try {
        if (empty) {
          if (!id) return;
          draftIdRef.current = null;
          await fetch(`/api/mail/drafts/${encodeURIComponent(id)}`, { method: "DELETE" });
          dirtyRef.current = false;
          if (!unmountedRef.current) {
            setDraftState(null);
          }
          window.dispatchEvent(new Event(MAIL_DRAFTS_CHANGED_EVENT));
          return;
        }
        const res = id
          ? await fetch(`/api/mail/drafts/${encodeURIComponent(id)}`, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            })
          : await fetch("/api/mail/drafts", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            });
        if (!res.ok) throw new Error(`${res.status}`);
        if (!id) {
          const created = (await res.json()) as MailDraft;
          draftIdRef.current = created.id;
        }
        dirtyRef.current = false;
        if (!unmountedRef.current) setDraftState({ status: "saved", at: Date.now() });
        window.dispatchEvent(new Event(MAIL_DRAFTS_CHANGED_EVENT));
      } catch {
        // 服务器写入失败：底栏亮琥珀点报「草稿保存失败」（title 有说明）
        if (!unmountedRef.current) setDraftState({ status: "error", at: Date.now() });
      }
    };
    saveChainRef.current = saveChainRef.current.then(run, run);
  }, []);

  // 草稿自动保存（500ms 防抖；恢复完成前不保存——防空白初值冲掉服务器草稿）
  useEffect(() => {
    if (!restoreDoneRef.current) return;
    if (skipNextAutosaveRef.current) {
      skipNextAutosaveRef.current = false;
      return;
    }
    dirtyRef.current = true;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => flushDraft(), 500);
    return () => clearTimeout(saveTimer.current);
  }, [draftKey, to, cc, bcc, subject, body, readReceipt, fromId, replyRef, flushDraft]);

  // 卸载：补一次未落盘的修改（防抖窗口内离开不丢最后 500ms 的输入）；已发送的不补
  useEffect(
    () => () => {
      unmountedRef.current = true;
      clearTimeout(saveTimer.current);
      if (!sentRef.current && restoreDoneRef.current && dirtyRef.current) flushDraft();
    },
    [flushDraft],
  );

  /**
   * 附件入列的唯一入口（用户拖拽/选择 与 转发预填 共用）：
   * 单个与总量上限同值（4.9「超总量给提示」），超限的逐个提示后丢弃。
   */
  const appendAttachments = useCallback(
    (incoming: SendAttachmentInput[]) => {
      if (incoming.length === 0) return;
      let total = attachmentsRef.current.reduce((s, a) => s + base64Bytes(a.contentBase64), 0);
      const accepted: SendAttachmentInput[] = [];
      for (const a of incoming) {
        const size = base64Bytes(a.contentBase64);
        if (size > MAX_ATTACHMENT_BYTES || total + size > MAX_ATTACHMENT_BYTES) {
          toast.add({ title: t("attachmentTooLarge", { name: a.filename }), type: "error" });
          continue;
        }
        total += size;
        accepted.push(a);
      }
      if (accepted.length > 0) setAttachments((prev) => [...prev, ...accepted]);
    },
    [t],
  );

  /**
   * 回复 / 回复全部：取原邮件，预填收件人、主题与引用关系。
   *
   * ⚠ 回复全部必须等「我的账号」就绪再算（`ownReady`）：自己的地址在 To/Cc 里时
   *   必须剔除，否则会给自己发一份——先算后到就剔不掉了。
   */
  useEffect(() => {
    if (!replyTo) return;
    if (replyAll && !ownReady) return;
    fetch(`/api/mail/message/${encodeURIComponent(replyTo)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: MailDetail | null) => {
        if (!data) return;
        const isOwn = (addr: string) => ownEmails.has(addr.toLowerCase());
        // 惯例：To = 原发件人 + 原收件人；Cc = 原抄送；两边都剔掉自己并去重
        const toList = replyAll
          ? dedupe(
              [data.fromAddr, ...data.to.map((a) => a.address ?? "")].filter(
                (a) => a && !isOwn(a),
              ),
            )
          : [data.fromAddr];
        const inTo = new Set(toList.map((a) => a.toLowerCase()));
        const ccList = replyAll
          ? dedupe(
              data.cc
                .map((a) => a.address ?? "")
                .filter((a) => a && !isOwn(a) && !inTo.has(a.toLowerCase())),
            )
          : [];
        setTo((prev) => prev || toList.join(", "));
        setCc((prev) => prev || ccList.join(", "));
        // 回复全部带出抄送时展开抄送行（否则内容藏在收起的行里）
        if (ccList.length > 0) setCcShown(true);
        setSubject((prev) => prev || (/^re:/i.test(data.subject) ? data.subject : `Re: ${data.subject}`));
        // 规范化后的 messageId 形如 mid:<id>@<host>，取尖括号形式写回引用头
        const rawMid = data.messageId.startsWith("mid:")
          ? `<${data.messageId.slice(4)}>`
          : "";
        if (rawMid) setReplyRef({ inReplyTo: rawMid, references: [rawMid] });
        setBody((prev) => prev || `\n\n-------- ${t("quoteSeparator")} --------\n${data.text}`);
      })
      .catch(() => {});
  }, [replyTo, replyAll, ownReady, ownEmails, t]);

  /**
   * 转发：带入原主题、引用头块与**附件**（内嵌图不带）。
   *
   * ⚠ 转发是新会话，**不**写 In-Reply-To / References（写了会把转发挂回原会话）。
   */
  useEffect(() => {
    if (!forwardId) return;
    let cancelled = false;
    const header = (d: MailDetail) => {
      const lines = [`${t("fieldFrom")}: ${d.fromName ? `${d.fromName} <${d.fromAddr}>` : d.fromAddr}`];
      if (d.date) {
        lines.push(`${t("fieldDate")}: ${new Date(d.date).toLocaleString(t("localeTag"))}`);
      }
      lines.push(`${t("fieldSubject")}: ${d.subject || t("noSubject")}`);
      const to = d.to.map(fmtAddress).filter(Boolean).join(", ");
      if (to) lines.push(`${t("fieldTo")}: ${to}`);
      const cc = d.cc.map(fmtAddress).filter(Boolean).join(", ");
      if (cc) lines.push(`${t("fieldCc")}: ${cc}`);
      return lines.join("\n");
    };
    void (async () => {
      const res = await fetch(`/api/mail/message/${encodeURIComponent(forwardId)}`).catch(() => null);
      if (!res?.ok || cancelled) return;
      const data = (await res.json()) as MailDetail;
      if (cancelled) return;
      setSubject((prev) => (prev || (/^fwd:/i.test(data.subject) ? data.subject : `Fwd: ${data.subject}`)));
      setBody((prev) => prev || `\n\n-------- ${t("forwardSeparator")} --------\n${header(data)}\n${data.text}`);
      // 附件随转发带走：逐个从附件端点取回字节再塞进附件列表（内嵌图不算附件）
      const wanted = data.attachments.filter((a) => !a.inline);
      if (wanted.length === 0) return;
      const fetched = await Promise.all(
        wanted.map(async (a): Promise<SendAttachmentInput | null> => {
          try {
            const r = await fetch(
              `/api/mail/message/${encodeURIComponent(forwardId)}/attachment/${a.index}`,
            );
            if (!r.ok) return null;
            return {
              filename: a.filename,
              contentType: a.contentType || "application/octet-stream",
              contentBase64: bytesToBase64(new Uint8Array(await r.arrayBuffer())),
            };
          } catch {
            return null; // 单个附件取不回来不影响写信
          }
        }),
      );
      if (cancelled) return;
      appendAttachments(fetched.filter((a): a is SendAttachmentInput => a !== null));
    })();
    return () => {
      cancelled = true;
    };
  }, [forwardId, appendAttachments, t]);

  // 通讯录「写信」入口：预填收件人（不覆盖草稿已恢复的内容）
  useEffect(() => {
    if (toParam) setTo((prev) => prev || toParam);
  }, [toParam]);

  // 左栏联系人面板（4.14）点击「加入收件人」→ 追加到收件人（去重；
  // 分隔符口径与发送解析一致。面板只在撰写路由显示，故直接 setTo 无顾虑）
  useEffect(() => {
    const onAdd = (e: Event) => {
      const email = (e as CustomEvent<string>).detail;
      if (!email) return;
      setTo((prev) => {
        const list = prev.split(/[,;，；]/).map((s) => s.trim()).filter(Boolean);
        if (list.some((a) => a.toLowerCase() === email.toLowerCase())) return prev;
        return [...list, email].join(", ");
      });
    };
    window.addEventListener("mail:add-recipient", onAdd);
    return () => window.removeEventListener("mail:add-recipient", onAdd);
  }, []);

  const addAttachments = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      for (const file of Array.from(files)) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          toast.add({ title: t("attachmentTooLarge", { name: file.name }), type: "error" });
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = String(reader.result);
          appendAttachments([
            {
              filename: file.name,
              contentType: file.type || "application/octet-stream",
              contentBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
            },
          ]);
        };
        reader.readAsDataURL(file);
      }
      if (fileRef.current) fileRef.current.value = "";
    },
    [appendAttachments, t],
  );

  // 附件拖拽入区（4.9）：整表单是放置区，拖入时显示虚线提示层
  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      setDragging(true);
    }
  }, []);
  const onDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
  }, []);
  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      addAttachments(e.dataTransfer.files);
    },
    [addAttachments],
  );

  const send = useCallback(async () => {
    if (!fromId || !to.trim()) {
      toast.add({ title: t("needRecipient"), type: "error" });
      return;
    }
    setSending(true);
    try {
      const res = await fetch("/api/mail/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: fromId,
          to: to.split(/[,;，；]/).map((s) => s.trim()).filter(Boolean),
          cc: cc.split(/[,;，；]/).map((s) => s.trim()).filter(Boolean),
          bcc: bcc.split(/[,;，；]/).map((s) => s.trim()).filter(Boolean),
          readReceipt,
          subject,
          text: body,
          inReplyTo: replyRef?.inReplyTo,
          references: replyRef?.references,
          attachments,
          // 来自草稿：webmaild 发送成功后删除该草稿（幂等）
          draftId: draftIdRef.current ?? undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `${res.status}`);
      // 发送成功：标记已发送（防卸载 flush 又新建一封草稿），并清理旧版本地键
      sentRef.current = true;
      dirtyRef.current = false;
      try {
        window.localStorage.removeItem(draftKey);
      } catch {
        // 存储不可用：忽略
      }
      toast.add({ title: t("sent"), type: "success" });
      router.push("/mail");
    } catch (err) {
      toast.add({ title: t("sendFailed"), description: err instanceof Error ? err.message : String(err), type: "error" });
      setSending(false);
    }
  }, [fromId, to, cc, bcc, readReceipt, subject, body, replyRef, attachments, draftKey, router, t]);

  // 选项 chip 的上标计数（0 不渲染）
  const ccCount = countAddrs(cc);
  const bccCount = countAddrs(bcc);

  return (
    <div
      // ⚠ 宽屏（两栏面板内）表单要撑满右栏、正文框吃掉富余高度：`lg:flex-1`
      //   接住 mail-pane-detail 的高度链；**不写 lg:min-h-0**——内容超限（小视口 /
      //   附件多）时让表单按 min-content 撑开、由外层滚动容器接管（写 min-h-0 会把
      //   正文框的 25vh 保底一并压掉，E2E 实测 147.5px < 22vh 红线）
      className="relative flex flex-col gap-4 lg:flex-1"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* 「返回邮件」仅窄屏需要（2026-10-05 用户定稿：桌面端的出口是左栏工具栏里
          的「返回邮箱」按钮，占原「写邮件」位置，两态对称——见 MailContactsPane）；
          窄屏左栏整体隐藏，这里是唯一退路。草稿自动保存，退出不丢内容。
          ⚠ `self-start` 必需：表单根是 flex-col（align-items: stretch 默认值），
          不加会被拉成全宽、按钮文字因 justify-center 居中，与下方字段左缘错位。 */}
      <Link
        href="/mail"
        data-slot="button"
        className={buttonVariants({ variant: "ghost", size: "sm", className: "self-start lg:hidden" })}
      >
        <ArrowLeftIcon data-icon="default" />
        {t("backToMail")}
      </Link>
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/80 text-sm font-medium text-primary">
          {t("dropHint")}
        </div>
      )}

      {/* 表单头（2026-10-06 重设计）：单一容器 + 发丝分隔行——标签固定列宽、行内控件
          无边框（描边属于容器），取代原先 2×2 的四个独立输入框。抄送 / 密送默认
          收起，由选项 chips 展开；chips 同时承担「有内容」的指示（上标计数，
          形态与列表的「未读 n」一致），收起的行不会藏内容。
          ⚠ 容器勿加 overflow-hidden：收件人补全下拉绝对定位在行下方，会被裁掉 */}
      <div data-slot="compose-header" className="divide-y divide-border rounded-xl border border-border">
        {/* 发件人行（2026-10-06 二稿）：发件人只有一个、行内大片留白，选项 chips
            （抄送 / 密送 / 邮件回执）就放这一行右侧，不再单占一条选项条。
            ⚠ 窄屏：`grow`（basis 取内容宽、无 `min-w-0`）让 Select 不被压到装不下
            ——放不下时 chips 整体换到下一行，账号名保持可读；`min-w-32` 是最后兜底
            （极窄视口下允许截断到 128px，不把行撑出横向溢出）。勿改回 `flex-1 min-w-0`：
            那会让账号名在 380px 视口被压到 ~60px（只剩「我<…」） */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3.5 py-1">
          <FieldLabel htmlFor="mail-from" className="w-14 shrink-0 text-muted-foreground">
            {t("fieldFrom")}
          </FieldLabel>
          <div className="min-w-32 grow">
            <Select value={fromId} onValueChange={(v) => setFromId(v ?? "")}>
              <SelectTrigger
                id="mail-from"
                className={cn("max-w-full dark:hover:bg-transparent", BARE_CONTROL)}
              >
                {/* ⚠ 必须用 children 函数渲染标签：不传 items 的裸 <SelectValue /> 显示的是
                    原始 value（账号 id「me」），不是账号名 */}
                <SelectValue>
                  {(v) => {
                    const a = accounts.find((x) => x.id === v);
                    return a ? senderLabel(a) : "";
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {senderLabel(a)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {/* 选项 chips（更多功能的落点）：抄送 / 密送 = 展开对应行，
              邮件回执 = 请求 MDN（写入端写 Disposition-Notification-To 头）。
              计数是上标角标且 aria-hidden——chip 的可访问名保持「抄送 / 密送」 */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Toggle variant="outline" size="sm" pressed={ccShown} onPressedChange={setCcShown} className={OPTION_CHIP}>
              <span className="whitespace-nowrap">
                {t("fieldCc")}
                {ccCount > 0 && (
                  <span
                    data-slot="compose-cc-count"
                    aria-hidden="true"
                    className="ml-0.5 align-super text-xs leading-none tabular-nums"
                  >
                    {ccCount}
                  </span>
                )}
              </span>
            </Toggle>
            <Toggle variant="outline" size="sm" pressed={bccShown} onPressedChange={setBccShown} className={OPTION_CHIP}>
              <span className="whitespace-nowrap">
                {t("fieldBcc")}
                {bccCount > 0 && (
                  <span
                    data-slot="compose-bcc-count"
                    aria-hidden="true"
                    className="ml-0.5 align-super text-xs leading-none tabular-nums"
                  >
                    {bccCount}
                  </span>
                )}
              </span>
            </Toggle>
            <Toggle variant="outline" size="sm" pressed={readReceipt} onPressedChange={setReadReceipt} className={OPTION_CHIP}>
              {t("readReceipt")}
            </Toggle>
          </div>
        </div>

        {/* 收件人 */}
        <div className={HEADER_ROW}>
          <FieldLabel htmlFor="mail-to" className="text-muted-foreground">
            {t("fieldTo")}
          </FieldLabel>
          <RecipientInput
            id="mail-to"
            value={to}
            onValueChange={setTo}
            placeholder="someone@example.org"
            own={own}
            className={BARE_CONTROL}
          />
        </div>

        {/* 抄送（默认收起） */}
        {ccShown && (
          <div className={HEADER_ROW} data-slot="compose-cc-row">
            <FieldLabel htmlFor="mail-cc" className="text-muted-foreground">
              {t("fieldCc")}
            </FieldLabel>
            <RecipientInput id="mail-cc" value={cc} onValueChange={setCc} own={own} className={BARE_CONTROL} />
          </div>
        )}

        {/* 密送（默认收起） */}
        {bccShown && (
          <div className={HEADER_ROW} data-slot="compose-bcc-row">
            <FieldLabel htmlFor="mail-bcc" className="text-muted-foreground">
              {t("fieldBcc")}
            </FieldLabel>
            <RecipientInput id="mail-bcc" value={bcc} onValueChange={setBcc} own={own} className={BARE_CONTROL} />
          </div>
        )}

        {/* 主题 */}
        <div className={HEADER_ROW}>
          <FieldLabel htmlFor="mail-subject" className="text-muted-foreground">
            {t("fieldSubject")}
          </FieldLabel>
          <Input
            id="mail-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className={BARE_CONTROL}
          />
        </div>
      </div>
      <Field className="lg:flex-1">
        {/* 「正文」行（2026-10-05 用户定稿）：标签在左，[添加附件] [发送] 靠最右——
            发送从此行操作，不再沉到表单底部（正文框填满剩余高度后底部没有位置了） */}
        <div className="flex items-center justify-between gap-2">
          <FieldLabel htmlFor="mail-body">{t("fieldBody")}</FieldLabel>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => fileRef.current?.click()} disabled={sending}>
              <PaperclipIcon data-icon="default" />
              {t("addAttachment")}
            </Button>
            <Button onClick={send} disabled={sending || !fromId}>
              {sending ? <Spinner /> : <SendIcon data-icon="default" />}
              {sending ? t("sending") : t("send")}
            </Button>
          </div>
        </div>
        {/* ⚠ 高度（2026-10-05 用户定稿两次）：`min-h-[25vh]` 保底（`rows={14}` 会被
            Textarea 基础类的 `field-sizing-content` 覆盖成 64px，用户反馈太小；E2E
            也锁「正文框 ≥ 22% 视口」）；**富余时填满**（`lg:flex-1`）——
            `lg:[field-sizing:fixed]`：field-sizing:content 与 flex 拉伸互相打架，
            宽屏强制固定尺寸让它听 flex 的。⚠ 勿加 `lg:min-h-0`（会压掉 25vh 保底）。
            内容超出后 textarea 内部滚动。 */}
        <Textarea
          id="mail-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={14}
          className="min-h-[25vh] font-mono text-sm lg:flex-1 lg:[field-sizing:fixed]"
        />
      </Field>

      {keptAttachments.length > 0 && (
        <p className="flex items-start gap-2 text-xs text-muted-foreground" data-slot="draft-kept-attachments">
          <PaperclipIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("draftKeptAttachments", { count: keptAttachments.length })}
        </p>
      )}
      {attachments.length > 0 && (
        <ul className="flex shrink-0 flex-wrap gap-2">
          {attachments.map((a, i) => (
            <li
              key={`${a.filename}-${i}`}
              className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs"
            >
              <PaperclipIcon className="size-3" aria-hidden />
              {a.filename}
              <span className="text-muted-foreground tabular-nums">{fmtSize(base64Bytes(a.contentBase64))}</span>
              <button
                type="button"
                aria-label={t("removeAttachment")}
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
              >
                <XIcon className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* 隐藏的取件 input：按钮已上移到「正文」行（2026-10-05 用户定稿） */}
      <input
        ref={fileRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => addAttachments(e.target.files)}
      />
    </div>
  );
}
