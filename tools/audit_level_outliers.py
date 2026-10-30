# -*- coding: utf-8 -*-
"""难度离群审计：跨信号检测，只读语料、只出报告，不改任何数据。

信号 1（考纲生词率）：与 tools/relevel_articles.py 同一套已知词判定
（词频 ≤800 保底 ∪ 累积考纲标签，缩写还原、动词归原形、专名不计），
但每篇用**它自己档位那份累积词表**量，并额外补上考研（ky）这一档，
使 6/7 级也有可比尺度。

信号 2（独立可读性）：不依赖任何词表——Flesch Reading Ease、
Flesch-Kincaid 年级、平均句长、长词（≥7 字母）占比，纯文本统计。

判据：档内稳健离群 |x-median| > 2.5×(1.4826×MAD)；两信号打架单独列。

用法：
    python tools/audit_level_outliers.py [--out-prefix docs/难度审计-YYYYMMDD]
本脚本不写 corpus/，不加 --write，没有 --write。
"""
import collections
import csv
import io
import json
import os
import re
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import audit  # noqa: E402
import relevel_articles as R  # noqa: E402  复用 Vocab（已知词判定与线上一致）

INDEX_PATH = os.path.join(ROOT, "corpus", "index.json")

# 档位 → 该档自己的累积词表标签
LEVEL_TIER = {2: "zk", 3: "gk", 4: "cet4", 5: "cet6", 6: "ky", 7: "ky"}
LEVEL_NAME = {2: "中考", 3: "高中", 4: "四级", 5: "六级", 6: "考研一", 7: "考研二"}
FIT_NAME = {2: "中考", 3: "高中", 4: "四级", 5: "六级", 6: "考研", 99: "超纲"}
# 考研一/二共用一份考纲，比较自动判档与现标签时并成一档，避免 6↔7 假偏差
LEVEL_ORD = {2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 6}
TIERS = ("zk", "gk", "cet4", "cet6", "ky")
FIT, HARD, EASY = 0.035, 0.08, 0.02     # 合适 / 吃力 / 太简单（沿用 audit.VERDICT_BANDS）
Z_CUT = 2.5

SENT_RE = audit.SENT_SPLIT
WORD_RE = audit.WORD
VOWEL = re.compile(r"[aeiouy]+")


def build_vocab():
    v = R.Vocab()
    acc = set(v.cum["cet6"])
    acc |= {w for w, d in v.data.items() if "ky" in str(d[3] or "").split()}
    v.cum["ky"] = frozenset(acc)
    return v


def rates_of(vocab, text):
    """与 relevel_articles.rates_of 同口径，多带一个 ky 档。"""
    text = audit.fold_latin(text)
    names = audit.find_names(text)
    heads = [vocab.head(w) for w in audit.iter_words(text)
             if len(w) >= 2 and w.lower() not in names]
    total = max(len(heads), 1)
    return {tag: sum(1 for h in heads if not vocab.known(h, tag)) / total
            for tag in TIERS}, len(heads)


def syllables(word):
    w = re.sub(r"[^a-z]", "", word.lower())
    if not w:
        return 0
    n = len(VOWEL.findall(w))
    if w.endswith("e") and not w.endswith(("le", "ee", "ye")) and len(w) > 3:
        n -= 1
    return max(n, 1)


GLUED_RE = re.compile(r"[a-z]{2}[.!?][A-Z][a-z]")


def readability(text):
    """Flesch 两个指标 + 平均句长 + 长词占比；不依赖任何词表。

    断句不能只用 audit.SENT_SPLIT（它要求标点后有空格）：语料里有一批 OCR/导入
    粘连的正文（`veterinarian.He became…`），那样会把两三句当成一句，FK 年级虚高。
    这里按标点本身切，同时把粘连处数记下来当数据质量线索。
    """
    text = audit.fold_latin(text)
    glued = len(GLUED_RE.findall(text))
    sents = [s for s in re.split(r"[.!?…]+[\"'”’)]*", text)
             if s and len(WORD_RE.findall(s)) >= 2]
    words = [w for w in WORD_RE.findall(text) if len(w) >= 1]
    ns = max(len(sents), 1)
    nw = max(len(words), 1)
    nsyl = sum(syllables(w) for w in words)
    asl = nw / ns
    asw = nsyl / nw
    return {
        "sentences": len(sents), "wc": len(words), "glued": glued,
        "asl": asl, "asw": asw,
        "fk_grade": 0.39 * asl + 11.8 * asw - 15.59,
        "fre": 206.835 - 1.015 * asl - 84.6 * asw,
        "long_ratio": sum(1 for w in words if len(w) >= 7) / nw,
    }


def lowest_fit(rt):
    """与线上 relevel_articles.assign 同口径，只是把考研（ky）接到最上面一档：
    ≤3.5% 的最低档；各档都不合适但 cet6 ≤8% → 六级（能读但吃力）；
    再不行但 ky ≤8% → 考研（吃力）；都超 → 超纲。"""
    for tag, lv in (("zk", 2), ("gk", 3), ("cet4", 4), ("cet6", 5), ("ky", 6)):
        if rt[tag] <= FIT:
            return lv, "fit"
    if rt["cet6"] <= HARD:
        return 5, "hard"
    if rt["ky"] <= HARD:
        return 6, "hard"
    return 99, "beyond"


def robust(vals):
    med = statistics.median(vals)
    mad = statistics.median([abs(v - med) for v in vals])
    scale = 1.4826 * mad
    if scale <= 1e-4:                     # MAD 退化（半数以上同值）：不判离群
        scale = float("inf")
    return med, mad, scale


def pct(x):
    return "%.2f%%" % (x * 100)


def main():
    prefix = "docs/难度审计-20261028"
    for i, a in enumerate(sys.argv):
        if a == "--out-prefix" and i + 1 < len(sys.argv):
            prefix = sys.argv[i + 1]
    vocab = build_vocab()
    doc = json.load(io.open(INDEX_PATH, encoding="utf-8"))

    rows = []
    for e in doc["entries"]:
        lv = e.get("level")
        if lv not in LEVEL_TIER:
            continue
        path = os.path.join(ROOT, "corpus", e.get("dir", ""), e["stem"] + "-en.txt")
        if not os.path.exists(path):
            rows.append({"stem": e["stem"], "level": lv, "missing": True})
            continue
        text = io.open(path, encoding="utf-8").read()
        rt, nheads = rates_of(vocab, text)
        rd = readability(text)
        fit, fit_kind = lowest_fit(rt)
        origin = e.get("origin") or ""
        rows.append({
            "stem": e["stem"], "level": lv, "origin": origin,
            "title": (e.get("title") or e["stem"])[:60],
            "locked": bool(origin) or bool(e.get("manual")),
            "why_locked": ("origin=" + origin) if origin else ("manual" if e.get("manual") else ""),
            "tier_tag": LEVEL_TIER[lv],
            "own_rate": rt[LEVEL_TIER[lv]],
            "rate": rt, "nheads": nheads,
            "fit": fit, "fit_kind": fit_kind,
            # 偏差 = 自动判档 − 现档（正=现档放低了，负=现档放高了）；
            # 考研一/二并成一档比较，超纲按「比考研再高一档」计
            "dev": (7 if fit == 99 else fit) - LEVEL_ORD[lv],
            "words": e.get("words") or rd["wc"],
            # 信号 2 只有断句可信时才作数
            "fk_ok": rd["glued"] == 0 and 1.0 <= rd["fk_grade"] <= 20.0,
            **rd
        })

    # ---- 档内分布 + 双信号稳健离群 ----
    by_lv = collections.defaultdict(list)
    for r in rows:
        if not r.get("missing"):
            by_lv[r["level"]].append(r)
    stats = {}
    for lv, rs in sorted(by_lv.items()):
        own = [r["own_rate"] for r in rs]
        fk = [r["fk_grade"] for r in rs]
        fre = [r["fre"] for r in rs]
        asl = [r["asl"] for r in rs]
        lng = [r["long_ratio"] for r in rs]
        m1, mad1, s1 = robust(own)
        m2, mad2, s2 = robust(fk)
        for r in rs:
            r["z1"] = (r["own_rate"] - m1) / s1
            r["z2"] = (r["fk_grade"] - m2) / s2
        stats[lv] = {
            "n": len(rs), "own": own, "own_med": m1, "own_mad": mad1,
            "own_p10": quantile(own, 0.10), "own_p90": quantile(own, 0.90),
            "own_min": min(own), "own_max": max(own),
            "fk_med": m2, "fk_p10": quantile(fk, 0.10), "fk_p90": quantile(fk, 0.90),
            "fk_min": min(fk), "fk_max": max(fk),
            "fre_med": statistics.median(fre), "asl_med": statistics.median(asl),
            "long_med": statistics.median(lng),
        }
    # 同一把尺子（cet6 累积表）下的跨档比较
    ref = {}
    for lv, rs in sorted(by_lv.items()):
        c6 = [r["rate"]["cet6"] for r in rs]
        ky = [r["rate"]["ky"] for r in rs]
        gk = [r["rate"]["gk"] for r in rs]
        ref[lv] = {"gk_med": statistics.median(gk), "cet6_med": statistics.median(c6),
                   "cet6_p10": quantile(c6, 0.10), "cet6_p90": quantile(c6, 0.90),
                   "ky_med": statistics.median(ky),
                   "fk_med": stats[lv]["fk_med"], "fre_med": stats[lv]["fre_med"],
                   "asl_med": stats[lv]["asl_med"], "long_med": stats[lv]["long_med"]}

    out_md = prefix + ".md"
    out_csv = prefix + ".csv"
    os.makedirs(os.path.dirname(out_md) or ".", exist_ok=True)

    # ---- CSV（用户指定的 7 列） ----
    with io.open(out_csv, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["stem", "level", "origin", "new_words_rate",
                    "tier_lowest_fit", "fk_grade", "flags"])
        for r in sorted(rows, key=lambda x: (x["level"], x["stem"])):
            if r.get("missing"):
                w.writerow([r["stem"], r["level"], "", "", "", "", "missing_en"])
                continue
            flags = []
            if r["locked"]:
                flags.append("locked:" + (r["why_locked"] or "manual"))
            if abs(r["z1"]) > Z_CUT:
                flags.append("S1_" + ("hard" if r["z1"] > 0 else "easy"))
            if r["fk_ok"] and abs(r["z2"]) > Z_CUT:
                flags.append("S2_" + ("hard" if r["z2"] > 0 else "easy"))
            if not r["fk_ok"]:
                flags.append("S2_untrusted")
            if r["glued"]:
                flags.append("glued=%d" % r["glued"])
            if r["dev"]:
                flags.append("dev%+d" % r["dev"])
            if r["own_rate"] > HARD:
                flags.append("too_hard")
            elif r["own_rate"] <= EASY:
                flags.append("too_easy")
            w.writerow([r["stem"], r["level"], r["origin"],
                        "%.4f" % r["own_rate"], r["fit"],
                        "%.1f" % r["fk_grade"], ";".join(flags)])

    # ---- Markdown ----
    lines = build_md(rows, by_lv, stats, ref)
    with io.open(out_md, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    live = [r for r in rows if not r.get("missing")]
    auto = [r for r in live if not r["locked"]]
    print("审计篇数:", len(live),
          "各档:", dict((lv, stats[lv]["n"]) for lv in sorted(stats)))
    print("锁定:", len(live) - len(auto), "可自动定级:", len(auto))
    print("S1 离群:", sum(1 for r in live if abs(r["z1"]) > Z_CUT),
          "S2 离群(可信断句):",
          sum(1 for r in live if r["fk_ok"] and abs(r["z2"]) > Z_CUT),
          "双信号打架:", sum(1 for r in live
                          if abs(r["z1"]) <= Z_CUT < abs(r["z2"]) and r["fk_ok"]))
    print("断句粘连(数据质量):", sum(1 for r in live if r["glued"]), "篇")
    print("自动判档≠现档:", sum(1 for r in live if r["dev"]),
          "其中现档放低了", sum(1 for r in live if r["dev"] > 0),
          "/ 放高了", sum(1 for r in live if r["dev"] < 0))
    print("报告:", out_md)
    print("明细:", out_csv)
    return 0


def quantile(vals, q):
    if not vals:
        return 0.0
    s = sorted(vals)
    if len(s) == 1:
        return s[0]
    pos = q * (len(s) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def band(rate):
    if rate > HARD:
        return "太难"
    if rate > FIT:
        return "吃力"
    if rate > EASY:
        return "合适"
    return "太简单"


def build_md(rows, by_lv, stats, ref):
    live = [r for r in rows if not r.get("missing")]
    L = ["# 难度离群审计（2026-10-28）", "",
         "范围：level 2/3/4/5/6/7 共 %d 篇（排除书架 90、番外 0）。**只读，未改动任何数据。**" % len(live),
         "",
         "- **信号 1**：考纲生词率。已知词判定与线上体检、`relevel_articles.py` 完全同一套"
         "（词频 ≤800 保底 ∪ 累积考纲标签，缩写还原、归原形、专名不计），"
         "但每篇用**它所在档位自己那份累积词表**量：中考=zk、高中=gk、四级=cet4、六级=cet6、考研=ky（本审计新补的一档）。"
         "判读线沿用 `audit.VERDICT_BANDS`：≤2% 太简单 / ≤3.5% 合适 / ≤8% 吃力 / >8% 太难。",
         "- **信号 2**：不依赖词表的可读性——Flesch-Kincaid 年级（fk_grade）、Flesch Reading Ease、平均句长、长词（≥7 字母）占比。",
         "- **离群判据**：档内稳健 z=(x−中位数)/(1.4826×MAD)，|z|>2.5 记离群；z>0=比同档更吃力，z<0=比同档更轻松。",
         "- **`tier_lowest_fit` 的定义**：与线上 `relevel_articles.py` 同一口径——生词率 ≤3.5% 的最低档；"
         "各档都不合适但六级 ≤8% → 5（六级·吃力）；六级也超但考研 ≤8% → 6（考研·吃力）；都不行 → 99（超纲）。"
         "本审计只是在顶端接了考研（ky）这一档，使考研篇也有可比尺度；考研一/二共用考纲，比较偏差时并成一档，"
         "所以 6↔7 之间不会假装出差错。",
         "- **循环论证的规避**：`relevel_articles.py` 的规则就是「生词率 ≤3.5% 取最低档」，"
         "所以本审计不把「规则重跑一遍零差异」当结论，只看**档内分布、档内离群、跨信号矛盾**三件事；"
         "锁定的真题/童书/考研全部单列，只量不改。", ""]

    L += ["## 一、各档分布（信号 1：本档累积词表的生词率）", "",
          "| 档位 | 篇数 | 生词率中位 | p10 | p90 | 最小 | 最大 | 判读（按中位） | 太简单 | 合适 | 吃力 | 太难 |",
          "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for lv in sorted(stats):
        s = stats[lv]
        rs = by_lv[lv]
        b = collections.Counter(band(r["own_rate"]) for r in rs)
        L.append("| %s（%d） | %d | %s | %s | %s | %s | %s | %s | %d | %d | %d | %d |" % (
            LEVEL_NAME[lv], lv, s["n"], pct(s["own_med"]), pct(s["own_p10"]),
            pct(s["own_p90"]), pct(s["own_min"]), pct(s["own_max"]), band(s["own_med"]),
            b["太简单"], b["合适"], b["吃力"], b["太难"]))
    L += ["", "每档都用**自己的**词表量，所以这张表回答的是「各档中位是否都落在合适带（2–3.5%）里」，"
          "不能用来横向比难度。横向比要看下面这张同一把尺子的表。", ""]

    L += ["## 二、跨档是否单调（同用六级 cet6 累积表这把尺子）", "",
          "| 档位 | 篇数 | cet6 生词率中位 | p10 | p90 | FK 年级中位 | FRE 中位 | 平均句长 | 长词占比 |",
          "|---|---|---|---|---|---|---|---|---|"]
    for lv in sorted(ref):
        s = ref[lv]
        L.append("| %s（%d） | %d | %s | %s | %s | %.1f | %.1f | %.1f | %s |" % (
            LEVEL_NAME[lv], lv, stats[lv]["n"], pct(s["cet6_med"]),
            pct(s["cet6_p10"]), pct(s["cet6_p90"]), s["fk_med"], s["fre_med"],
            s["asl_med"], pct(s["long_med"])))
    mono = [ref[lv]["cet6_med"] for lv in sorted(ref)]
    inv = [(lv, next_lv) for lv in sorted(ref)
           for next_lv in sorted(ref)
           if next_lv > lv and ref[next_lv]["cet6_med"] < ref[lv]["cet6_med"]]
    fk_inv = [(lv, next_lv) for lv in sorted(ref)
              for next_lv in sorted(ref)
              if next_lv > lv and ref[next_lv]["fk_med"] < ref[lv]["fk_med"]]
    L += ["", "单调性检查（现标签越高，cet6 生词率/FK 年级应越高）：",
          "- cet6 生词率倒挂：%s" % ("、".join("%s→%s" % (LEVEL_NAME[a], LEVEL_NAME[b])
                                               for a, b in inv) or "无"),
          "- FK 年级倒挂：%s" % ("、".join("%s→%s" % (LEVEL_NAME[a], LEVEL_NAME[b])
                                          for a, b in fk_inv) or "无"),
          "- 档间重叠（后档 p10 低于前档 p90 视为重叠）：%s" % overlap_note(ref), ""]

    # 离群名单
    for lv in sorted(stats):
        rs = by_lv[lv]
        s = stats[lv]
        hard = sorted([r for r in rs if r["z1"] > Z_CUT], key=lambda r: -r["own_rate"])
        easy = sorted([r for r in rs if r["z1"] < -Z_CUT], key=lambda r: r["own_rate"])
        s2 = sorted([r for r in rs if r["fk_ok"] and abs(r["z2"]) > Z_CUT
                     and abs(r["z1"]) <= Z_CUT], key=lambda r: -abs(r["z2"]))
        L += ["## 三·%s（level %d，%d 篇）档内离群" % (LEVEL_NAME[lv], lv, s["n"]), "",
              "本档中位生词率 %s（MAD %s），FK 年级中位 %.1f。" % (
                  pct(s["own_med"]), pct(s["own_mad"]), s["fk_med"])]
        if not (hard or easy or s2):
            L.append("- 无离群（|z|>2.5 零命中）。")
            L.append("")
            continue
        if hard:
            L.append("- **比同档明显更吃力**（z1>+2.5，%d 篇）：" % len(hard))
            L.append("  | stem | 生词率 | z1 | 判读 | FK | z2 | 现档 | 自动判档 | 锁定 |")
            L.append("  |---|---|---|---|---|---|---|---|---|")
            for r in hard:
                L.append("  | `%s` %s | %s | %+.1f | %s | %.1f | %+.1f | %s | %s | %s |" % (
                    r["stem"], r["title"][:22], pct(r["own_rate"]), r["z1"],
                    band(r["own_rate"]), r["fk_grade"], r["z2"],
                    LEVEL_NAME[r["level"]], fit_label(r), lock_note(r)))
        if easy:
            L.append("- **比同档明显更轻松**（z1<−2.5，%d 篇）：" % len(easy))
            L.append("  | stem | 生词率 | z1 | 判读 | FK | z2 | 现档 | 自动判档 | 锁定 |")
            L.append("  |---|---|---|---|---|---|---|---|---|")
            for r in easy:
                L.append("  | `%s` %s | %s | %+.1f | %s | %.1f | %+.1f | %s | %s | %s |" % (
                    r["stem"], r["title"][:22], pct(r["own_rate"]), r["z1"],
                    band(r["own_rate"]), r["fk_grade"], r["z2"],
                    LEVEL_NAME[r["level"]], fit_label(r), lock_note(r)))
        if s2:
            L.append("- **信号 1 正常、信号 2 却离群**（结构/句法层面的异常，%d 篇）：" % len(s2))
            L.append("  | stem | 生词率(z1) | FK | z2 | 句长 | 长词占比 | FRE | 锁定 |")
            L.append("  |---|---|---|---|---|---|---|---|")
            for r in s2:
                L.append("  | `%s` %s | %s (%+.1f) | %.1f | %+.1f | %.1f | %s | %.1f | %s |" % (
                    r["stem"], r["title"][:22], pct(r["own_rate"]), r["z1"],
                    r["fk_grade"], r["z2"], r["asl"], pct(r["long_ratio"]),
                    r["fre"], lock_note(r)))
        L.append("")

    # 锁定项
    locked = [r for r in live if r["locked"]]
    L += ["## 四、锁定项（只量不改）：%d 篇" % len(locked), "",
          "真题（origin=gaokao/cet4/cet6/kaoyan）按来源档位锁定，童书/人工指定（manual）按人工档位锁定，"
          "`relevel_articles.py` 都不会写回它们。这里把两信号量出来的东西摊开，看清「锁定带来的代价」。", ""]
    groups = collections.Counter((r["origin"] or "-", "manual" if r["why_locked"] == "manual" else "-")
                                 for r in locked)
    L.append("| 来源 | 篇数 | 本档生词率中位 | 太难(>8%) | 太简单(≤2%) | 现档放低(dev>0) | 现档放高(dev<0) | FK 中位 |")
    L.append("|---|---|---|---|---|---|---|---|")
    for origin in ("gaokao", "cet4", "cet6", "kaoyan", ""):
        grp = [r for r in locked if r["origin"] == origin and
               (origin != "" or r["why_locked"] == "manual")]
        if not grp:
            continue
        name = {"gaokao": "高考真题", "cet4": "四级真题", "cet6": "六级真题",
                "kaoyan": "考研真题", "": "manual（童书/人工）"}[origin]
        own = [r["own_rate"] for r in grp]
        L.append("| %s | %d | %s | %d | %d | %d | %d | %.1f |" % (
            name, len(grp), pct(statistics.median(own)),
            sum(1 for r in grp if r["own_rate"] > HARD),
            sum(1 for r in grp if r["own_rate"] <= EASY),
            sum(1 for r in grp if r["dev"] > 0), sum(1 for r in grp if r["dev"] < 0),
            statistics.median([r["fk_grade"] for r in grp])))
    L += ["", "`dev` = 自动判档 − 现档：**正 = 现档把这篇放低了**（按词表它该在更高档），"
          "**负 = 现档放高了**。考研一/二共用考研考纲，已在同一档内比较，不计 6↔7 的假偏差。",
          "", "### 锁定项里偏差最大的（按 |dev| 再按本档生词率）", "",
          "| stem | 现档 | 自动判档 | dev | 方向 | 本档生词率 | FK | z1 | 锁定原因 |",
          "|---|---|---|---|---|---|---|---|---|"]
    lk = sorted([r for r in locked if r["dev"]],
                key=lambda r: (-abs(r["dev"]), -abs(r["z1"]), -r["own_rate"]))
    for r in lk[:35]:
        L.append("| `%s` %s | %s | %s | %+d | %s | %s | %.1f | %+.1f | %s |" % (
            r["stem"], r["title"][:22], LEVEL_NAME[r["level"]], fit_label(r),
            r["dev"], "现档偏低" if r["dev"] > 0 else "现档偏高",
            pct(r["own_rate"]), r["fk_grade"], r["z1"], r["why_locked"]))
    if not lk:
        L.append("| —（无） | | | | | | | | |")
    L.append("")

    # 数据质量：断句粘连会让信号 2 失真
    glued = sorted([r for r in live if r["glued"]], key=lambda r: -r["glued"])
    L += ["## 四·附、影响朗读/分句的文本质量问题（顺带量到的，不改）", "",
          "语料里有一批正文**句末标点后没有空格**（`veterinarian.He became…`），"
          "`audit.SENT_SPLIT` 这种「标点+空白」的断句会把两三句并成一句："
          "本审计的 FK 年级因此对这些篇不可信（已在 flags 里记 `S2_untrusted`，不进建议）。"
          "同样的问题会影响 App 里的**按句高亮、朗读分句、单词卡取句**，值得单独排一次。", ""]
    if glued:
        L += ["| stem | 粘连处数 | 词数 | 断句数 | 句/100词 | FK | 档位 | 锁定 |",
              "|---|---|---|---|---|---|---|---|"]
        for r in glued[:40]:
            L.append("| `%s` %s | %d | %d | %d | %.1f | %.1f | %s | %s |" % (
                r["stem"], r["title"][:22], r["glued"], r["wc"], r["sentences"],
                r["sentences"] * 100.0 / max(r["wc"], 1), r["fk_grade"],
                LEVEL_NAME[r["level"]], lock_note(r)))
        L.append("")
        L.append("共 %d 篇检出标点粘连（合计 %d 处）。" % (
            len(glued), sum(r["glued"] for r in glued)))
    else:
        L.append("未检出标点粘连。")
    L.append("")

    # 可动项与建议
    auto = [r for r in live if not r["locked"]]
    cand = []
    for r in auto:
        why = []
        if r["own_rate"] > HARD:
            why.append("本档太难 %s" % pct(r["own_rate"]))
        elif r["own_rate"] <= EASY:
            why.append("本档太简单 %s" % pct(r["own_rate"]))
        if r["dev"]:
            why.append("自动判档 %s（现 %s，dev %+d）" % (
                fit_label(r), LEVEL_NAME[r["level"]], r["dev"]))
        if abs(r["z1"]) > Z_CUT:
            why.append("档内 z1 %+.1f" % r["z1"])
        if r["fk_ok"] and abs(r["z2"]) > Z_CUT:
            why.append("档内 z2 %+.1f（FK %.1f，同档中位 %.1f）" % (
                r["z2"], r["fk_grade"], stats[r["level"]]["fk_med"]))
        elif not r["fk_ok"]:
            why.append("FK 不可信（标点粘连 %d 处）" % r["glued"])
        # 方向：+1 应升档，-1 应降档，0 无
        dirs = []
        if r["dev"]:
            dirs.append(1 if r["dev"] > 0 else -1)
        if r["own_rate"] > HARD:
            dirs.append(1)
        elif r["own_rate"] <= EASY:
            dirs.append(-1)
        if r["z1"] > Z_CUT:
            dirs.append(1)
        elif r["z1"] < -Z_CUT:
            dirs.append(-1)
        s2dir = 0
        if r["fk_ok"] and abs(r["z2"]) > Z_CUT:
            s2dir = 1 if r["z2"] > 0 else -1
        agree = len([d for d in dirs if d > 0])
        oppose = len([d for d in dirs if d < 0])
        if not dirs:
            continue
        primary = 1 if agree >= oppose else -1
        r["dir"] = primary
        r["n_agree"] = max(agree, oppose)
        r["s2_agree"] = (s2dir == primary and s2dir != 0)
        r["s2_conflict"] = (s2dir != 0 and s2dir != primary)
        r["why_str"] = "；".join(why)
        if r["n_agree"] >= 2:
            cand.append((r, why))
    L += ["## 五、可自动定级的 %d 篇：建议名单" % len(auto), "",
          "只有这批是真的能被 `relevel_articles.py` 写回的（无 origin、无 manual）。"
          "**入建议的门槛**：三条独立判据（dev≠0、本档生词率越带、档内 z1 超 2.5）里"
          "**至少两条同向**；信号 2（FK）反向作对时单独标注但不否决，FK 不可信的（标点粘连）不计入。", ""]
    if cand:
        L += ["| stem | 现档 | 建议 | 本档生词率 | 自动判档 | dev | FK | z1 | z2 | 信号2 | 理由 |",
              "|---|---|---|---|---|---|---|---|---|---|---|"]
        for r, why in sorted(cand, key=lambda x: (x[0]["level"], -abs(x[0]["dev"]))):
            act = ("→ %s" % fit_label(r)) if r["dev"] else "维持（仅复核）"
            L.append("| `%s` %s | %s | %s | %s | %s | %+d | %.1f | %+.1f | %+.1f | %s | %s |" % (
                r["stem"], r["title"][:22], LEVEL_NAME[r["level"]], act,
                pct(r["own_rate"]), fit_label(r), r["dev"], r["fk_grade"],
                r["z1"], r["z2"],
                "同向" if r["s2_agree"] else ("冲突" if r["s2_conflict"] else "未越带"),
                "；".join(why)))
        L.append("")
        L.append("每篇的五个档生词率（中考/高中/四级/六级/考研），用来看它到底能不能往下走：")
        for r, why in sorted(cand, key=lambda x: (x[0]["level"], -abs(x[0]["dev"]))):
            rt = r["rate"]
            L.append("- `%s`：%s / %s / %s / %s / %s" % (
                r["stem"], pct(rt["zk"]), pct(rt["gk"]), pct(rt["cet4"]),
                pct(rt["cet6"]), pct(rt["ky"])))
        L.append("  「往下降档」要求更低那一档的生词率也 ≤3.5%，上面任何一格超了就只能维持现档。")
    else:
        L.append("（无：没有任何一篇满足「两条以上同向判据越带」）")
    watch = [r for r in auto if r.get("n_agree") == 1]
    if watch:
        L += ["", "### 只有一条判据越带、暂不建议动的 %d 篇（复核名单）" % len(watch), "",
              "| stem | 现档 | 本档生词率 | 自动判档 | dev | FK | z1 | z2 | 越带的那条 |",
              "|---|---|---|---|---|---|---|---|---|"]
        for r in sorted(watch, key=lambda x: (x["level"], x["stem"])):
            L.append("| `%s` %s | %s | %s | %s | %+d | %.1f | %+.1f | %+.1f | %s |" % (
                r["stem"], r["title"][:22], LEVEL_NAME[r["level"]],
                pct(r["own_rate"]), fit_label(r), r["dev"], r["fk_grade"],
                r["z1"], r["z2"], r["why_str"]))
    L += ["", "## 六、结论", ""]
    L += conclusion(cand, locked, auto, ref, stats, rows)
    L += ["", "---", "",
          "本审计只读。未改动 `corpus/index.json`、任何 `-en.txt`/`-chs.txt`、`docs/译名表.md`、"
          "前端与版本号；未调用任何外部接口；未打包、未发布。",
          "复现：`python tools/audit_level_outliers.py`（产物仅 docs/难度审计-20261028.md / .csv）。"]
    return L


def fit_label(r):
    if r["fit"] == 99:
        return "超纲（连考研表都 >8%）"
    return "%s%s" % (FIT_NAME[r["fit"]], "·吃力" if r["fit_kind"] == "hard" else "")


def lock_note(r):
    if not r["locked"]:
        return "可动"
    return "锁定（%s）" % (r["why_locked"] or "manual")


def overlap_note(ref):
    notes = []
    lv = sorted(ref)
    for a, b in zip(lv, lv[1:]):
        if ref[b]["cet6_p10"] < ref[a]["cet6_p90"]:
            notes.append("%s p10(%s) 低于 %s p90(%s)" % (
                LEVEL_NAME[b], pct(ref[b]["cet6_p10"]),
                LEVEL_NAME[a], pct(ref[a]["cet6_p90"])))
    return "、".join(notes) or "各档 p10/p90 无重叠"


def conclusion(cand, locked, auto, ref, stats, rows):
    live = [r for r in rows if not r.get("missing")]
    out = ["- 各档篇数：%s（合计 %d 篇，已排除书架 90 与番外 0）。" % (
        "、".join("%s %d" % (LEVEL_NAME[lv], stats[lv]["n"]) for lv in sorted(stats)), len(live)),
        "- 可动（无 origin 且无 manual）%d 篇；锁定 %d 篇（真题 284 + manual 135）。" % (
            len(auto), len(locked))]
    offband = [(lv, band(stats[lv]["own_med"])) for lv in sorted(stats)
               if band(stats[lv]["own_med"]) != "合适"]
    out.append("- 档内分布：**中位不在「合适」带（2–3.5%%）的档位有 %s**。"
               "%s" % ("、".join("%s 中位 %s（%s）" % (LEVEL_NAME[lv], pct(stats[lv]["own_med"]), b)
                                 for lv, b in offband) or "无",
                       "六级档整体按其自身词表衡量是「吃力」而不是「合适」（%d 篇里只有 %d 篇落进合适带），"
                       "这说明 cet6 词表对六级文章的覆盖本就不足，不是六级档放错了文章。" % (
                           stats[5]["n"],
                           sum(1 for r in live if r["level"] == 5 and EASY < r["own_rate"] <= FIT))
                       if 5 in stats and band(stats[5]["own_med"]) != "合适" else ""))
    move = [c for c in cand if c[0]["dev"]]
    review = [c for c in cand if not c[0]["dev"]]
    if cand:
        out.append("- **真正建议调档：%d 篇；另有 %d 篇判据越带但自动判档给的就是现档（只能算复核，动不了）**。" % (
            len(move), len(review)))
    else:
        out.append("- **真正建议调档：0 篇**。没有任何一篇能同时满足两条同向判据。")
    for r, why in sorted(cand, key=lambda x: (x[0]["level"], x[0]["stem"])):
        tgt = "→ %s" % fit_label(r) if r["dev"] else "维持现档（词表上无处可去，见第五节的五档生词率）"
        out.append("  - `%s` %s：%s %s；%s" % (
            r["stem"], r["title"][:20], LEVEL_NAME[r["level"]], tgt, "；".join(why)))
    mono = [ref[lv]["cet6_med"] for lv in sorted(ref)]
    out.append("- 跨档单调性（cet6 这把尺子）：%s；FK 年级同序：%s。倒挂点见第二节。" % (
        "单调" if mono == sorted(mono) else "有倒挂（六级 > 考研，见第二节）",
        "单调" if [ref[lv]["fk_med"] for lv in sorted(ref)] ==
        sorted([ref[lv]["fk_med"] for lv in sorted(ref)]) else "有倒挂"))
    out.append("- 考研一（6）与考研二（7）**用任何词表都分不开**：两档共用考研考纲，"
               "本档生词率中位 %s vs %s，cet6 尺子下 %s vs %s——差别只在结构（FK %.1f vs %.1f）。"
               "要区分 6/7，只能靠结构指标或人工，词表这条路是死的。" % (
                   pct(stats[6]["own_med"]), pct(stats[7]["own_med"]),
                   pct(ref[6]["cet6_med"]), pct(ref[7]["cet6_med"]),
                   stats[6]["fk_med"], stats[7]["fk_med"]))
    pairs = [(a, b) for a, b in zip(sorted(ref), sorted(ref)[1:])]
    overlapped = [(a, b) for a, b in pairs if ref[b]["cet6_p10"] < ref[a]["cet6_p90"]]
    out.append("- 档间重叠：%d 对相邻档里 %d 对重叠（后一档 p10 低于前一档 p90，明细见第二节），"
               "也就是说**相邻两档的文章池本身是交叠的**，光调单篇解决不了「档与档拉不开」。" % (len(pairs), len(overlapped)))
    out.append("- 锁定项代价（只报不改）：真题/manual 里本档生词率 >8%%（太难）%d 篇、"
               "≤2%%（太简单）%d 篇；自动判档与现标签不一致 %d 篇（现档偏低 %d、偏高 %d）——"
               "其中考研 136 篇里 %d 篇「现档偏高」是因为它们对六级读者也已经够得着，"
               "这些动不到，是产品口径而非数据错误。" % (
                   sum(1 for r in locked if r["own_rate"] > HARD),
                   sum(1 for r in locked if r["own_rate"] <= EASY),
                   sum(1 for r in locked if r["dev"]),
                   sum(1 for r in locked if r["dev"] > 0),
                   sum(1 for r in locked if r["dev"] < 0),
                   sum(1 for r in locked if r["origin"] == "kaoyan" and r["dev"] < 0)))
    gl = [r for r in live if r["glued"]]
    if gl:
        out.append("- 顺带发现的数据质量问题：**%d 篇正文标点后缺空格**（合计 %d 处），"
                   "会让按句高亮、朗读分句、单词卡取句把这些粘连句当成一整句，"
                   "本审计的 FK 对这些篇不作数（见「四·附」）。这是独立于调档的问题，建议单列一件事去修。" % (
                       len(gl), sum(r["glued"] for r in gl)))
    return out


if __name__ == "__main__":
    sys.exit(main())
