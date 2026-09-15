/**
 * 「本人」识别：判断一篇论文的作者串里有没有我（用于在作者列表中把自己的名字加粗）。
 *
 * 为什么不能简单做字符串相等：作者名的写法千差万别 ——
 * `YU Shaoyuan`（profile.yaml 里的写法）/ `Yu, Shaoyuan` / `Shaoyuan Yu`
 * 三种写法在论文里都常见，而 profile 只提供一个写法（历史上 `isMe()` 就是
 * `author.toLowerCase() === myName.toLowerCase()`，于是 `Shaoyuan Yu` 根本不会被识别）。
 *
 * 规则（按优先级）：
 *   1. 作者串里出现 `*` → 直接认定（显式标记，可覆盖任何写法差异，如缩写名 `S. Yu`）
 *   2. 否则做**顺序无关、忽略标点与大小写**的姓名 token 匹配：
 *      我的姓名 token（`YU Shaoyuan` → {yu, shaoyuan}）**全部**出现在该作者串里即视为本人。
 *      要求「全部命中」可避免把「Yu Chen」这类只共享姓氏的合作者误判成我。
 */

/** 去掉「本人」标记 `*`（连同紧邻空白）——`*` 只是数据里的标记，不能出现在任何输出里 */
export function stripMeMarker(author: string): string {
  return author.replace(/\*/g, "").trim();
}

/** 归一化成 token：小写、去标点、按空白切分 */
function toTokens(value: string): string[] {
  return stripMeMarker(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

/**
 * 构造作者判定函数。
 *
 * @param myNames 我自己的姓名写法，可给多个别名（如中英文各一）；
 *                在 `app/[locale]/publications/page.tsx` 里由 `profile.name` 传入
 *                —— 注意必须是**可序列化**的值（页面是服务端组件，函数不能跨边界传）
 */
export function createAuthorMatcher(myNames: readonly string[]) {
  const myTokenSets = myNames.map(toTokens).filter((tokens) => tokens.length > 0);

  return (author: string): boolean => {
    if (author.includes("*")) return true;
    const tokens = toTokens(author);
    if (tokens.length === 0) return false;
    return myTokenSets.some((mine) => mine.every((token) => tokens.includes(token)));
  };
}
