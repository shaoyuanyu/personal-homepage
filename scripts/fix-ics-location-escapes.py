#!/usr/bin/env python3
r"""把已写入事件里 LOCATION 的转义逗号改写成中点（与站点新的写入端一致）。

背景（两层约束）：
  · Radicale 用 vobject 校验并**重新序列化**每个 item，vobject 把裸逗号当列表
    分隔符、只保留第一项 —— `LOCATION:Providence, RI, USA` 存进去会静默变成
    `LOCATION:Providence`（丢数据）→ 所以逗号**必须**转义成 `\,`；
  · 但手机端 CalDAV 客户端（华为/鸿蒙日历）不做反转义，会把 `\,` 原样显示 →
    用户看到「Providence\, RI\, USA」。
站点写入端已改为把地点写成 `Providence · RI · USA`（不含需转义字符，两端都干净）；
本脚本把**已存在**的事件刷成同一形式。

只改 LOCATION 一行，其余字节（含 CRLF）原样保留；默认 dry-run，加 --apply 才写回。
幂等：已经是中点形式的地点不会再被改动。
"""
import glob
import os
import re
import sys

DIR = os.environ.get(
    "RADICALE_COLLECTION_DIR",
    os.path.join(
        os.path.expanduser("~"),
        "personal-homepage",
        "radicale",
        "collections",
        "collection-root",
        "ysy",
        "conference-ddl",
    ),
)
APPLY = "--apply" in sys.argv


def fix_line(line: str) -> str:
    if not line.upper().startswith("LOCATION"):
        return line
    head, _, value = line.partition(":")
    # 先反转义（\, \; \\），再把逗号/分号换成中点（与 lib/ical.ts 的 icsLocationText 同规则）
    unescaped = value.replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")
    return f"{head}:{re.sub(r'\s*[;,]+\s*', ' · ', unescaped).strip()}"


changed = 0
for path in sorted(glob.glob(os.path.join(DIR, "*.ics"))):
    with open(path, newline="") as fh:
        text = fh.read()
    lines = text.split("\r\n")
    out = [fix_line(line) for line in lines]
    new_text = "\r\n".join(out)
    if new_text == text:
        continue
    changed += 1
    old = [line for line in lines if line.upper().startswith("LOCATION")]
    new = [line for line in out if line.upper().startswith("LOCATION")]
    print(f"{os.path.basename(path)}\n  - {old}\n  + {new}")
    if APPLY:
        with open(path, "w", newline="") as fh:
            fh.write(new_text)

print(f"{'已写回' if APPLY else 'DRY-RUN'}：{changed}/{len(glob.glob(os.path.join(DIR, '*.ics')))} 个文件需要修改")
