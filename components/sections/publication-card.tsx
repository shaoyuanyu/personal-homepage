"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { BookOpenIcon, CopyIcon, ExternalLinkIcon, FileCode2Icon, FolderGit2Icon, ScrollTextIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "@/components/ui/toast";
import { generateBibtex } from "@/lib/bibtex";
import { cn } from "@/lib/utils";
import type { Publication } from "@/lib/data";

export function PublicationCard({
  pub,
  isMe,
  defaultOpen,
}: {
  pub: Publication;
  isMe: (author: string) => boolean;
  defaultOpen?: boolean;
}) {
  const t = useTranslations("publications");
  const [open, setOpen] = useState(defaultOpen ?? false);

  const bibtex = generateBibtex(pub);

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
      <CardContent className="flex flex-col gap-2 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="min-w-0 flex-1 text-base font-medium leading-snug">
            <a
              href={pub.url ?? (pub.doi ? `https://doi.org/${pub.doi}` : undefined)}
              className="hover:underline"
            >
              {pub.title}
            </a>
          </h3>
          <Badge variant={pub.type === "preprint" ? "secondary" : "outline"}>
            {t(`types.${pub.type}`)}
          </Badge>
        </div>

        <p className="text-sm text-muted-foreground">
          {pub.authors.map((author, i) => (
            <span key={i}>
              {i > 0 && ", "}
              <span className={isMe(author) ? "font-medium text-foreground" : undefined}>{author}</span>
            </span>
          ))}
        </p>

        <p className="text-sm text-muted-foreground">{pub.venue}</p>

        <div className="mt-1 flex flex-wrap items-center gap-1">
          {links.map((link) => (
            <Button
              key={link.label}
              variant="ghost"
              size="sm"
              render={<a href={link.href} target="_blank" rel="noopener noreferrer" />}
            >
              {link.icon}
              {link.label}
            </Button>
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
            <DialogContent className="max-w-2xl">
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
        </div>
      </CardContent>
    </Card>
  );
}
