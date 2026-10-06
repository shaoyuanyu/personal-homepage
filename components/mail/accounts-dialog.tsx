"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { CircleAlertIcon, PencilIcon, PlusIcon, Trash2Icon, UserCogIcon, XIcon } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import type { MailAccount } from "@/lib/mail/types";

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

/** 账号管理弹窗：列出已添加账号（可删除）+ 添加新账号（保存前先做 IMAP/SMTP 连接测试） */
export function AccountsDialog() {
  const t = useTranslations("mail.accounts");
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

  /** 关闭表单（取消 / 保存成功后）：两条入口（新增 / 编辑）共用 */
  const closeForm = useCallback(() => {
    setAdding(false);
    setEditing(null);
    setForm(EMPTY_FORM);
    setSaveError(null);
  }, []);

  const openAdd = useCallback(() => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setSaveError(null);
    setAdding(true);
  }, []);

  const openEdit = useCallback((a: MailAccount) => {
    setEditing(a);
    setForm(accountToForm(a));
    setSaveError(null);
    setAdding(true);
  }, []);

  const submit = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const payload = {
        displayName: form.displayName,
        senderName: form.senderName,
        email: form.email,
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
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            {loadError && (
              <p className="flex items-center gap-2 text-sm text-destructive">
                <CircleAlertIcon className="size-4" aria-hidden />
                {t("loadFailed")}：{loadError}
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
                  <Field>
                    <FieldLabel htmlFor="acct-email">{t("fieldEmail")}</FieldLabel>
                    <Input
                      id="acct-email"
                      type="email"
                      value={form.email}
                      onChange={(e) => patch({ email: e.target.value })}
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
                  <FieldLabel htmlFor="acct-folders">{t("fieldFolders")}</FieldLabel>
                  <Input
                    id="acct-folders"
                    value={form.folders}
                    placeholder={t("foldersHint")}
                    onChange={(e) => patch({ folders: e.target.value })}
                  />
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
        description={t("deleteBody", { email: pendingDelete?.email ?? "" })}
        pending={deleting}
        onConfirm={doDelete}
      />
    </>
  );
}
