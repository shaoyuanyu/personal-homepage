/**
 * 特殊用途标志 → i18n 键（`mail.folderSpecial.*`）。未收录的返回 null（不渲染徽章）。
 * 与 webmaild 的 folders.ts 同一份语义（\Sent / \Drafts / \Trash / \Junk / \Archive / \All）。
 *
 * ⚠ 2026-10-07 起本文件**只此一个函数**：原先还有 `useAccountFolders()`（前端拉文件夹清单），
 *   随「文件夹」视图与「移动」菜单一起删除（见 MAIL-AGENT.md 4.15 一）。剩下的这枚映射供
 *   账号弹窗的**同步文件夹勾选**渲染特殊用途徽章，是前端唯一还需要"文件夹概念"的地方。
 */
export function folderSpecialKey(specialUse: string): string | null {
  switch (specialUse) {
    case "\\Sent":
      return "sent";
    case "\\Drafts":
      return "drafts";
    case "\\Trash":
      return "trash";
    case "\\Junk":
      return "junk";
    case "\\Archive":
      return "archive";
    case "\\All":
      return "all";
    default:
      return null;
  }
}
