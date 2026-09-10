import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";

import { LoginForm } from "@/components/auth/login-form";
import { isOwner } from "@/lib/auth/owner";
import { Card, CardContent } from "@/components/ui/card";
import { pageMetadata } from "@/lib/i18n/metadata";

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props) {
  return {
    ...(await pageMetadata(params, "login")),
    robots: { index: false, follow: false },
  };
}

export default async function LoginPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  // 已登录的管理员直接回首页（cookies() 使本页动态渲染）
  if (await isOwner()) {
    redirect("/");
  }

  const t = await getTranslations("login");

  // shadcn login-01 卡片式：所有内容（标题、描述、表单、提示）集中在卡片内，
  // 整卡在 header 与 footer 之间垂直居中（main 为 flex 容器，flex-1 撑满剩余高度）
  return (
    <div className="flex w-full flex-1 flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <Card>
          <CardContent className="flex flex-col gap-6">
            {/* 标题区：左对齐（官方 CardTitle：text-base font-semibold + CardDescription text-sm muted） */}
            <div className="flex flex-col gap-2">
              <h1 className="text-base font-semibold">{t("title")}</h1>
              <p className="text-balance text-sm text-muted-foreground">
                {t("description")}
              </p>
            </div>
            <LoginForm />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
