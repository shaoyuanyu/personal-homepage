import type { Publication } from "@/lib/data";
import { stripMeMarker } from "@/lib/publications/authors";

/** 转义 BibTeX 特殊字符 */
function escapeTex(value: string): string {
  return value
    .replace(/&/g, "\\&")
    .replace(/%/g, "\\%")
    .replace(/#/g, "\\#")
    .replace(/_/g, "\\_");
}

/**
 * 生成 BibTeX 条目。
 *
 * * 若数据里给了 `bibtex` 字段（出版社/BibTeX 服务给出的规范版本），**原样使用** ——
 *   手工维护时经常希望与官方版本逐字一致，自动生成反而会走样。
 * * ⚠ 自动生成时作者串必须经 `stripMeMarker()` 剥掉「本人」标记，
 *   否则会把 `author = {YU Shaoyuan*}` 写进用户的参考文献库。
 */
export function generateBibtex(pub: Publication): string {
  const manual = pub.bibtex?.trim();
  if (manual) return manual;

  const fields: string[] = [];
  const add = (key: string, value: string) => fields.push(`  ${key} = {${escapeTex(value)}}`);

  add("title", pub.title);
  add("author", pub.authors.map(stripMeMarker).join(" and "));
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
