import type { Metadata } from "next";
import { useTranslations } from "next-intl";

import { PublicationsList } from "@/components/sections/publications-list";
import { profile, publications } from "@/lib/data";

export const metadata: Metadata = {
  title: "Publications",
  description: "List of publications and preprints",
};

export default function PublicationsPage() {
  const t = useTranslations("publications");

  const sorted = [...publications].sort((a, b) => b.year - a.year);

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <div className="mb-8 flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>
      <PublicationsList publications={sorted} myName={profile.name} />
    </div>
  );
}
