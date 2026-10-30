# -*- coding: utf-8 -*-
"""把 ECDICT 音标开头的旧式次重音标记 . / , 还原成 IPA 的次重音符号 ˌ（2026-10-30）。

之前对齐腾讯写法时把开头的 . / , 直接删了，结果次重音全丢（belfast 只剩 belfɑ:st）。
正确做法是换成 ˌ：.æbdi'keiʃən → ˌæbdi'keiʃən。

用法：
    python tools/restore_stress_marks.py            # 只统计
    python tools/restore_stress_marks.py --write    # 备份后落盘
"""
import csv
import json
import os
import re
import shutil
import sys
import time

csv.field_size_limit(10 ** 7)
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DICT = os.path.join(ROOT, "data", "dict.json")
CSV_PATH = os.path.join(HERE, "_cache", "ecdict.csv")
LEAD = re.compile(r"^[.,]\s*")
SECONDARY = "\u02cc"   # ˌ


def raw_phon():
    out = {}
    with open(CSV_PATH, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            w = (row.get("word") or "").strip().lower()
            ph = (row.get("phonetic") or "").strip()
            if w and ph and w not in out:
                out[w] = ph
    return out


def main():
    write = "--write" in sys.argv
    d = json.load(open(DICT, encoding="utf-8"))
    raw = raw_phon()
    fixed = []
    for w, v in d.items():
        ph = v[0] or ""
        if not ph:
            continue
        if LEAD.match(ph):
            v[0] = SECONDARY + LEAD.sub("", ph)
            fixed.append(w)
            continue
        src = raw.get(w)
        if src and LEAD.match(src) and not ph.startswith(SECONDARY):
            v[0] = SECONDARY + ph
            fixed.append(w)
    print("词典 %d 条，补回次重音 %d 条" % (len(d), len(fixed)))
    print("样例:", [(w, d[w][0]) for w in fixed[:12]])
    if not write:
        print("(只报告，加 --write 落盘)")
        return 0
    arch = os.path.join(ROOT, "data", "_archive", "dict-stress-%s" % time.strftime("%Y%m%d-%H%M%S"))
    os.makedirs(arch, exist_ok=True)
    shutil.copyfile(DICT, os.path.join(arch, "dict.json"))
    with open(DICT, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print("落盘完成，备份 %s" % arch)
    return 0


if __name__ == "__main__":
    sys.exit(main())
