import type { Metadata } from "next";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { CcfDirectory } from "@/components/ccf/ccf-directory";

export const metadata: Metadata = {
  title: "CCF Recommended List (2026)",
  description:
    "China Computer Federation recommended international conferences and journals, 7th edition (2026)",
};

export default function CcfPage() {
  const t = useTranslations("ccf");

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <div className="mb-8 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
          <Badge variant="secondary" className="rounded-full">
            {t("versionBadge")}
          </Badge>
        </div>
        <p className="text-muted-foreground">{t("description")}</p>
        <p className="text-xs text-muted-foreground/80">
          {t("source")}{" "}
          <a
            href="https://ccf.atom.im/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-foreground"
          >
            ccf.atom.im
          </a>
          {" · "}
          <a
            href="https://www.ccf.org.cn/Academic_Evaluation/By_category/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-foreground"
          >
            CCF
          </a>
        </p>
      </div>
      <CcfDirectory />
      <p className="mt-14 border-t pt-4 text-xs text-muted-foreground/70">
        {t("sourceNote")}
      </p>
    </div>
  );
}
