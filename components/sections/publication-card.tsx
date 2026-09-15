"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { BookOpenIcon, CopyIcon, ExternalLinkIcon, FileCode2Icon, FolderGit2Icon, PinIcon, PinOffIcon, ScrollTextIcon } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "@/components/ui/toast";
import { generateBibtex } from "@/lib/bibtex";
import { createAuthorMatcher, stripMeMarker } from "@/lib/publications/authors";
import { cn } from "@/lib/utils";
import type { Publication } from "@/lib/data";

export function PublicationCard({
  pub,
  myNames,
  pinned = false,
  onTogglePin,
  defaultOpen,
}: {
  pub: Publication;
  /** 我自己的姓名写法（可多个别名）—— 必须是可序列化值，卡片自行构造匹配器 */
  myNames: readonly string[];
  /** 是否已置顶（置顶标记对所有人可见；开关只给站主） */
  pinned?: boolean;
  /** 传入则渲染置顶开关（仅站主登录态传入） */
  onTogglePin?: () => void;
  defaultOpen?: boolean;
}) {
  const t = useTranslations("publications");
  const [open, setOpen] = useState(defaultOpen ?? false);
  const isMe = useMemo(() => createAuthorMatcher(myNames), [myNames]);

  const bibtex = generateBibtex(pub);

  // 无 url / doi 时不要把标题渲染成「没有 href 的 <a>」：不可聚焦、语义也不对
  const titleHref = pub.url ?? (pub.doi ? `https://doi.org/${pub.doi}` : undefined);

  async function copyBibtex() {
    // 优先使用 Clipboard API，失败时回退到 execCommand
    try {
      await navigator.clipboard.writeText(bibtex);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = bibtex;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    toast.add({ title: t("copied"), type: "success" });
  }

  const links: { href: string; label: string; icon: React.ReactNode }[] = [];
  if (pub.pdf) links.push({ href: pub.pdf, label: "PDF", icon: <FileCode2Icon data-icon="default" /> });
  if (pub.doi) links.push({ href: `https://doi.org/${pub.doi}`, label: "DOI", icon: <ExternalLinkIcon data-icon="default" /> });
  if (pub.arxiv) links.push({ href: `https://arxiv.org/abs/${pub.arxiv}`, label: "arXiv", icon: <BookOpenIcon data-icon="default" /> });
  if (pub.code) links.push({ href: pub.code, label: "Code", icon: <FolderGit2Icon data-icon="default" /> });

  return (
    <Card className="group">
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="min-w-0 flex-1 text-base font-medium leading-snug">
            {titleHref ? (
              <a href={titleHref} className="hover:underline">
                {pub.title}
              </a>
            ) : (
              pub.title
            )}
          </h3>
          {pinned && (
            <Badge variant="secondary" data-slot="publication-pinned">
              <PinIcon data-icon="default" />
              {t("pinned")}
            </Badge>
          )}
          <Badge variant={pub.type === "preprint" ? "secondary" : "outline"}>
            {t(`types.${pub.type}`)}
          </Badge>
        </div>

        <p className="text-sm text-muted-foreground">
          {pub.authors.map((author, i) => (
            <span key={i}>
              {i > 0 && ", "}
              {/* ⚠ 显示时必须剥掉「本人」标记，否则页面上会出现 `YU Shaoyuan*` */}
              <span className={isMe(author) ? "font-medium text-foreground" : undefined}>
                {stripMeMarker(author)}
              </span>
            </span>
          ))}
        </p>

        <p className="text-sm text-muted-foreground">{pub.venue}</p>

        <div className="mt-1 flex flex-wrap items-center gap-1">
          {links.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              data-slot="button"
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              {link.icon}
              {link.label}
            </a>
          ))}
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger
              render={
                <Button variant="outline" size="sm">
                  <ScrollTextIcon data-icon="inline-start" />
                  {t("copyBibtex")}
                </Button>
              }
            />
            <DialogContent className="sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>{pub.title}</DialogTitle>
                <DialogDescription>{pub.venue}, {pub.year}</DialogDescription>
              </DialogHeader>
              <ScrollArea className={cn("h-64 rounded-lg border bg-muted/50 p-4")}>
                <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed">{bibtex}</pre>
              </ScrollArea>
              <div className="flex justify-end">
                <Button size="sm" onClick={copyBibtex}>
                  <CopyIcon data-icon="inline-start" />
                  {t("copyBibtex")}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          {/* 置顶开关：仅站主登录态（游客传 undefined，不渲染也不占位） */}
          {onTogglePin && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onTogglePin}
              aria-pressed={pinned}
              data-slot="publication-pin-toggle"
            >
              {pinned ? (
                <PinOffIcon data-icon="inline-start" />
              ) : (
                <PinIcon data-icon="inline-start" />
              )}
              {t(pinned ? "unpin" : "pin")}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
