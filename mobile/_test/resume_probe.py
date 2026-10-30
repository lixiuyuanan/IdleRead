# -*- coding: utf-8 -*-
"""冷启动续读探针:被清后台时在阅读页,再开 App 要回到那篇文章的原位置。

验四件事:
  1) 打开文章后 resume_stem 落盘;
  2) 重新加载页面(等价冷启动)后直接进阅读页,滚动位置与关掉时一致;
  3) 返回键退回列表,resume_stem 清空,再冷启动不会又跳进去;
  4) resume_stem 指向不存在的文章时,冷启动停在列表并自愈。

先确保 www 下有静态服务器:
    cd mobile/android/app/src/main/assets/www && python -m http.server 8765
然后:
    python mobile/_test/resume_probe.py
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
    # 先给旧文档打标记,新文档里没有这个变量:不然导航还没落地时
    # 会在旧页面上看到 #app 可见就提前返回,断言全打在上一页上。
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


def state(c):
    raw = c.ev("localStorage.getItem(%r)" % STORE)
    return json.loads(raw) if raw else {}


def in_reader(c):
    return c.ev("document.body.classList.contains('reader')")


def para_count(c):
    return c.ev("document.querySelectorAll('#view .para').length")


def scroll_top(c):
    return c.ev("Math.round(document.querySelector('#view').scrollTop)")


def strip_hidden(c):
    return c.ev("document.querySelector('#levelStrip').classList.contains('hidden')")


def main():
    c = CDP()
    try:
        seed(c, {"version": 4, "settings": {"onboarded": 1, "last_level": 5,
                                            "update_freq": "never"}})
        boot(c)

        print("== 1 打开文章 ==")
        check("起手在列表", in_reader(c) is False, in_reader(c))
        check("列表有文章", c.ev("document.querySelectorAll('#view .art').length") > 0)
        c.ev("(document.querySelector('#view .art')||{}).click()")
        time.sleep(.8)
        check("进了阅读页", in_reader(c) is True, in_reader(c))
        check("正文有段落", para_count(c) > 0, para_count(c))
        check("难度条已收起", strip_hidden(c) is True)
        st = state(c)
        stem = (st.get("settings") or {}).get("resume_stem")
        check("resume_stem 已落盘", bool(stem), stem)
        check("resume_stem 指向当前文章", stem == st.get("last_stem"),
              "%s / %s" % (stem, st.get("last_stem")))

        print("\n== 2 滚到中间再冷启动 ==")
        maxs = c.ev("Math.max(0,document.querySelector('#view').scrollHeight"
                    "-document.querySelector('#view').clientHeight)")
        want = min(int(maxs * 0.5), 900)
        c.ev("document.querySelector('#view').scrollTop=%d" % want)
        time.sleep(1.0)          # 等滚动防抖(400ms)落盘
        pos = (state(c).get("readPos") or {}).get(stem)
        check("位置已落盘", bool(pos), pos)
        got_before = scroll_top(c)
        check("落盘位置与当前滚动一致", abs(got_before - want) <= 4,
              "%s vs %s" % (got_before, want))

        boot(c)                  # 重新加载 = 冷启动
        check("冷启动直接进阅读页", in_reader(c) is True, in_reader(c))
        check("冷启动有正文", para_count(c) > 0, para_count(c))
        check("冷启动难度条收起", strip_hidden(c) is True)
        got_after = scroll_top(c)
        check("冷启动回到原位置", abs(got_after - got_before) <= 6,
              "%s vs %s" % (got_after, got_before))
        check("冷启动无 JS 异常", c.errors == [], c.errors[-3:])

        print("\n== 3 返回列表后不该再续读 ==")
        c.ev("window.appBack()")
        time.sleep(.8)
        check("返回键回到列表", in_reader(c) is False, in_reader(c))
        check("列表难度条回来了", strip_hidden(c) is False)
        check("resume_stem 已清空", (state(c).get("settings") or {}).get("resume_stem") == "",
              (state(c).get("settings") or {}).get("resume_stem"))
        boot(c)
        check("再冷启动停在列表", in_reader(c) is False, in_reader(c))
        check("再冷启动难度条可见", strip_hidden(c) is False)

        print("\n== 4 指向已删文章时自愈 ==")
        st = state(c)
        st.setdefault("settings", {})["resume_stem"] = "no-such-stem"
        seed(c, st)
        boot(c)
        check("坏 stem 不炸", in_reader(c) is False, in_reader(c))
        check("坏 stem 被清掉", (state(c).get("settings") or {}).get("resume_stem") == "",
              (state(c).get("settings") or {}).get("resume_stem"))
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
