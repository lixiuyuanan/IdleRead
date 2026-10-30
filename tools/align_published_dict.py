# -*- coding: utf-8 -*-
"""把已发布词表里原有词条的释义对回来（2026-10-30）。

扩量重建会重新走 ECDICT + 清洗，少数常用词的释义被换成了另一份更像"原始数据"的写法
（thinner 丢了"较薄的"，scrooge 丢了"吝啬鬼"）。已发布词表的释义是人工清过的，
除非明确更好，一律以线上版为准；允许保留的个例写在 KEEP_CURRENT。

用法：
    python tools/align_published_dict.py --base data/_archive/<备份>/dict.json
    python tools/align_published_dict.py --base ... --write
"""
import json
import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DICT = os.path.join(ROOT, "data", "dict.json")

# 线上版本身有问题、新数据更好的词：保留当前释义。
KEEP_CURRENT = {
    "bagpipes",   # 线上版被截成 '(also. 风笛'
    "ceylon",     # 线上版含错字 '现以更名为'
    "ddt",        # 线上版 abbr. 展开项与词义不符
}


def main():
    write = "--write" in sys.argv
    base = None
    for i, a in enumerate(sys.argv):
        if a == "--base" and i + 1 < len(sys.argv):
            base = sys.argv[i + 1]
    if not base:
        print("缺 --base <已发布词表备份路径>")
        return 2
    pub = json.load(open(base, encoding="utf-8"))
    cur = json.load(open(DICT, encoding="utf-8"))
    todo = []
    for w in sorted(set(pub) & set(cur)):
        if w in KEEP_CURRENT:
            continue
        if (pub[w][1] or "") != (cur[w][1] or ""):
            todo.append((w, pub[w][1], cur[w][1]))
    print("共同词条 %d，释义不一致 %d，恢复 %d"
          % (len(set(pub) & set(cur)), len(todo), len(todo)))
    for w, a, b in todo:
        print("  %s: %r -> %r" % (w, (b or "")[:60], (a or "")[:60]))
    if not write:
        print("(只报告，加 --write 落盘)")
        return 0
    arch = os.path.join(ROOT, "data", "_archive", "dict-align-%s" % time.strftime("%Y%m%d-%H%M%S"))
    os.makedirs(arch, exist_ok=True)
    shutil.copyfile(DICT, os.path.join(arch, "dict.json"))
    for w, a, b in todo:
        cur[w][1] = a
    with open(DICT, "w", encoding="utf-8") as f:
        json.dump(cur, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print("已恢复 %d 条，备份 %s" % (len(todo), arch))
    return 0


if __name__ == "__main__":
    sys.exit(main())
