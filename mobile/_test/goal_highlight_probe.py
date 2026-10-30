# -*- coding: utf-8 -*-
"""学习目标 → 正文划线口径探针(2026-10-29)。

规则(产品约定):
  已掌握 = 上一个难度及更低的全部词汇 + 最常用基础词(KNOWN_FLOOR 800)
  划线(learn) = 本档新增词:带本档标签、且不带任何更低档标签
  求索 = 只划没进任何分级表(xx/zk/gk/cet4/cet6/ky/toefl/ielts/gre)的词

页面里拿不到内部函数,这里按 app.js 的 headOf/isKnown/isLearning 逐条复算,
再和 DOM 里 .w 的 class 逐词比对。误标/应标未标都必须为 0。

    cd mobile/android/app/src/main/assets/www && python -m http.server 8765
    PYTHONIOENCODING=utf-8 python mobile/_test/goal_highlight_probe.py
"""
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
from cdp import CDP  # noqa: E402

URL = "http://127.0.0.1:8765/index.html"
BLANK = "http://127.0.0.1:8765/app.css"
STORE = "ldleRead.mobile.v1"
DATA = os.path.join(ROOT, "mobile", "android", "app", "src", "main", "assets",
                    "www", "data")

DICT = json.load(open(os.path.join(DATA, "dict.json"), encoding="utf-8"))
LEMMA = json.load(open(os.path.join(DATA, "lemma.json"), encoding="utf-8"))

TIER = ["xx", "zk", "gk", "cet4", "cet6", "ky", "toefl", "ielts", "gre"]
KNOWN_FLOOR = 800
SUFFIXES = [("ies", "y"), ("es", ""), ("s", ""), ("ed", "e"), ("ed", ""), ("d", ""),
            ("ing", "e"), ("ing", ""), ("er", "e"), ("er", ""), ("est", "e"), ("est", "")]
BAD_LEMMA = {"i": "zoning", "s": "yrs", "t": "youngest", "d": "wrought", "r": "younger",
             "feed": "fee", "number": "numb", "does": "doe", "rent": "rend",
             "bit": "bite", "ground": "grind"}
CONTRACT = {
    "don't": "do", "doesn't": "do", "didn't": "do", "can't": "can", "won't": "will",
    "shan't": "shall", "ain't": "be", "mustn't": "must", "needn't": "need",
    "wouldn't": "would", "couldn't": "could", "shouldn't": "should", "isn't": "is",
    "aren't": "are", "wasn't": "was", "weren't": "were", "haven't": "have",
    "hasn't": "have", "hadn't": "have", "i'm": "i", "i've": "i", "i'll": "i",
    "i'd": "i", "you'd": "you", "he'd": "he", "she'd": "she", "it'd": "it",
    "we'd": "we", "they'd": "they", "that'd": "that",
    "it's": "it", "that's": "that", "there's": "there", "he's": "he", "she's": "she",
    "we'll": "we", "they'll": "they", "he'll": "he", "she'll": "she", "it'll": "it",
    "you'll": "you", "that'll": "that", "there'll": "there",
    "we're": "we", "they're": "they", "you're": "you", "let's": "let",
    "there're": "there", "who've": "who", "you've": "you", "we've": "we",
    "they've": "they", "what's": "what", "where's": "where", "when's": "when",
    "why's": "why", "how's": "how", "who's": "who", "could've": "could",
    "would've": "would", "should've": "should", "might've": "might", "must've": "must",
    "who'd": "who", "who'll": "who", "who're": "who",
}
PROPER_RE = re.compile(r"[（(](人名|女子名|男子名|姓氏|地名|国名|城市名|州名|河名|山名|书名|片名|品牌名|公司名|缩写|专名)")
ACC_FOLD = {"æ": "ae", "œ": "oe", "ø": "o", "ß": "ss", "đ": "d", "ð": "d",
            "ł": "l", "þ": "th", "ı": "i"}


def fold_accents(s):
    import unicodedata
    s = unicodedata.normalize("NFD", str(s or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return "".join(ACC_FOLD.get(c, c) for c in s)

TAG_MODES = {
    "xx": [], "zk": ["xx"], "gk": ["xx", "zk"],
    "cet4": ["xx", "zk", "gk"], "cet6": ["xx", "zk", "gk", "cet4"],
    "advanced": ["xx", "zk", "gk", "cet4", "cet6"],
}
GOAL_TIER = {"xx": "xx", "zk": "zk", "gk": "gk", "cet4": "cet4", "cet6": "cet6"}


def stem_variants(w):
    out = []
    for suf, add in SUFFIXES:
        if len(w) > len(suf) and w.endswith(suf) and len(w) - len(suf) >= 3:
            out.append(w[: -len(suf)] + add)
    if len(w) > 4 and w[-1] == w[-2] and w[-1] not in "aeiou":
        out.append(w[:-1])
    return out


def head_of(word):
    key = str(word or "").lower().strip().replace("’", "'")
    if key.endswith("'s"):
        key = key[:-2]
    w = CONTRACT.get(key, key)
    if w not in DICT and w not in LEMMA:
        f = fold_accents(w)
        if f != w:
            w = f
    if w not in DICT:
        if w.endswith("'ll"):
            w = w[:-3]
        elif w.endswith("n't"):
            w = w[:-3]
    bad = BAD_LEMMA.get(w)
    if w in LEMMA and LEMMA[w] != bad:
        return LEMMA[w]
    own = DICT.get(w)
    if own and (own[2] or own[3]):
        return w
    for cand in stem_variants(w):
        c = LEMMA.get(cand, cand)
        e = DICT.get(c)
        if e and (e[2] or e[3]):
            return c
    return w


def tags_of(head):
    v = DICT.get(head)
    return str(v[3] if v else "").split()


def rank_of(head):
    v = DICT.get(head)
    return int(v[2]) if v and v[2] else 0


def is_proper(head):
    v = DICT.get(head)
    return bool(v and PROPER_RE.search(str(v[1])))


def in_table(head, mode):
    cands = [head] + [c for c in stem_variants(head) if c != head]
    mastered = TAG_MODES[mode]
    for c in cands:
        r = rank_of(c)
        if r and r <= KNOWN_FLOOR:
            return True
        for t in tags_of(c):
            if t in mastered:
                return True
    return False


def is_known(word, mode):
    h = head_of(word)
    return is_proper(h) or in_table(h, mode)


def is_learning(word, mode):
    tags = tags_of(head_of(word))
    if mode == "advanced":
        return not any(t in TIER for t in tags)
    want = GOAL_TIER[mode]
    ti = TIER.index(want)
    hit = False
    for t in tags:
        if t not in TIER:
            continue
        k = TIER.index(t)
        if k < ti:
            return False
        if k == ti:
            hit = True
    return hit


def expect_learn(surface, mode):
    if surface[:1].isupper() and len(surface) > 1:
        return None          # app 对句首/大写词一律不标,不做断言
    word = surface.lower()
    if word != surface and False:
        return None
    if is_known(word, mode):
        return False
    return bool(is_learning(word, mode))


FAILS = []
N = [0]


def check(name, ok, detail=""):
    N[0] += 1
    if not ok:
        FAILS.append(name)
    print(("  PASS " if ok else "  FAIL ") + name + (("  " + str(detail)) if detail != "" else ""))


def seed(c, obj):
    c.nav(BLANK)
    time.sleep(.4)
    c.ev("localStorage.clear(); localStorage.setItem(%r,%r)" % (STORE, json.dumps(obj, ensure_ascii=False)))


def boot(c):
    c.nav(URL)
    for _ in range(100):
        if c.ev("!document.querySelector('#app').classList.contains('hidden')"):
            break
        time.sleep(.2)
    time.sleep(.6)


def run_mode(mode, level):
    print("\n== %s（last_level=%d） ==" % (mode, level))
    c = CDP()
    try:
        seed(c, {"version": 4, "settings": {"onboarded": 1, "last_level": level,
                                            "update_freq": "never", "known_mode": mode}})
        boot(c)
        real = c.ev("JSON.parse(localStorage.getItem(%r)).settings.known_mode" % STORE)
        check("目标已生效", real == mode, real)
        ok = c.ev("(function(){var a=document.querySelector('#view .art');if(!a)return false;a.click();return true;})()")
        time.sleep(1.4)
        check("打开文章", ok is True and c.ev("document.body.classList.contains('reader')") is True)
        rows = c.ev("(function(){return [].map.call(document.querySelectorAll('.w'),"
                    "function(e){return [e.getAttribute('data-w'), e.className];});})()")
        learn = set()
        wrong = []
        miss = []
        # app 的横线缓存按小写键存第一次结果:这个词若在文中任何一处是大写
        # (句首 Ambassador),整篇都按不标处理。这里有大小写混用的词不做「应标」断言。
        capset = set(w.lower() for w, _ in rows if w[:1].isupper())
        for w, cls in rows:
            exp = expect_learn(w, mode)
            got = "learn" in (cls or "")
            if exp is None:
                continue
            if exp:
                learn.add(w.lower())
            if got and not exp:
                wrong.append(w)
            if exp and not got and w.lower() not in capset:
                miss.append(w)
        check("划线词无「已掌握」误标", not wrong, wrong[:12])
        check("本档新词都已划线", not miss, miss[:12])
        check("无 JS 异常", c.errors == [], c.errors[-3:])
        print("   划线 %d 个，样例：%s" % (len(learn), sorted(learn)[:10]))
    finally:
        c.close()
        time.sleep(1.2)


def main():
    run_mode("xx", 1)
    run_mode("zk", 2)
    run_mode("gk", 3)
    run_mode("cet4", 4)
    run_mode("cet6", 5)
    run_mode("advanced", 5)
    print("\n断言 %d 条,失败 %d 条" % (N[0], len(FAILS)))
    if FAILS:
        for f in FAILS:
            print("  FAILED:", f)
        sys.exit(1)
    print("ALL GREEN")


if __name__ == "__main__":
    main()
