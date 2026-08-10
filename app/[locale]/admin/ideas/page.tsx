import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { requireOwner } from "@/lib/auth/owner";
import { listIdeas } from "@/lib/ideas/store";
import { IdeasManager } from "@/components/ideas/ideas-manager";

export const metadata: Metadata = {
  title: "Idea Scratchpad",
  robots: { index: false, follow: false },
};

/** 想法速记：主人专属页面，未登录重定向到登录页 */
export default async function AdminIdeasPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  await requireOwner();

  const t = await getTranslations("ideas");
  const ideas = listIdeas();

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("description")}</p>
      </header>
      <IdeasManager initialIdeas={ideas} />
    </div>
  );
}
