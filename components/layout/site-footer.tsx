import { useTranslations } from "next-intl";

export function SiteFooter() {
  const t = useTranslations("footer");

  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-2 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:px-6">
        <p>{t("copyright", { year: new Date().getFullYear() })}</p>
        <p>{t("builtWith")}</p>
      </div>
    </footer>
  );
}
