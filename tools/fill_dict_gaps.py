# -*- coding: utf-8 -*-
"""补齐语料里出现、但词典还查不到的词（2026-10-30）。

三类缺口：
  1. 拼写变体：语料里是 jobseeker / anti-poverty / bo’sun，ECDICT 里是 job seeker / antipoverty / bosun
     —— 按「去掉空格、连字符、撇号」后的紧凑形式找回原文，用它的释义/音标/标签补一条。
  2. 专名：全篇只以大写出现、ECDICT 也没有 → 补「（专名）…」条目，前端 PROPER_RE 认作专名，
     不划线、词卡显示专名，不再落到「该词汇未收录」。
  3. 其余（OCR 乱码、新造词）：只报告，不硬造释义。

用法：
    python tools/fill_dict_gaps.py            # 只报告
    python tools/fill_dict_gaps.py --write    # 落盘（先备份）
"""
import collections
import csv
import json
import os
import re
import shutil
import sys
import time
import unicodedata

from lint_text import clean_phon

csv.field_size_limit(10 ** 7)
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DICT = os.path.join(ROOT, "data", "dict.json")
LEMMA = os.path.join(ROOT, "data", "lemma.json")
CSV_PATH = os.path.join(HERE, "_cache", "ecdict.csv")
ARTS = os.path.join(ROOT, "mobile", "android", "app", "src", "main", "assets",
                    "www", "data", "articles.json")

WORD = re.compile(r"[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]+(?:['’][A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]+)*")
CONTRACT = {
    "don't": "do", "doesn't": "do", "didn't": "do", "can't": "can", "won't": "will",
    "shan't": "shall", "ain't": "be", "mustn't": "must", "needn't": "need",
    "wouldn't": "would", "couldn't": "could", "shouldn't": "should", "isn't": "is",
    "aren't": "are", "wasn't": "was", "weren't": "were", "haven't": "have",
    "hasn't": "have", "hadn't": "have", "i'm": "i", "i've": "i", "i'll": "i",
    "i'd": "i", "you'd": "you", "he'd": "he", "she'd": "she", "it'd": "it",
    "we'd": "we", "they'd": "they", "that'd": "that", "it's": "it",
    "that's": "that", "there's": "there", "he's": "he", "she's": "she",
    "we'll": "we", "they'll": "they", "he'll": "he", "she'll": "she",
    "it'll": "it", "you'll": "you", "that'll": "that", "there'll": "there",
    "we're": "we", "they're": "they", "you're": "you", "let's": "let",
    "there're": "there", "who've": "who", "you've": "you", "we've": "we",
    "they've": "they", "what's": "what", "where's": "where", "when's": "when",
    "why's": "why", "how's": "how", "who's": "who", "could've": "could",
    "would've": "would", "should've": "should", "might've": "might", "must've": "must",
    "who'd": "who", "who'll": "who", "who're": "who",
}
FOLD_EXTRA = str.maketrans({"æ": "ae", "œ": "oe", "ø": "o", "ß": "ss", "đ": "d",
                            "ð": "d", "ł": "l", "þ": "th", "ı": "i"})


def fold_word(w):
    w = unicodedata.normalize("NFD", w.lower())
    w = "".join(c for c in w if not unicodedata.combining(c))
    return w.translate(FOLD_EXTRA)
SUFFIXES = [("ies", "y"), ("es", ""), ("s", ""), ("ed", "e"), ("ed", ""), ("d", ""),
            ("ing", "e"), ("ing", ""), ("er", "e"), ("er", ""), ("est", "e"), ("est", "")]
SIMPLE = re.compile(r"^[a-z][a-z'\- ]*$")


def variants(w):
    out = []
    for suf, add in SUFFIXES:
        if len(w) > len(suf) and w.endswith(suf) and len(w) - len(suf) >= 3:
            out.append(w[:-len(suf)] + add)
    if len(w) > 4 and w[-1] == w[-2] and w[-1] not in "aeiou":
        out.append(w[:-1])
    return out


def compact(w):
    return re.sub(r"[\s'’\-]", "", w.lower())


def head_of(w, d, lemma):
    x = w.lower().replace("’", "'")
    if x.endswith("'s"):
        x = x[:-2]
    x = CONTRACT.get(x, x)
    if x not in d and x not in lemma:
        f = fold_word(x)
        if f != x:
            x = f
    if x in d or x in lemma:
        return lemma.get(x, x)
    for v in variants(x):
        c = lemma.get(v, v)
        if c in d:
            return c
    return x


def corpus_heads(d, lemma):
    arts = json.load(open(ARTS, encoding="utf-8"))["articles"]
    heads = collections.Counter()
    cap = collections.Counter()
    mid = collections.Counter()
    for a in arts:
        for p in a.get("p") or []:
            toks = WORD.findall(p)
            for i, w in enumerate(toks):
                if len(w) < 2:
                    continue
                h = head_of(w, d, lemma)
                heads[h] += 1
                if w[0].isupper():
                    cap[h] += 1
                    if i > 0:
                        mid[h] += 1
    return heads, cap, mid


def ecdict_rows():
    rows = {}
    for row in csv.DictReader(open(CSV_PATH, encoding="utf-8", newline="")):
        w = (row.get("word") or "").strip().lower()
        if not SIMPLE.match(w) or not (row.get("translation") or "").strip():
            continue
        rows.setdefault(compact(w), row)
    return rows


def main():
    write = "--write" in sys.argv
    d = json.load(open(DICT, encoding="utf-8"))
    lemma = json.load(open(LEMMA, encoding="utf-8"))
    heads, cap, mid = corpus_heads(d, lemma)
    missing = [h for h in heads if h not in d]
    rows = ecdict_rows()
    filled_variant = {}
    filled_name = []
    left = []
    for h in missing:
        # 全篇只有大写、且出现在句中(不是句首) → 专名优先。不能先按紧凑形式借 ECDICT:
        # Barbé 会被 compact 借到法语 barbe「胡子」,把专名变成无关义项。
        if cap.get(h, 0) == heads[h] and (heads[h] > 1 or mid.get(h, 0) == heads[h]):
            filled_name.append(h)
            continue
        row = rows.get(compact(h))
        # 命中的行可能正好是同词(bo'sun 在 ECDICT 里有、但构建时被过滤),
        # 也可能是去空格/连字符/撇号后的变体(jobseeker → job seeker),都直接借用。
        if row:
            cn = (row.get("translation") or "").replace("\\r\\n", "\\n").replace("\\r", "\\n")
            cn = re.sub(r"\s+", " ", cn.replace("\\n", " / ")).strip()
            if cn:
                filled_variant[h] = [(clean_phon(row.get("phonetic") or "").strip()), cn,
                                     int(float(row["frq"])) if (row.get("frq") or "").strip()
                                     and float(row.get("frq") or 0) > 0 else 0,
                                     (row.get("tag") or "").strip()]
                continue
        if cap.get(h, 0) == heads[h]:
            filled_name.append(h)
            continue
        left.append((h, heads[h]))
    print("语料词头 %d，缺 %d：变体补 %d，专名补 %d，未补 %d"
          % (len(heads), len(missing), len(filled_variant), len(filled_name), len(left)))
    print("变体样例:", list(filled_variant)[:10])
    print("专名样例:", filled_name[:10])
    print("未补样例:", sorted(left, key=lambda x: -x[1])[:20])
    if not write:
        print("(只报告，加 --write 落盘)")
        return 0
    arch = os.path.join(ROOT, "data", "_archive", "dict-gaps-%s" % time.strftime("%Y%m%d-%H%M%S"))
    os.makedirs(arch, exist_ok=True)
    shutil.copyfile(DICT, os.path.join(arch, "dict.json"))
    for h, idx in filled_variant.items():
        d[h] = idx
    for h in filled_name:
        name = h[:1].upper() + h[1:]
        d[h] = ["", "（专名）人名、地名等专有名词", 0, ""]
    with open(DICT, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print("已写入 %d 条（%d 变体 + %d 专名），备份 %s"
          % (len(filled_variant) + len(filled_name), len(filled_variant), len(filled_name), arch))
    return 0


if __name__ == "__main__":
    sys.exit(main())
