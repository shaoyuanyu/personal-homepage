"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  FolderOpenIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  UserCogIcon,
  XIcon,
} from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { accountDotProps } from "@/components/mail/account-dot";
import { cn } from "@/lib/utils";
import { mailErrorText } from "@/lib/mail/error-text";
import type { MailAccount, MailFolder } from "@/lib/mail/types";

/**
 * 表单里的逗号串 → 提交给后端的 `folders` 数组。
 *
 * - 空串 = `undefined`（交给后端按服务器清单自动选：收件箱 + 已发送 + 垃圾邮件）；
 * - 非空则**保证含 INBOX**：界面上收件箱是锁定常开的（见 probeTarget 附近的注记），
 *   历史白名单里缺它就等于「收件」页空着——用户没有任何理由遇到那个状态。
 */
function pickFolders(raw: string): string[] | undefined {
  const picked = raw.split(",").map((f) => f.trim()).filter(Boolean);
  if (picked.length === 0) return undefined;
  if (picked.some((f) => f.toUpperCase() === "INBOX")) return picked;
  return ["INBOX", ...picked];
}

/**
 * 同步范围里的一行（2026-10-10 重做界面时抽出来）：
 * 复选框 + 人话标题 + 一句说明（说明可以省）。
 *
 * ⚠ 用**原生复选框**（与日历的节点勾选同一套约定）：语义/键盘/无障碍名最稳，
 *   项目里没有也不打算引入 checkbox 封装（`components/ui/` 下没有这个原语）。
 */
function SyncFolderRow({
  label,
  note,
  warn,
  checked,
  locked,
  onChange,
}: {
  label: string;
  note?: string;
  /** 一句"这样做会有什么后果"的提醒（目前只有关掉发件箱时用） */
  warn?: string;
  checked: boolean;
  /** 锁定常开（收件箱）：画一枚静态对勾而不是 `disabled` 的复选框——后者在浏览器里
   *  渲染成一枚灰勾，看着像"这项坏了"（2026-10-10 实测），而这里表达的是"不用选，本来就有" */
  locked?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  if (locked) {
    return (
      <div className="flex items-start gap-2 rounded-md px-1 py-1 text-sm">
        <CheckIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{label}</span>
          {note && <span className="block text-xs text-muted-foreground">{note}</span>}
        </span>
      </div>
    );
  }
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 text-sm hover:bg-accent/40">
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-primary"
        checked={checked}
        onChange={(e) => onChange?.(e.target.checked)}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {note && <span className="block text-xs text-muted-foreground">{note}</span>}
        {warn && (
          <span className="block text-xs text-amber-600 dark:text-amber-400">{warn}</span>
        )}
      </span>
    </label>
  );
}

/** 账号增删后广播，邮件列表（MailClient）据此刷新账号筛选 chips */
export const MAIL_ACCOUNTS_CHANGED_EVENT = "mail-accounts-changed";

interface AddForm {
  /** 备注名（仅站内 UI 显示，**不外发**） */
  displayName: string;
  /** 发件人姓名（随邮件发出的 From 显示名；空 = 只发邮箱地址） */
  senderName: string;
  email: string;
  username: string;
  /** 新增必填；编辑留空 = 不改 */
  password: string;
  imapHost: string;
  imapPort: string;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  folders: string;
}

const EMPTY_FORM: AddForm = {
  displayName: "",
  senderName: "",
  email: "",
  username: "",
  password: "",
  imapHost: "",
  imapPort: "993",
  imapSecure: true,
  smtpHost: "",
  smtpPort: "465",
  smtpSecure: true,
  folders: "",
};

/** 编辑预填：连接字段从账号摘要回填；密码**不回填**（留空 = 不改） */
function accountToForm(a: MailAccount): AddForm {
  return {
    displayName: a.displayName,
    senderName: a.senderName ?? "",
    email: a.email,
    username: a.username ?? "",
    password: "",
    imapHost: a.imapHost ?? "",
    imapPort: String(a.imapPort ?? 993),
    imapSecure: a.imapSecure ?? true,
    smtpHost: a.smtpHost ?? "",
    smtpPort: String(a.smtpPort ?? 465),
    smtpSecure: a.smtpSecure ?? true,
    folders: (a.folders ?? []).join(", "),
  };
}

/**
 * 按邮箱域名自动填 IMAP / SMTP 主机（2026-10-08 用户要求：「输入邮箱地址后，主机应该
 * 自动对应生成，如果不对用户自己会改」）。
 *
 * 两层：常见服务商是**确定的**主机名（下表），其余域名按最通行的约定猜
 * `imap.<域名>` / `smtp.<域名>`——猜错也只是预填错，用户改一下即可。
 * ⚠ 只覆盖**空着**或**仍是我们上次自动填的值**的字段：用户手改过就不再动它
 *   （见 patchEmail 的 autoHostsRef）。
 */
const PROVIDER_HOSTS: { domains: string[]; imap: string; smtp: string }[] = [
  { domains: ["gmail.com", "googlemail.com"], imap: "imap.gmail.com", smtp: "smtp.gmail.com" },
  {
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com", "outlook.com.cn"],
    imap: "outlook.office365.com",
    smtp: "smtp.office365.com",
  },
  { domains: ["qq.com", "foxmail.com", "vip.qq.com"], imap: "imap.qq.com", smtp: "smtp.qq.com" },
  {
    domains: ["exmail.qq.com"],
    imap: "imap.exmail.qq.com",
    smtp: "smtp.exmail.qq.com",
  },
  {
    domains: ["163.com", "126.com", "yeah.net", "188.com"],
    imap: "imap.163.com",
    smtp: "smtp.163.com",
  },
  {
    domains: ["qiye.163.com"],
    imap: "imap.qiye.163.com",
    smtp: "smtp.qiye.163.com",
  },
  {
    domains: ["aliyun.com", "aliyun.cn", "mxhichina.com"],
    imap: "imap.qiye.aliyun.com",
    smtp: "smtp.qiye.aliyun.com",
  },
  { domains: ["sina.com", "sina.cn"], imap: "imap.sina.com", smtp: "smtp.sina.com" },
  { domains: ["sohu.com"], imap: "imap.sohu.com", smtp: "smtp.sohu.com" },
  { domains: ["139.com"], imap: "imap.139.com", smtp: "smtp.139.com" },
  { domains: ["189.cn"], imap: "imap.189.cn", smtp: "smtp.189.cn" },
  {
    domains: ["icloud.com", "me.com", "mac.com"],
    imap: "imap.mail.me.com",
    smtp: "smtp.mail.me.com",
  },
  {
    domains: ["yahoo.com", "yahoo.com.cn"],
    imap: "imap.mail.yahoo.com",
    smtp: "smtp.mail.yahoo.com",
  },
  { domains: ["zoho.com", "zoho.com.cn"], imap: "imap.zoho.com", smtp: "smtp.zoho.com" },
  { domains: ["fastmail.com"], imap: "imap.fastmail.com", smtp: "smtp.fastmail.com" },
  { domains: ["gmx.com", "gmx.net"], imap: "imap.gmx.com", smtp: "smtp.gmx.com" },
];

/** 邮箱地址 → `{imap, smtp}` 预填值；域名还没成形（没有 `@` 或没有点）时返回 null（不动表单） */
export function hostsForEmail(email: string): { imap: string; smtp: string } | null {
  const domain = email.split("@")[1]?.trim().toLowerCase() ?? "";
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return null;
  const hit = PROVIDER_HOSTS.find((p) => p.domains.includes(domain));
  if (hit) return { imap: hit.imap, smtp: hit.smtp };
  return { imap: `imap.${domain}`, smtp: `smtp.${domain}` };
}

/** 账号管理弹窗：列出已添加账号（可删除）+ 添加新账号（保存前先做 IMAP/SMTP 连接测试） */
export function AccountsDialog() {
  const t = useTranslations("mail.accounts");
  /** 顶层 mail 命名空间：文件夹徽章文案（folderSpecial.*）在它下面 */
  const tMail = useTranslations("mail");
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<MailAccount[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /** 编辑中的账号（null = 新增模式）；与 adding 共用同一张表单 */
  const [editing, setEditing] = useState<MailAccount | null>(null);
  const [form, setForm] = useState<AddForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MailAccount | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 远程图片白名单（4.4）：全局设置，与账号同级放在本弹窗；变更即时 PUT 全量
  const [domains, setDomains] = useState<string[] | null>(null);
  const [domainDraft, setDomainDraft] = useState("");
  const [domainSaving, setDomainSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/mail/accounts");
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `${res.status}`);
    setAccounts((await res.json()) as MailAccount[]);
  }, []);

  const loadDomains = useCallback(async () => {
    const res = await fetch("/api/mail/remote-image-domains");
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `${res.status}`);
    setDomains(((await res.json()) as { domains: string[] }).domains);
  }, []);

  useEffect(() => {
    if (!open) return;
    setLoadError(null);
    load().catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
    loadDomains().catch(() => toast.add({ title: t("whitelistFailed"), type: "error" }));
  }, [open, load, loadDomains, t]);

  /** 白名单变更即时落盘（PUT 全量数组，服务端归一化）；失败 toast 且不改本地态 */
  const saveDomains = useCallback(
    async (next: string[]): Promise<boolean> => {
      setDomainSaving(true);
      try {
        const res = await fetch("/api/mail/remote-image-domains", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ domains: next }),
        });
        if (!res.ok) {
          throw new Error((await res.json().catch(() => null))?.error ?? `${res.status}`);
        }
        setDomains(((await res.json()) as { domains: string[] }).domains);
        return true;
      } catch (err) {
        toast.add({
          title: t("whitelistFailed"),
          description: err instanceof Error ? err.message : String(err),
          type: "error",
        });
        return false;
      } finally {
        setDomainSaving(false);
      }
    },
    [t],
  );

  const addDomain = useCallback(async () => {
    const d = domainDraft.trim().toLowerCase();
    if (!d || !domains || domains.includes(d)) return;
    if (await saveDomains([...domains, d])) setDomainDraft("");
  }, [domainDraft, domains, saveDomains]);

  const removeDomain = useCallback(
    async (d: string) => {
      if (!domains) return;
      await saveDomains(domains.filter((x) => x !== d));
    },
    [domains, saveDomains],
  );

  const patch = useCallback((change: Partial<AddForm>) => {
    setForm((prev) => ({ ...prev, ...change }));
  }, []);

  /** 上一次「按域名自动填」写进表单的主机名——用来判断某个字段是否还归自动填管 */
  const autoHostsRef = useRef<{ imap: string; smtp: string }>({ imap: "", smtp: "" });

  /**
   * 邮箱地址变更：顺带把两个主机名跟着域名走。
   * ⚠ 副作用（更新 autoHostsRef）写在 setState **之外**——StrictMode 下 updater 会被
   *   调用两次，写在里面会重复执行（CLAUDE.md「静默失效陷阱 5」）。
   * ⚠ 用户手改过的主机名不动：只在字段为空、或仍是上次自动填的值时才覆盖。
   */
  const patchEmail = useCallback(
    (email: string) => {
      const hosts = hostsForEmail(email);
      const auto = autoHostsRef.current;
      const change: Partial<AddForm> = { email };
      if (hosts) {
        if (!form.imapHost || form.imapHost.trim() === auto.imap) change.imapHost = hosts.imap;
        if (!form.smtpHost || form.smtpHost.trim() === auto.smtp) change.smtpHost = hosts.smtp;
      }
      autoHostsRef.current = {
        imap: change.imapHost ?? auto.imap,
        smtp: change.smtpHost ?? auto.smtp,
      };
      patch(change);
    },
    [form.imapHost, form.smtpHost, patch],
  );

  // ---- 同步范围（2026-10-07 建，2026-10-10 按用户反馈重做界面）----
  // 起因：以前这里是一个手打的输入框（「INBOX, 已发送」），用户得先知道服务器上的文件夹
  // 叫什么；猜错（写 Sent 而实际叫「已发送」）就静默少同步一个文件夹——最典型的症状是新
  // 账号「发件」页永远为空。2026-10-07 改成「探测（IMAP LIST）→ 勾选」，但**界面是给工程师
  // 看的**：一长串服务器路径 + 「用推荐的一组 / 清空」两个没头没脑的按钮，用户（2026-10-10）
  // 说「还是很混乱，且很丑」「看了也一头雾水」。现在改为按**用户视角**问「站内显示哪些邮件」：
  //   · 收件箱 —— 固定同步，不给关；
  //   · 已发送 —— 一个开关，说明它决定「发件」页有没有内容；
  //   · 垃圾邮件 —— 一个开关，说明它决定「垃圾」页有没有内容；
  //   · 其他文件夹 —— 折叠区（默认收起），只有确实想搜归档/自定义文件夹的人才展开。
  // 「用推荐的一组 / 清空」两个按钮删掉：开关本身就是推荐（清空还会让白名单为空被后端拒绝）。
  // ⚠ 新增模式下账号还没落盘、拿不到 id，走 `POST /folders` 用表单里现填的连接参数登录
  //   （因此需要先填密码，未填则按钮禁用并给出提示）；编辑模式在 `openEdit` 里直接自动读。
  const [folderList, setFolderList] = useState<MailFolder[] | null>(null);
  const [folderLoading, setFolderLoading] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  /** `folderList` / `folderError` 是哪一次探测的结果（= 探测目标指纹；见 probeTarget） */
  const [folderProbeKey, setFolderProbeKey] = useState<string | null>(null);
  /** 探测序号：只让**最新**那次的结果落地（连着换账号时旧响应不能覆盖新清单） */
  const probeSeqRef = useRef(0);

  const selectedFolders = useMemo(
    () => form.folders.split(",").map((f) => f.trim()).filter(Boolean),
    [form.folders],
  );
  const canProbe = !!editing || (!!form.password && !!form.imapHost);

  /**
   * 探测目标的指纹：编辑模式 = 账号 id；新增模式 = 表单里现填的连接参数。
   *
   * ⚠ **必须按目标记账**（2026-10-10 用户报「添加这个账号后没手动改过，『同步文件夹』
   *   已选里是「已发送 / 垃圾邮件」，下方未选里却又列出 Sent Messages / Junk」）：
   *   那个清单压根不是这个账号的——是**另一个账号**（QQ）的。`folderList` 是组件 state，
   *   而弹窗组件常驻挂载（开关弹窗并不卸载它），旧代码只在 `folderList === null` 时探测，
   *   于是**一个页面会话里只有第一次探测过**：之后编辑任何账号都看到第一次那个账号的
   *   文件夹列表（实测复现：先看 QQ 账号 → 再编辑阿里云账号，列的仍是 QQ 的
   *   `Sent Messages / Drafts / Deleted Messages / Junk / Archives / 其他文件夹/QQ邮件订阅`）。
   *   危害不止是看不懂：**用户会照着错误的清单勾选**，把别的账号的文件夹路径写进这个账号的
   *   白名单（保存后同步静默少抓或抓错文件夹）。
   */
  const probeKeyOf = useCallback(
    (acct: MailAccount | null) =>
      acct
        ? `account:${acct.id}`
        : ["form", form.email, form.imapHost, form.imapPort, form.imapSecure, form.username].join("\u0000"),
    [form.email, form.imapHost, form.imapPort, form.imapSecure, form.username],
  );
  const probeTarget = useMemo(() => probeKeyOf(editing), [probeKeyOf, editing]);
  /** 结果与当前目标是否对得上：对不上就当作「还没探测」，别把上一个目标的清单/错误拿来显示 */
  const folderProbeFresh = folderProbeKey === probeTarget;

  const probeFolders = useCallback(
    async (acct: MailAccount | null = editing) => {
      const seq = ++probeSeqRef.current;
      const key = probeKeyOf(acct);
      setFolderLoading(true);
      setFolderError(null);
      try {
        const res = acct
          ? await fetch(`/api/mail/folders?account=${encodeURIComponent(acct.id)}`)
          : await fetch("/api/mail/folders", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                email: form.email,
                imapHost: form.imapHost,
                imapPort: Number(form.imapPort),
                imapSecure: form.imapSecure,
                username: form.username || undefined,
                password: form.password,
              }),
            });
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `${res.status}`);
        const data = (await res.json()) as {
          folders: MailFolder[];
          suggested?: string[];
          synced?: string[];
        };
        if (seq !== probeSeqRef.current) return; // 已有更新的探测发出：丢弃这次结果
        setFolderList(data.folders);
        if (selectedFolders.length === 0) {
          // 编辑模式：预选服务器上**当前**的白名单（用户在此基础上增减）；
          // 新增模式：预选后端给的推荐集（收件箱 + 已发送 + 垃圾邮件 —— 与保存时
          //   `suggestSyncFolders()` 自动挑的那一套同源，**不在这里抄一份**，免得漂移）。
          // 不预选的话，开关会是一片空、而保存后后端仍会自动同步那两个文件夹，两边对不上。
          const preset = (acct ? data.synced : data.suggested) ?? [];
          if (preset.length > 0) patch({ folders: preset.join(", ") });
        }
      } catch (err) {
        if (seq !== probeSeqRef.current) return;
        setFolderList(null);
        setFolderError(err instanceof Error ? err.message : String(err));
      } finally {
        if (seq === probeSeqRef.current) {
          setFolderLoading(false);
          setFolderProbeKey(key);
        }
      }
      // ⚠ 不把 selectedFolders 放进依赖：预选只在首次探测时发生，避免后续勾选重跑探测
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editing, probeKeyOf, form.email, form.imapHost, form.imapPort, form.imapSecure, form.username, form.password, patch],
  );

  /** 探测结果里**可同步**的文件夹（`\Noselect` 的容器节点不能 SELECT，不进任何勾选位） */
  const syncableFolders = useMemo(() => (folderList ?? []).filter((f) => f.selectable), [folderList]);
  const sentFolder = syncableFolders.find((f) => f.specialUse === "\\Sent");
  const junkFolder = syncableFolders.find((f) => f.specialUse === "\\Junk");
  /** 收件箱 / 已发送 / 垃圾之外的文件夹——收进「其他文件夹」折叠区 */
  const otherFolders = syncableFolders.filter(
    (f) => f.path.toUpperCase() !== "INBOX" && f !== sentFolder && f !== junkFolder,
  );

  /**
   * 「其他文件夹」里每一行的说明：只对**有坑的两个**说话（草稿 / 已删除邮件），
   * 其余留空——一长串说明本身就是当初"很混乱"的来源之一。
   */
  const otherFolderNote = (use: string): string | undefined => {
    if (use === "\\Drafts") return t("folderDraftNote");
    if (use === "\\Trash") return t("folderTrashNote");
    if (use === "\\Archive") return t("folderArchiveNote");
    return undefined;
  };

  /**
   * 丢掉文件夹探测的这一切状态（清单 + 错误 + 记账 + 折叠区）。
   *
   * **属于「一次表单会话」的东西不要跨会话活着**（2026-10-10）：旧版把这些留在组件里，
   * 于是关掉弹窗、重开去编辑另一个账号时，还顶着上一个账号的清单。
   */
  const resetFolderProbe = useCallback(() => {
    setFolderList(null);
    setFolderError(null);
    setFolderProbeKey(null);
    setMoreOpen(false);
  }, []);
  /** 关闭表单（取消 / 保存成功后）：两条入口（新增 / 编辑）共用 */
  const closeForm = useCallback(() => {
    setAdding(false);
    setEditing(null);
    setForm(EMPTY_FORM);
    setSaveError(null);
    autoHostsRef.current = { imap: "", smtp: "" };
    resetFolderProbe();
  }, [resetFolderProbe]);

  const openAdd = useCallback(() => {
    setEditing(null);
    // 颜色不在这里选（2026-10-10）：后端 `nextAccountColor()` 会分配第一个未被占用的色
    setForm(EMPTY_FORM);
    setSaveError(null);
    autoHostsRef.current = { imap: "", smtp: "" };
    setAdding(true);
  }, []);

  const openEdit = useCallback(
    (a: MailAccount) => {
      setEditing(a);
      setForm(accountToForm(a));
      setSaveError(null);
      // 编辑已有账号：预填的是账号自己的主机名，**不归自动填管**——改邮箱域名时不会把它冲掉
      autoHostsRef.current = { imap: "", smtp: "" };
      setAdding(true);
      // 打开就顺手读一次服务器文件夹（编辑模式有 id、不必等用户点按钮）：
      // 在**事件处理器**里发，而不是挂 useEffect —— 后者在 StrictMode 下会被调用两次，
      // 变成两次 IMAP 登录（2026-10-07 的 `POST /folders` 双发就是这个坑）。
      void probeFolders(a);
    },
    [probeFolders],
  );

  const toggleFolder = useCallback(
    (path: string) => {
      const next = selectedFolders.includes(path)
        ? selectedFolders.filter((f) => f !== path)
        : [...selectedFolders, path];
      patch({ folders: next.join(", ") });
    },
    [selectedFolders, patch],
  );

  const submit = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const payload = {
        displayName: form.displayName,
        senderName: form.senderName,
        email: form.email,
        // ⚠ **不下发 color**（2026-10-10）：账号色完全由后端 `nextAccountColor()` 决定
        //   （新建 = 第一个未被占用的色，编辑 = 保留原值），前端连色板都不再展示。
        username: form.username || undefined,
        imapHost: form.imapHost,
        imapPort: Number(form.imapPort),
        imapSecure: form.imapSecure,
        smtpHost: form.smtpHost,
        smtpPort: Number(form.smtpPort),
        smtpSecure: form.smtpSecure,
        // 收件箱在界面上是**锁定常开**的开关（RFC 3501 规定它必然存在、名字就是 INBOX），
        // 所以这里补齐：历史白名单里若碰巧没有它，「收件」页会是空的，而用户没有任何理由
        // 遇到那个状态（2026-10-10）
        folders: pickFolders(form.folders),
      };
      const res = editing
        ? await fetch(`/api/mail/accounts/${encodeURIComponent(editing.id)}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            // 编辑：密码留空 = 保持原密码（不下发空串，否则会校验失败）
            body: JSON.stringify({ ...payload, password: form.password || undefined }),
          })
        : await fetch("/api/mail/accounts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...payload, password: form.password }),
          });
      if (!res.ok) {
        throw new Error((await res.json().catch(() => null))?.error ?? `${res.status}`);
      }
      toast.add({ title: editing ? t("saved") : t("added"), type: "success" });
      closeForm();
      await load();
      window.dispatchEvent(new Event(MAIL_ACCOUNTS_CHANGED_EVENT));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [form, editing, load, closeForm, t]);

  const doDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/mail/accounts/${encodeURIComponent(pendingDelete.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        throw new Error((await res.json().catch(() => null))?.error ?? `${res.status}`);
      }
      toast.add({ title: t("deleted"), type: "success" });
      setPendingDelete(null);
      await load();
      window.dispatchEvent(new Event(MAIL_ACCOUNTS_CHANGED_EVENT));
    } catch (err) {
      toast.add({
        title: t("failed"),
        description: err instanceof Error ? err.message : undefined,
        type: "error",
      });
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, load, t]);

  return (
    <>
      {/* ⚠ **勿改回 `<Button variant="outline">`**（2026-10 用户反馈「账号入口和旁边
          两个不统一」）：`Button` 组件内部走 `cn()`（tailwind-merge）会归并冲突类名，
          于是 outline 的 `border-border` 胜出、sm 的圆角/图标档生效（有边框 / 8px /
          14px 图标）；而旁边「通讯录」「agent 入口」是 `<Link>` + **裸**
          `buttonVariants()`（未经 cn），实际生效的是基础类那一组
          `border-transparent` / `rounded-lg` / `size-4`（无边框 / 10px / 16px）。
          两者并排时「账号」有边框、邻居没有，观感突兀。
          统一方式 = 用与两个邻居**完全相同**的写法（原生元素 + 裸 buttonVariants +
          `data-slot="button"`）。改任一处渲染方式前先确认三者类名一致。 */}
      <button
        type="button"
        data-slot="button"
        className={buttonVariants({ variant: "outline", size: "sm" })}
        onClick={() => setOpen(true)}
      >
        <UserCogIcon data-icon="default" aria-hidden />
        {t("entry")}
      </button>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          // 弹窗关掉 = 这次表单会话结束：文件夹探测的展开态/清单/错误一并清掉。
          // ⚠ 表单内容本身**保留**（用户只是点开了别处再回来，半截输入不该被吃掉），
          //   但「选择文件夹」面板属于一次性的探测动作，留着它只会在下次弹开时顶着
          //   上一个账号的清单（2026-10-10 用户报的清单串号就是这个 state 泄漏的一半）。
          if (!o) resetFolderProbe();
        }}
      >
        {/* ⚠ 弹窗自己管高度与滚动（2026-10-10 打磨）：共享的 `DialogContent` 只有
            `fixed top-1/2 -translate-y-1/2`、**既没有 max-height 也没有滚动**。上一版把
            `max-h-[85vh] overflow-y-auto` 挂在 DialogContent 上，等于「整个窗口一起滚」：
            标签栏与关闭按钮被推走、底部「保存」要滚到最后才够得着、内容在圆角处被生生切断
            （用户反馈「编辑账号时窗口拉长，窗口样式没写好」）。
            现在是「固定窗口 + 只滚中段」三段式，与桌面应用的设置窗口一致：
              · 标题栏 shrink-0，且随模式换文案（正文里不再重复一遍「编辑账号：x@y」）
              · 中段 min-h-0 flex-1 + 自己滚（细滚动条，不会压在圆角与关闭按钮上）
              · 操作栏 shrink-0，表单打开时才出现，「取消 / 保存」永远可见 */}
        <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
          <DialogHeader className="shrink-0 gap-1 border-b border-border px-5 py-4 pr-12">
            <DialogTitle>
              {adding
                ? editing
                  ? t("editTitle", { email: editing.email })
                  : t("addTitle")
                : t("title")}
            </DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>

          {/* ⚠ 中段是**普通 div**，不是共享的 `<ScrollArea>`（2026-10-10 实测）：ScrollArea 的
              viewport 靠 `height:100%` 撑满 Root，而 Root 的高度来自 `flex-1`、弹窗本身又是
              「`max-h` + 内容自适应」——**百分比高度在这条链路上解析成 auto**：viewport 会随内容
              长到 913px、再被弹窗的 `overflow-hidden` 整块裁掉，症状是「只看得到一屏，而且怎么
              滚都滚不动」（比改之前更难用）。普通 `overflow-y-auto` 的元素**自己就是滚动容器**，
              不依赖父级高度是否确定。
              ⚠ 滚动条只写标准属性 `scrollbar-width/color`：一旦设置 `scrollbar-width`，
              Chromium 会**停用** `::-webkit-scrollbar` 那套伪元素（写了也不生效）；而默认的
              15px 经典滚动条会占掉 10px 内容宽、压在弹窗圆角上（旧版截图里那条就是它）。
              实测 `thin` 在本机 Chromium 下是叠层滚动条：不占布局宽度、悬停才现形。 */}
          <div
            data-slot="accounts-dialog-body"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin]"
          >
            <div className="flex flex-col gap-5">
              {loadError && (
                <p className="flex items-center gap-2 text-sm text-destructive">
                  <CircleAlertIcon className="size-4" aria-hidden />
                  {mailErrorText(loadError, tMail)}
                </p>
              )}

              {/* 已添加账号列表 */}
              <ul
                data-slot="account-list"
                className="flex flex-col divide-y divide-border rounded-lg border border-border"
              >
                {/* 加载态：账号还没回来时别留一个空边框盒子 */}
                {accounts === null && !loadError && (
                  <li className="flex items-center gap-2 px-3 py-5 text-sm text-muted-foreground">
                    <Spinner /> {t("loading")}
                  </li>
                )}
                {accounts?.map((a) => {
                  // ⚠ 必须走 accountDotProps，**不能**直接把 a.color 当 CSS 颜色内联（2026-10-09 用户报
                  //   「账号管理页显示的账号颜色和底栏指示器的有色差」）：色板色存的是**名字**
                  //   （cyan/pink/violet/orange/teal），而它们恰好都是 **CSS 具名颜色**，`background-color: pink`
                  //   解析出来是 `#FFC0CB`（淡粉），不是 Tailwind `pink-600` 的 `#DB2777`——不会报错、只是
                  //   静默地画出另一个色，且没有 `dark:` 档。名字 → 类的映射只在 accountDotProps 里。
                  const d = accountDotProps(a.color);
                  return (
                    <li key={a.id} className="flex items-center gap-3 px-3 py-2.5">
                      <span
                        className={cn("inline-block size-2.5 shrink-0 rounded-full", d.className)}
                        style={d.style}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {a.displayName}
                          {!a.enabled && (
                            <span className="ml-2 text-xs text-muted-foreground">{t("disabled")}</span>
                          )}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">{a.email}</p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("editAccount", { email: a.email })}
                        title={t("editAccount", { email: a.email })}
                        onClick={() => openEdit(a)}
                      >
                        <PencilIcon data-icon="default" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("deleteAccount", { email: a.email })}
                        disabled={(accounts?.length ?? 0) <= 1}
                        title={
                          (accounts?.length ?? 0) <= 1
                            ? t("keepOne")
                            : t("deleteAccount", { email: a.email })
                        }
                        onClick={() => setPendingDelete(a)}
                      >
                        <Trash2Icon data-icon="default" />
                      </Button>
                    </li>
                  );
                })}
              </ul>

              {/* 添加 / 编辑账号：两张入口共用一张表单。
                  ⚠ **没有账号颜色选择器**（2026-10-10 用户要求）：色值完全由后端
                  `nextAccountColor()` 分配（新建取第一个未被占用的色、编辑保留原值），
                  前端连色板都不再展示——只有 5 个色名，摆出来既显得选择少，又逼着写一段
                  「系统会自动挑、你也可以手动改」的解释（上一版那句「不用你管」就是这个来源）。
                  颜色本身在列表行的色点、底栏账号一览里都能看到，不需要在这里解释。 */}
              {!adding ? (
                <Button variant="outline" size="sm" className="self-start" onClick={openAdd}>
                  <PlusIcon data-icon="default" />
                  {t("add")}
                </Button>
              ) : (
                <div className="flex flex-col gap-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor="acct-name">{t("fieldDisplayName")}</FieldLabel>
                      <Input
                        id="acct-name"
                        value={form.displayName}
                        onChange={(e) => patch({ displayName: e.target.value })}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="acct-sender-name">{t("fieldSenderName")}</FieldLabel>
                      <Input
                        id="acct-sender-name"
                        value={form.senderName}
                        placeholder={t("senderNamePlaceholder")}
                        onChange={(e) => patch({ senderName: e.target.value })}
                      />
                    </Field>
                    <p className="text-xs text-muted-foreground sm:col-span-2">{t("nameFieldsHint")}</p>
                    <Field>
                      <FieldLabel htmlFor="acct-email">{t("fieldEmail")}</FieldLabel>
                      <Input
                        id="acct-email"
                        type="email"
                        value={form.email}
                        onChange={(e) => patchEmail(e.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="acct-username">{t("fieldUsername")}</FieldLabel>
                      <Input
                        id="acct-username"
                        value={form.username}
                        placeholder={t("usernameHint")}
                        onChange={(e) => patch({ username: e.target.value })}
                      />
                    </Field>
                    <Field className="sm:col-span-2">
                      <FieldLabel htmlFor="acct-password">{t("fieldPassword")}</FieldLabel>
                      <Input
                        id="acct-password"
                        type="password"
                        value={form.password}
                        placeholder={editing ? t("passwordKeepHint") : undefined}
                        onChange={(e) => patch({ password: e.target.value })}
                      />
                    </Field>
                  </div>

                  <section className="flex flex-col gap-3 border-t border-border pt-4">
                    <p className="text-xs font-medium text-muted-foreground">{t("imapSection")}</p>
                    <div className="grid gap-3 sm:grid-cols-[1fr_7rem_auto]">
                      <Field>
                        <FieldLabel htmlFor="acct-imap-host">{t("fieldHost")}</FieldLabel>
                        <Input
                          id="acct-imap-host"
                          value={form.imapHost}
                          placeholder="imap.example.com"
                          onChange={(e) => patch({ imapHost: e.target.value })}
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="acct-imap-port">{t("fieldPort")}</FieldLabel>
                        <Input
                          id="acct-imap-port"
                          inputMode="numeric"
                          value={form.imapPort}
                          onChange={(e) => patch({ imapPort: e.target.value })}
                        />
                      </Field>
                      <Field className="justify-end">
                        <label className="flex h-8 items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="accent-primary"
                            checked={form.imapSecure}
                            onChange={(e) => patch({ imapSecure: e.target.checked })}
                          />
                          {t("fieldSecure")}
                        </label>
                      </Field>
                    </div>
                  </section>

                  <section className="flex flex-col gap-3 border-t border-border pt-4">
                    <p className="text-xs font-medium text-muted-foreground">{t("smtpSection")}</p>
                    <div className="grid gap-3 sm:grid-cols-[1fr_7rem_auto]">
                      <Field>
                        <FieldLabel htmlFor="acct-smtp-host">{t("fieldHost")}</FieldLabel>
                        <Input
                          id="acct-smtp-host"
                          value={form.smtpHost}
                          placeholder="smtp.example.com"
                          onChange={(e) => patch({ smtpHost: e.target.value })}
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="acct-smtp-port">{t("fieldPort")}</FieldLabel>
                        <Input
                          id="acct-smtp-port"
                          inputMode="numeric"
                          value={form.smtpPort}
                          onChange={(e) => patch({ smtpPort: e.target.value })}
                        />
                      </Field>
                      <Field className="justify-end">
                        <label className="flex h-8 items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="accent-primary"
                            checked={form.smtpSecure}
                            onChange={(e) => patch({ smtpSecure: e.target.checked })}
                          />
                          {t("fieldSecure")}
                        </label>
                      </Field>
                    </div>
                  </section>

                  {/* 同步范围（2026-10-10 按用户反馈重做）：按**用户视角**问「站内显示哪些邮件」，
                      而不是甩一串服务器文件夹路径。收件箱锁定常开；已发送 / 垃圾邮件 各一个开关，
                      说明里直接写清它决定哪个页面有没有内容；其余文件夹收进折叠区（默认收起）。
                      原来的「用推荐的一组 / 清空」两个按钮已删除——开关本身就是推荐，
                      而「清空」还会让白名单为空、保存时被后端拒绝。 */}
                  <section className="flex flex-col gap-3 border-t border-border pt-4">
                    <Field>
                      <FieldLabel>{t("fieldFolders")}</FieldLabel>
                      <div
                        data-slot="folder-sync"
                        className="flex flex-col gap-1 rounded-lg bg-muted/40 p-3"
                      >
                        {folderLoading ? (
                          <p className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Spinner /> {t("foldersProbing")}
                          </p>
                        ) : folderProbeFresh && folderList !== null ? (
                          <>
                            <SyncFolderRow
                              label={t("folderInbox")}
                              note={t("folderInboxNote")}
                              checked
                              locked
                            />
                            {sentFolder ? (
                              <SyncFolderRow
                                label={t("folderSent")}
                                note={t("folderSentNote")}
                                warn={
                                  selectedFolders.includes(sentFolder.path)
                                    ? undefined
                                    : t("folderSentOff")
                                }
                                checked={selectedFolders.includes(sentFolder.path)}
                                onChange={() => toggleFolder(sentFolder.path)}
                              />
                            ) : (
                              <p className="px-1 text-xs text-muted-foreground">
                                {t("folderMissing", { name: t("folderSent") })}
                              </p>
                            )}
                            {junkFolder ? (
                              <SyncFolderRow
                                label={t("folderJunk")}
                                note={t("folderJunkNote")}
                                checked={selectedFolders.includes(junkFolder.path)}
                                onChange={() => toggleFolder(junkFolder.path)}
                              />
                            ) : null}
                            {otherFolders.length > 0 && (
                              <div className="mt-1 border-t border-border pt-2">
                                <button
                                  type="button"
                                  data-slot="folder-more-toggle"
                                  aria-expanded={moreOpen}
                                  onClick={() => setMoreOpen((o) => !o)}
                                  className="flex items-center gap-1 rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                                >
                                  {moreOpen ? (
                                    <ChevronDownIcon className="size-3.5" aria-hidden />
                                  ) : (
                                    <ChevronRightIcon className="size-3.5" aria-hidden />
                                  )}
                                  {t("foldersMore", { count: otherFolders.length })}
                                </button>
                                {moreOpen && (
                                  <>
                                    <p className="px-1 pt-1 text-xs text-muted-foreground">
                                      {t("foldersMoreNote")}
                                    </p>
                                    <ul className="mt-1 flex flex-col gap-0.5">
                                      {otherFolders.map((f) => (
                                        <li key={f.path}>
                                          <SyncFolderRow
                                            label={f.path}
                                            note={otherFolderNote(f.specialUse)}
                                            checked={selectedFolders.includes(f.path)}
                                            onChange={() => toggleFolder(f.path)}
                                          />
                                        </li>
                                      ))}
                                    </ul>
                                  </>
                                )}
                              </div>
                            )}
                          </>
                        ) : (
                          // 还没读（或读失败）：先把**当前**同步范围摆出来——读取是一个显式动作，
                          // 新增模式下要先填密码（探测 = 用表单里的连接参数真登录一次）
                          <>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-xs text-muted-foreground">{t("foldersCurrent")}</span>
                              {selectedFolders.length === 0 ? (
                                <span className="text-sm text-muted-foreground">{t("foldersAuto")}</span>
                              ) : (
                                selectedFolders.map((f) => (
                                  <span
                                    key={f}
                                    data-slot="folder-chip"
                                    className="rounded-full border border-border bg-background px-2 py-0.5 text-xs"
                                  >
                                    {f}
                                  </span>
                                ))
                              )}
                            </div>
                            {folderProbeFresh && folderError && (
                              <p className="text-sm text-destructive">{folderError}</p>
                            )}
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="self-start"
                              data-slot="folders-read"
                              disabled={!canProbe}
                              title={canProbe ? undefined : t("foldersNeedPassword")}
                              onClick={() => void probeFolders()}
                            >
                              <FolderOpenIcon data-icon="default" />
                              {folderError ? t("foldersRetry") : t("foldersRead")}
                            </Button>
                          </>
                        )}
                      </div>
                      <FieldDescription>{t("foldersHint")}</FieldDescription>
                    </Field>
                  </section>
                </div>
              )}

              {/* 远程图片白名单（4.4）：这些域名的图片直接显示不再拦截，子域名一并放行 */}
              <section
                data-slot="remote-image-whitelist"
                className="flex flex-col gap-2 border-t border-border pt-4"
              >
                <div>
                  <p className="text-sm font-medium">{t("whitelistTitle")}</p>
                  <p className="text-xs text-muted-foreground">{t("whitelistDesc")}</p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {domains?.map((d) => (
                    <span
                      key={d}
                      className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
                    >
                      {d}
                      <button
                        type="button"
                        aria-label={t("whitelistRemove", { domain: d })}
                        disabled={domainSaving}
                        onClick={() => void removeDomain(d)}
                      >
                        <XIcon className="size-3" aria-hidden />
                      </button>
                    </span>
                  ))}
                  {domains?.length === 0 && (
                    <p className="text-xs text-muted-foreground">{t("whitelistEmpty")}</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Input
                    value={domainDraft}
                    placeholder={t("whitelistPlaceholder")}
                    aria-label={t("whitelistPlaceholder")}
                    inputMode="url"
                    onChange={(e) => setDomainDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void addDomain();
                      }
                    }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    disabled={domainSaving || !domainDraft.trim()}
                    onClick={() => void addDomain()}
                  >
                    {t("whitelistAdd")}
                  </Button>
                </div>
              </section>
            </div>
          </div>

          {/* 表单操作栏：固定在窗口底部，保存失败时错误也在这里（滚到底才看得见 = 等于看不见） */}
          {adding && (
            <div className="flex shrink-0 flex-col gap-2 border-t border-border bg-muted/40 px-5 py-3">
              {saveError && (
                <p className="flex items-center gap-2 text-sm text-destructive">
                  <CircleAlertIcon className="size-4" aria-hidden />
                  {saveError}
                </p>
              )}
              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" size="sm" disabled={saving} onClick={closeForm}>
                  {t("cancel")}
                </Button>
                <Button size="sm" disabled={saving} onClick={submit}>
                  {saving ? <Spinner /> : editing ? <PencilIcon data-icon="default" /> : <PlusIcon data-icon="default" />}
                  {saving ? (editing ? t("saving") : t("submitting")) : editing ? t("save") : t("submit")}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => {
          if (!o) setPendingDelete(null);
        }}
        title={t("deleteTitle")}
        // 删除期间（pending）换成「正在删除本地 N 封副本与全文索引…」——这一步是同步 SQL，
        // 数量级大时要让用户知道在等什么（2026-10-08：6516 封的账号曾卡 41 秒且无任何说明）
        description={
          deleting
            ? t("deletePending", { count: pendingDelete?.localMessages ?? 0 })
            : t("deleteBody", {
                email: pendingDelete?.email ?? "",
                count: pendingDelete?.localMessages ?? 0,
              })
        }
        pending={deleting}
        onConfirm={doDelete}
      />
    </>
  );
}
