"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { BookmarkIcon, KeyRoundIcon } from "lucide-react";

import { Link, usePathname } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/button";

/**
 * 导航主人入口：挂载后请求 /api/auth/me 判断登录态。
 * 主人 → 显示「速记」链接；游客 → 显示「登录」链接。
 * 路径变化时重新检查（登录/登出跳转后布局组件不会重挂载，
 * 需随路由变化刷新登录态）；查询期间渲染同尺寸占位，避免导航栏布局跳动。
 */
export function OwnerNavItem() {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const [owner, setOwner] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    setOwner(null); // 路径变化后先回到占位态，再重新查询
    fetch("/api/auth/me")
      .then((r) => r.json().catch(() => null))
      .then((data: { owner?: boolean } | null) => {
        if (!cancelled) setOwner(data?.owner === true);
      })
      .catch(() => {
        if (!cancelled) setOwner(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  if (owner === null) {
    // 占位：与按钮同尺寸，避免布局跳动
    return <span aria-hidden className="size-9" />;
  }

  if (owner) {
    return (
      <Button
        variant="ghost"
        size="sm"
        render={<Link href="/admin/ideas" />}
        aria-label={t("ideas")}
      >
        <BookmarkIcon />
        {t("ideas")}
      </Button>
    );
  }

  return (
    <Button variant="ghost" size="sm" render={<Link href="/login" />} aria-label={t("login")}>
      <KeyRoundIcon />
      {t("login")}
    </Button>
  );
}
