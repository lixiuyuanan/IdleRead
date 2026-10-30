"""从 ECDICT(skywind3000/ECDICT, MIT)造本地离线词典。

输入  tools/_cache/ecdict.csv     65.9MB,77 万词条:音标 + 中文释义 + 变形 + 考试标签
      tools/_cache/coca_20k.txt   2 万词按词频排序,一行一个,行号即排名(当基线用)
输出  dict.json   {word: [音标, 中文释义, 词频排名, 考试标签]}   只留常用词
      lemma.json  {变形: 原形}   来自 exchange 字段,让 offering/offer 算同一个词

用法  python tools/build_dict.py [--max-frq 20000]
"""
import csv
import json
import os
import re
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lint_text import clean, clean_phon  # noqa: E402  音标/释义里的脏字符统一处理

csv.field_size_limit(10 ** 7)
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CSV_PATH = os.path.join(HERE, "_cache", "ecdict.csv")
RANK_PATH = os.path.join(HERE, "_cache", "coca_20k.txt")
WORD_RE = re.compile(r"[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F][A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F']+")
SIMPLE = re.compile(r"^[a-z][a-z']*$")
EXCH = re.compile(r"(?:^|/)([0-9a-z]{1,2}):([^/]+)")
FOLD_EXTRA = str.maketrans({"æ": "ae", "œ": "oe", "ø": "o", "ß": "ss", "đ": "d",
                            "ð": "d", "ł": "l", "þ": "th", "ı": "i"})


def fold_word(w):
    """重音折回 ASCII:cliché→cliche、Ødegaard→odegaard,和前端 headOf 同一口径。"""
    w = unicodedata.normalize("NFD", w.lower())
    w = "".join(c for c in w if not unicodedata.combining(c))
    return w.translate(FOLD_EXTRA)


def inflections(exchange):
    """exchange 形如 s:cows/d:cowed/1:am,is,are —— 冒号后可能是一串逗号分隔的变形。

    `1:` 段存的不是变形词，是「这个词条有哪些变形代码」，照收会写出
    lemma["i"]="zoning" 这种短键残渣（2026-10-28 清掉的 8 条就是它造的）。
    """
    for code, forms in EXCH.findall(exchange or ""):
        if code == "0" or code == "1":
            continue
        for form in forms.split(","):
            yield form.strip().lower()


def corpus_words():
    """语料里真实出现过的词都得留释义,不然阅读器会开天窗。

    递归扫子目录:考研、书架等语料放在 corpus/kaoyan/、corpus/books/ 下面,
    只扫顶层会把它们的词漏掉(2026-10-30 前 antipoverty 等 122 个词就是这样丢的)。
    """
    out = set()
    cdir = os.path.join(ROOT, "corpus")
    for base, dirs, files in os.walk(cdir) if os.path.isdir(cdir) else []:
        dirs[:] = [d for d in dirs if not d.startswith("_")]   # _archive 里是删掉的文章,别收
        for p in files:
            if p.endswith("-en.txt"):
                with open(os.path.join(base, p), encoding="utf-8") as f:
                    for w in WORD_RE.findall(f.read()):
                        out.add(fold_word(w).replace("’", "'"))   # 弯撇号统一成直撇号,不然 bo'sun 对不上
    return out


def num(v):
    try:
        n = int(float(v))
        return n if n > 0 else 0
    except (TypeError, ValueError):
        return 0


def rank_list():
    """按行序编号的词频表(ECDICT 自带的 frq 字段对 is/are 这类词是坏的)。"""
    out = {}
    if os.path.exists(RANK_PATH):
        with open(RANK_PATH, encoding="utf-8") as f:
            for i, w in enumerate(f, 1):
                w = w.strip().lower()
                if w and w not in out:
                    out[w] = i
    return out


def main():
    max_frq = 20000
    if "--max-frq" in sys.argv:
        max_frq = int(sys.argv[sys.argv.index("--max-frq") + 1])
    if not os.path.exists(CSV_PATH):
        print("没有", CSV_PATH)
        return 1
    ranks = rank_list()
    keep = corpus_words()
    data, lemma, total = {}, {}, 0
    with open(CSV_PATH, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            total += 1
            w = (row.get("word") or "").strip().lower()
            if not SIMPLE.match(w):
                continue
            frq, bnc = num(row.get("frq")), num(row.get("bnc"))
            tag = (row.get("tag") or "").strip()
            # ECDICT 用字面 \n 分隔释义行,偶尔混进 \r:先统一成 \n 再换成 " / ",
            # 否则 \r 会留在释义里当成正文显示出来。用 str.replace 而不是 re.sub,
            # re.sub 的替换串会把 "\n" 当成真换行,分隔符就丢了。
            raw = (row.get("translation") or "").replace("\\r\\n", "\\n")
            raw = raw.replace("\\r", "\\n")
            cn = clean(raw.replace("\\n", " / "))
            common = (bool(tag) or w in ranks or frq and frq <= max_frq
                      or bnc and bnc <= max_frq or num(row.get("collins")) >= 3
                      or row.get("oxford"))
            if not (common or w in keep):
                continue
            if not cn:
                continue
            rank = ranks.get(w) or min(x for x in (frq or 10 ** 9, bnc or 10 ** 9))
            data[w] = [clean_phon(row.get("phonetic") or ""), re.sub(r"\s+", " ", cn)[:220],
                       0 if rank > 10 ** 8 else rank, tag]
            # 变形表无条件生成:复数本身也可能混进词频表(cows),不映射回 cow 会被当成两个生词
            for inf in inflections(row.get("exchange")):
                if SIMPLE.match(inf) and inf != w:
                    lemma[inf] = w
    # 变形不复制释义:Dictionary.entry() 先 head() 归原形再查,省掉一倍体积
    data_dir = os.path.join(ROOT, "data")
    os.makedirs(data_dir, exist_ok=True)
    for path, obj in ((os.path.join(data_dir, "dict.json"), data),
                      (os.path.join(data_dir, "lemma.json"), lemma)):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        print("%-12s %7d 条  %.1f MB" % (os.path.basename(path), len(obj),
                                         os.path.getsize(path) / 1e6))
    print("读入 %d 行,语料词 %d 个" % (total, len(keep)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
