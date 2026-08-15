import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { routing } from "@/lib/i18n/routing";

/**
 * 页面级 generateMetadata 助手：按 locale 从消息文件生成页面标题与描述，
 * 使浏览器标签页 / 搜索引擎展示与页面语言一致（zh 下显示中文标题）。
 * 非法 locale 返回空对象——组件层会 notFound()，此处避免 getTranslations 抛错导致 500。
 */
export async function pageMetadata(
  params: Promise<{ locale: string }>,
  namespace: string,
): Promise<Metadata> {
  const { locale } = await params;
  if (!routing.locales.includes(locale as (typeof routing.locales)[number])) {
    return {};
  }
  const t = await getTranslations({ locale, namespace });
  return {
    title: t("title"),
    description: t("description"),
  };
}
