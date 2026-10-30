# -*- coding: utf-8 -*-
"""全交互逐帧巡检:动画流畅度 + 主线程阻塞。

**关键:触发和采样全部在页面内一次跑完**。早期版本从 Python 侧交错调
`start()` / `click()`,CDP 往返会被算进帧间隔,量出过 872ms 的假卡顿;
实际同步阻塞只有 4~16ms。所以这里统一用 `window.__lag(expr, sel, ms)`:
  1. 记 t0
  2. `new Function(expr)()` 真触发交互
  3. `setTimeout(0)` 量主线程被同步占住多久 -> block
  4. rAF 逐帧记 sel 的 transform / opacity -> frames

判读:
  block  >50ms   点击后明显发木
  slow   掉帧数(>32ms 的帧)
  mid    中间帧数量,0 说明动画直接跳到终点(没过渡)
  maxgap 最长一帧间隔

用法:
    cd mobile/android/app/src/main/assets/www && python -m http.server 8765
    python mobile/_test/frame_audit.py
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

PROBE = """
window.__lag = function (expr, sel, ms) {
  var el = sel ? document.querySelector(sel) : document.querySelector('#view');
  var out = { block: 0, frames: [], err: '' };
  var t0 = performance.now();
  try { (new Function(expr))(); } catch (e) { out.err = String(e); }
  setTimeout(function () { out.block = Math.round(performance.now() - t0); }, 0);
  var n = 0, limit = Math.max(20, Math.round((ms || 900) / 16));
  (function loop() {
    var now = performance.now();
    var tx = 0, ty = 0, op = 1, w = 0, h = 0;
    if (el && el.isConnected) {
      var cs = getComputedStyle(el);
      if (cs.transform && cs.transform !== 'none') {
        try { var m = new DOMMatrixReadOnly(cs.transform); tx = m.m41; ty = m.m42; }
        catch (e) {}
      }
      op = +cs.opacity;
      var r = el.getBoundingClientRect();
      w = r.width; h = r.height;
    }
    out.frames.push([Math.round(now - t0), Math.round(tx), Math.round(ty),
                     Math.round(op * 100) / 100, Math.round(w), Math.round(h)]);
    if (++n > limit || now - t0 > (ms || 900)) return;
    requestAnimationFrame(loop);
  })();
  window.__lagOut = out;
  return true;
};
"""

ROWS = []


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
    try:
        c.call("Emulation.setTouchEmulationEnabled", enabled=True, maxTouchPoints=5)
    except Exception:
        pass
    c.call("Emulation.setDeviceMetricsOverride", width=W, height=H,
           deviceScaleFactor=2, mobile=True)
    c.ev(PROBE)


def run(c, label, expr, sel="#view", ms=900, settle=.45):
    c.ev("window.__lagOut = null")
    c.ev("window.__lag(%s, %r, %d)" % (json.dumps(expr), sel, ms))
    time.sleep(ms / 1000.0 + settle)
    r = c.ev("window.__lagOut") or {}
    fr = r.get("frames") or []
    if len(fr) < 4:
        print("  %-24s 采样失败 %s" % (label, r.get("err")))
        ROWS.append((label, -1, 0, 0, 0, r.get("err", "")))
        return r
    gaps = [fr[i + 1][0] - fr[i][0] for i in range(len(fr) - 1)]
    slow = len([g for g in gaps if g > 32])
    maxgap = max(gaps)
    # 中间帧:transform(tx/ty) 或 opacity 既不是起点也不是终点的帧。
    # sheet 的进场是 translateY,只看 tx 会把它漏判成「没动」。
    a, b = fr[0], fr[-1]
    mid = 0
    for f in fr[1:-1]:
        if ((f[1] != a[1] and f[1] != b[1])
                or (f[2] != a[2] and f[2] != b[2])
                or (f[3] != a[3] and f[3] != b[3])):
            mid += 1
    moved = ((a[1] != b[1]) or (a[2] != b[2]) or (a[3] != b[3])
             or (a[4] != b[4]) or (a[5] != b[5]))
    block = r.get("block", 0)
    ROWS.append((label, block, slow, maxgap, mid, ""))
    flag = ""
    if block > 50:
        flag += " 阻塞!"
    if slow > 3:
        flag += " 掉帧!"
    if moved and mid == 0:
        flag += " 无过渡!"
    # 元素在采样结束时到底什么状态:区分「真的没动画」和「根本没打开」
    end = fr[-1]
    print("  %-24s 阻塞%4dms  帧%3d  最长帧%4d  掉帧%2d  中间帧%3d  %s%s  末帧[w=%d h=%d op=%s]"
          % (label, block, len(fr), maxgap, slow, mid,
             "动了" if moved else "没动", flag, end[4], end[5], end[3]))
    return r


def main():
    c = CDP()
    try:
        c.nav(BLANK)
        time.sleep(.4)
        c.ev("localStorage.setItem(%r,%r)" % (
            STORE, json.dumps({"version": 4, "settings": {"onboarded": 1,
                                                          "last_level": 5,
                                                          "update_freq": "never"}},
                              ensure_ascii=False)))
        boot(c)

        print("\n=== 1 tab 横滑 ===")
        for name in ("flash", "stats", "me", "read"):
            run(c, "切到 %s" % name,
                "document.querySelector('#tabbar [data-tab=\"%s\"]').click()" % name)
            time.sleep(.35)

        print("\n=== 2 进出正文 ===")
        run(c, "列表 → 正文", "document.querySelector('#view .art').click()", ms=1000)
        time.sleep(.4)
        run(c, "正文 → 列表", "document.querySelector('#backBtn').click()", ms=1000)
        time.sleep(.4)

        print("\n=== 3 难度 chip ===")
        run(c, "点第 3 个 chip",
            "document.querySelectorAll('#levelStrip .chip')[2].click()", "#levelStrip")
        time.sleep(.4)
        run(c, "点第 5 个 chip",
            "document.querySelectorAll('#levelStrip .chip')[4].click()", "#levelStrip")
        time.sleep(.4)

        print("\n=== 4 sheet 开关 ===")
        run(c, "我的 → 设置", "document.querySelector('#tabbar [data-tab=\"me\"]').click()",
            ms=700)
        time.sleep(.4)
        # go-set 是切到设置页(整页 push),不是开面板 —— 看 #view。
        run(c, "我的 → 设置页",
            "document.querySelector('#view [data-act=\"go-set\"]').click()", "#view")
        time.sleep(.4)
        run(c, "设置页 → 返回", "document.querySelector('#backBtn').click()", "#view")
        time.sleep(.4)

        print("\n=== 5 主题切换 ===")
        run(c, "浅 → 深",
            "document.documentElement.setAttribute('data-theme','dark')", "#app", ms=800)
        time.sleep(.4)
        run(c, "深 → 浅",
            "document.documentElement.removeAttribute('data-theme')", "#app", ms=800)
        time.sleep(.4)

        print("\n=== 6 正文点词 ===")
        run(c, "回阅读列表", "document.querySelector('#tabbar [data-tab=\"read\"]').click()",
            ms=700)
        time.sleep(.5)
        run(c, "进正文", "document.querySelector('#view .art').click()", ms=900)
        time.sleep(.5)
        run(c, "点一个词",
            "(document.querySelector('#view .w')||{click:function(){}}).click()",
            "#sheet", ms=900)
        time.sleep(.5)

        print("\n=== 汇总 ===")
        bad = [r[0] for r in ROWS if r[1] < 0 or r[1] > 50 or r[2] > 3]
        print("  有问题的场景:", bad or "无")
        print("  errors:", c.errors[-5:])
    finally:
        c.close()


if __name__ == "__main__":
    main()
