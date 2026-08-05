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

  if (pub.venue) {
    // 会议 → booktitle，期刊 → journal，学位论文 → school
    const venueField = pub.type === "journal" ? "journal" : pub.type === "thesis" ? "school" : "booktitle";
    add(venueField, pub.venue);
  }
  if (pub.doi) add("doi", pub.doi);
  if (pub.url) add("url", pub.url);

  // 会议 → inproceedings，期刊/预印本 → article，学位论文 → phdthesis
  const bibType =
    pub.type === "conference" ? "inproceedings" : pub.type === "thesis" ? "phdthesis" : "article";
  return `@${bibType}{${pub.key},\n${fields.join(",\n")}\n}`;
}
