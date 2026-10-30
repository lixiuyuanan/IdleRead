# -*- coding: utf-8 -*-
"""词表实测探针（2026-10-30）：在真实页面里，用复习页的搜索框逐个开词卡。

不看条数，看“点开有没有释义”：
  1. 从 1190 篇文章里随机抽 80 个词头 + 20 个新词/专名/重音词,输入搜索框,
     点第一条建议,词卡不能出现「该词汇未收录」,释义不能为空;
  2. 中文搜词:同一搜索框输入中文,建议行要带中文释义,点开的词卡释义里要含该中文;
     常用查询(政府/美丽/宇宙…)第一条必须是对应常用词;
  3. 英文搜索的老行为不回归:精确匹配排第一、大小写不敏感、重音输入能折回 ASCII。

前置:www 目录静态服务器 8765
    cd mobile/android/app/src/main/assets/www && python -m http.server 8765
运行:
    python mobile/_test/dict_quality_probe.py
"""
import json
import os
import random
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import goal_highlight_probe as gh  # noqa: E402  复用与 App 同口径的 head_of/DICT
from cdp import CDP  # noqa: E402

URL = "http://127.0.0.1:8765/index.html"
BLANK = "http://127.0.0.1:8765/app.css"
STORE = "ldleRead.mobile.v1"
ARTS = os.path.join(os.path.dirname(os.path.dirname(HERE)), "mobile", "android", "app",
                    "src", "main", "assets", "www", "data", "articles.json")
WORD = re.compile(r"[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]+"
                  r"(?:['’][A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]+)*")

FAILS = []
N = [0]


def check(name, ok, detail=""):
    N[0] += 1
    if not ok:
        FAILS.append(name)
    if not ok or detail != "":
        print(("  PASS " if ok else "  FAIL ") + name + (("  " + str(detail)) if detail != "" else ""))


def model_heads():
    arts = json.load(open(ARTS, encoding="utf-8"))["articles"]
    heads = set()
    for a in arts:
        for p in a.get("p") or []:
            for w in WORD.findall(p):
                h = gh.head_of(w)
                if len(h) > 1:
                    heads.add(h)
    return sorted(heads)


def seed(c):
    c.nav(BLANK)
    time.sleep(.4)
    c.ev("localStorage.clear(); localStorage.setItem(%r,%r)" % (
        STORE, json.dumps({"version": 4, "settings": {
            "onboarded": 1, "last_level": 3, "update_freq": "never", "known_mode": "gk"}})))


def boot(c):
    c.nav(URL)
    for _ in range(100):
        if c.ev("!!document.querySelector('#app') && !document.querySelector('#app').classList.contains('hidden')"):
            break
        time.sleep(.2)
    time.sleep(.7)
    c.ev("document.querySelector(\".tab[data-tab='flash']\").click()")
    time.sleep(.7)


def type_q(c, q):
    c.ev("""(function(){var i=document.querySelector('#fcSearchQ');
      var s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      s.call(i,%r); i.dispatchEvent(new Event('input',{bubbles:true}));})()""" % q)
    time.sleep(.22)


def rows(c):
    return c.ev("""[].map.call(document.querySelectorAll('#fcSug .fc-sug-row'),function(e){
      return [e.getAttribute('data-fc-word'), e.querySelector('.fc-sug-d').textContent];})""")


def open_row(c, word):
    ok = c.ev("""(function(){var rows=[].slice.call(document.querySelectorAll('#fcSug .fc-sug-row'));
      for (var i=0;i<rows.length;i++){ if(rows[i].getAttribute('data-fc-word')===%r){ rows[i].click(); return true; } }
      return rows.length ? (rows[0].click(), 'first') : false;})()""" % word)
    time.sleep(.25)
    return ok


def sheet(c):
    return c.ev("""(function(){
      var w=document.querySelector('.sheet-word'), m=document.querySelector('.sheet-mean');
      return {word: w?w.textContent:'', mean: m?m.textContent:'', miss: !!document.querySelector('.sheet-miss')};})()""")


def close_sheet(c):
    c.ev("(document.querySelector('#backdrop')||{click:function(){}}).click()")
    time.sleep(.15)


def english(c):
    print("\n== 英文搜词 → 词卡 ==")
    heads = model_heads()
    random.seed(20261030)
    sample = random.sample(heads, 80)
    sample += ["multimessenger", "caregiving", "reskilling", "chatbots", "metaverse",
               "esports", "piko", "macropod", "protoscience", "texters", "odegaard",
               "gyorgyi", "distingue", "thinner", "scrooge", "cliche", "haiku",
               "translink", "côte", "antipoverty"]
    bad_missing, bad_exact, bad_def, bad_word = [], [], [], []
    for w in sample:
        type_q(c, w)
        rs = rows(c)
        if not rs or rs[0][0] != w:
            bad_exact.append((w, rs[:2]))
        ok = open_row(c, w)
        sh = sheet(c)
        if not ok:
            bad_missing.append((w, 'no-row'))
        elif sh["miss"] or not sh["mean"].strip():
            bad_missing.append((w, sh))
        elif sh["word"].split(" ")[0] != gh.head_of(w):
            bad_word.append((w, sh["word"]))
        close_sheet(c)
    check("精确匹配排第一(%d 个)" % len(sample), not bad_exact, bad_exact[:6])
    check("词卡都有释义、无「未收录」", not bad_missing, bad_missing[:6])
    check("词卡词头正确", not bad_word, bad_word[:6])
    print("   抽查 %d 个词头" % len(sample))


def chinese(c):
    print("\n== 中文搜词 ==")
    type_q(c, "政府")
    listed = rows(c)
    check("中文查询有结果", bool(listed), listed[:2])
    check("建议行带中文释义", bool(listed) and "政府" in listed[0][1], listed[:1])
    pairs = [("政府", "government"), ("美丽", "beautiful"), ("宇宙", "universe"),
             ("朋友", "friend"), ("洪水", "flood"), ("疾病", "disease"),
             ("气候", "climate"), ("担心", "worry"), ("放弃", "abandon"),
             ("恐龙", "dinosaur")]
    bad_top, bad_snip = [], []
    for q, want in pairs:
        type_q(c, q)
        rs = rows(c)
        top = [x[0] for x in rs[:5]]
        if not rs or want not in top:
            bad_top.append((q, want, top))
        if not rs or q not in rs[0][1]:
            bad_snip.append((q, rs[:1]))
    check("常用中文查询首条是常用词", not bad_top, bad_top[:5])
    check("首条建议显示命中段", not bad_snip, bad_snip[:5])
    type_q(c, "恐龙")
    open_row(c, rows(c)[0][0])
    sh = sheet(c)
    check("中文结果点开无「未收录」", not sh["miss"] and bool(sh["mean"].strip()), sh)
    check("词卡释义含查询词", "恐龙" in sh["mean"], sh["mean"][:40])
    close_sheet(c)
    type_q(c, "龘龘")
    none = c.ev("(document.querySelector('.fc-sug-none')||{}).textContent")
    check("无结果有中文提示", none == "没有找到匹配的词", none)


def english_regress(c):
    print("\n== 英文搜索不回归 ==")
    type_q(c, "Abandon")
    rs = rows(c)
    check("大小写不敏感且精确排第一", bool(rs) and rs[0][0] == "abandon", rs[:2])
    type_q(c, "cliché")
    rs = rows(c)
    check("重音输入能折回 ASCII", bool(rs) and rs[0][0] == "cliche", rs[:2])
    type_q(c, "")
    hidden = c.ev("document.querySelector('#fcSug').hasAttribute('hidden')")
    check("清空输入隐藏建议", hidden is True)


def private_phrases(c):
    print("\n== 固定短语 ==")
    type_q(c, "ark")
    rs = rows(c)
    got = [x[0] for x in rs[:4]]
    shown = c.ev("""[].map.call(document.querySelectorAll('#fcSug .fc-sug-w'),function(e){return e.textContent;})""")
    check("Ark 同时出 Arknights 与完整短语", "arknights" in got and "arknights: endfield" in got, got)
    check("短语显示原名大小写", "Arknights: Endfield" in shown and "Arknights" in shown, shown[:4])
    type_q(c, "endf")
    rs = rows(c)
    check("Endfield 能搜到完整短语", bool(rs) and rs[0][0] == "arknights: endfield", rs[:2])
    type_q(c, "终末地")
    rs = rows(c)
    check("中文也只出完整短语", [x[0] for x in rs] == ["arknights: endfield"], rs[:3])
    open_row(c, "arknights: endfield")
    sh = sheet(c)
    check("短语词卡不拆分", sh["word"].startswith("Arknights: Endfield"), sh["word"])
    close_sheet(c)


def main():
    c = CDP()
    try:
        seed(c)
        boot(c)
        check("无 JS 异常(启动)", c.errors == [], c.errors[-2:])
        english(c)
        chinese(c)
        english_regress(c)
        private_phrases(c)
        check("无 JS 异常(全程)", c.errors == [], c.errors[-3:])
    finally:
        c.close()
    print("\n断言 %d 条,失败 %d 条" % (N[0], len(FAILS)))
    if FAILS:
        for f in FAILS:
            print("  FAILED:", f)
        sys.exit(1)
    print("ALL GREEN")


if __name__ == "__main__":
    main()
