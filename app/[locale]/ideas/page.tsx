import { getTranslations, setRequestLocale } from "next-intl/server";

import { requireOwner } from "@/lib/auth/owner";
import { listIdeas } from "@/lib/ideas/store";
import { IdeasManager } from "@/components/ideas/ideas-manager";
import { pageMetadata } from "@/lib/i18n/metadata";

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props) {
  return {
    ...(await pageMetadata(params, "ideas")),
    robots: { index: false, follow: false },
  };
}

/** Idea 速记：主人专属页面，未登录重定向到登录页 */
export default async function IdeasPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  await requireOwner();

  const t = await getTranslations("ideas");
  const ideas = listIdeas();

  return (
    <div className="w-full mx-auto max-w-5xl px-4 py-12 sm:px-6">
      {/* 标准页头排版（与论文/导航等页面一致） */}
      <div className="mb-8 flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>
      <IdeasManager initialIdeas={ideas} />
    </div>
  );
}
