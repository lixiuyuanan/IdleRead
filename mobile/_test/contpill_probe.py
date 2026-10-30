# -*- coding: utf-8 -*-
"""接着读浮条探针:列表页展开成卡片、其他页缩成右侧窄条、可拖、可关。

先确保 www 下有静态服务器:
    cd mobile/android/app/src/main/assets/www && python -m http.server 8765
然后:
    python mobile/_test/contpill_probe.py
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

FAILS = []
NASSERT = [0]


def check(name, ok, detail=""):
    NASSERT[0] += 1
    if not ok:
        FAILS.append(name)
    print(("  PASS " if ok else "  FAIL ") + name
          + (("  " + str(detail)) if detail != "" else ""))


def seed(c, obj):
    c.nav(BLANK)
    time.sleep(.4)
    c.ev("localStorage.setItem(%r,%r)" % (STORE, json.dumps(obj, ensure_ascii=False)))


def boot(c):
    # 开着触控模拟直接重新导航,Chrome 偶发整进程退出;先关掉,加载完再开。
    try:
        c.call("Emulation.setTouchEmulationEnabled", enabled=False)
    except Exception:
        pass
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
    time.sleep(.7)
    try:
        c.call("Emulation.setTouchEmulationEnabled", enabled=True, maxTouchPoints=5)
    except Exception:
        pass


def click(c, sel, wait=.6):
    ok = c.ev("(function(){var e=document.querySelector(%r);if(!e)return false;"
              "e.click();return true;})()" % sel)
    time.sleep(wait)
    return ok


def state(c):
    raw = c.ev("localStorage.getItem(%r)" % STORE)
    return json.loads(raw) if raw else {}


def pill(c):
    return c.ev("(function(){var e=document.querySelector('#contPill');if(!e)return null;"
                "var r=e.getBoundingClientRect();"
                "return {hidden:e.classList.contains('hidden'),"
                "card:!!e.querySelector('.cont-card'),rail:!!e.querySelector('.cont-rail'),"
                "text:(e.textContent||'').replace(/\\s+/g,''),"
                "top:Math.round(e.style.top?parseFloat(e.style.top):r.top),"
                "left:Math.round(r.left),w:Math.round(r.width),h:Math.round(r.height)};})()")


def touch(c, kind, x=None, y=None, delay=.06):
    pts = [] if kind == "touchEnd" else [{"x": x, "y": y, "radiusX": 9,
                                          "radiusY": 9, "force": 1, "id": 1}]
    c.call("Input.dispatchTouchEvent", type=kind, touchPoints=pts)
    time.sleep(delay)


def main():
    c = CDP()
    try:
        seed(c, {"version": 4, "settings": {"onboarded": 1, "last_level": 5,
                                            "update_freq": "never"}})
        boot(c)

        print("== 1 还没读过文章 ==")
        p = pill(c)
        check("没有上次文章时不显示", p["hidden"] is True, p)
        check("列表顶部旧卡片已去掉",
              c.ev("document.querySelectorAll('.continue-card').length") == 0)

        print("\n== 2 读一篇再退出 ==")
        c.ev("(document.querySelector('#view .art')||{}).click()")
        time.sleep(.9)
        check("正文页不显示浮条", pill(c)["hidden"] is True, pill(c))
        c.ev("window.appBack()")
        time.sleep(.9)
        p = pill(c)
        check("退回列表浮条出现", p["hidden"] is False, p)
        check("列表页是展开卡片", p["card"] is True and p["rail"] is False, p)
        check("卡片有「接着读」", "接着读" in p["text"], p["text"])
        st = state(c)
        stem = st.get("last_stem")
        title = c.ev("(function(){var e=document.querySelector('#contPill .cont-t');"
                     "return e?e.textContent.trim():'';})()")
        check("卡片显示文章名", bool(title) and len(title) >= 4, title)
        check("卡片在屏幕中下位置", p["top"] > 200, p["top"])
        check("卡片贴右边", p["left"] + p["w"] >= c.ev("window.innerWidth") - 1,
              "%s+%s" % (p["left"], p["w"]))

        print("\n== 3 收起 / 展开 ==")
        cardH, cardTop = p["h"], p["top"]
        click(c, "#contPill [data-act='cont-fold']", .5)
        p = pill(c)
        check("收起后是窄条", p["rail"] is True and p["card"] is False, p)
        check("收起后只剩展开图标", p["text"] == "‹", p["text"])
        # 窄条写死 44 的话,收起后顶部不动、底部短 13px,看着就是
        # 「展开和缩回上下边界不一致」。所以要求高度和顶部都跟卡片一致。
        check("收起后和卡片等高", p["h"] == cardH, "rail %s vs card %s" % (p["h"], cardH))
        check("收起后顶部不动", p["top"] == cardTop, "rail %s vs card %s" % (p["top"], cardTop))
        check("收起状态点一下不会进正文",
              c.ev("(function(){var e=document.querySelector('#contPill .cont-rail');"
                   "if(!e)return 'no-rail';e.click();return "
                   "document.body.classList.contains('reader');})()") is False)
        click(c, "#contPill [data-act='cont-open']", .5)
        p = pill(c)
        check("再展开回到卡片", p["card"] is True, p)

        print("\n== 4 点卡片回到文章 ==")
        click(c, "#contPill .cont-card", 1.0)
        check("点卡片进了正文", c.ev("document.body.classList.contains('reader')") is True)
        c.ev("window.appBack()")
        time.sleep(.9)
        check("退出后浮条又回来", pill(c)["card"] is True, pill(c))

        print("\n== 5 其他页面缩成侧条 ==")
        click(c, ".tab[data-tab='stats']", .8)
        p = pill(c)
        check("统计页缩成窄条", p["hidden"] is False and p["rail"] is True, p)
        click(c, ".tab[data-tab='me']", .8)
        p = pill(c)
        check("我的页仍是窄条", p["rail"] is True, p)
        click(c, "[data-act='go-set']", .8)
        check("设置页仍是窄条", pill(c)["rail"] is True, pill(c))
        click(c, ".tab[data-tab='read']", .8)
        check("回列表又展开", pill(c)["card"] is True, pill(c))

        print("\n== 6 拖动记住位置 ==")
        before = pill(c)
        y = before["top"] + 20
        x = before["left"] + 40
        touch(c, "touchStart", x, y)
        for k in range(1, 7):
            touch(c, "touchMove", x, y - 20 * k)
        touch(c, "touchEnd", delay=.5)
        after = pill(c)
        check("拖动后位置变高", after["top"] < before["top"] - 80,
              "%s -> %s" % (before["top"], after["top"]))
        check("拖动不会误开文章",
              c.ev("document.body.classList.contains('reader')") is False)
        ratio = (state(c).get("settings") or {}).get("cont_pill_y")
        check("纵向比例已落盘", isinstance(ratio, (int, float)), ratio)

        boot(c)
        p = pill(c)
        check("冷启动还原拖动后的位置", abs(p["top"] - after["top"]) <= 4,
              "%s vs %s" % (p["top"], after["top"]))

        print("\n== 7 外观设置里可以关掉 ==")
        click(c, ".tab[data-tab='me']", .7)
        click(c, "[data-act='go-set']", .7)
        click(c, "[data-act='go-appearance']", .8)
        check("外观页有开关", c.ev("!!document.querySelector('#contPillSw')") is True)
        click(c, "#contPillSw", .6)
        check("关掉后浮条消失", pill(c)["hidden"] is True, pill(c))
        click(c, "#contPillSw", .6)
        check("再打开浮条回来", pill(c)["hidden"] is False, pill(c))
        check("全程无 JS 异常", c.errors == [], c.errors[-3:])
    finally:
        c.close()

    print("\n断言 %d 条,失败 %d 条" % (NASSERT[0], len(FAILS)))
    if FAILS:
        print("FAILED: " + " / ".join(FAILS))
        sys.exit(1)
    print("ALL GREEN")


if __name__ == "__main__":
    main()
