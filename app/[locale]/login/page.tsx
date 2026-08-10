import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { InfoIcon, KeyRoundIcon } from "lucide-react";

import { LoginForm } from "@/components/auth/login-form";
import { isOwner } from "@/lib/auth/owner";
import { Card, CardContent } from "@/components/ui/card";

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
      <div className="mb-8 flex flex-col items-center text-center">
        <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/20">
          <KeyRoundIcon className="size-6" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("description")}</p>
        {/* 游客提示：消除访客困惑（本页为管理员专属入口） */}
        <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
          <InfoIcon className="size-3.5 shrink-0" />
          {t("guestHint")}
        </p>
      </div>
      <Card className="p-6 sm:p-8">
        <CardContent className="p-0">
          <LoginForm />
        </CardContent>
      </Card>
      <p className="mt-6 text-center text-xs text-muted-foreground">
        {t("recoveryHint")}
      </p>
    </div>
  );
}
