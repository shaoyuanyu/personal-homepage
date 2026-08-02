import type { Publication } from "@/lib/data";

/** 转义 BibTeX 特殊字符 */
function escapeTex(value: string): string {
  return value
    .replace(/&/g, "\\&")
    .replace(/%/g, "\\%")
    .replace(/#/g, "\\#")
    .replace(/_/g, "\\_");
}

/** 根据论文数据生成 BibTeX 条目 */
export function generateBibtex(pub: Publication): string {
  const fields: string[] = [];
  const add = (key: string, value: string) => fields.push(`  ${key} = {${escapeTex(value)}}`);

  add("title", pub.title);
  add("author", pub.authors.join(" and "));
  add("year", String(pub.year));

  if (pub.venue) add("booktitle", pub.venue);
  if (pub.doi) add("doi", pub.doi);
  if (pub.url) add("url", pub.url);

  const type = pub.type === "preprint" ? "article" : "inproceedings";
  return `@${type}{${pub.key},\n${fields.join(",\n")}\n}`;
}
