import NextLink from "next/link";
import { FileQuestionIcon } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { routing } from "@/lib/i18n/routing";
import { buttonVariants } from "@/components/ui/button";

/**
 * 根级 404。
 *
 * ⚠ 为什么需要它：Next.js 中 `not-found.tsx` 只对「该路由段内调用 notFound()」
 * 生效——`app/[locale]/not-found.tsx` 处理的是语言前缀非法等场景（[locale]/layout
 * 里显式 notFound()）。而**未匹配任何路由**的 URL（如手输错地址、失效外链）会落到
 * 根级 not-found，此前项目未提供该文件，于是渲染 Next 内置 404：英文硬编码文案、
 * 内置 system-ui 字体（页面主标题不是衬线）、无站点样式与返回入口。
 *
 * 渲染位置：app/layout.tsx 之内，故有全站 CSS 与字体，但**没有** SiteHeader /
 * SiteFooter（二者在 [locale]/layout.tsx 中）。语言取 next-intl 中间件的请求配置，
 * 与正常页面一致。
 */
export default async function RootNotFound() {
  const locale = await getLocale();
  const t = await getTranslations({ locale, namespace: "notFound" });
  const tNav = await getTranslations({ locale, namespace: "nav" });

  // 首页地址需带语言前缀：routing 为 as-needed（默认语言 zh 不带前缀）
  const homeHref = locale === routing.defaultLocale ? "/" : `/${locale}`;

  return (
    <div className="mx-auto flex min-h-svh max-w-5xl flex-col items-center justify-center gap-4 px-4 py-24 text-center sm:px-6">
      <FileQuestionIcon className="size-12 text-muted-foreground" />
      {/* 页面主标题：无衬线（见 app/globals.css 字体策略） */}
      <h1 className="text-3xl font-bold">404</h1>
      <p className="text-muted-foreground">{t("message")}</p>
      <NextLink href={homeHref} data-slot="button" className={buttonVariants({})}>
        {tNav("home")}
      </NextLink>
    </div>
  );
}
