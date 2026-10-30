"""Export PEP vocabulary as a three-tier table (小学/初中/高中).

Dedup by lowest stage (primary < junior < senior), keeping the cleaned
translation used when merging into data/dict.json.
"""
import csv
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UNITS = os.path.join(ROOT, "tools", "_cache", "vocab", "pep_units")
DICT = os.path.join(ROOT, "data", "dict.json")
OUT = os.path.join(ROOT, "docs", "教材预览", "pep三档词表.csv")

STAGE_LABEL = {"primary": "小学", "junior": "初中", "senior": "高中"}
STAGE_ORDER = {"primary": 0, "junior": 1, "senior": 2}
BRACKET = re.compile(r"\[[^\]]{1,6}\]")
CJK_BRACKET = re.compile(r"[〔【][^〕】]{1,10}[〕】]")


def clean(zh):
    zh = BRACKET.sub("", zh or "")
    zh = CJK_BRACKET.sub("", zh)
    parts = [p.strip() for p in re.split(r"[；;]", zh) if p.strip()]
    return "；".join(parts[:2])


def main():
    index = json.load(open(os.path.join(UNITS, "index.json"), encoding="utf-8"))
    app_dict = json.load(open(DICT, encoding="utf-8"))
    best = {}
    for book in index["books"]:
        path = os.path.join(UNITS, book["id"] + ".json")
        data = json.load(open(path, encoding="utf-8"))
        stage = data["stage"]
        for unit in data["units"]:
            for w in unit["words"]:
                en = (w.get("en") or "").strip()
                if not en:
                    continue
                key = en.lower()
                zh = clean(w.get("zh", ""))
                rec = {
                    "stage": stage,
                    "en": en,
                    "zh": zh,
                    "phonetic": (w.get("phonetic") or "").strip(),
                }
                old = best.get(key)
                if old is None or STAGE_ORDER[stage] < STAGE_ORDER[old["stage"]] or (
                    STAGE_ORDER[stage] == STAGE_ORDER[old["stage"]] and not old["zh"] and zh
                ):
                    best[key] = rec

    for rec in best.values():
        key = rec["en"].lower()
        if " " not in key and "." not in key and key in app_dict:
            rec["zh"] = app_dict[key][1]

    rows = sorted(best.values(), key=lambda r: (STAGE_ORDER[r["stage"]], r["en"].lower()))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["等级", "单词", "释义", "音标"])
        for r in rows:
            w.writerow([STAGE_LABEL[r["stage"]], r["en"], r["zh"], r["phonetic"]])

    counts = {}
    for r in rows:
        counts[STAGE_LABEL[r["stage"]]] = counts.get(STAGE_LABEL[r["stage"]], 0) + 1
    print("rows", len(rows), counts, "->", OUT)


if __name__ == "__main__":
    main()
