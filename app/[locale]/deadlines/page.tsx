import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { DeadlinesList } from "@/components/deadlines/deadlines-list";
import {
  deadlines as builtinDeadlines,
  deadlinesFetchedAt as builtinFetchedAt,
  type DeadlineConf,
} from "@/lib/data";
import { pageMetadata } from "@/lib/i18n/metadata";

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props) {
  return pageMetadata(params, "deadlines");
}

/**
 * 动态渲染：优先读取运行时同步数据（/api/deadlines/sync 写入的 data/deadlines.json），
 * 不存在时回退到构建时入库数据（lib/data/deadlines.json）。
 * 手动「立即同步」后刷新页面即可看到最新数据，无需等待重新部署。
 */
export const dynamic = "force-dynamic";

function readLiveDeadlines(): {
  conferences: DeadlineConf[];
  fetchedAt: string;
} | null {
  const livePath = join(process.cwd(), "data/deadlines.json");
  if (!existsSync(livePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(livePath, "utf8")) as {
      conferences?: DeadlineConf[];
      fetchedAt?: string;
    };
    if (Array.isArray(parsed.conferences) && parsed.conferences.length > 0) {
      return {
        conferences: parsed.conferences,
        fetchedAt: parsed.fetchedAt ?? builtinFetchedAt,
      };
    }
    return null;
  } catch {
    // 文件损坏/非法：回退构建时数据，不抛错影响页面
    return null;
  }
}

export default function DeadlinesPage() {
  const t = useTranslations("deadlines");
  const live = readLiveDeadlines();
  const deadlines = live?.conferences ?? builtinDeadlines;
  const fetchedAt = live?.fetchedAt ?? builtinFetchedAt;

  return (
    <div className="w-full mx-auto max-w-5xl px-4 py-12 sm:px-6">
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
            href="https://github.com/ccfddl/ccf-deadlines"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-foreground"
          >
            ccfddl/ccf-deadlines
          </a>
          {" · "}
          {t("updatedAt")} {fetchedAt}
        </p>
      </div>
      <DeadlinesList deadlines={deadlines} />
      <p className="mt-14 border-t pt-4 text-xs text-muted-foreground/70">
        {t("sourceNote")}
      </p>
    </div>
  );
}
