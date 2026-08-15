import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations, setRequestLocale } from "next-intl/server";

import { routing } from "@/lib/i18n/routing";
import { Providers } from "@/components/providers";
import { SiteHeader } from "@/components/layout/site-header";
import { SiteFooter } from "@/components/layout/site-footer";
import { NavFab } from "@/components/layout/nav-fab";
import { Toaster } from "@/components/ui/toast";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

// 站点默认标题/描述本地化：首页 tab 显示「Yu Shaoyuan | 硕士生」（en 为 M.S. Student），
// 子页面由 template 拼接（如「博客 | Yu Shaoyuan」）；根 layout 的英文默认值仅兜底非 locale 页面
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!routing.locales.includes(locale as (typeof routing.locales)[number])) {
    return {};
  }
  const t = await getTranslations({ locale, namespace: "meta" });
  return {
    title: {
      default: t("defaultTitle"),
      template: t("titleTemplate"),
    },
    description: t("description"),
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!routing.locales.includes(locale as (typeof routing.locales)[number])) {
    notFound();
  }
  setRequestLocale(locale);

  const messages = await getMessages();

  return (
    <NextIntlClientProvider messages={messages}>
      <div className="flex min-h-svh flex-col">
        <Providers>
          <SiteHeader />
          <main className="flex-1">
            {children}
            <NavFab />
          </main>
          <SiteFooter />
          <Toaster />
        </Providers>
      </div>
    </NextIntlClientProvider>
  );
}
