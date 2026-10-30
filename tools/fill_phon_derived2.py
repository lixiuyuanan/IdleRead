# -*- coding: utf-8 -*-
"""CMU 也没收录的派生/变形词，按构词规则借原形音标（2026-10-30）。

只处理仍为空且不是专名/缩写的词条：先走 lemma，再按词尾规则(复数/过去式/分词/
-ly/-ness/-less/-ment/比较级)给原形音标加尾音，最后试复合词切分(nightgown)。
原形音标取自 dict.json（已由 ECDICT/CMU 补过），查不到就留空，不硬造。

用法：
    python tools/fill_phon_derived2.py            # 只统计
    python tools/fill_phon_derived2.py --write    # 备份后落盘
"""
import json
import os
import re
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DICT = os.path.join(ROOT, "data", "dict.json")
LEMMA = os.path.join(ROOT, "data", "lemma.json")
STRESS = "ˈˌ'ː"
SIBILANT = ("s", "z", "ʃ", "ʒ", "tʃ", "dʒ")
VOICELESS = ("p", "t", "k", "f", "θ", "s", "ʃ", "tʃ")


def last_phon(p):
    q = "".join(c for c in p if c not in STRESS)
    for d in ("tʃ", "dʒ"):
        if q.endswith(d):
            return q[-2:]
    return q[-1:]


def plural(last):
    if last in SIBILANT:
        return "ɪz"
    return "s" if last in VOICELESS else "z"


def past(last):
    if last in ("t", "d"):
        return "ɪd"
    return "t" if last in VOICELESS else "d"


def ly_tail(last):
    # -ly 接在 /l/ 后面只补 i(careful /ˈkeəfəl/ → /ˈkeəfəli/),否则补 li
    return "i" if last == "l" else "li"


# (词尾, 去掉词尾后要补的字母, 尾音函数)
RULES = [
    ("ies", "y", lambda last: "z"),
    ("ied", "y", lambda last: "d"),
    ("es", "", lambda last: "ɪz"),
    ("s", "", plural),
    ("ed", "", past),
    ("ing", "", lambda last: "ɪŋ"),
    ("ily", "y", lambda last: "li"),
    ("ly", "", ly_tail),
    ("ness", "", lambda last: "nəs"),
    ("less", "", lambda last: "ləs"),
    ("ment", "", lambda last: "mənt"),
    ("est", "", lambda last: "ɪst"),
    ("er", "", lambda last: "ə"),
]
PROPER = "（专名）"
REF = re.compile(r"[(（]?\s*([a-z][a-z'\-]+)\s*的(过去分词|过去式|复数形式|复数|现在分词|比较级|最高级)")
PREFIX = {
    "dis": "dɪs", "mis": "mɪs", "non": "nɔn", "pre": "pri:", "un": "ʌn", "re": "ri:",
    "over": "'əuvə", "under": "'ʌndə", "out": "aut", "sub": "sʌb", "super": "'sju:pə",
    "anti": "'ænti", "auto": "'ɔ:təu", "semi": "'semi", "multi": "'mʌlti",
    "post": "pəust", "pro": "prəu", "inter": "'intə", "trans": "træns",
    "micro": "'maikrəu", "macro": "'mækrəu", "mono": "'mɔnəu", "co": "kəu",
}
REF_TAIL = {"过去分词": past, "过去式": past, "复数形式": plural, "复数": plural,
            "现在分词": lambda last: "ɪŋ", "比较级": lambda last: "ə",
            "最高级": lambda last: "ɪst"}


def find_base(w, d, lemma):
    """返回 (原形音标, 尾音) 或 None。只认和词尾对应的原形,不拿 lemma 乱套。"""
    for suf, add, snd in RULES:
        if not (len(w) > len(suf) + 2 and w.endswith(suf)):
            continue
        b = w[: -len(suf)] + add
        if len(b) < 4:
            continue
        e = d.get(b)
        if not (e and (e[0] or "").strip()):
            lb = lemma.get(b)
            e = d.get(lb) if lb else None
        if not (e and (e[0] or "").strip()):
            if w in lemma:
                e = d.get(lemma[w])
        if e and (e[0] or "").strip():
            return (e[0], snd(last_phon(e[0])))
    return None


BAD_REF = {"chid"}   # 不规则过去式,照规则加尾音会读错


def from_ref(w, dfn, d, lemma):
    """释义里写了「X 的过去式/复数」的，直接借 X 的音标加尾音。"""
    if w in BAD_REF:
        return None
    m = REF.search(dfn or "")
    if not m:
        return None
    base, kind = m.group(1), m.group(2)
    e = d.get(base) or d.get(lemma.get(base, base))
    if not (e and (e[0] or "").strip()):
        return None
    snd = REF_TAIL[kind]
    tail = snd(last_phon(e[0]))
    if kind in ("过去式", "过去分词") and w.endswith("t"):
        tail = "t"          # spoilt / learnt:词尾 t 说明是清音
    p = e[0] + tail
    if " " in p or "." in p:
        return None         # 原形音标里带多个变体,不硬拼
    return p


def with_prefix(w, d):
    if len(w) < 7:
        return None
    for p, ph in sorted(PREFIX.items(), key=lambda x: -len(x[0])):
        if w.startswith(p) and len(w) - len(p) >= 4:
            e = d.get(w[len(p):])
            if e and (e[0] or "").strip():
                return ph + e[0]
    return None


def compound(w, d, lemma):
    if len(w) < 8:
        return None
    for i in range(4, len(w) - 3):
        a, b = w[:i], w[i:]
        if b in ("ally", "ness", "less", "ment", "ing", "ed", "ly", "er", "est"):
            continue
        ea, eb = d.get(a), d.get(b) or d.get(lemma.get(b, b))
        if ea and eb and (ea[0] or "").strip() and (eb[0] or "").strip():
            return ea[0] + eb[0]
    return None


def main():
    write = "--write" in sys.argv
    d = json.load(open(DICT, encoding="utf-8"))
    lemma = json.load(open(LEMMA, encoding="utf-8"))
    via_rule, via_compound, left = [], [], []
    for w, v in d.items():
        if (v[0] or "").strip():
            continue
        dfn = v[1] or ""
        if (PROPER in dfn or "abbr" in dfn.lower() or "缩略" in dfn or "缩写" in dfn):
            left.append(w)
            continue
        got = find_base(w, d, lemma)
        if got and got[1]:
            v[0] = got[0] + got[1]
            via_rule.append((w, v[0]))
            continue
        r = from_ref(w, dfn, d, lemma)
        if r:
            v[0] = r
            via_rule.append((w, r))
            continue
        p = with_prefix(w, d)
        if p:
            v[0] = p
            via_compound.append((w, p))
            continue
        c = compound(w, d, lemma)
        if c:
            v[0] = c
            via_compound.append((w, c))
            continue
        left.append(w)
    print("规则补 %d，复合词补 %d，仍缺 %d" % (len(via_rule), len(via_compound), len(left)))
    print("规则样例:", [(w, p) for w, p in via_rule[:10]])
    print("复合样例:", [(w, p) for w, p in via_compound[:10]])
    print("仍缺样例:", left[:12])
    if not write:
        print("(只统计，加 --write 落盘)")
        return 0
    arch = os.path.join(ROOT, "data", "_archive", "dict-phon-rule-%s" % time.strftime("%Y%m%d-%H%M%S"))
    os.makedirs(arch, exist_ok=True)
    shutil.copyfile(DICT, os.path.join(arch, "dict.json"))
    with open(DICT, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print("已写入，备份 %s" % arch)
    return 0


if __name__ == "__main__":
    sys.exit(main())
