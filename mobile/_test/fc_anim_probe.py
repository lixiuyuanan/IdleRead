# -*- coding: utf-8 -*-
"""复习页「开始 / 结束」的升起落下动画逐帧探针。

要求:
  · 点「开始」卡片从下方升起(translateY 26 -> 0, opacity 0 -> 1)
  · 点「结束」当前内容沉下去(translateY 0 -> 26, opacity 1 -> 0),落完回今日
  · 动画类播完必须摘干净,否则 fc-fall 的 both 会把下一页停在 opacity:0

用法:
    cd mobile/android/app/src/main/assets/www && python -m http.server 8765
    python mobile/_test/fc_anim_probe.py
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

W, H = 390, 844
FAILS = []
NASSERT = [0]

PROBE = """
window.__fcRec = function (act, ms) {
  var out = { frames: [], err: '' };
  var t0 = performance.now();
  var btn = document.querySelector('[data-act="' + act + '"]');
  if (!btn) { out.err = 'no-btn:' + act; return out; }
  btn.click();
  var n = 0, limit = Math.round((ms || 600) / 16);
  (function loop() {
    var v = document.querySelector('#view');
    var ty = 0, op = 1;
    if (v) {
      var cs = getComputedStyle(v);
      if (cs.transform && cs.transform !== 'none') {
        try { ty = Math.round(new DOMMatrixReadOnly(cs.transform).m42); } catch (e) {}
      }
      op = Math.round(+cs.opacity * 100) / 100;
    }
    out.frames.push([Math.round(performance.now() - t0), ty, op,
                     v ? v.className.replace('view', '').trim() : '']);
    if (++n > limit) return;
    requestAnimationFrame(loop);
  })();
  window.__fcOut = out;
  return true;
};
"""


def check(name, ok, detail=""):
    NASSERT[0] += 1
    if not ok:
        FAILS.append(name)
    print(("  PASS " if ok else "  FAIL ") + name
          + (("  " + str(detail)) if detail != "" else ""))


def boot(c):
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
    time.sleep(.8)
    c.call("Emulation.setDeviceMetricsOverride", width=W, height=H,
           deviceScaleFactor=2, mobile=True)
    c.ev(PROBE)


def run(c, act, ms=600):
    c.ev("window.__fcOut = null")
    c.ev("window.__fcRec(%r, %d)" % (act, ms))
    time.sleep(ms / 1000.0 + .5)
    return c.ev("window.__fcOut") or {}


def dump(label, frames):
    print("\n== %s ==" % label)
    print("   t(ms)  ty   op   #view class")
    for f in frames[:22]:
        print("  %5d %4d  %4.2f  %s" % (f[0], f[1], f[2], f[3]))


def main():
    c = CDP()
    try:
        c.nav(BLANK)
        time.sleep(.4)
        # 造两个今天到期的词,复习页才有「开始」按钮
        today = time.strftime("%Y-%m-%d")
        store = {
            "version": 4,
            "settings": {"onboarded": 1, "last_level": 5, "update_freq": "never"},
            "words": {
                "apple": {"st": 1, "n": 2, "first": today, "due": today,
                          "contexts": [], "note": ""},
                "book": {"st": 1, "n": 2, "first": today, "due": today,
                         "contexts": [], "note": ""},
            },
        }
        c.ev("localStorage.setItem(%r,%r)" % (STORE, json.dumps(store, ensure_ascii=False)))
        boot(c)

        c.ev("document.querySelector('#tabbar [data-tab=\"flash\"]').click()")
        time.sleep(.9)
        print("主页有开始按钮:", c.ev("!!document.querySelector('[data-act=\"fc-start\"]')"))
        print("到期词数:", c.ev(
            "(document.querySelector('.fc-count')||{}).textContent"))

        # ---- 开始:升起 ----
        r = run(c, "fc-start", 600)
        fr = r.get("frames") or []
        dump("点开始(升起)", fr)
        print()
        check("开始:采到帧", len(fr) > 5, len(fr))
        if fr:
            tys = [f[1] for f in fr]
            check("开始:从下方升起", tys[0] > 10, tys[:6])
            check("开始:最终回到 0", tys[-1] == 0, tys[-3:])
            mids = [t for t in tys[1:-1] if 0 < t < tys[0]]
            check("开始:有中间帧", len(mids) >= 2, mids[:6])
            check("开始:透明度跟着淡入", fr[0][2] < .5 and fr[-1][2] == 1,
                  [fr[0][2], fr[-1][2]])
            check("开始:动画类播完已摘", "fc-rise" not in (fr[-1][3] or ""),
                  fr[-1][3])
        check("开始后进了卡片", c.ev("!!document.querySelector('[data-act=\"fc-pass\"]')"))

        # ---- 结束:落下 ----
        r = run(c, "fc-home", 600)
        fr = r.get("frames") or []
        dump("点结束(落下)", fr)
        print()
        check("结束:采到帧", len(fr) > 5, len(fr))
        if fr:
            tys = [f[1] for f in fr]
            check("结束:向下沉", tys[-1] > 10 or min(tys) == 0 and tys[0] == 0,
                  tys[:6] + tys[-3:])
            check("结束:透明度降到 0", min(f[2] for f in fr) < .1,
                  sorted(set(f[2] for f in fr))[:5])
        time.sleep(.3)
        st = c.ev("(function(){var v=document.querySelector('#view');"
                  "var cs=getComputedStyle(v);"
                  "return {cls:v.className, op:+cs.opacity, ty:(function(){"
                  "if(!cs.transform||cs.transform==='none')return 0;"
                  "return Math.round(new DOMMatrixReadOnly(cs.transform).m42);})()};})()")
        print("落定后:", st)
        check("落定后没有残留动画类", "fc-fall" not in (st.get("cls") or ""), st)
        check("落定后页面可见", (st.get("op") or 0) > .95, st.get("op"))
        check("落定后回到今日", c.ev("!!document.querySelector('[data-act=\"fc-start\"]')"))

        # 落下途中切走:不能把别的页面留在 opacity:0
        print("\n== 落下途中切到阅读页 ==")
        c.ev("window.__fcRec('fc-start', 400)")
        time.sleep(.6)
        c.ev("document.querySelector('[data-act=\"fc-home\"]').click()")
        time.sleep(.05)
        c.ev("document.querySelector('#tabbar [data-tab=\"read\"]').click()")
        time.sleep(.8)
        st2 = c.ev("(function(){var v=document.querySelector('#view');"
                   "var cs=getComputedStyle(v);"
                   "return {cls:v.className, op:+cs.opacity};})()")
        print("  切走后:", st2)
        check("切走后阅读页可见", (st2.get("op") or 0) > .95, st2)
        check("切走后没有残留动画类", "fc-fall" not in (st2.get("cls") or ""), st2)

        print("\n断言 %d 条,失败 %d 条" % (NASSERT[0], len(FAILS)))
        if FAILS:
            print("FAILED:", FAILS)
        else:
            print("ALL GREEN")
        print("errors:", c.errors[-4:])
        return 0 if not FAILS else 1
    finally:
        c.close()


if __name__ == "__main__":
    sys.exit(main())
