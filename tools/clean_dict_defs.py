"""clean_dict_defs.py —— 就地重建 data/dict.json 的释义字段（只动 [1]，其余原样）。

目标格式
    同一词性的多条释义合并成一行，行内用「，」分隔；不同词性各占一行。
    行首保留词性前缀（n. / vt. / vi. / a. / adv. / abbr. ...）。
    方括号领域标记（[计] [医] [法] ...）一律删除，标记后的文字保留并归入词性组。

归属规则（产品约定）
    1. 带词性前缀的段，直接归该词性。
    2. 不带前缀但带标记的段：只有一个词性组就并入；有多个时优先并入 n.；
       义项以「使/把/进行/予以/加以」开头时单开 v.。
    3. 不带前缀也不带标记的段（如 a 的「第一个字母 A; 一个; 第一的」）原样保留为无前缀行。
    4. 组内去重，普通义排前、领域义排后；全角标点；总长 ≤220，按义项边界截断。

用法
    python tools/clean_dict_defs.py --dry-run    # 只统计，不写盘
    python tools/clean_dict_defs.py             # 备份 + 重建
"""
import json
import os
import re
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DICT_PATH = os.path.join(ROOT, "data", "dict.json")
ARCHIVE = os.path.join(ROOT, "data", "_archive")

# 词性前缀：只认前端 posKeyOf 认的那批，外加 ECDICT 常见的 abbr / pl
POS_RE = re.compile(
    r"^(n|vt|vi|v|a|adj|adv|prep|pron|num|conj|int|art|abbr|pl)\.\s*", re.I)
# 方括号领域标记：长度限死，避免把正文里的方括号当标记吃掉
BR_RE = re.compile(r"\[[^\[\]]{1,20}\]")
# 段内顶层分隔符（半角/全角都收）
ITEM_SEP = re.compile(r"[,，;；、]")
VERB_HINT = re.compile(r"^(使|把|进行|予以|加以)")
MAXLEN = 220


def split_top(text):
    """按顶层分隔符切分义项，括号内的分隔符不切。返回 [(item, sep), ...]。"""
    out, buf, depth = [], [], 0
    i = 0
    while i < len(text):
        c = text[i]
        if c in "(（":
            depth += 1
            buf.append(c)
        elif c in ")）":
            depth = max(0, depth - 1)
            buf.append(c)
        elif depth == 0 and ITEM_SEP.match(c):
            # 吃掉分隔符后面的空格
            seg = "".join(buf).strip()
            out.append(seg)
            buf = []
            while i + 1 < len(text) and text[i + 1] in " \u3000":
                i += 1
        else:
            buf.append(c)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        out.append(tail)
    return [x for x in out if x]


def norm_item(s):
    """单个义项清洗：去多余空格、行尾标点、全角化。"""
    s = re.sub(r"\s+", " ", s).strip()
    s = s.replace(",", "，").replace(";", "；")
    s = re.sub(r"[，；、]{2,}", "，", s)
    s = re.sub(r"\s*([，；、])\s*", r"\1", s)
    s = s.strip("，；、 ")
    return s


def parse(defs):
    """拆出 [(pos_key, pos_label, [items], is_domain)] 与无前缀行。"""
    segs = [x for x in re.split(r"\s+/\s+", defs or "") if x.strip()]
    groups = []          # [{'key','label','items','domains'}]
    index = {}
    noprefix = []        # 无前缀、无标记的原始行
    pending = []         # 无前缀但带标记的段，等分组后再归属

    for seg in segs:
        seg = seg.strip()
        if not seg:
            continue
        m = POS_RE.match(seg)
        pos = m.group(1).lower() if m else ""
        body = seg[m.end():] if m else seg
        has_br = bool(BR_RE.search(body))
        body = BR_RE.sub("", body).strip()
        items = [norm_item(x) for x in split_top(body)]
        items = [x for x in items if x]
        if not items:
            continue
        if pos:
            # 同一原始标签归一组（vt 与 vi 不合并，保留及物/不及物区分）
            if pos not in index:
                index[pos] = len(groups)
                groups.append({"label": pos, "items": [], "domains": []})
            g = groups[index[pos]]
            (g["domains"] if has_br else g["items"]).extend(items)
        elif has_br:
            pending.append(items)
        else:
            noprefix.append(items)

    return groups, noprefix, pending


def attach(groups, pending):
    """把无前缀领域段按规则归入词性组。"""
    if not groups:
        if pending:
            # 整条释义只有领域标记、没有任何词性前缀：建 n. 组接住，别把文字丢了
            groups.append({"label": "n", "items": [], "domains": []})
        else:
            return
    for items in pending:
        # 明显动词义单开 v 组
        if items and VERB_HINT.match(items[0]):
            idx = None
            for i, g in enumerate(groups):
                if g["label"] in ("v", "vt", "vi"):
                    idx = i
                    break
            if idx is None:
                groups.append({"label": "v", "items": [], "domains": []})
                idx = len(groups) - 1
            groups[idx]["domains"].extend(items)
            continue
        # 只有一个组就直接并
        if len(groups) == 1:
            groups[0]["domains"].extend(items)
            continue
        # 多个组优先并入 n.
        target = None
        for g in groups:
            if g["label"] == "n":
                target = g
                break
        if target is None:
            target = groups[0]
        target["domains"].extend(items)


def render(groups, noprefix):
    """拼成最终释义串。"""
    lines = []
    for items in noprefix:
        uniq = []
        for x in items:
            if x not in uniq:
                uniq.append(x)
        if uniq:
            lines.append("，".join(uniq))
    for g in groups:
        seq = []
        for x in g["items"] + g["domains"]:
            if x not in seq:
                seq.append(x)
        if not seq:
            continue
        lines.append(g["label"] + ". " + "，".join(seq))
    # 按义项边界截断到 MAXLEN
    out, total = [], 0
    for ln in lines:
        if not out:
            if len(ln) <= MAXLEN:
                out.append(ln)
                total = len(ln)
            else:
                cut = ln[:MAXLEN]
                cut = cut[:cut.rfind("，")] if "，" in cut else cut
                out.append(cut.rstrip("，；、 "))
                total = len(out[0])
            continue
        add = 3 + len(ln)   # " / " + 行
        if total + add <= MAXLEN:
            out.append(ln)
            total += add
        else:
            room = MAXLEN - total - 3
            if room > 6:
                cut = ln[:room]
                if "，" in cut:
                    cut = cut[:cut.rfind("，")]
                cut = cut.rstrip("，；、 ")
                if len(cut) > len(ln.split(". ")[0]) + 3:
                    out.append(cut)
            break
    return " / ".join(out)


def rebuild(defs):
    groups, noprefix, pending = parse(defs)
    attach(groups, pending)
    return render(groups, noprefix)


def main():
    dry = "--dry-run" in sys.argv
    data = json.load(open(DICT_PATH, encoding="utf-8"))
    old_n = len(data)
    changes = []
    removed_marks = 0
    n_changed = 0
    empty = []

    for w, v in data.items():
        old = v[1] if len(v) > 1 else ""
        new = rebuild(old)
        if not new:
            empty.append(w)
            new = old
        if new != old:
            n_changed += 1
            changes.append((w, old, new))
        removed_marks += len(BR_RE.findall(old))

    print("条目 %d → %d" % (old_n, len(data)))
    print("释义有变化 %d 条" % n_changed)
    print("将删除方括号标记 %d 个" % removed_marks)
    print("重建后释义为空 %d 条" % len(empty))
    if empty:
        print("  空值样例:", empty[:8])
    # 剩余方括号
    left = [w for w, v in data.items() if BR_RE.search(rebuild(v[1]))]
    print("重建后仍含方括号 %d 条" % len(left))
    if left:
        print("  样例:", left[:5])
    # 长度
    over = [w for w, v in data.items() if len(rebuild(v[1])) > MAXLEN]
    print("超过 %d 字符 %d 条" % (MAXLEN, len(over)))

    if dry:
        print("\n--dry-run，未写盘")
        for w, o, n in changes[:8]:
            print("\n[%s]\n  OLD %s\n  NEW %s" % (w, o[:110], n[:110]))
        return 0

    ts = time.strftime("%Y%m%d-%H%M%S")
    bak = os.path.join(ARCHIVE, "dict-defs-" + ts)
    os.makedirs(bak, exist_ok=True)
    shutil.copy2(DICT_PATH, os.path.join(bak, "dict.json"))
    with open(os.path.join(bak, "changes.tsv"), "w", encoding="utf-8", newline="\n") as f:
        f.write("word\told\tnew\n")
        for w, o, n in changes:
            f.write("%s\t%s\t%s\n" % (w, o.replace("\t", " "), n.replace("\t", " ")))
    print("\n备份 →", bak)

    for w, o, n in changes:
        data[w][1] = n
    with open(DICT_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print("已写回", DICT_PATH)
    return 0


if __name__ == "__main__":
    sys.exit(main())
