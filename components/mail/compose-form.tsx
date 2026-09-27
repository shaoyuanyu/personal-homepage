"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { PaperclipIcon, SendIcon, XIcon } from "lucide-react";

import { useRouter } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import type { MailAccount, MailDetail, SendAttachmentInput } from "@/lib/mail/types";

/** 附件大小上限（与 webmaild 的 40MB body 上限配套，留 base64 膨胀余量） */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** 写邮件：三家账号中选发件身份；回复时带入原主题 / In-Reply-To / References */
export function ComposeForm() {
  const t = useTranslations("mail");
  const router = useRouter();
  const searchParams = useSearchParams();
  const replyTo = searchParams.get("replyTo");

  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [fromId, setFromId] = useState("");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [attachments, setAttachments] = useState<SendAttachmentInput[]>([]);
  const [sending, setSending] = useState(false);
  const [replyRef, setReplyRef] = useState<{ inReplyTo: string; references: string[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/mail/accounts")
      .then((r) => (r.ok ? r.json() : []))
      .then((data: MailAccount[]) => {
        const enabled = data.filter((a) => a.enabled);
        setAccounts(enabled);
        if (enabled.length > 0) setFromId(enabled[0].id);
      })
      .catch(() => {});
  }, []);

  // 回复：取原邮件，预填收件人 / 主题 / 引用关系
  useEffect(() => {
    if (!replyTo) return;
    fetch(`/api/mail/message/${encodeURIComponent(replyTo)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: MailDetail | null) => {
        if (!data) return;
        setTo((prev) => prev || data.fromAddr);
        setSubject((prev) => prev || (/^re:/i.test(data.subject) ? data.subject : `Re: ${data.subject}`));
        // 规范化后的 messageId 形如 mid:<id>@<host>，取尖括号形式写回引用头
        const rawMid = data.messageId.startsWith("mid:")
          ? `<${data.messageId.slice(4)}>`
          : "";
        if (rawMid) setReplyRef({ inReplyTo: rawMid, references: [rawMid] });
        setBody((prev) => prev || `\n\n-------- ${t("quoteSeparator")} --------\n${data.text}`);
      })
      .catch(() => {});
  }, [replyTo, t]);

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
          setAttachments((prev) => [
            ...prev,
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
    [t],
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
          subject,
          text: body,
          inReplyTo: replyRef?.inReplyTo,
          references: replyRef?.references,
          attachments,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `${res.status}`);
      toast.add({ title: t("sent"), type: "success" });
      router.push("/mail");
    } catch (err) {
      toast.add({ title: t("sendFailed"), description: err instanceof Error ? err.message : String(err), type: "error" });
      setSending(false);
    }
  }, [fromId, to, cc, subject, body, replyRef, attachments, router, t]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-[1fr_1fr]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="mail-from">{t("fieldFrom")}</Label>
          <Select value={fromId} onValueChange={(v) => setFromId(v ?? "")}>
            <SelectTrigger id="mail-from" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.displayName}（{a.email}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="mail-to">{t("fieldTo")}</Label>
          <Input id="mail-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="someone@example.org" />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-[1fr_1fr]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="mail-cc">{t("fieldCc")}</Label>
          <Input id="mail-cc" value={cc} onChange={(e) => setCc(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="mail-subject">{t("fieldSubject")}</Label>
          <Input id="mail-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="mail-body">{t("fieldBody")}</Label>
        <Textarea
          id="mail-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={14}
          className="font-mono text-sm"
        />
      </div>

      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {attachments.map((a, i) => (
            <li
              key={`${a.filename}-${i}`}
              className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs"
            >
              <PaperclipIcon className="size-3" aria-hidden />
              {a.filename}
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

      <div className="flex items-center gap-2">
        <Button onClick={send} disabled={sending || !fromId}>
          {sending ? <Spinner /> : <SendIcon data-icon="default" />}
          {sending ? t("sending") : t("send")}
        </Button>
        <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={sending}>
          <PaperclipIcon data-icon="default" />
          {t("addAttachment")}
        </Button>
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => addAttachments(e.target.files)}
        />
      </div>
    </div>
  );
}
