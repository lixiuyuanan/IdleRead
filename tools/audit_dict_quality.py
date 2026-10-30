# -*- coding: utf-8 -*-
"""词表体检（2026-10-30）：不看条数，看每条能不能用。

检查项
    1. 释义为空 / 完全没有中文
    2. 残留方括号领域标记 [计] [医]…
    3. 释义超长(>220)
    4. 词形表指向不存在的原形
    5. 语料词头覆盖（与 App 同一套 headOf 口径）
    6. 音标:空音标比例、是否还有旧式次重音标记 ./,
    7. 抽 20 条随机词打印,人眼过一遍

用法：python tools/audit_dict_quality.py
"""
import json
import os
import random
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import fill_dict_gaps as F  # noqa: E402  复用 head_of / corpus_heads，和 App 同口径

DICT_PATH = os.path.join(ROOT, "data", "dict.json")
LEMMA_PATH = os.path.join(ROOT, "data", "lemma.json")
CJK = re.compile(r"[\u4e00-\u9fff]")
BR = re.compile(r"\[[^\[\]]{1,20}\]")


def main():
    d = json.load(open(DICT_PATH, encoding="utf-8"))
    lemma = json.load(open(LEMMA_PATH, encoding="utf-8"))
    empty = [w for w, v in d.items() if not (v[1] or "").strip()]
    no_cjk = [w for w, v in d.items() if v[1] and not CJK.search(v[1])]
    bracket = [w for w, v in d.items() if v[1] and BR.search(v[1])]
    overlong = [w for w, v in d.items() if len(v[1] or "") > 220]
    bad_lemma = [(w, b) for w, b in lemma.items() if b not in d]
    no_phon = sum(1 for v in d.values() if not (v[0] or "").strip())
    old_mark = [w for w, v in d.items() if v[0] and re.match(r"^[.,]", v[0])]

    heads, _, _ = F.corpus_heads(d, lemma)
    missing = [h for h in heads if h not in d]

    print("词条 %d ｜ 词形 %d ｜ 语料词头 %d" % (len(d), len(lemma), len(heads)))
    print("空释义       %d" % len(empty))
    print("无中文释义   %d %s" % (len(no_cjk), no_cjk[:8]))
    print("残留方括号   %d %s" % (len(bracket), bracket[:8]))
    print("释义超长     %d %s" % (len(overlong), overlong[:8]))
    print("词形指向缺词 %d %s" % (len(bad_lemma), bad_lemma[:5]))
    print("空音标       %d（%.2f%%）" % (no_phon, 100.0 * no_phon / len(d)))
    print("旧次重音标记 %d %s" % (len(old_mark), old_mark[:5]))
    print("语料未收录   %d %s" % (len(missing), sorted(missing)[:10]))

    random.seed(20261030)
    picks = random.sample(sorted(d), 20)
    print("\n随机 20 条：")
    for w in picks:
        print("  %-16s %-22s %s" % (w, (d[w][0] or "-")[:22], (d[w][1] or "")[:56]))

    hard_fail = empty or no_cjk or bracket or bad_lemma or missing
    print("\n结论：%s" % ("有硬伤，见上" if hard_fail else "无硬伤（空释义/无中文/方括号/断词形/语料缺口均为 0）"))
    return 1 if hard_fail else 0


if __name__ == "__main__":
    sys.exit(main())
