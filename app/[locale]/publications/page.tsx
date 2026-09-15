import { useTranslations } from "next-intl";
import { BookMarkedIcon } from "lucide-react";

import { PublicationsList } from "@/components/sections/publications-list";
import { buttonVariants } from "@/components/ui/button";
import { Link } from "@/lib/i18n/navigation";
import { pageMetadata } from "@/lib/i18n/metadata";
import { profile, publications } from "@/lib/data";
import { getPinnedKeys } from "@/lib/publications/pinned";

// 置顶列表是运行时状态（data/preferences.json），不可预渲染 —— 否则置顶会
// 冻结在构建时刻。与 /deadlines（读运行时 data/deadlines.json）同一处理。
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props) {
  return pageMetadata(params, "publications");
}

export default function PublicationsPage() {
  const t = useTranslations("publications");

  const sorted = [...publications].sort((a, b) => b.year - a.year);
  // 置顶列表在服务端读（首页与本站点同一份），客户端只负责开关交互
  const pinnedKeys = getPinnedKeys();

  return (
    <div className="w-full mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold">{t("title")}</h1>
          <p className="text-muted-foreground">{t("description")}</p>
        </div>
        <Link
          href="/ccf"
          data-slot="button"
          className={buttonVariants({ variant: "outline", size: "sm", className: "shrink-0" })}
        >
          <BookMarkedIcon />
          {t("ccfEntry")}
        </Link>
      </div>
      {/* 自己的姓名可传多个写法（匹配顺序/标点无关）；若将来 profile 增加中文名，
          在这里补一项即可。⚠ 只传可序列化值（本文件是 server component） */}
      <PublicationsList
        publications={sorted}
        myNames={[profile.name]}
        initialPinnedKeys={pinnedKeys}
      />
    </div>
  );
}
