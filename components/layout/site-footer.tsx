import { useTranslations } from "next-intl";

export function SiteFooter() {
  const t = useTranslations("footer");

  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-2 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:px-6">
        <p>{t("copyright", { year: new Date().getFullYear() })}</p>
        <p>
          <a
            href="https://beian.miit.gov.cn/"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground hover:underline"
          >
            {t("icp")}
          </a>
        </p>
      </div>
    </footer>
  );
}
