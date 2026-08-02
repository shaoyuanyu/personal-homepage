import type { Metadata } from "next";
import { useLocale, useTranslations } from "next-intl";
import { ExternalLinkIcon, FolderGit2Icon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { projects } from "@/lib/data";

export const metadata: Metadata = {
  title: "Projects",
  description: "Research and open-source projects",
};

export default function ProjectsPage() {
  const t = useTranslations("projects");
  const locale = useLocale();
  const lang = locale === "zh" ? "zh" : "en";

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <div className="mb-8 flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>

      {projects.length === 0 && <Empty title={t("empty")} />}

      <div className="grid gap-4 sm:grid-cols-2">
        {projects.map((project) => (
          <Card key={project.name} className="flex flex-col transition-colors hover:border-primary/40">
            <CardHeader className="pb-2">
              <CardTitle className="font-mono text-base">
                <a
                  href={project.github ?? project.url ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {project.name}
                </a>
              </CardTitle>
              <CardDescription className="text-sm">{project.description[lang]}</CardDescription>
            </CardHeader>
            <CardContent className="mt-auto flex flex-col gap-3 pt-2">
              <div className="flex flex-wrap gap-1.5">
                {project.tags.map((tag) => (
                  <Badge key={tag} variant="secondary">{tag}</Badge>
                ))}
              </div>
              <div className="flex gap-1">
                {project.github && (
                  <a
                    href={project.github}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                  >
                    <FolderGit2Icon className="size-3.5" />
                    GitHub
                  </a>
                )}
                {project.url && (
                  <a
                    href={project.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                  >
                    <ExternalLinkIcon className="size-3.5" />
                    Link
                  </a>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
