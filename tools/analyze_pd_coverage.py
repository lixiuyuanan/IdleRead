"""公版读本 vs pep 三档词表 —— 覆盖率实测 v2（只读，不写文件）

v1 把覆盖率算低了，两个原因已修：
  1. McGuffey 排印把省写符号放在词中（driv'ing / moth'er / glass'es），必须先去内部撇号；
  2. said / knew / made / running 这类不规则与双写变形要回到词族（say / know / make / run）。
另：人名与 Gutenberg 版式残迹（Illustration、罗马数字页码）不计入超纲，单独统计。

用法：python tools/analyze_pd_coverage.py
"""
import csv
import io
import json
import os
import re
import urllib.request
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TIERS = os.path.join(ROOT, "docs", "教材预览", "pep三档词表.csv")
READERS = os.path.join(ROOT, "docs", "教材预览", "公版读本")

IRREGULAR = {
    "said": "say", "knew": "know", "made": "make", "came": "come", "went": "go",
    "saw": "see", "gave": "give", "took": "take", "told": "tell", "thought": "think",
    "brought": "bring", "bought": "buy", "found": "find", "had": "have", "did": "do",
    "was": "be", "were": "be", "ran": "run", "sung": "sing", "sang": "sing",
    "begin": "begin", "began": "begin", "begun": "begin", "drawn": "draw", "drew": "draw",
    "written": "write", "wrote": "write", "spoken": "speak", "spoke": "speak",
    "broken": "break", "broke": "break", "chosen": "choose", "woke": "wake",
    "worn": "wear", "wore": "wear", "ridden": "ride", "rode": "ride", "risen": "rise",
    "rose": "rise", "driven": "drive", "drove": "drive", "flown": "fly", "flew": "fly",
    "grown": "grow", "grew": "grow", "thrown": "throw", "threw": "throw",
    "eaten": "eat", "ate": "eat", "given": "give", "taken": "take", "paid": "pay",
    "laid": "lay", "led": "lead", "fed": "feed", "met": "meet", "sat": "sit",
    "got": "get", "gotten": "get", "let": "let", "put": "put", "set": "set",
    "cut": "cut", "shut": "shut", "hurt": "hurt", "cost": "cost", "lost": "lose",
    "lose": "lose", "left": "leave", "kept": "keep", "slept": "sleep", "crept": "creep",
    "meant": "mean", "lent": "lend", "spent": "spend", "sent": "send", "built": "build",
    "held": "hold", "sold": "sell", "heard": "hear", "stood": "stand", "understand": "understand",
    "understood": "understand", "dreamt": "dream", "learnt": "learn", "burnt": "burn",
    "gone": "go", "done": "do", "seen": "see", "known": "know", "laid": "lay",
}

NOISE = re.compile(r"^(illustration|frontispiece|index|contents|preface|"
                   r"[ivxlcdm]{1,7}\.?|\d+\.?)$", re.I)

# 封闭词类（冠词/代词/介词/连词/助动词/数词/疑问副词）。教材单元词表按可教词条罗列，
# a/the/of/to/is 这类不单列（本表里落在初中档），所以要并一层，否则小学档被系统性低估。
# 只收真正的功能词，不收 time/people/work 这类实词；报告 strict/aug 两数并列，
# 让人看清这一层贡献了多少，不拿它把覆盖率刷上去。
BASE_FUNCTION = set("""a an the and or but so if then than that this these those it he she
they we you i me him her us them my your his our their mine yours its be am is are was were
been being do does did doing done have has had having will would shall should can could may
might must of in on at to for from with by as about above below under over into onto near far
away back up down out off again once not no yes none all any some each every both either
neither other another such too very who whom whose which what where when why how because
while until since during before after between among through against without within one two
three four five six seven eight nine ten eleven twelve twenty thirty hundred first second
third there here""".split())

BOILERPLATE = re.compile(r"project gutenberg|gutenberg|license|refund|trademark|"
                         r"donations|prize|electronic work|laws of the united states|"
                         r"foundation|congregation", re.I)


def load_csv(path):
    raw = open(path, "rb").read()
    return list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig", errors="replace"))))


def norm(w):
    w = w.lower().strip(".!?,:;\"'’`()")
    if w.endswith("n't"):
        w = w[:-3] + " not"
    w = w.replace("'", "").replace("’", "")       # driv'ing -> driving
    return w


def wordforms(w):
    """词形 -> 词族候选集。宽松匹配，命中任一即算在纲。"""
    out = {w}
    if w in IRREGULAR:
        out.add(IRREGULAR[w])
    if len(w) > 4 and w.endswith("ing"):
        b = w[:-3]
        out |= {b, b + "e", b[:-1], b + b[-1]}
    if len(w) > 3 and w.endswith("ed"):
        b = w[:-2]
        out |= {b, b + "e", b[:-1], w[:-1]}
    if len(w) > 3 and w.endswith("ies"):
        out.add(w[:-3] + "y")
    if len(w) > 3 and w.endswith("es"):
        out |= {w[:-2], w[:-1]}
    if len(w) > 2 and w.endswith("s") and not w.endswith("ss"):
        out.add(w[:-1])
    for suf in ("ly", "ness", "ment", "ful", "less", "ing", "ed"):
        if len(w) > len(suf) + 3 and w.endswith(suf):
            out.add(w[:-len(suf)])
    if len(w) > 5 and w.endswith("er"):
        out |= {w[:-2], w[:-1]}
    if len(w) > 6 and w.endswith("est"):
        out |= {w[:-3], w[:-2]}
    return {x for x in out if len(x) > 1}


def build_gates():
    per, phrases = defaultdict(set), defaultdict(set)
    for r in load_csv(TIERS):
        tier = (r.get("等级") or "").strip()
        w = norm(r.get("单词") or "")
        if not tier or not w:
            continue
        (phrases if (" " in w or "/" in w) else per)[tier].add(w)
    gates = {"小学": per["小学"],
             "初中": per["小学"] | per["初中"],
             "高中": per["小学"] | per["初中"] | per["高中"]}
    aug = {k: v | BASE_FUNCTION for k, v in gates.items()}
    return per, phrases, gates, aug


CEFRJ_REPO = ("openlanguageprofiles", "olp-en-cefrj", "cefrj-vocabulary-profile-1.5.csv")
CEFRJ_CACHE = os.path.join(ROOT, "教材", "_wordlists", "cefrj-vocabulary-profile-1.5.csv")
CEFRJ_CITE = ("CEFR-J Wordlist version 1.5 (Yukio Tono et al., Tokyo University of Foreign "
              "Studies), https://github.com/openlanguageprofiles/olp-en-cefrj — "
              "free for research and commercial use with citation.")


def load_cefrj(fetch=True):
    """按 CEFR 级别返回词集。缓存到 教材/_wordlists/，没有缓存且允许联网时走 api.github。

    为什么需要它：人教单元词表只列"这一单元要教的词"，good/please/enough 这类
    教材里出现但不单列的词不在表内，单用它会把小学档难度判低。CEFR-J 是逐词 A1–B2
    分级的公开词表，用来补这一层；同时保留 pep 覆盖率作为"教材匹配度"指标。

    缓存写不进去（低完整性沙箱、只读盘）时直接用内存里的文本解析，不让打分悄悄降级。
    """
    text = None
    if os.path.exists(CEFRJ_CACHE):
        text = open(CEFRJ_CACHE, "rb").read().decode("utf-8-sig", errors="replace")
    elif fetch:
        owner, repo, name = CEFRJ_REPO
        url = "https://api.github.com/repos/%s/%s/contents/%s" % (owner, repo, name)
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 probe"})
        try:
            import base64
            data = json.loads(urllib.request.urlopen(req, timeout=60).read().decode())
            text = base64.b64decode(data["content"]).decode("utf-8", errors="replace")
            try:
                os.makedirs(os.path.dirname(CEFRJ_CACHE), exist_ok=True)
                with open(CEFRJ_CACHE, "wb") as fh:
                    fh.write(text.encode("utf-8"))
            except OSError as e:
                print("CEFR-J 缓存写不了（%s），本次用内存数据" % e)
        except Exception as e:
            raise RuntimeError(
                "CEFR-J 词表既不在缓存 %s 也拉不下来（%s）。少了这一层小学档会被判低、"
                "coverage_fit 不可用，不能继续打分。先把 CSV 放进缓存路径，"
                "或修好网络再跑。" % (CEFRJ_CACHE, e))
    if text is None:
        return {}
    out = defaultdict(set)
    for r in csv.DictReader(io.StringIO(text)):
        level = (r.get("CEFR") or "").strip()
        w = norm(r.get("headword") or "")
        if not level or not w:
            continue
        out[level].add(w)
        for part in re.split(r"[^A-Za-z]+", w):
            if part:
                out[level].add(part.lower())
    return dict(out)


_CEFRJ_MEMO = {}
_GATES_MEMO = {}


def build_gates_memo():
    if "g" not in _GATES_MEMO:
        _GATES_MEMO["g"] = build_gates()
    return _GATES_MEMO["g"]


def gates_with_cefr(levels_by_tier=None):
    """返回 (pep 门槛, 并 CEFR 后的门槛, 各级词数)。

    爬虫每篇都要打分，缓存写不进盘时不记忆就会每篇重取一次 GitHub API，
    既慢又对公共 API 不礼貌，所以按 key 记忆。
    """
    key = str(sorted((levels_by_tier or {}).items()))
    if key in _CEFRJ_MEMO:
        return _CEFRJ_MEMO[key]
    per, phrases, gates, aug = build_gates_memo()
    cj = load_cefrj()
    levels_by_tier = levels_by_tier or {"小学": ("A1",),
                                        "初中": ("A1", "A2"),
                                        "高中": ("A1", "A2", "B1")}
    fit = {}
    for tier, lv in levels_by_tier.items():
        extra = set()
        for l in lv:
            extra |= cj.get(l, set())
        fit[tier] = aug[tier] | extra
    out = (aug, fit, {k: len(v) for k, v in cj.items()})
    _CEFRJ_MEMO[key] = out
    return out


def strip_gutenberg(text):
    m = re.search(r"\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG.*?\*\*\*", text, re.S)
    if m:
        text = text[m.end():]
    m = re.search(r"\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG", text)
    return text[:m.start()] if m else text


def tokenize(s):
    return re.findall(r"[A-Za-z][A-Za-z'’]*", s)


def sentences(text):
    text = re.sub(r"\r\n", "\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    out = []
    for p in re.split(r"\n\s*\n", text):
        p = re.sub(r"\n", " ", p).strip()
        p = re.sub(r"^\s*\d+\.\s*", "", p)
        if NOISE.match(p):
            continue
        for s in re.split(r"(?<=[.!?])\s+(?=[\"A-Z‘‘])", p):
            s = s.strip()
            if s and not NOISE.match(s) and len(s) > 2:
                out.append(s)
    return out


def windows(sents, lo, hi):
    """按句子边界拼窗口，贪心到接近 hi 就收；返回 (文本, 词数)。"""
    out, buf, n = [], [], 0
    for s in sents:
        k = len(tokenize(s))
        if n and n + k > hi:
            if n >= lo:
                out.append((" ".join(buf), n))
            buf, n = [], 0
            if k > hi:
                continue
        buf.append(s)
        n += k
    if n >= lo:
        out.append((" ".join(buf), n))
    return out


def score(text, gate, phrases):
    """返回 (覆盖率%, 超纲实词 Counter, 专有名词数, 总词数)。

    覆盖 = 词族命中词表 或 命中封闭词类 或 首字母大写且不在词表(视作人名/地名)。
    专有名词不算超纲，但会计数并单独打印，方便判断一篇里名字是否过密。
    """
    miss, names, tot = Counter(), 0, 0
    for m in re.finditer(r"[A-Za-z][A-Za-z'’]*", text):
        raw, lw = m.group(0), norm(m.group(0))
        if not lw or NOISE.match(lw):
            continue
        tot += 1
        if lw in gate or (wordforms(lw) & gate) or lw in BASE_FUNCTION:
            continue
        prev = text[:m.start()].rstrip()
        at_start = (not prev) or prev[-1] in ".!?:;"
        if raw[0].isupper() and not at_start and lw not in gate:
            names += 1
            continue
        miss[lw] += 1
    covered = tot - sum(miss.values())
    return (covered / tot * 100.0 if tot else 0.0), miss, names, tot


def main():
    per, phrases, gates, aug = build_gates()
    print("三档词表 小学=%d 初中=%d 高中=%d  累积 小学=%d 初中=%d 高中=%d  短语=%d  封闭词类=%d"
          % (len(per["小学"]), len(per["初中"]), len(per["高中"]),
             len(gates["小学"]), len(gates["初中"]), len(gates["高中"]),
             sum(len(v) for v in phrases.values()), len(BASE_FUNCTION)))
    specs = {"小学": (60, 150), "初中": (200, 300), "高中": (200, 300)}
    totals = defaultdict(int)
    for fname in sorted(f for f in os.listdir(READERS) if f.endswith(".txt")):
        text = strip_gutenberg(open(os.path.join(READERS, fname), "rb").read()
                               .decode("utf-8", errors="replace"))
        sents = sentences(text)
        print("\n== %s  (%d 句 / %d 词)" % (fname, len(sents), len(tokenize(text))))
        for tier, (lo, hi) in specs.items():
            rows = []
            for w, nw in windows(sents, lo, hi):
                if BOILERPLATE.search(w):
                    continue
                cov, miss, names, tot = score(w, aug[tier], phrases[tier])
                rows.append((cov, nw, names, tot, miss))
            rows.sort(key=lambda r: -r[0])
            band = lambda x: sum(1 for r in rows if r[0] >= x)
            med = sorted(r[0] for r in rows)[len(rows) // 2] if rows else 0
            print("   %-4s 窗口 %3d | 中位 %.1f%% | ≥98%%:%2d ≥95%%:%2d ≥90%%:%2d ≥85%%:%2d"
                  % (tier, len(rows), med, band(98), band(95), band(90), band(85)))
            totals[tier] += band(90)
            if rows:
                top = rows[0]
                print("        最好一篇 %.1f%%/%d词 专名%d | 超纲 %d 种: %s"
                      % (top[0], top[1], top[2], len(top[4]),
                         ", ".join(sorted(top[4])[:12])))
    print("\n≥90%% 覆盖的可用窗口合计：", dict(totals))


if __name__ == "__main__":
    main()
