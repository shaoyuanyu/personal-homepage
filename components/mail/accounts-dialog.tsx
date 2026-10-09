"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import {
  ACCOUNT_COLOR_NAMES,
  accountColorKey,
  accountDotProps,
  nextAccountColor,
} from "@/components/mail/account-dot";
import { cn } from "@/lib/utils";
import { mailErrorText } from "@/lib/mail/error-text";
import { folderSpecialKey } from "@/lib/mail/folder-special";
import type { MailAccount, MailFolder } from "@/lib/mail/types";

/** 账号增删后广播，邮件列表（MailClient）据此刷新账号筛选 chips */
export const MAIL_ACCOUNTS_CHANGED_EVENT = "mail-accounts-changed";

interface AddForm {
  /** 备注名（仅站内 UI 显示，**不外发**） */
  displayName: string;
  /** 发件人姓名（随邮件发出的 From 显示名；空 = 只发邮箱地址） */
  senderName: string;
  email: string;
  /**
   * 账号色（用于底栏账号一览 / 账号下拉 / 列表行的账号标识）。
   * 色板名字（`cyan` 等，见 account-dot.ts）或任意 CSS 色；新增时预填「下一个没被占用的色」。
   */
  color: string;
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
  color: "",
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
    color: a.color,
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

  /** 选中的颜色是否已被**别的**账号占用（只提示、不拦——同色本身不是错误） */
  const colorTaken =
    !!form.color &&
    (accounts ?? []).some(
      (a) => a.id !== editing?.id && accountColorKey(a.color) === accountColorKey(form.color),
    );
  /** 不在色板里的颜色（hex 等手写值）：渲染成一枚额外的「当前颜色」圆钮 */
  const customColor =
    form.color && !(ACCOUNT_COLOR_NAMES as readonly string[]).includes(accountColorKey(form.color))
      ? form.color
      : null;

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

  /** 关闭表单（取消 / 保存成功后）：两条入口（新增 / 编辑）共用 */
  const closeForm = useCallback(() => {
    setAdding(false);
    setEditing(null);
    setForm(EMPTY_FORM);
    setSaveError(null);
    autoHostsRef.current = { imap: "", smtp: "" };
  }, []);

  const openAdd = useCallback(() => {
    setEditing(null);
    // 预选「下一个没被占用的色」：色板顺序固定，账号多起来才不会出现两个同色色点
    setForm({ ...EMPTY_FORM, color: nextAccountColor((accounts ?? []).map((a) => a.color)) });
    setSaveError(null);
    autoHostsRef.current = { imap: "", smtp: "" };
    setAdding(true);
  }, [accounts]);

  const openEdit = useCallback((a: MailAccount) => {
    setEditing(a);
    setForm(accountToForm(a));
    setSaveError(null);
    // 编辑已有账号：预填的是账号自己的主机名，**不归自动填管**——改邮箱域名时不会把它冲掉
    autoHostsRef.current = { imap: "", smtp: "" };
    setAdding(true);
  }, []);

  // ---- 同步文件夹选择器（2026-10-07，MAIL-AGENT.md 4.15）----
  // 起因：以前这里是一个手打的输入框（「INBOX, 已发送」），用户得先知道服务器上的文件夹
  // 叫什么；猜错（写 Sent 而实际叫「已发送」）就静默少同步一个文件夹——最典型的症状是新
  // 账号「发件」页永远为空。现在改为：探测（IMAP LIST）→ 勾选。
  // ⚠ 新增模式下账号还没落盘、拿不到 id，走 `POST /folders` 用表单里现填的连接参数登录
  //   （因此需要先填密码；未填则按钮禁用并给出提示）。
  const [pickerOpen, setPickerOpen] = useState(false);
  const [folderList, setFolderList] = useState<MailFolder[] | null>(null);
  const [folderSuggested, setFolderSuggested] = useState<string[]>([]);
  const [folderLoading, setFolderLoading] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);

  const selectedFolders = useMemo(
    () => form.folders.split(",").map((f) => f.trim()).filter(Boolean),
    [form.folders],
  );
  const canProbe = !!editing || (!!form.password && !!form.imapHost);

  const probeFolders = useCallback(async () => {
    setFolderLoading(true);
    setFolderError(null);
    try {
      const res = editing
        ? await fetch(`/api/mail/folders?account=${encodeURIComponent(editing.id)}`)
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
        suggested: string[];
        synced?: string[];
      };
      setFolderList(data.folders);
      setFolderSuggested(data.suggested);
      // 编辑模式：预选服务器上当前的白名单（用户在此基础上增减）
      if (editing && data.synced && selectedFolders.length === 0) {
        patch({ folders: data.synced.join(", ") });
      }
    } catch (err) {
      setFolderList(null);
      setFolderError(err instanceof Error ? err.message : String(err));
    } finally {
      setFolderLoading(false);
    }
    // ⚠ 不把 selectedFolders 放进依赖：预选只在首次探测时发生，避免后续勾选重跑探测
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, form.email, form.imapHost, form.imapPort, form.imapSecure, form.username, form.password, patch]);

  // ⚠ 副作用**不能写进 setState 的 updater 里**（2026-10-07 实测）：React 在
  //   StrictMode（next dev 默认开）下会把 updater 调用两次探测纯度，于是点一次
  //   「选择文件夹」会发**两次** `POST /folders`（E2E 断言 calls.folders.length === 1
  //   时暴露）。改成先算 next 再 setState，判断走正常的 render 期值。
  const openPicker = useCallback(() => {
    const next = !pickerOpen;
    setPickerOpen(next);
    if (next && folderList === null && !folderLoading) void probeFolders();
  }, [pickerOpen, folderList, folderLoading, probeFolders]);

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
        // 颜色随账号保存（后端缺省时会自己避让已占用的色，这里显式带上用户在色板上的选择）
        color: form.color || undefined,
        username: form.username || undefined,
        imapHost: form.imapHost,
        imapPort: Number(form.imapPort),
        imapSecure: form.imapSecure,
        smtpHost: form.smtpHost,
        smtpPort: Number(form.smtpPort),
        smtpSecure: form.smtpSecure,
        folders: form.folders.trim()
          ? form.folders.split(",").map((f) => f.trim()).filter(Boolean)
          : undefined,
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

      <Dialog open={open} onOpenChange={setOpen}>
        {/* ⚠ `max-h` + `overflow-y-auto` 是必需的（2026-10-09 由 E2E 暴露）：共享的
            `DialogContent` 只有 `fixed top-1/2 -translate-y-1/2`、**没有 max-height 也没有
            滚动**——表单展开后弹窗实测高 1198px，在 720 高的视口里上下各被裁掉（top = −239），
            标题、关闭按钮与底部「保存」全在视口外且**滚不到**。同款写法见 `calendar-view`
            与 `agent-view` 的弹窗（`max-h-[85vh] overflow-y-auto`）。 */}
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
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
              {accounts?.map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-3 py-2.5">
                  <span
                    className="inline-block size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: a.color }}
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
              ))}
            </ul>

            {/* 添加 / 编辑账号：共用一张展开式表单 */}
            {!adding ? (
              <Button variant="outline" size="sm" className="self-start" onClick={openAdd}>
                <PlusIcon data-icon="default" />
                {t("add")}
              </Button>
            ) : (
              <FieldGroup className="rounded-lg border border-border p-3">
                <p className="text-sm font-medium">
                  {editing ? t("editTitle", { email: editing.email }) : t("addTitle")}
                </p>
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
                  {/* 账号颜色：底栏账号一览 / 账号下拉 / 列表行的账号标识都用它。
                      ⚠ 必须让用户能改：两个账号同色时色点就没有信息了（2026-10-09 用户报
                      「账号指示器中多个账号之间的颜色没有区别」——此前这个弹窗根本不提交
                      color，后端给每个新账号填同一个默认色，属于必然撞色）。 */}
                  <Field className="sm:col-span-2">
                    <FieldLabel>{t("fieldColor")}</FieldLabel>
                    <div
                      data-slot="account-color-picker"
                      role="group"
                      aria-label={t("fieldColor")}
                      className="flex flex-wrap items-center gap-1.5"
                    >
                      {ACCOUNT_COLOR_NAMES.map((name) => (
                        <ColorSwatch
                          key={name}
                          color={name}
                          label={t(`colorNames.${name}`)}
                          // 比较走 accountColorKey：历史缺省色 #0ea5e9 要落在「青色」这一格上
                          selected={accountColorKey(form.color) === name}
                          onSelect={() => patch({ color: name })}
                        />
                      ))}
                      {/* 手改过配置/历史遗留的 hex 色不在色板里：给它一枚「当前颜色」圆钮，
                          否则面板上没有一项处于选中态，看起来像「这个账号没有颜色」 */}
                      {customColor && (
                        <ColorSwatch
                          color={customColor}
                          label={t("colorCustom")}
                          selected
                          onSelect={() => patch({ color: customColor })}
                        />
                      )}
                    </div>
                    <FieldDescription>{t("colorHint")}</FieldDescription>
                    {colorTaken && (
                      <p data-slot="account-color-taken" className="text-xs text-amber-600 dark:text-amber-400">
                        {t("colorTaken")}
                      </p>
                    )}
                  </Field>
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

                <Field>
                  <FieldLabel>{t("fieldFolders")}</FieldLabel>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {selectedFolders.length === 0 ? (
                      <span className="text-sm text-muted-foreground">{t("foldersAuto")}</span>
                    ) : (
                      selectedFolders.map((f) => (
                        <span
                          key={f}
                          data-slot="folder-chip"
                          className="rounded-full border border-border px-2 py-0.5 text-xs"
                        >
                          {f}
                        </span>
                      ))
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!canProbe}
                      title={canProbe ? undefined : t("foldersNeedPassword")}
                      onClick={openPicker}
                    >
                      <FolderOpenIcon data-icon="default" />
                      {pickerOpen ? t("foldersClose") : t("foldersPick")}
                    </Button>
                  </div>
                  {pickerOpen && (
                    <div
                      data-slot="folder-picker"
                      className="mt-2 flex flex-col gap-2 rounded-xl border border-border p-3"
                    >
                      {folderLoading ? (
                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Spinner /> {t("foldersProbing")}
                        </p>
                      ) : folderError ? (
                        <div className="flex flex-col items-start gap-2">
                          <p className="text-sm text-destructive">{folderError}</p>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void probeFolders()}
                          >
                            {t("foldersRetry")}
                          </Button>
                        </div>
                      ) : folderList === null ? null : (
                        <>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => patch({ folders: folderSuggested.join(", ") })}
                            >
                              {t("foldersUseSuggested")}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => patch({ folders: "" })}
                            >
                              {t("foldersClear")}
                            </Button>
                          </div>
                          <ul className="flex flex-col gap-1">
                            {folderList.map((f) => (
                              <li key={`${f.path}`}>
                                <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-sm hover:bg-accent/40">
                                  <input
                                    type="checkbox"
                                    className="size-4 accent-primary"
                                    checked={selectedFolders.includes(f.path)}
                                    onChange={() => toggleFolder(f.path)}
                                  />
                                  <span className="min-w-0 flex-1 truncate">{f.path}</span>
                                  {folderSpecialKey(f.specialUse) && (
                                    <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
                                      {tMail(`folderSpecial.${folderSpecialKey(f.specialUse)}`)}
                                    </span>
                                  )}
                                </label>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  )}
                  <FieldDescription>{t("foldersHint")}</FieldDescription>
                </Field>

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
              </FieldGroup>
            )}

            {/* 远程图片白名单（4.4）：这些域名的图片直接显示不再拦截，子域名一并放行 */}
            <div data-slot="remote-image-whitelist" className="flex flex-col gap-2 rounded-lg border border-border p-3">
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
            </div>
          </div>
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

/**
 * 色板圆钮（账号颜色）。
 *
 * ⚠ 选中态**不能只靠颜色本身**表达——五个圆钮本来就是五种颜色，选中与否都是个色点。
 *   这里用「外描边 + 未选中略淡」两种非颜色线索：`aria-pressed` + `data-color` 供 E2E 断言，
 *   颜色类名（`bg-cyan-600` 这类）不进断言（CLAUDE.md：锁契约不锁像素）。
 */
function ColorSwatch({
  color,
  label,
  selected,
  onSelect,
}: {
  color: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const d = accountDotProps(color);
  return (
    <button
      type="button"
      data-slot="account-color-swatch"
      data-color={color}
      aria-pressed={selected}
      aria-label={label}
      title={label}
      onClick={onSelect}
      className={cn(
        "size-6 shrink-0 rounded-full transition-[opacity,outline-color] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        d.className,
        selected
          ? "outline-2 outline-offset-2 outline-foreground"
          : "opacity-60 hover:opacity-100",
      )}
      style={d.style}
    />
  );
}
