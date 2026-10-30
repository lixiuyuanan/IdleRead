# -*- coding: utf-8 -*-
"""按考纲词表给文章重新定级。

档位(与词表标签一一对应,数字是写回 index.json 的 level):
    2 中考   xx + zk(小学词表已并入,不再单独成档)
    3 高中   + gk
    4 四级   + cet4
    5 六级   + cet6
    6 课外   六级读者仍 >8% 生词

定级规则沿用现有体检分档(合适 ≤3.5% / 吃力 ≤8%):
  - 取「生词率 ≤ 3.5%」的最低一档
  - 各档都不合适、但六级读者 8% 以内 → 六级(能读但吃力)
  - 六级也 >8% → 课外
番外(level 0)和书架(level 90)不动;文章 id 不变,本机进度不受影响。
真题(带 origin 的高考/四级/六级阅读原文)是校验用的真值,保留来源档位,
不写回;报告里给出自动判档与真值的对照。

已知词判定与 app 一致:词频 ≤800 保底 ∪ 累积考纲标签;缩写先还原,
变形先归原形,专有名词不计入生词。

用法:
    python tools/relevel_articles.py            # 生成报告 + relevel.json 草稿
    python tools/relevel_articles.py --write    # 写回 corpus/index.json
"""
import collections
import json
import os
import re
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import audit  # noqa: E402  CONTRACT / IRREG / find_names 与体检保持同一套

DICT_PATH = os.path.join(ROOT, "data", "dict.json")
LEMMA_PATH = os.path.join(ROOT, "data", "lemma.json")
INDEX_PATH = os.path.join(ROOT, "corpus", "index.json")
REPORT_MD = os.path.join(ROOT, "docs", "vocab-level-report.md")
REPORT_CSV = os.path.join(ROOT, "docs", "vocab-level-report.csv")
DRAFT = os.path.join(ROOT, "corpus", "relevel.json")

KNOWN_FLOOR = 800
TIERS = (("zk", "中考", 2), ("gk", "高中", 3),
         ("cet4", "四级", 4), ("cet6", "六级", 5))
BASE_TAGS = ("xx",)          # 小学词表已并入中考,只当前置已知词,不再单独成档
BEYOND = ("beyond", "课外", 6)
FIT, HARD = 0.035, 0.08

SUFFIX = [("ies", "y"), ("ied", "y"), ("es", ""), ("s", ""), ("ing", ""),
          ("ing", "e"), ("ed", ""), ("ed", "e"), ("ly", ""), ("er", ""),
          ("est", "")]


class Vocab:
    def __init__(self):
        with open(DICT_PATH, encoding="utf-8") as f:
            self.data = json.load(f)
        with open(LEMMA_PATH, encoding="utf-8") as f:
            self.lemma = json.load(f)
        self.cum, acc = {}, set()
        for tag in BASE_TAGS:
            acc |= {w for w, v in self.data.items()
                    if tag in str(v[3] or "").split()}
        for tag, _name, _lv in TIERS:
            acc = acc | {w for w, v in self.data.items()
                         if tag in str(v[3] or "").split()}
            self.cum[tag] = frozenset(acc)
        self._head = {}

    def head(self, word):
        w = word.lower().replace("’", "'")
        if w in self._head:
            return self._head[w]
        base = self._head_word(w)
        self._head[w] = base
        return base

    def _head_word(self, w):
        w = re.sub(r"'s$", "", w)
        w = audit.CONTRACT.get(w, w)
        if w not in self.data:
            if w.endswith("'ll"):
                w = w[:-3]
            elif w.endswith("n't"):
                w = w[:-3]
        bad = audit.BAD_LEMMA.get(w)
        if w in self.lemma and self.lemma[w] != bad:
            return self.lemma[w]
        own = self.data.get(w)
        if own and (own[2] or own[3]):
            return w
        for suf, add in SUFFIX:
            if w.endswith(suf) and len(w) > 4:
                c = w[:-len(suf)] + add
                c = self.lemma.get(c, c)
                e = self.data.get(c)
                if e and (e[2] or e[3]):
                    return c
        return w

    def known(self, h, tag):
        """词频保底 ∪ 累积考纲;派生词带自己的词条时再退一步查原形。"""
        for c in [h] + audit.stem_variants(h):
            v = self.data.get(c)
            if v and v[2] and v[2] <= KNOWN_FLOOR:
                return True
            if c in self.cum[tag]:
                return True
        return False


def rates_of(vocab, text):
    text = audit.fold_latin(text)
    names = audit.find_names(text)
    heads = [vocab.head(w) for w in audit.iter_words(text)
             if len(w) >= 2 and w.lower() not in names]
    total = max(len(heads), 1)
    return {tag: sum(1 for h in heads if not vocab.known(h, tag)) / total
            for tag, _n, _l in TIERS}


def assign(rates):
    for tag, name, lv in TIERS:
        if rates[tag] <= FIT:
            return tag, name, lv
    if rates["cet6"] <= HARD:
        return "cet6", "六级", 5
    return BEYOND


def main():
    write = "--write" in sys.argv
    vocab = Vocab()
    with open(INDEX_PATH, encoding="utf-8") as f:
        doc = json.load(f)
    entries = doc["entries"]

    rows, exams, dist = [], [], collections.Counter()
    for e in entries:
        lv = e.get("level")
        if lv in (0, 90):
            continue
        stem = e["stem"]
        path = os.path.join(ROOT, "corpus", e.get("dir", ""), stem + "-en.txt")
        with open(path, encoding="utf-8") as f:
            text = f.read()
        rates = rates_of(vocab, text)
        tag, name, new_lv = assign(rates)
        rec = {
            "stem": stem, "title": e.get("title") or stem, "origin": e.get("origin") or "",
            "old": lv, "tier": name, "level": new_lv,
            "rate_zk": rates["zk"], "rate_gk": rates["gk"],
            "rate_cet4": rates["cet4"], "rate_cet6": rates["cet6"],
            "words": e.get("words") or 0,
        }
        # 真题按来源定级,是校验用的真值;重写会把真值换成待校验的估计值。
        if rec["origin"]:
            exams.append(rec)
            continue
        # 人工指定档位(童书统一放高中)不参与自动重写。
        if e.get("manual"):
            continue
        dist[name] += 1
        rows.append(rec)

    rows.sort(key=lambda r: (r["level"], r["rate_cet6"], r["stem"]))
    exams.sort(key=lambda r: (r["origin"], r["rate_cet6"], r["stem"]))
    order = ["中考", "高中", "四级", "六级", "课外"]
    cross = collections.Counter((r["old"], r["tier"]) for r in rows)
    exported = rows + exams

    os.makedirs(os.path.dirname(REPORT_MD), exist_ok=True)
    with open(REPORT_CSV, "w", encoding="utf-8-sig", newline="") as f:
        f.write("stem,title,origin,old_level,new_tier,new_level,applied,rate_zk,"
                "rate_gk,rate_cet4,rate_cet6,words\n")
        for r in exported:
            f.write('"%s","%s",%s,%s,%s,%s,%d,%.4f,%.4f,%.4f,%.4f,%s\n' % (
                r["stem"], r["title"].replace('"', '""'), r["origin"], r["old"],
                r["tier"], r["level"], 0 if r["origin"] else 1,
                r["rate_zk"], r["rate_gk"],
                r["rate_cet4"], r["rate_cet6"], r["words"]))

    manual_n = sum(1 for e in entries
                   if e.get("manual") and e.get("level") not in (0, 90))
    lines = ["# 按考纲词表重新定级", "",
             "定级规则：生词率 ≤3.5% 的最低档；都不合适但六级 ≤8% 归六级；否则课外。",
             "真题（高考/四级/六级阅读原文）以来源档位为准，不参与重写，只用来校验。",
             "童书 %d 篇按人工指定统一放在高中，不参与自动定级。" % manual_n, "",
             "| 档位 | 篇数 |", "|---|---|"]
    for name in order:
        lines.append("| %s | %d |" % (name, dist[name]))
    lines += ["", "## 原档位 → 新档位", "", "| 原 | 新 | 篇数 |", "|---|---|---|"]
    for (old, new), n in sorted(cross.items(), key=lambda x: (x[0][0], order.index(x[0][1]))):
        lines.append("| %s | %s | %d |" % (old, new, n))

    if exams:
        src = {"gaokao": ("高中", 3), "cet4": ("四级", 4), "cet6": ("六级", 5)}
        lines += ["", "## 真题校验（%d 篇）" % len(exams), "",
                  "| 来源 | 篇数 | 自动判档 | 命中 | 平均生词率 中考/高中/四级/六级 |",
                  "|---|---|---|---|---|"]
        for origin in ("gaokao", "cet4", "cet6"):
            rs = [r for r in exams if r["origin"] == origin]
            if not rs:
                continue
            c = collections.Counter(r["tier"] for r in rs)
            name = src[origin][0]
            hit = c[name] / len(rs)
            means = " / ".join("%.1f%%" % (statistics.mean(r["rate_" + t] for r in rs) * 100)
                               for t in ("zk", "gk", "cet4", "cet6"))
            dists = "、".join("%s %d" % (n, c[n]) for n in order if c[n])
            lines.append("| %s | %d | %s | %.0f%% | %s |"
                         % (origin, len(rs), dists, hit * 100, means))
        lines += ["", "同一口径下，真题的难度排序应为 高考 < 四级 < 六级；"
                      "命中率不足说明自动判档整体偏严（低档真题被判高一档）。"]

    lines += ["", "## 各档文章", ""]
    for name in order:
        lines.append("### %s（%d 篇）" % (name, dist[name]))
        for r in rows:
            if r["tier"] == name:
                lines.append("- `%s` %s（%s 词，原 %s 档，六级生词率 %.1f%%）"
                             % (r["stem"], r["title"], r["words"], r["old"],
                                r["rate_cet6"] * 100))
        lines.append("")
    with open(REPORT_MD, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    draft = {"tiers": {tag: {"name": name, "level": lv}
                       for tag, name, lv in TIERS + (BEYOND,)},
             "levels": {r["stem"]: r["level"] for r in rows}}
    with open(DRAFT, "w", encoding="utf-8") as f:
        json.dump(draft, f, ensure_ascii=False, indent=1)

    print("重定级分布:", dict((n, dist[n]) for n in order))
    print("真题校验:", dict((o, sum(1 for r in exams if r["origin"] == o))
                        for o in ("gaokao", "cet4", "cet6")))
    print("报告:", REPORT_MD)
    print("明细:", REPORT_CSV)
    print("草稿:", DRAFT)

    if write:
        for e in entries:
            new = draft["levels"].get(e["stem"])
            if new is not None:
                e["level"] = new
        with open(INDEX_PATH, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=1)
        print("已写回", INDEX_PATH)
    else:
        print("(草稿未应用,确认后加 --write)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
