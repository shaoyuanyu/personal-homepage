import { FileQuestionIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Link } from "@/lib/i18n/navigation";

export default function NotFound() {
  const tNav = useTranslations("nav");

  return (
    <div className="mx-auto flex max-w-5xl flex-col items-center justify-center gap-4 px-4 py-24 text-center sm:px-6">
      <FileQuestionIcon className="size-12 text-muted-foreground" />
      <h1 className="text-3xl font-bold tracking-tight">404</h1>
      <p className="text-muted-foreground">Page not found</p>
      <Button render={<Link href="/" />}>{tNav("home")}</Button>
    </div>
  );
}
