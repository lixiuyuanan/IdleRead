# -*- coding: utf-8 -*-
"""1.7.1 收尾改动探针:统计 7 天、关闭番外、设置图标。

先确保 www 下有静态服务器:
    cd mobile/android/app/src/main/assets/www && python -m http.server 8765
然后:
    python mobile/_test/ui172_probe.py
"""
import datetime
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from cdp import CDP  # noqa: E402

URL = "http://127.0.0.1:8765/index.html"
BLANK = "http://127.0.0.1:8765/app.css"
STORE = "ldleRead.mobile.v1"

FAILS = []
NASSERT = [0]


def check(name, ok, detail=""):
    NASSERT[0] += 1
    if not ok:
        FAILS.append(name)
    print(("  PASS " if ok else "  FAIL ") + name + (("  " + str(detail)) if detail != "" else ""))


def seed(c, obj):
    c.nav(BLANK)
    time.sleep(.4)
    c.ev("localStorage.setItem(%r,%r)" % (STORE, json.dumps(obj, ensure_ascii=False)))


def boot(c):
    # 导航还没落地时,旧文档里 #app 也是可见的,只看这一条会提前返回、
    # 断言全打在上一页上。先给旧文档打标记,新文档里没有它才算加载完。
    try:
        c.ev("window.__probeMark = 1")
    except Exception:
        pass
    c.nav(URL)
    for _ in range(150):
        try:
            if c.ev("typeof window.__probeMark === 'undefined' && "
                    "!document.querySelector('#app').classList.contains('hidden')"):
                break
        except Exception:
            pass
        time.sleep(.15)
    time.sleep(.5)


def click(c, sel, wait=.5):
    ok = c.ev("(function(){var e=document.querySelector(%r);if(!e)return false;e.click();return true;})()" % sel)
    time.sleep(wait)
    return ok


def title(c):
    return c.ev("document.querySelector('#topTitle').textContent")


def run_stats():
    print("\n== 统计 7 天 ==")
    c = CDP()
    try:
        day = datetime.date.today()
        key = lambda n: (day - datetime.timedelta(days=n)).isoformat()
        seed(c, {
            "version": 4,
            "settings": {"onboarded": 1, "last_level": 2, "update_freq": "never"},
            "days": {key(0): {"words": 10, "checks": 1}, key(1): {"words": 20},
                     key(6): {"words": 40}, key(7): {"words": 80}},
        })
        boot(c)
        click(c, ".tab[data-tab='stats']", .7)
        check("进入统计", title(c) == "统计", title(c))
        txt = c.ev("document.querySelector('#view').textContent")
        check("标题=近 7 天", "近 7 天每天读了多少词" in txt, txt[:40])
        check("不再出现 14 天", "14 天" not in txt)
        check("近 7 天合计=70(不含第 8 天)", "70" in txt, txt[:120])
        bars = c.ev("[].map.call(document.querySelectorAll('#view .bar'),function(e){return e.getAttribute('title')||'';})")
        check("柱子 7 根", len(bars) == 7, bars)
        labels = c.ev("[].map.call(document.querySelectorAll('#view .bar span'),function(e){return e.textContent;})")
        check("7 天都带日期", len([x for x in labels if x]) == 7, labels)
        check("统计页无 JS 异常", c.errors == [], c.errors[-3:])
    finally:
        c.close()


def run_epilogue_and_icon():
    print("\n== 番外关闭 / 设置图标 ==")
    c = CDP()
    try:
        seed(c, {
            "version": 4,
            "settings": {"onboarded": 1, "last_level": 2, "update_freq": "never"},
        })
        boot(c)
        chips = c.ev("[].map.call(document.querySelectorAll('#levelStrip .chip'),function(e){return e.textContent;})")
        check("难度条无番外", not any("番外" in (x or "") for x in chips), chips)
        check("难度条 8 档(书架+7)", len(chips) == 8, chips)

        click(c, "#actionBtn", .6)
        stxt = c.ev("document.querySelector('#sheet').textContent")
        check("阅读菜单仍可打开", "导入图书" in (stxt or ""), (stxt or "")[:60])
        check("阅读菜单无生成番外", "番外" not in (stxt or ""), (stxt or "")[:120])
        check("无 epilogue 菜单项", c.ev("!!document.querySelector('[data-menu-act=\\'epilogue\\']')") is False)
        click(c, "#backdrop", .3)

        click(c, ".tab[data-tab='me']", .7)
        row = c.ev("(function(){var e=document.querySelector('[data-act=\\'go-set\\'] .me-ico');"
                   "return e?e.innerHTML:'';})()")
        check("设置行图标=矢量齿轮", row.strip().startswith("<svg"), row[:60])
        check("我的页无番外", "番外" not in c.ev("document.querySelector('#view').textContent"))
        check("无 JS 异常", c.errors == [], c.errors[-3:])
    finally:
        c.close()


def run_last_level_zero():
    print("\n== 上次停在番外的回退 ==")
    c = CDP()
    try:
        seed(c, {
            "version": 4,
            "settings": {"onboarded": 1, "last_level": 0, "update_freq": "never"},
        })
        boot(c)
        check("回到阅读页", title(c) == "阅读", title(c))
        check("有文章可读", c.ev("document.querySelectorAll('#view .art').length") > 0)
        sel = c.ev("document.querySelector('#levelStrip .chip.on') && document.querySelector('#levelStrip .chip.on').textContent")
        check("选中档不是番外", "番外" not in (sel or ""), sel)
        check("无 JS 异常", c.errors == [], c.errors[-3:])
    finally:
        c.close()


def run_primary():
    print("\n== 小学档 ==")
    c = CDP()
    try:
        # 手机宽度:难度条在桌面上放得下 8 颗 chip,不滚动就测不了居中。
        c.call("Emulation.setDeviceMetricsOverride", width=390, height=844,
               deviceScaleFactor=2, mobile=True)
        seed(c, {
            "version": 4,
            "settings": {"onboarded": 1, "last_level": 2, "update_freq": "never"},
        })
        boot(c)
        chips = c.ev("[].map.call(document.querySelectorAll('#levelStrip .chip'),function(e){return e.textContent;})")
        check("难度条含小学", any((x or "").startswith("小学") for x in chips), chips)
        ok = c.ev("(function(){var e=document.querySelector('#levelStrip .chip[data-level=\\'1\\']');if(!e)return false;e.click();return true;})()", )
        time.sleep(.08)
        mid = c.ev("document.querySelector('#levelStrip .chip.on') && document.querySelector('#levelStrip .chip.on').textContent")
        check("能切到小学档", ok is True)
        check("转场中选中态已落新档", (mid or "").startswith("小学"), mid)
        time.sleep(1.0)
        sel1 = c.ev("document.querySelector('#levelStrip .chip.on') && document.querySelector('#levelStrip .chip.on').textContent")
        check("落位后选中的仍是小学", (sel1 or "").startswith("小学"), sel1)
        # 中间档位才测真居中;小学/考研二贴着两头,居中本来就被滚动范围钳住
        ok2 = c.ev("(function(){var e=document.querySelector('#levelStrip .chip[data-level=\\'5\\']');if(!e)return false;e.click();return true;})()", )
        time.sleep(1.0)
        delta = c.ev("(function(){var b=document.querySelector('#levelStrip .chips');"
                     "var c=b.querySelector('.chip.on');"
                     "var br=b.getBoundingClientRect(),cr=c.getBoundingClientRect();"
                     "return Math.round(cr.left+cr.width/2-br.left-br.width/2);})()")
        sel = c.ev("document.querySelector('#levelStrip .chip.on') && document.querySelector('#levelStrip .chip.on').textContent")
        check("点六级自动居中", ok2 is True and (sel or "").startswith("六级") and abs(delta) <= 3,
              "%s delta=%s" % (sel, delta))
        c.ev("(function(){var e=document.querySelector('#levelStrip .chip[data-level=\\'1\\']');if(!e)return false;e.click();return true;})()", )
        time.sleep(1.0)
        n = c.ev("document.querySelectorAll('#view .art').length")
        check("小学 50 篇", n == 50, n)
        t0 = c.ev("document.querySelector('#view .art .art-title') && document.querySelector('#view .art .art-title').textContent")
        check("标题=中文 English", bool(t0 and t0.strip()), t0)
        click(c, "#view .art", 1.0)
        check("打开小学文章", c.ev("document.body.classList.contains('reader')") is True)
        paras = c.ev("document.querySelectorAll('#readBody .para, #view .para').length")
        check("正文有段落", paras > 0, paras)
        check("无 JS 异常", c.errors == [], c.errors[-3:])
    finally:
        c.close()


def main():
    run_stats()
    run_epilogue_and_icon()
    run_last_level_zero()
    run_primary()
    print("\n断言 %d 条,失败 %d 条" % (NASSERT[0], len(FAILS)))
    if FAILS:
        for f in FAILS:
            print("  FAILED:", f)
        sys.exit(1)
    print("ALL GREEN")


if __name__ == "__main__":
    main()
