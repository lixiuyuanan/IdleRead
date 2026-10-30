# -*- coding: utf-8 -*-
"""用 CMU 发音词典补音标（2026-10-30）。

eng_to_ipa 内置 CMUdict（BSD 风格许可），把 ARPAbet 转成 IPA，自带 ˈ / ˌ 重音。
只补 dict.json 里音标为空的词条，已有音标一律不动；CMU 查不到（返回 word*）就跳过。

输出统一到现有风格：ʤ→dʒ、ʧ→tʃ、ɚ/ɝ→ə、ɾ→t。

用法：
    python tools/fill_phon_cmu.py            # 只统计
    python tools/fill_phon_cmu.py --write    # 备份后落盘
"""
import json
import os
import re
import shutil
import sys
import time

import eng_to_ipa as ipa

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DICT = os.path.join(ROOT, "data", "dict.json")
WORD = re.compile(r"^[a-z][a-z'\-]*$")
NORM = {"ʤ": "dʒ", "ʧ": "tʃ", "ɚ": "ə", "ɝ": "ɜː", "ɐ": "ʌ", "ɾ": "t"}


def to_ipa(w):
    try:
        alts = ipa.ipa_list(w)
    except Exception:
        return ""
    if not alts:
        return ""
    s = alts[0][0] if isinstance(alts[0], (list, tuple)) else alts[0]
    s = str(s)
    if not s or "*" in s:
        return ""
    for a, b in NORM.items():
        s = s.replace(a, b)
    return re.sub(r"\s+", "", s)


def main():
    write = "--write" in sys.argv
    d = json.load(open(DICT, encoding="utf-8"))
    filled, left = [], []
    for w, v in d.items():
        if (v[0] or "").strip():
            continue
        if not WORD.match(w):
            left.append(w)
            continue
        p = to_ipa(w)
        if not p:
            left.append(w)
            continue
        v[0] = p
        filled.append((w, p))
    print("空音标补上 %d 条；仍缺 %d 条（CMU 没收录/缩写/带空格）" % (len(filled), len(left)))
    for w, p in filled[:15]:
        print("  %-18s %s" % (w, p))
    print("仍缺样例:", left[:20])
    if not write:
        print("(只统计，加 --write 落盘)")
        return 0
    arch = os.path.join(ROOT, "data", "_archive", "dict-phon-cmu-%s" % time.strftime("%Y%m%d-%H%M%S"))
    os.makedirs(arch, exist_ok=True)
    shutil.copyfile(DICT, os.path.join(arch, "dict.json"))
    with open(DICT, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print("已写入，备份 %s" % arch)
    return 0


if __name__ == "__main__":
    sys.exit(main())
