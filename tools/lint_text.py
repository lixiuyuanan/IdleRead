# -*- coding: utf-8 -*-
"""全库文本体检:把「看着像乱码」的字符在打包之前找出来。

只读,不改任何文件。check_corpus.py 管的是内容对不对得上(段数、语言),
这个管的是字符脏不脏 —— 零宽字符、控制符、没解开的字面 \\n、UTF-8 套娃乱码、
词典音标里被写坏的 ɡ 和 ɜː。真机上出现过「音标/翻译偶发乱码」,靠肉眼翻不出来。

检查范围:
  corpus/ 下的 *-en.txt、*-chs.txt、corpus/index.json 的标题
  data/dict.json、data/lemma.json
  mobile/.../www/data/articles.json、dict.json、lemma.json(真正打进 APK 的那几份)

用法:
    python tools/lint_text.py
    python tools/lint_text.py --sample 5          # 每种问题多打几条样例
    python tools/lint_text.py --json _preview/text_lint.json
    python tools/lint_text.py --scope mobile      # 只查打进 APK 的数据

退出码:0 = 干净;1 = 有硬问题;2 = 文件没找到。
"""
import argparse
import io
import json
import os
import re
import sys
import time
from collections import Counter

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORPUS = os.path.join(HERE, "corpus")
DATA = os.path.join(HERE, "data")
MOBILE = os.path.join(HERE, "mobile", "android", "app", "src", "main",
                      "assets", "www", "data")

# 与 app.js 的 cleanText()/cleanPhon() 一一对应,改这里要同步改那边。
ZW_CHARS = "\u200b\u200c\u200d\u2060\ufeff\u00ad"
ZW_RE = re.compile("[" + ZW_CHARS + "]")
# \t \n 是正常排版用的,其余 C0、DEL、C1 都算脏;单独的 \r 也报(打包前该换成 \n)。
CTL_RE = re.compile(r"[\u0000-\u0008\u000e-\u001f\u007f-\u009f]|\r")
LIT_ESC_RE = re.compile(r"\\[rnt]|\\{2,}")
BAD_CHAR_RE = re.compile(r"\ufffd+")
# latin-1 当成 UTF-8 读回来的典型痕迹:é â 一类后接 ASCII。
MOJI_RE = re.compile(r"Ã[\x80-\xbf©¨¤¢¥¦§¨©ª«¬®°±²³´µ¶·¹º»¼½¾¿]"
                     r"|â[\x80-\xbf€œ”˜™ˆ]"
                     r"|[\xc2\xc3][\x80-\xbf]{2,}")
NBSP_RE = re.compile(r"\u00a0")
# ECDICT 音标里 ɡ 被写成了 ^(全库 335 个词),ɜː 被写成一串反斜杠加冒号(53 个词)。
PHON_CARET_RE = re.compile(r"\^")
PHON_BS_RE = re.compile(r"\\{1,}:")

# 硬问题 = 会显示到屏幕上或被当成正文的一部分,必须清零。
HARD = ["zero_width", "control", "lit_escape", "replacement", "mojibake",
        "phon_caret", "phon_backslash"]
LABELS = {
    "zero_width": "零宽字符/BOM",
    "control": "控制字符",
    "lit_escape": "字面转义没解开",
    "replacement": "U+FFFD 替换符",
    "mojibake": "编码套娃乱码",
    "phon_caret": "音标里的 ^",
    "phon_backslash": "音标里的反斜杠",
    "nbsp": "不换行空格",
}
CHECKS = [
    ("zero_width", ZW_RE), ("control", CTL_RE), ("lit_escape", LIT_ESC_RE),
    ("replacement", BAD_CHAR_RE), ("mojibake", MOJI_RE), ("nbsp", NBSP_RE),
]


def scan_text(text):
    """返回 {问题类型: 次数} 和每种问题的第一个样例。"""
    found = Counter()
    samples = {}
    for name, rx in CHECKS:
        hits = rx.findall(text)
        if not hits:
            continue
        found[name] += len(hits)
        if name not in samples:
            m = rx.search(text)
            samples[name] = snippet(text, m.start(), m.end())
    return found, samples


def snippet(text, a, b, width=22):
    s = text[max(0, a - width):b + width].replace("\n", "\\n")
    return "".join(ch if ord(ch) >= 32 or ch == " " else "<%02X>" % ord(ch)
                   for ch in s)


# ---- 清洗:build_dict.py / build_mobile_data.py 打包前调用 ----
# 规则与 app.js 的 cleanText()/cleanPhon() 对齐:换行留着(译文一段一句),
# 其余脏字符一律去掉。改这里记得同步改 app.js。
def clean(text):
    if not isinstance(text, str):
        return text
    t = re.sub(r"\r\n?", "\n", text)
    t = ZW_RE.sub("", t)
    t = re.sub(r"[\u0000-\u0008\u000e-\u001f\u007f-\u009f]", "", t)
    t = re.sub(r"\\r\\n|\\r|\\n", "\n", t)
    t = BAD_CHAR_RE.sub("", t)
    t = re.sub(r"[\u00a0\t\f\v]+", " ", t)
    t = re.sub(r"[ ]{2,}", " ", t)
    t = re.sub(r" ?\n ?", "\n", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def clean_phon(text):
    """音标专用:除了通用清洗,再把 ECDICT 写坏的 ɡ 和 ɜː 还原。

    开头的 . / , 是旧式次重音标记,换成 IPA 的 ˌ(belfast: .belfɑ:st → ˌbelfɑ:st);
    ɒ 统一写成 ɔ;Cyrillic ә 统一成 IPA ə。
    """
    t = clean(text)
    if not isinstance(t, str):
        return t
    t = re.sub(r"^[.,]\s*", "\u02cc", t)
    t = re.sub(r"^\u02cc['ˈ]", "\u02cc", t)   # 次重音后紧跟主重音是脏数据,留次重音
    t = t.replace("ɒ", "ɔ").replace("ә", "ə")
    return re.sub(r"\\{1,}:", "ɜː", re.sub(r"\^", "ɡ", t))


def clean_obj(obj):
    """递归清洗列表/字典里的字符串(语料段落、词典条目都能套)。"""
    if isinstance(obj, str):
        return clean(obj)
    if isinstance(obj, list):
        return [clean_obj(x) for x in obj]
    if isinstance(obj, dict):
        return dict((k, clean_obj(v)) for k, v in obj.items())
    return obj


class Report(object):
    def __init__(self):
        self.files = []
        self.missing = []

    def add(self, kind, path, found, samples, where=""):
        if not found:
            return
        self.files.append({
            "kind": kind,
            "path": rel(path),
            "counts": dict(found),
            "total": sum(found.values()),
            "samples": [{"issue": k, "where": where, "text": v}
                        for k, v in sorted(samples.items())],
        })

    def miss(self, path):
        self.missing.append(rel(path))


def rel(path):
    try:
        return os.path.relpath(path, HERE).replace("\\", "/")
    except ValueError:
        return path


def walk_text(report, paths, kind):
    for path in paths:
        if not os.path.exists(path):
            report.miss(path)
            continue
        with io.open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
        found, samples = scan_text(text)
        report.add(kind, path, found, samples, os.path.basename(path))


def read_json(path):
    if not os.path.exists(path):
        return None
    with io.open(path, encoding="utf-8") as f:
        return json.load(f)


def lint_dict(report, path):
    data = read_json(path)
    if data is None:
        report.miss(path)
        return
    found = Counter()
    samples = {}
    bad_words = Counter()
    for word, val in data.items():
        phon = ""
        gloss = ""
        if isinstance(val, list):
            phon = val[0] if len(val) > 0 and val[0] else ""
            gloss = val[1] if len(val) > 1 and val[1] else ""
        elif isinstance(val, str):
            gloss = val
        for name, rx in (("phon_caret", PHON_CARET_RE),
                         ("phon_backslash", PHON_BS_RE)):
            n = len(rx.findall(phon))
            if n:
                found[name] += n
                bad_words[name] += 1
                if name not in samples:
                    samples[name] = "%s → %s" % (word, phon)
        f2, s2 = scan_text(gloss)
        for k, v in f2.items():
            found[k] += v
            if k not in samples:
                samples[k] = "%s → %s" % (word, s2[k])
    report.add("dict", path, found, samples,
               "、".join("%s %d 词" % (LABELS[k], n) for k, n in bad_words.items()))


def lint_articles(report, path):
    obj = read_json(path)
    if obj is None:
        report.miss(path)
        return
    arts = obj.get("articles") if isinstance(obj, dict) else obj
    found = Counter()
    samples = {}
    for art in arts or []:
        fields = [("title", [art.get("t") or ""]),
                  ("en", art.get("p") or []),
                  ("chs", art.get("c") or [])]
        for fname, values in fields:
            for i, text in enumerate(values):
                if not isinstance(text, str):
                    continue
                f2, s2 = scan_text(text)
                for k, v in f2.items():
                    found[k] += v
                    if k not in samples:
                        samples[k] = "%s %s[%d]: %s" % (
                            art.get("s") or "", fname, i, s2[k])
    report.add("articles", path, found, samples)


def lint_index(report, path):
    obj = read_json(path)
    if obj is None:
        report.miss(path)
        return
    found = Counter()
    samples = {}
    for e in obj.get("entries") or []:
        f2, s2 = scan_text(str(e.get("title") or ""))
        for k, v in f2.items():
            found[k] += v
            if k not in samples:
                samples[k] = "%s: %s" % (e.get("stem"), s2[k])
    report.add("index", path, found, samples)


def corpus_files():
    out = []
    for base, dirs, names in os.walk(CORPUS):
        dirs[:] = [d for d in dirs if not d.startswith(("_", "."))]
        for n in names:
            if n.endswith("-en.txt") or n.endswith("-chs.txt"):
                out.append(os.path.join(base, n))
    return sorted(out)


def show(report, sample_n, scope):
    counts = Counter()
    hard = 0
    for item in report.files:
        for k, v in item["counts"].items():
            counts[k] += v
            if k in HARD:
                hard += v
    print("扫描范围:%s,有问题的文件 %d 份"
          % (scope, len(report.files)))
    for key in HARD + ["nbsp"]:
        if not counts.get(key):
            continue
        print("  !! %-18s %d 处" % (LABELS[key], counts[key]))
    if not counts:
        print("  OK 没发现脏字符")
    for item in sorted(report.files, key=lambda x: -x["total"])[:sample_n]:
        print("\n%s (%s)" % (item["path"], item["kind"]))
        for s in item["samples"][:8]:
            print("  %-14s %s%s" % (LABELS.get(s["issue"], s["issue"]),
                                    (s["where"] + " ") if s["where"] else "",
                                    s["text"]))
    if report.missing:
        print("\n没找到的文件:")
        for p in report.missing:
            print("  ", p)
    return counts, hard


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scope", choices=("all", "mobile", "corpus", "data"),
                    default="all")
    ap.add_argument("--sample", type=int, default=6,
                    help="打印问题最多的前 N 个文件")
    ap.add_argument("--json", help="把完整结果写到这个 json 文件")
    args = ap.parse_args()

    report = Report()
    if args.scope in ("all", "corpus"):
        walk_text(report, corpus_files(), "corpus")
        lint_index(report, os.path.join(CORPUS, "index.json"))
    if args.scope in ("all", "data"):
        lint_dict(report, os.path.join(DATA, "dict.json"))
        walk_text(report, [os.path.join(DATA, "lemma.json")], "lemma")
    if args.scope in ("all", "mobile"):
        lint_articles(report, os.path.join(MOBILE, "articles.json"))
        lint_dict(report, os.path.join(MOBILE, "dict.json"))
        walk_text(report, [os.path.join(MOBILE, "lemma.json")], "lemma")

    counts, hard = show(report, args.sample, args.scope)

    if args.json:
        out = args.json if os.path.isabs(args.json) else os.path.join(HERE, args.json)
        d = os.path.dirname(out)
        if d:
            os.makedirs(d, exist_ok=True)
        with io.open(out, "w", encoding="utf-8") as f:
            json.dump({"generated": time.strftime("%Y-%m-%d %H:%M:%S"),
                       "scope": args.scope, "counts": dict(counts),
                       "hard": hard, "missing": report.missing,
                       "files": report.files},
                      f, ensure_ascii=False, indent=1)
        print("\n报告:%s" % out)

    if report.missing:
        return 2
    return 1 if hard else 0


if __name__ == "__main__":
    sys.exit(main())
