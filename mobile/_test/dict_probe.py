# -*- coding: utf-8 -*-
"""联网重词典(词性+释义)、覆盖缓存与「不会」词样式的无头自检(1.5.7 A+C1)。

外部请求全部用本地 stub 顶掉:装一个只有 dictWord 的假 Android 桥,
让它在 setTimeout 里回调 window.__dictResult。所以这条链路一次点击只发一个请求,
测试也不会真去打有道接口。无桥 / stub 返回错误 = 失败路径,应落到「稍后再试」。

    python mobile/_test/dict_probe.py
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
DB = "ldleRead.mobile"
MISS = "该词汇未收录，点我翻译"

# 假桥:window.Android 只露 dictWord,其余(translate/ttsSpeak)一律没有,
# 于是词典失败时腾讯回退也必然失败,正好落在「稍后再试」。
STUB = """(function(){
  window.__stubHits = 0;
  window.Android = {
    dictWord: function (id, word) {
      window.__stubHits++;
      window.__stubLast = word;
      var body = window.__stubOk
        ? {ok: true, content: JSON.stringify({
             phon: 'b\\u028ak',
             trs: [{pos: 'n.', tran: '联网释义·名词，测试用'},
                   {pos: 'v.', tran: '联网释义·动词，测试用'},
                   {tran: '不带词性的一行'}]})}
        : {ok: false, error: '词典接口返回 429 '};
      setTimeout(function () { window.__dictResult(id, JSON.stringify(body)); }, 30);
    }
  };
})()"""


def clear_sc_words(c):
    """profile 是复用的,上一轮 flash_probe 塞的 w:/dw: 会让缺词直接命中缓存,先清干净。"""
    js = ("new Promise(function(res){var r=indexedDB.open(%r,2);"
          "r.onsuccess=function(){var db=r.result;"
          "var tx=db.transaction('sc','readwrite'),os=tx.objectStore('sc'),n=0;"
          "os.getAllKeys().onsuccess=function(e){"
          "e.target.result.forEach(function(k){var s=String(k);"
          "if(s.indexOf('w:')===0||s.indexOf('dw:')===0){os['delete'](k);n++;}});};;"
          "tx.oncomplete=function(){db.close();res('del '+n);};"
          "tx.onerror=function(){db.close();res('err');};};"
          "r.onerror=function(){res('open-fail');};})" % DB)
    return c.ev(js, awaitp=True)


def boot(c):
    c.nav(URL)
    for _ in range(80):
        if c.ev("!document.querySelector('#app').classList.contains('hidden')"):
            break
        time.sleep(.2)
    time.sleep(.4)


def reset_store(c):
    c.nav(BLANK)
    time.sleep(.4)
    c.ev("localStorage.setItem(%r,%r)" % (STORE, json.dumps(
        {"version": 4, "settings": {"onboarded": 1, "last_level": 2}})))


def click(c, sel):
    ok = c.ev("(function(){var e=document.querySelector(%r);if(!e)return 'missing';"
              "e.click();return 'ok';})()" % sel)
    time.sleep(.5)
    return ok


def text(c, sel):
    return c.ev("(function(){var e=document.querySelector(%r);"
                "return e?e.textContent.trim():null;})()" % sel)


def has(c, sel):
    return c.ev("!!document.querySelector(%r)" % sel) is True


def head_of_sheet(c):
    return c.ev("(function(){var e=document.querySelector('.sheet-word');"
                "return e?e.childNodes[0].textContent.trim():null;})()")


def lines(c):
    return c.ev("[].map.call(document.querySelectorAll('.sheet-mean .mean-line'),"
                "function(e){return e.textContent.trim();})") or []


def stub(c, ok):
    c.ev(STUB)
    c.ev("window.__stubOk=%s" % ("true" if ok else "false"))


def sc_row(c, key):
    js = ("new Promise(function(res){var r=indexedDB.open(%r,2);"
          "r.onsuccess=function(){var db=r.result;"
          "var rq=db.transaction('sc','readonly').objectStore('sc').get(%r);"
          "rq.onsuccess=function(){db.close();res(rq.result?rq.result.z:null);};"
          "rq.onerror=function(){db.close();res('err');};};"
          "r.onerror=function(){res('open-fail');};})" % (DB, key))
    return c.ev(js, awaitp=True)


def open_first_art(c):
    click(c, "[data-tab='read']")
    click(c, '.chip[data-level="2"]')
    click(c, ".art")


def find_rich_word(c):
    """找一个内置词典里有释义的词(卡片应给出「重译」)。"""
    for w in c.ev("[].map.call(document.querySelectorAll('.w'),"
                  "function(e){return e.dataset.w;})")[:40]:
        if click(c, '.w[data-w="%s"]' % w) != "ok":
            continue
        if has(c, "[data-sheet-act='redict']") and not has(c, "[data-sheet-act='undict']"):
            return w
        click(c, "#backdrop")
    return None


def words_on_page(c, cap):
    cand = c.ev("[].map.call(document.querySelectorAll('.w'),"
                "function(e){return e.dataset.w;})")
    cand = (cand or [])[:cap]
    named = [w for w in cand if w[:1].isupper()]
    rest = sorted([w for w in cand if w[:1].islower()], key=lambda x: -len(x))
    return named + rest


def click_n(c, sel, idx):
    ok = c.ev("(function(){var e=document.querySelectorAll(%r)[%d];"
              "if(!e)return 'missing';e.click();return 'ok';})()" % (sel, idx))
    time.sleep(.55)
    return ok


def click_w(c, w):
    """带真实坐标的点击:el.click() 的 clientX/Y 是 0,tapSentence 算不出所在句,
    词性判定就不会出现,置顶断言需要真实 ctx。"""
    ok = c.ev("(function(){var e=document.querySelector(%r);"
              "if(!e)return 'missing';"
              "var r=e.getBoundingClientRect();"
              "e.dispatchEvent(new MouseEvent('click',{clientX:r.left+r.width/2,"
              "clientY:r.top+r.height/2,bubbles:true}));return 'ok';})()"
              % ('.w[data-w="%s"]' % w))
    time.sleep(.55)
    return ok


def find_bare_word(c):
    """找内置词典查不到的词(卡片给红字整行)。中考篇词太常见,从四级/高中各取前两篇。"""
    if has(c, ".reader-body"):
        click(c, "#backBtn")
    for lv in (4, 3):
        click(c, "[data-tab='read']")
        click(c, '.chip[data-level="%d"]' % lv)
        for k in (0, 1):
            if click_n(c, ".art", k) != "ok":
                break
            for w in words_on_page(c, 24):
                if click(c, '.w[data-w="%s"]' % w) != "ok":
                    continue
                if has(c, ".sheet-miss"):
                    return {"tok": w, "head": (head_of_sheet(c) or w).lower(), "lv": lv}
                click(c, "#backdrop")
            click(c, "#backBtn")
    return {}


def main():
    c = CDP()
    try:
        reset_store(c)
        print("清遗留覆盖  ", clear_sc_words(c))
        boot(c)
        open_first_art(c)

        word = find_rich_word(c)
        head = (head_of_sheet(c) or "").lower()
        builtin = lines(c)
        print("有释义词    ", word, "词头", head, "内置释义", len(builtin), "行")
        print("重译按钮    ", text(c, "[data-sheet-act='redict']"),
              "| 还没有恢复", has(c, "[data-sheet-act='undict']") is False)

        # 1) 成功路径:stub 回三份释义(其中一条没词性)
        stub(c, True)
        click(c, "[data-sheet-act='redict']")
        time.sleep(.6)
        got = lines(c)
        print("请求次数    ", c.ev("window.__stubHits"), "(要求 1)",
              "查的词", c.ev("window.__stubLast"))
        print("重译后释义  ", got)
        print("词性高亮挑中", has(c, ".mean-line.on") or "本句没判出词性")
        print("恢复入口    ", text(c, "[data-sheet-act='undict']"),
              "|", text(c, ".sheet-ov .muted"))
        print("音标换来源  ", text(c, ".sheet-phon"))
        time.sleep(.4)
        raw = sc_row(c, "dw:" + head)
        print("落盘 sc     ", (raw or "")[:60])
        click(c, "#backdrop")

        # 2) 重启后仍走覆盖结果
        boot(c)
        open_first_art(c)
        click(c, '.w[data-w="%s"]' % word)
        print("重启后释义  ", lines(c))
        print("还有整行提示", has(c, ".sheet-miss") is False)

        # 3) 恢复词典 → 回到内置释义
        click(c, "[data-sheet-act='undict']")
        print("恢复后释义  ", lines(c) == builtin, lines(c)[:1])
        time.sleep(.4)
        print("覆盖已删    ", sc_row(c, "dw:" + head) is None)
        click(c, "#backdrop")

        # 4) 失败路径:stub 返 429,腾讯回退也没有桥 → 一行「稍后再试」
        stub(c, False)
        click(c, '.w[data-w="%s"]' % word)
        click(c, "[data-sheet-act='redict']")
        time.sleep(.8)
        print("失败提示    ", text(c, ".sheet-ov"), "| 释义没被动", lines(c) == builtin)
        print("还是发了一次", c.ev("window.__stubHits"))
        click(c, "#backdrop")

        # 5) 词典没收录的词:红字整行 → 点它走同一个接口
        bare = find_bare_word(c)
        if bare.get("tok"):
            click(c, '.w[data-w="%s"]' % bare["tok"])
            miss = text(c, ".sheet-miss")
            col = c.ev("(function(){var e=document.querySelector('.sheet-miss');"
                       "var s=getComputedStyle(e);return s.color+' / '+s.textAlign;})()")
            print("缺词整行    ", miss, "颜色", col, "点得动",
                  has(c, "[data-sheet-act='tr']"))
            stub(c, True)
            click(c, "[data-sheet-act='tr']")
            time.sleep(.6)
            print("缺词翻译后  ", lines(c), "| 整行已收起", has(c, ".sheet-miss") is False)
            print("空词性行也在", sum(1 for x in lines(c) if x[:2] not in ("n.", "v.")))
            time.sleep(.4)
            print("落盘 sc     ", (sc_row(c, "dw:" + bare["head"]) or "")[:50])
            click(c, "#backdrop")
            # 老存档里 1.5.6 只存了一串整词译文,兼容成一条不带词性的释义
        else:
            print("缺词整行    ", "(四级/高中都没找到无释义词)")

        # 6) 兼容:1.5.6 的 w:<head> 纯文本缓存
        if bare.get("tok"):
            js = ("new Promise(function(res){var r=indexedDB.open(%r,2);"
                  "r.onsuccess=function(){var db=r.result;"
                  "var tx=db.transaction('sc','readwrite');"
                  "tx.objectStore('sc').put({k:%r,z:'旧版整词译文'});"
                  "tx.objectStore('sc').delete(%r);"
                  "tx.oncomplete=function(){db.close();res('ok');};};r.onerror=function(){res('e');};})"
                  % (DB, "w:" + bare["head"], "dw:" + bare["head"]))
            print("塞旧格式    ", c.ev(js, awaitp=True))
            boot(c)
            click(c, "[data-tab='read']")
            click(c, '.chip[data-level="%d"]' % bare["lv"])
            click(c, ".art")
            if click(c, '.w[data-w="%s"]' % bare["tok"]) == "ok":
                print("旧缓存显示  ", lines(c), "| 无红字整行", has(c, ".sheet-miss") is False)
            click(c, "#backdrop")

        # 7) C1:标「不会」的词 = 红字 + 红色点状下划线,没有背景
        click(c, "[data-tab='read']")
        click(c, '#backBtn')
        click(c, '.chip[data-level="2"]')
        click(c, ".art")
        w2 = find_rich_word(c)
        click(c, "[data-sheet-act='no']")
        click(c, "#backdrop")
        time.sleep(.3)
        style = c.ev("(function(){var e=document.querySelector('.w.no');"
                     "if(!e)return null;var s=getComputedStyle(e);"
                     "return [e.dataset.w,s.color,s.backgroundColor,s.textDecorationStyle,"
                     "s.textDecorationLine,s.textUnderlineOffset,s.textDecorationThickness].join(' | ');})()")
        print("不会词样式  ", w2, "→", style)
        plain = c.ev("(function(){var a=document.querySelectorAll('.w'),i;"
                     "for(i=0;i<a.length;i++){if(a[i].className.indexOf('no')<0"
                     "&&a[i].className.indexOf('s')<0&&a[i].className.indexOf('hint')<0"
                     "&&a[i].className.indexOf('learn')<0){var s=getComputedStyle(a[i]);"
                     "return a[i].dataset.w+' | '+s.color+' | '+s.backgroundColor"
                     "}}return null;})()")
        print("普通词不动  ", plain)
        click(c, "#backdrop")
        # 8) 单词卡:本句词性命中的释义排到最前(1.6.3),浅色深色各留一张
        if has(c, ".reader-body"):
            click(c, "#backBtn")
        top_info = None
        for lv in (2, 3, 4):
            if top_info:
                break
            click(c, "[data-tab='read']")
            click(c, '.chip[data-level="%d"]' % lv)
            for k in (0, 1, 2):
                if click_n(c, ".art", k) != "ok":
                    break
                for w in words_on_page(c, 40):
                    if click_w(c, w) != "ok":
                        continue
                    if has(c, ".mean-line.on") and len(lines(c)) > 1:
                        top_info = (
                            w,
                            c.ev("document.querySelector('.sheet-mean .mean-line')"
                                 ".classList.contains('on')"),
                            c.ev("document.querySelector('.pos-note')"),
                            lines(c),
                        )
                        break
                    click(c, "#backdrop")
                if top_info:
                    # headless 启动时可能就是深色,先明确切到浅色再截
                    c.call("Emulation.setEmulatedMedia",
                           features=[{"name": "prefers-color-scheme", "value": "light"}])
                    time.sleep(.25)
                    c.shot("word_card_light.png", True)
                    c.call("Emulation.setEmulatedMedia",
                           features=[{"name": "prefers-color-scheme", "value": "dark"}])
                    time.sleep(.25)
                    c.shot("word_card_dark.png", True)
                    c.call("Emulation.setEmulatedMedia",
                           features=[{"name": "prefers-color-scheme", "value": "light"}])
                    click(c, "#backdrop")
                    break
                click(c, "#backBtn")
        if top_info:
            print("匹配释义置顶", top_info[0], "| 首条带 on:", top_info[1],
                  "|", top_info[2], "| 行序", top_info[3])
        else:
            print("匹配释义置顶  (这一页没找到带词性匹配的多行词,探针需换页)")

        c.shot("dict_sheet.png", True)
        print("errors      ", c.errors[:8])
    finally:
        c.close()


if __name__ == "__main__":
    main()
