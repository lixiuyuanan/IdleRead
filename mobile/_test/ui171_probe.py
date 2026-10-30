# -*- coding: utf-8 -*-
"""1.7.1 界面改动探针(本地测试用)。

先确保 www 下有静态服务器:
    cd mobile/android/app/src/main/assets/www && python -m http.server 8765
然后:
    python mobile/_test/ui171_probe.py

覆盖:
  A 「我的」：学习目标显示小学；KPI=已读完；点进去是已读完列表(新的在前)；
     点行开文章、返回回列表；「历史记录」行仍进历史；页脚 tagline 原样
  B 镜像源页：来源=同步源；新文案到位
  C 自动检查到新版本：在阅读页直接弹更新框(最顶层 z-index)，稍后关闭且不写 update_skip
"""
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
WWW = os.path.join(HERE, "..", "android", "app", "src", "main", "assets", "www")

FAILS = []
NASSERT = [0]


def check(name, ok, detail=""):
    NASSERT[0] += 1
    if not ok:
        FAILS.append(name)
    print(("  PASS " if ok else "  FAIL ") + name + (("  " + str(detail)) if detail != "" else ""))


def load_articles():
    with open(os.path.join(WWW, "data", "articles.json"), encoding="utf-8") as f:
        return json.load(f)["articles"]


def pick_stems():
    arts = [a for a in load_articles() if a.get("l") == 2]
    return arts[0]["s"], arts[1]["s"], arts[2]["s"]


def seed(c, obj):
    c.nav(BLANK)
    time.sleep(.4)
    c.ev("localStorage.setItem(%r,%r)" % (STORE, json.dumps(obj, ensure_ascii=False)))


def boot(c):
    c.nav(URL)
    for _ in range(100):
        if c.ev("!document.querySelector('#app').classList.contains('hidden')"):
            break
        time.sleep(.2)
    time.sleep(.5)


def click(c, sel, wait=.5):
    ok = c.ev("(function(){var e=document.querySelector(%r);if(!e)return false;e.click();return true;})()" % sel)
    time.sleep(wait)
    return ok


def title(c):
    return c.ev("document.querySelector('#topTitle').textContent")


def view_text(c):
    return c.ev("document.querySelector('#view').textContent")


def run_a():
    print("\n== A 我的 / 已读完 / 镜像源 ==")
    s1, s2, s3 = pick_stems()

    new_cdp = CDP()
    try:
        seed(new_cdp, {
            "version": 4,
            "settings": {"onboarded": 1, "last_level": 2, "update_freq": "never"},
            "articles": {
                s1: {"read": [0], "done": True, "done_at": "2026-10-25", "times": 1},
                s2: {"read": [0], "done": True, "done_at": "2026-10-28", "times": 1},
                s3: {"read": [0], "done": False, "times": 1},
            },
            "history": [{"s": s3, "at": 1793200000000, "p": 0}],
            "mirrors": {"list": [{"name": "mirror-a", "url": "http://127.0.0.1:8765/a"}],
                        "updated": "2026-10-29 10:00"},
        })
        boot(new_cdp)
        check("启动后默认在阅读", title(new_cdp) == "阅读", title(new_cdp))

        click(new_cdp, ".tab[data-tab='me']", .6)
        check("进入我的", title(new_cdp) == "我的", title(new_cdp))
        txt = view_text(new_cdp)
        check("学习目标显示「小学」", "小学" in txt, txt[:60])
        check("页面不再出现「初学者」", "初学者" not in txt)
        check("页脚 tagline 原样", "读闲书,长词汇" in txt and "读闲书,长词汇。" not in txt,
              [x for x in txt.split() if "读闲书" in x])

        kpi = new_cdp.ev("(function(){var e=document.querySelector('[data-act=\\'go-done\\']');"
                         "return e?e.textContent:'';})()")
        check("KPI 文案=已读完", "已读完" in kpi, kpi)
        check("KPI 数字=2", kpi.strip().startswith("2"), kpi)

        click(new_cdp, "[data-act='go-done']", .7)
        check("点 KPI 进已读完页", title(new_cdp) == "已读完", title(new_cdp))
        rows = new_cdp.ev("[].map.call(document.querySelectorAll('#view .art'),"
                          "function(e){return e.getAttribute('data-stem');})")
        check("已读完列表 2 篇", len(rows) == 2, rows)
        check("新的在前(10-28)", rows and rows[0] == s2, rows)
        check("列表带已读完标记", "已读完" in view_text(new_cdp))
        check("没有混进未读完的", s3 not in rows, rows)

        click(new_cdp, "#view .art", .9)
        check("点行进阅读页", new_cdp.ev("document.body.classList.contains('reader')") is True)
        new_cdp.ev("window.appBack && window.appBack()")
        time.sleep(.7)
        check("返回仍在已读完", title(new_cdp) == "已读完", title(new_cdp))
        new_cdp.ev("window.appBack && window.appBack()")
        time.sleep(.7)
        check("再返回回我的", title(new_cdp) == "我的", title(new_cdp))

        click(new_cdp, "[data-act='go-history']", .7)
        check("历史记录行仍进历史", title(new_cdp) == "历史记录", title(new_cdp))
        new_cdp.ev("window.appBack && window.appBack()")
        time.sleep(.7)

        click(new_cdp, "[data-act='go-set']", .6)
        click(new_cdp, "[data-act='go-mirror']", .8)
        check("进入下载镜像源", title(new_cdp) == "下载镜像源", title(new_cdp))
        mtxt = view_text(new_cdp)
        check("来源 chip=同步源", "同步源" in mtxt and "同步来的" not in mtxt, mtxt[:40])
        check("恢复默认清单按钮", "恢复默认清单" in mtxt, mtxt[:40])
        check("新文案:获取清单", "获取失败时继续使用当前清单" in mtxt)
        check("新文案:测速", "优先使用较快的源" in mtxt)
        check("新文案:顺序", "列表顺序与速度无关" in mtxt)
        check("A 段无 JS 异常", new_cdp.errors == [], new_cdp.errors[-3:])
    finally:
        new_cdp.close()


AUTO_SCRIPT = """
window.Android = new Proxy({}, { get: function (t, k) {
  if (k === 'checkUpdate') {
    return function (id) {
      setTimeout(function () {
        window.__updateResult(id, JSON.stringify({
          ok: true, version: '9.9.9', url: 'http://127.0.0.1:8765/x.apk',
          notes: '测试更新说明', sha: 'deadbeef', size: 1234
        }));
      }, 40);
    };
  }
  return function () { return ''; };
}});
"""


def run_b():
    print("\n== C 自动弹更新框 ==")
    s1, s2, s3 = pick_stems()
    c = CDP()
    try:
        seed(c, {
            "version": 4,
            "settings": {"onboarded": 1, "last_level": 2, "update_freq": "launch"},
            "articles": {s1: {"read": [0], "done": False, "times": 1}},
        })
        c.call("Page.addScriptToEvaluateOnNewDocument", source=AUTO_SCRIPT)
        boot(c)
        click(c, "#view .art", .8)
        check("先进入阅读页", c.ev("document.body.classList.contains('reader')") is True)

        shown = False
        for _ in range(40):
            if c.ev("!document.querySelector('#sheet').classList.contains('hidden')"):
                shown = True
                break
            time.sleep(.2)
        check("当前页自动弹出更新框", shown)
        stxt = c.ev("document.querySelector('#sheet').textContent")
        check("弹出内容是新版本", "发现新版本 v9.9.9" in (stxt or ""), (stxt or "")[:60])
        check("阅读页仍在下面(没跳页)", c.ev("document.body.classList.contains('reader')") is True)
        zs = c.ev("getComputedStyle(document.querySelector('#sheet')).zIndex")
        zb = c.ev("getComputedStyle(document.querySelector('#backdrop')).zIndex")
        check("弹层 z-index=70", zs == "70", zs)
        check("遮罩 z-index=69", zb == "69", zb)
        check("弹层高于长按菜单(60)", int(zs or 0) > 60, zs)

        click(c, "[data-sheet-act='update-later']", .8)
        check("点稍后关闭", c.ev("document.querySelector('#sheet').classList.contains('hidden')") is True)
        skip = c.ev("JSON.parse(localStorage.getItem(%r)).settings.update_skip" % STORE)
        check("稍后不写 update_skip", skip == "", skip)
        check("C 段无 JS 异常", c.errors == [], c.errors[-3:])
    finally:
        c.close()


def main():
    run_a()
    run_b()
    print("\n断言 %d 条,失败 %d 条" % (NASSERT[0], len(FAILS)))
    if FAILS:
        for f in FAILS:
            print("  FAILED:", f)
        sys.exit(1)
    print("ALL GREEN")


if __name__ == "__main__":
    main()
