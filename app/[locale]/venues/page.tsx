import Link from "next/link";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { VenueExplorer } from "@/components/venues/venue-explorer";
import { venueStats } from "@/lib/data/venue";
import { pageMetadata } from "@/lib/i18n/metadata";

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props) {
  return pageMetadata(params, "venues");
}

export default function VenuesPage() {
  const t = useTranslations("venues");

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col px-4 py-12 sm:px-6">
      <div className="mb-8 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-bold">{t("title")}</h1>
          <Badge variant="secondary">{t("versionBadge")}</Badge>
        </div>
        <p className="text-muted-foreground">{t("description")}</p>
        <p className="text-xs text-muted-foreground">
          {t("source")}{" "}
          <a
            href="https://www.ccf.org.cn/Academic_Evaluation/By_category/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-foreground"
          >
            CCF
          </a>
          {" · "}
          <a
            href="https://fenqubiao.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-foreground"
          >
            中科院分区表
          </a>
          {" · "}
          <a
            href="https://github.com/ccfddl/ccf-deadlines"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-foreground"
          >
            ccfddl
          </a>
          {" · "}
          <span>
            {t("statsMeta", {
              confs: venueStats.conferences,
              jours: venueStats.journals,
              dual: venueStats.dualRankedJournals,
            })}
          </span>
        </p>
      </div>
      <VenueExplorer />
      <p className="mt-14 border-t pt-4 text-xs text-muted-foreground">
        {t.rich("sourceNote", {
          ccf: (chunks) => (
            <Link href="/ccf" className="underline underline-offset-4 hover:text-foreground">
              {chunks}
            </Link>
          ),
          cas: (chunks) => (
            <Link href="/cas" className="underline underline-offset-4 hover:text-foreground">
              {chunks}
            </Link>
          ),
          deadlines: (chunks) => (
            <Link
              href="/deadlines"
              className="underline underline-offset-4 hover:text-foreground"
            >
              {chunks}
            </Link>
          ),
        })}
      </p>
    </div>
  );
}
