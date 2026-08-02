import { useTranslations } from "next-intl";
import { MenuIcon } from "lucide-react";

import { Link } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { LocaleSwitcher } from "@/components/layout/locale-switcher";
import { profile } from "@/lib/data";

const navItems = [
  { href: "/", key: "home" },
  { href: "/publications", key: "publications" },
  { href: "/talks", key: "talks" },
  { href: "/projects", key: "projects" },
  { href: "/blog", key: "blog" },
  { href: "/nav", key: "nav" },
  { href: "/cv", key: "cv" },
] as const;

export function SiteHeader() {
  const t = useTranslations("nav");
  const name = profile.name.split(" ").map((s) => s[0]).join("");

  return (
    <header className="sticky top-0 z-40 w-full border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
        {/* Logo */}
        <Link href="/" className="font-mono text-sm font-semibold tracking-tight">
          {name}
        </Link>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-1 md:flex">
          {navItems.map((item) => (
            <Button key={item.key} variant="ghost" size="sm" render={<Link href={item.href} />}>
              {t(item.key)}
            </Button>
          ))}
        </nav>

        <div className="flex items-center gap-1">
          <ThemeToggle />
          <LocaleSwitcher />
          {/* Mobile nav */}
          <Sheet>
            <SheetTrigger
              render={<Button variant="ghost" size="icon-sm" className="md:hidden" aria-label={t("menu")} />}
            >
              <MenuIcon data-icon="default" />
            </SheetTrigger>
            <SheetContent side="right" className="w-64">
              <SheetTitle className="sr-only">{t("menu")}</SheetTitle>
              <nav className="flex flex-col gap-1 pt-4">
                {navItems.map((item) => (
                  <Button key={item.key} variant="ghost" size="sm" className="justify-start" render={<Link href={item.href} />}>
                    {t(item.key)}
                  </Button>
                ))}
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
