import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { LightbulbIcon } from "lucide-react";

import { requireOwner } from "@/lib/auth/owner";
import { listIdeas } from "@/lib/ideas/store";
import { IdeasManager } from "@/components/ideas/ideas-manager";

export const metadata: Metadata = {
  title: "Idea Scratchpad",
  robots: { index: false, follow: false },
};

/** Idea 速记：主人专属页面，未登录重定向到登录页 */
export default async function IdeasPage({
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
      <header className="mb-8 flex flex-col items-center text-center">
        <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/20">
          <LightbulbIcon className="size-6" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("description")}</p>
      </header>
      <IdeasManager initialIdeas={ideas} />
    </div>
  );
}
