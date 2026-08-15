import { useTranslations } from "next-intl";

import { LinksSearch } from "@/components/links/links-search";
import { pageMetadata } from "@/lib/i18n/metadata";
import { navLinks } from "@/lib/data";

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props) {
  return pageMetadata(params, "navPage");
}

export default function NavPage() {
  const t = useTranslations("navPage");

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <div className="mb-8 flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>
      <LinksSearch groups={navLinks} />
    </div>
  );
}
