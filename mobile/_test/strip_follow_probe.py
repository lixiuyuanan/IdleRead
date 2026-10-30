# -*- coding: utf-8 -*-
"""难度条选中框「跟手」探针（1.7.3 前的手势改造）。

验的是:拖动过程中 chip.on 随实时提交判定切换,而不是抬手后才补一下。
全程用 CDP 真实触控(Input.dispatchTouchEvent),不用 JS 合成事件。

先确保 www 下有静态服务器:
    cd mobile/android/app/src/main/assets/www && python -m http.server 8765
然后:
    python mobile/_test/strip_follow_probe.py

注意:探针复用 _test/profile 与 9222 端口,上一轮 Chrome 没退干净会连到旧页面,
表现为莫名其妙的 FAIL。跑之前先确认没有残留 chrome.exe。
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
POS = [0, 0]   # 当前手指位置,跨 move_to 保持


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
    c.nav(URL)
    for _ in range(100):
        if c.ev("!document.querySelector('#app').classList.contains('hidden')"):
            break
        time.sleep(.2)
    time.sleep(.6)


def touch(c, kind, x=None, y=None, delay=.05):
    pts = [] if kind == "touchEnd" else [{"x": x, "y": y, "radiusX": 9,
                                          "radiusY": 9, "force": 1, "id": 1}]
    c.call("Input.dispatchTouchEvent", type=kind, touchPoints=pts)
    time.sleep(delay)


def press(c, x, y, delay=.05):
    POS[0], POS[1] = x, y
    touch(c, "touchStart", x, y, delay)


def move_to(c, x, delay=.06, step=20):
    """慢速挪到 x:每步 20px / 60ms ≈ 0.33 px/ms,低于 SWAP_VEL=0.5,
    这样"没跨过距离阈值"的断言不会被速度甩动误判成 flick。"""
    y = POS[1]
    cx = POS[0]
    sign = 1 if x > cx else -1
    while abs(x - cx) > 0.5:
        cx += sign * min(step, abs(x - cx))
        touch(c, "touchMove", cx, y, delay)
    POS[0] = cx


def release(c, wait=.45):
    touch(c, "touchEnd", delay=wait)


def on_chip(c):
    return c.ev("(function(){var e=document.querySelector('#levelStrip .chip.on');"
                "return e?e.textContent.trim():null;})()")


def chip_names(c):
    return c.ev("[].map.call(document.querySelectorAll('#levelStrip .chip'),"
                "function(e){return e.textContent.trim();})")


def center_delta(c):
    return c.ev("(function(){var b=document.querySelector('#levelStrip .chips'),"
                "e=b&&b.querySelector('.chip.on');if(!e)return null;"
                "var br=b.getBoundingClientRect(),cr=e.getBoundingClientRect();"
                "return Math.round((cr.left+cr.width/2)-(br.left+br.width/2));})()")


def first_art(c):
    return c.ev("(function(){var e=document.querySelector('#view .art');"
                "return e?e.textContent.trim().slice(0,24):null;})()")


def strip_scroll(c):
    return c.ev("(function(){var b=document.querySelector('#levelStrip .chips');"
                "return b?Math.round(b.scrollLeft):null;})()")


def click_sel(c, sel, wait=.55):
    ok = c.ev("(function(){var e=document.querySelector(%r);"
              "if(!e)return false;e.click();return true;})()" % sel)
    time.sleep(wait)
    return ok


def main():
    c = CDP()
    try:
        c.call("Emulation.setTouchEmulationEnabled", enabled=True, maxTouchPoints=5)
        seed(c, {"version": 4, "settings": {"onboarded": 1, "last_level": 5,
                                            "update_freq": "never"}})
        boot(c)

        chips = chip_names(c)
        print("  chips", chips)
        check("起手在六级", (on_chip(c) or "").startswith("六级"), on_chip(c))

        w = c.ev("document.querySelector('#view').clientWidth")
        th = w * 0.6
        print("  屏宽 %s / 阈值 %s" % (w, round(th, 1)))
        art0 = first_art(c)
        strip0 = strip_scroll(c)

        # --- 1) 拖到阈值内:保持原档 ---
        print("\n== 1 阈值内拖动 ==")
        press(c, 60, 420)
        move_to(c, 60 + int(w * 0.30))
        check("0.30 屏宽时仍是六级", (on_chip(c) or "").startswith("六级"), on_chip(c))
        move_to(c, 60 + int(w * 0.50))
        check("0.50 屏宽时仍是六级", (on_chip(c) or "").startswith("六级"), on_chip(c))
        check("拖动中不滚难度条", strip_scroll(c) == strip0,
              "%s -> %s" % (strip0, strip_scroll(c)))

        # --- 2) 跨过阈值:立即变目标档 ---
        print("\n== 2 跨阈值跟随 ==")
        move_to(c, 60 + int(th) + 24)
        check("跨过 0.6 屏宽立刻变四级", (on_chip(c) or "").startswith("四级"), on_chip(c))
        check("跨阈值时页面还没落位", c.ev("document.querySelectorAll('.view-ghost').length") == 1)
        check("跨阈值时难度条仍不滚", strip_scroll(c) == strip0,
              "%s -> %s" % (strip0, strip_scroll(c)))

        # --- 3) 拖回阈值内:退回原档 ---
        print("\n== 3 退回阈值内 ==")
        move_to(c, 60 + int(w * 0.35))
        check("退回 0.35 屏宽又变回六级", (on_chip(c) or "").startswith("六级"), on_chip(c))

        # --- 4) 再跨阈值并松手:落位 ---
        print("\n== 4 跨阈值松手落位 ==")
        move_to(c, 60 + int(w * 0.72))
        check("松手前已是四级", (on_chip(c) or "").startswith("四级"), on_chip(c))
        release(c)
        time.sleep(.45)
        check("落位后选中四级", (on_chip(c) or "").startswith("四级"), on_chip(c))
        check("落位后列表换成四级内容", first_art(c) != art0, "%s -> %s" % (art0, first_art(c)))
        d = center_delta(c)
        check("落位后四级居中", d is not None and abs(d) <= 2, d)

        # --- 5) 点 chip:立即选中 + 居中 ---
        print("\n== 5 点 chip ==")
        click_sel(c, "#levelStrip .chip[data-level='3']")
        check("点 chip 立即选中高中", (on_chip(c) or "").startswith("高中"), on_chip(c))
        d = center_delta(c)
        check("点 chip 立即居中", d is not None and abs(d) <= 2, d)

        # --- 6) 阈值内松手:回弹,不换档 ---
        print("\n== 6 阈值内松手回弹 ==")
        click_sel(c, "#levelStrip .chip[data-level='5']")
        check("先回到六级", (on_chip(c) or "").startswith("六级"), on_chip(c))
        art1 = first_art(c)
        strip1 = strip_scroll(c)
        press(c, 60, 420)
        move_to(c, 60 + int(w * 0.45))
        check("回弹前仍显示六级", (on_chip(c) or "").startswith("六级"), on_chip(c))
        release(c)
        time.sleep(.45)
        check("回弹后仍是六级", (on_chip(c) or "").startswith("六级"), on_chip(c))
        check("回弹后列表没变", first_art(c) == art1, "%s -> %s" % (art1, first_art(c)))
        check("回弹后难度条滚动位置复原", strip_scroll(c) == strip1,
              "%s -> %s" % (strip1, strip_scroll(c)))
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
