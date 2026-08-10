import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";

import { LoginForm } from "@/components/auth/login-form";
import { isOwner } from "@/lib/auth/owner";

export const metadata: Metadata = {
  title: "Admin Login",
  robots: { index: false, follow: false },
};

export default async function LoginPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  // 已登录的管理员直接回首页（cookies() 使本页动态渲染）
  if (await isOwner()) {
    redirect("/");
  }

  const t = await getTranslations("login");

  return (
    <div className="mx-auto flex max-w-md flex-col px-4 py-16 sm:px-6">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <LoginForm />
    </div>
  );
}
