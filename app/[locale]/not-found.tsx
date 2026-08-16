import type { Metadata } from "next";
import { FileQuestionIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";

import { buttonVariants } from "@/components/ui/button";
import { Link } from "@/lib/i18n/navigation";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("notFound");
  return { title: t("title") };
}

export default function NotFound() {
  const tNav = useTranslations("nav");
  const t = useTranslations("notFound");

  return (
    <div className="mx-auto flex max-w-5xl flex-col items-center justify-center gap-4 px-4 py-24 text-center sm:px-6">
      <FileQuestionIcon className="size-12 text-muted-foreground" />
      <h1 className="text-3xl font-bold tracking-tight">404</h1>
      <p className="text-muted-foreground">{t("message")}</p>
      <Link href="/" data-slot="button" className={buttonVariants({})}>
        {tNav("home")}
      </Link>
    </div>
  );
}
