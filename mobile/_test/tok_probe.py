# -*- coding: utf-8 -*-
"""1.5.9 A 组:分词修正的无头自检。

导入一本合成书,把撇号的写法一次摆齐:
  farmers' / man' / 'I'(直撇号)、don’t / o’clock / O’Brien / rock’n’roll / scientists’(弯撇号)、
  “Hero” 双引号包裹。断言:
  1) 生产分词器吐出的词序列与手写期望完全一致(span 不拆、结尾撇号不吃进词里);
  2) .para 的 textContent 逐字等于原文 —— 划线偏移坐标系没被破坏;
  3) 点词后单词卡的词头正确,未收录的词走「点我翻译」而不是查错词;
  4) 长按 + 拖手柄选中带撇号的短语,复制/翻译拿到的文本与选区完全一致;
  5) guessPos 的所有格改看词间撇号:__posTrace 的 possPrev 该真则真、该假则假,
     ‘yes’ is / 'Smiling Victorians' makes 这种收尾引号由引号配对排掉;
  6) 朗读按句高亮 .w.tts-sent 覆盖整句的词;
  7) 旧划线(含撇号的绝对偏移)重开页面后重绘仍然对位;
  8) 真实语料里 fathers' day / daughters’ photos / eight o’clock / “earn” / ‘yes’ 的分词与卡头。

导入书每个单元的第一段是「Chapter 1 Apostrophes」这一行,所以正文段号整体 +1。

    python mobile/_test/tok_probe.py
"""
import base64
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import mark_probe as mp  # noqa: E402

# 段号 -> (原文, 期望词序列)。0 是章节标题行。
BODY = {
    1: ("The farmers' market opens at nine o'clock, and the children don't want to leave.",
        ["The", "farmers", "market", "opens", "at", "nine", "o'clock", "and",
         "the", "children", "don't", "want", "to", "leave"]),
    2: ("O’Brien kept rock’n’roll playing, and the scientists’ findings impressed nobody.",
        ["O’Brien", "kept", "rock’n’roll", "playing", "and", "the",
         "scientists", "findings", "impressed", "nobody"]),
    3: ("The old man' hat blew away, and 'I' am sorry, said the boy near the door.",
        ["The", "old", "man", "hat", "blew", "away", "and", "I", "am", "sorry",
         "said", "the", "boy", "near", "the", "door"]),
    4: ("“Hero” is only a word, and ‘yes’ is another, but the crowd shouted nothing.",
        ["Hero", "is", "only", "a", "word", "and", "yes", "is", "another", "but",
         "the", "crowd", "shouted", "nothing"]),
}
TXT = "Chapter 1 Apostrophes\n" + "\n".join(BODY[k][0] for k in sorted(BODY)) + "\n"
POSS = "scientists\u2019 findings"

# 点词卡期望:词头 / 旁边的表面词形(和词头一样就不显示)/ 本句词性提示。
CARDS = [
    (1, 1, "farmer", "farmers", "本句里作名词"),      # farmers'  结尾撇号不吃进词里
    (1, 2, "market", "", "本句里作名词"),             # 所有格后面的中心名词
    (1, 6, "o'clock", "", "本句里作名词"),            # o'clock  一个词
    (1, 10, "do", "don't", "本句里作动词"),            # don’t    缩写还原成 do
    (2, 6, "scientist", "scientists", "本句里作名词"),  # scientists’
    (3, 2, "man", "", "本句里作名词"),                # man'     光杆撇号
    (3, 7, "i", "", ""),                              # 'I'      引号不吃进词里
    (4, 0, "hero", "", "本句里作名词"),               # “Hero”   引号不吃进词里
]


def para_tokens(c, para):
    """渲染出来的 .w span 文本序列(生产分词器的落地结果)。"""
    return c.ev("[].map.call(document.querySelectorAll("
                "'.para[data-para=\"%d\"] .w'),function(e){return e.textContent;})" % para)


def para_text(c, para):
    return c.ev("document.querySelector('.para[data-para=\"%d\"]').textContent" % para)


def card(c):
    """单词卡的 [词头, 表面词形, 本句词性提示, 有没有「点我翻译」]。"""
    return c.ev("(function(){var e=document.querySelector('.sheet-word');"
                "if(!e)return null;var sp=e.querySelector('.tiny');"
                "var p=document.querySelector('.pos-note');"
                "return [(e.firstChild.textContent||'').trim(), "
                "sp?(sp.textContent||'').trim():'', "
                "p?(p.textContent||'').trim():'', "
                "!!document.querySelector('[data-sheet-act=tr]')];})()")


def tap_word(c, para, i):
    """按词序点第 i 个词(真触摸),等单词卡弹出来。"""
    b = mp.word_box(c, para, i)
    if not b:
        return None
    mp.tp(c, "touchStart", b[0], b[1])
    mp.tp(c, "touchEnd", b[0], b[1])
    time.sleep(.45)
    return card(c)


def close_sheet(c):
    c.ev("document.querySelector('#backdrop').click()")
    time.sleep(.35)


def to_shelf(c):
    mp.click(c, "[data-tab='read']")
    time.sleep(.4)


def open_group_art(c, level, name_kw):
    """书架 -> 指定档位 -> 按书名找书组展开 -> 点第一篇。"""
    to_shelf(c)
    c.ev("document.querySelector('[data-level=\"%d\"]').click()" % level)
    time.sleep(.5)
    grp = c.ev("(function(){var gs=[].slice.call(document.querySelectorAll('.book-group'));"
               "var g=gs.filter(function(e){return ((e.querySelector('.book-name')||{})"
               ".textContent||'').indexOf(%s)>=0;})[0]||gs[0];"
               "if(!g)return 'no-group';window.__g=g;"
               "if(!g.classList.contains('open'))g.querySelector('.book-head').click();"
               "return ((g.querySelector('.book-name')||{}).textContent||'').trim();})()"
               % mp.js(name_kw))
    print("   书组", grp)
    c.ev("if(window.__g){var h=window.__g.querySelector('.book-head');"
         "if(h)h.id='__bh';}")
    ok = False
    for _ in range(8):
        if c.ev("!!(window.__g&&window.__g.querySelector('.art'))") is True:
            ok = True
            break
        mp.click(c, "#__bh")
    if ok:
        c.ev("window.__g.querySelector('.art').id='__art'")
        mp.click(c, "#__art")
        for _ in range(8):
            if c.ev("!!document.querySelector('.para')"):
                break
            time.sleep(.3)
    return ok


def open_body(c):
    """导入合成书并从书架打开,返回 stem。"""
    b64 = base64.b64encode(TXT.encode("utf-8")).decode("ascii")
    c.ev("window.__fetched=null;window.fetch=function(u){window.__fetched=u;"
         "var s=atob('%s');var u8=new Uint8Array(s.length);"
         "for(var i=0;i<s.length;i++)u8[i]=s.charCodeAt(i);"
         "return Promise.resolve(new Response(u8,{status:200}));};" % b64)
    c.ev("window.__nativeImport('撇号测试.txt','/import/tok1')")
    for _ in range(40):
        if "加入书架" in (c.ev("document.querySelector('#sheet').textContent") or ""):
            break
        time.sleep(.2)
    if not mp.yes("导入预览出弹层", "加入书架" in (c.ev(
            "document.querySelector('#sheet').textContent") or "")):
        return ""
    c.ev("document.querySelector('[data-import-act=save]').click()")
    time.sleep(.7)
    close_sheet(c)
    if not mp.yes("书架里翻到这本导入书", open_group_art(c, 90, "撇号")):
        return ""
    stem = mp.store_json(c).get("last_stem")
    print("   stem", stem, "段数", c.ev("document.querySelectorAll('.para').length"))
    return stem


def wait_hook(c):
    for _ in range(30):
        if c.ev("typeof window.__posTokens") == "function":
            return True
        time.sleep(.3)
    return False


def main():
    c = mp.CDP()
    try:
        mp.reset_store(c)
        # 书架书存在 IndexedDB 里,不清掉会拿到上一轮留下的书,点错文章。
        c.ev("indexedDB.deleteDatabase('ldleRead.mobile')")
        time.sleep(.5)
        c.ev("localStorage.setItem('ldleRead.mobile.v1',JSON.stringify({version:4,"
             "settings:{onboarded:1,last_level:90,ttsGuide:1}}))")
        mp.boot(c)
        mp.yes("posdebug 钩子在", wait_hook(c))
        mp.stub_bridge(c)
        # 朗读:只记句子,推进由探针显式触发,免得断言时已经跑到第三句。
        c.ev("(function(){var o=window.onTTS;window.__tts=[];"
             "window.Android.ttsStatus=function(){return 'ok';};"
             "window.Android.ttsStop=function(){};"
             "window.Android.ttsSpeak=function(t){window.__tts.push(t);};"
             "window.__ttsNext=function(){o('done','');};})()")

        print("== 1 导入合成书 ==")
        stem = open_body(c)

        print("== 2 分词 ==")
        mp.eq("段落数", c.ev("document.querySelectorAll('.para').length"), 5)
        for p in sorted(BODY):
            src, want = BODY[p]
            mp.eq("P%d 词序列" % p, para_tokens(c, p), want)
            mp.eq("P%d 逐字原文" % p, para_text(c, p), src)
        mp.yes("没有 span 吃掉结尾撇号", c.ev(
            "[].every.call(document.querySelectorAll('.para .w'),"
            "function(e){return !/['\u2019]$/.test(e.textContent);})") is True)
        mp.yes("rock’n’roll 是一个 span", c.ev(
            "!!document.querySelector('.para[data-para=\"2\"] "
            "[data-w=\"rock\u2019n\u2019roll\"]')"))
        toks = c.ev("window.__posTokens(%s,2)" % mp.js(stem or ""))
        mp.eq("__posTokens 与 DOM 一致", [t["word"] for t in toks], BODY[2][1])
        src2 = BODY[2][0]
        mp.eq("偏移逐字对位", [src2[t["off"]:t["off"] + len(t["word"])] for t in toks],
              [t["word"] for t in toks])

        print("== 3 点词卡 ==")
        for p, i, head, surf, note in CARDS:
            got = tap_word(c, p, i)
            mp.eq("点 %s 词头" % BODY[p][1][i], (got or [])[:2], [head, surf])
            if note or (got or ["", "", ""])[2]:
                mp.eq("点 %s 词性" % BODY[p][1][i], (got or [None, None, None, None])[2], note)
            close_sheet(c)
        rock = tap_word(c, 2, 2)
        mp.yes("rock’n’roll 走未收录翻译入口",
               rock is not None and rock[0] == "rock'n'roll" and rock[3] is True, str(rock))
        close_sheet(c)
        ob = tap_word(c, 2, 0)
        mp.yes("O’Brien 词形完整且未收录",
               ob is not None and ob[0] == "o'brien" and ob[3] is True, str(ob))
        close_sheet(c)

        print("== 4 复制/翻译 ==")
        mp.ensure_visible(c, 2, 6)
        mp.long_press(c, 2, 6)
        wb = mp.word_box(c, 2, 7)
        mp.drag_handle(c, "r", wb[2] - 2, wb[1])
        time.sleep(.25)
        mp.eq("选区词", mp.sel_words(c), ["scientists", "findings"])
        mp.popclick(c, 'copy')
        mp.eq("复制含撇号", mp.last_copy(c), POSS)
        mp.popclick(c, 'trans')
        time.sleep(.5)
        mp.eq("翻译含撇号", mp.last_req(c), mp.norm(POSS))
        close_sheet(c)

        print("== 5 possPrev 与引号配对 ==")
        cases = [
            ("The farmers' market opens", "market", True),
            ("The scientists\u2019 findings impressed nobody", "findings", True),
            ("The old man' hat blew away", "hat", True),
            ("and \u2018yes\u2019 is another", "another", False),
            ("said the boy \u2018near\u2019 the door", "door", False),
            ("children don't want to leave", "want", False),
            ("O\u2019Brien kept rock\u2019n\u2019roll playing", "playing", False),
            ("my collection of 'Smiling Victorians' makes up little", "up", False),
        ]
        for sent, word, want_p in cases:
            tr = c.ev("(function(){var r=window.__posTrace(%s,%s),t=r.trace;"
                      "return [t?!!t.possPrev:null,r.guess];})()"
                      % (mp.js(sent), mp.js(word)))
            mp.eq("possPrev %s" % word, tr[0], want_p)
        mp.eq("所有格后名词仍判名词",
              c.ev("window.__posGuess(%s,'market')" % mp.js(BODY[1][0])), "n")
        mp.eq("弯撇号所有格后仍判名词",
              c.ev("window.__posGuess(%s,'findings')" % mp.js(BODY[2][0])), "n")
        mp.eq("缩写后动词照判",
              c.ev("window.__posGuess(%s,'want')" % mp.js(BODY[1][0])), "v")
        mp.eq("引号里的标题不抢谓语",
              c.ev("window.__posGuess('Of course, I need to concede that my "
                   "collection of \u2018Smiling Victorians\u2019 makes up only a "
                   "tiny part.','makes')"), "v")

        print("== 6 朗读高亮 ==")
        c.ev("document.querySelector('#ttsBtn').click()")
        time.sleep(.5)
        mp.eq("第一句送原生", c.ev("window.__tts[0]"), "Chapter 1 Apostrophes")
        mp.eq("第一句先高亮", c.ev(
            "[].map.call(document.querySelectorAll('.w.tts-sent'),"
            "function(e){return e.textContent;})"), ["Chapter", "Apostrophes"])
        c.ev("window.__ttsNext()")
        time.sleep(.45)
        mp.eq("第二句送原生", c.ev("window.__tts[1]"), BODY[1][0])
        mp.eq("高亮覆盖整句词", c.ev(
            "[].map.call(document.querySelectorAll('.w.tts-sent'),"
            "function(e){return e.textContent;})"), BODY[1][1])
        c.ev("document.querySelector('#ttsBtn').click()")
        time.sleep(.35)

        print("== 7 旧划线对位 ==")
        mp.ensure_visible(c, 2, 6)
        mp.long_press(c, 2, 6)
        wb = mp.word_box(c, 2, 7)
        mp.drag_handle(c, "r", wb[2] - 2, wb[1])
        mp.popclick(c, 'mark')
        time.sleep(.4)
        rec = (mp.marks(c) or [{}])[0]
        rng = (rec.get("r") or [[]])[0]
        mp.eq("划线记录段号", rec.get("p"), 2)
        mp.eq("记录偏移还原原文", BODY[2][0][rng[0]:rng[1]], POSS)
        mp.boot(c)
        time.sleep(.6)
        mp.yes("重启后钩子还在", wait_hook(c))
        # 书架一次只铺 30 个书组,滚动才继续渲染;回旧文章走「我的 → 历史」更稳。
        mp.click(c, "[data-tab='me']")
        mp.click(c, "[data-act='go-history']")
        mp.click(c, ".art[data-stem=%s]" % mp.js(stem or ""))
        time.sleep(.8)
        mp.eq("历史里点开了导入书", c.ev("document.querySelectorAll('.para').length"), 5)
        mk = c.ev("[].map.call(document.querySelectorAll("
                  "'.para[data-para=\"2\"] .mk'),function(e){return e.textContent;})")
        mp.eq("重开页后高亮词", mk, ["scientists", "findings"])
        mp.yes("黄条还在", c.ev(
            "!!document.querySelector('.para[data-para=\"2\"] .mk')") is True)

        print("== 8 真实语料 ==")
        real = [("2-55", 0, "fathers", "day"), ("2-68", 2, "daughters", "photos"),
                ("1-9", 0, "o\u2019clock", "We"), ("3-69", 1, "earn", "more"),
                ("3-97", 0, "yes", "and")]
        for stem2, para, word, nxt in real:
            r = c.ev("(function(){var ts=window.__posTokens(%s,%d),i;"
                     "for(i=0;i<ts.length;i++)if(ts[i].word===%s)"
                     "return [ts[i].word,ts[i+1]?ts[i+1].word:null];return null;})()"
                     % (mp.js(stem2), para, mp.js(word)))
            mp.eq("%s 分词" % word, r, [word, nxt])
        c.ev("localStorage.setItem('ldleRead.mobile.v1',JSON.stringify({version:4,"
             "settings:{onboarded:1,last_level:2,ttsGuide:1}}))")
        mp.boot(c)
        time.sleep(.4)
        mp.yes("切档后钩子还在", wait_hook(c))
        to_shelf(c)
        c.ev("document.querySelector('[data-level=\"2\"]').click()")
        time.sleep(.5)
        mp.click(c, ".art[data-stem='2-55']")
        time.sleep(.7)
        idx = c.ev("(function(){var ws=document.querySelectorAll("
                   "'.para[data-para=\"0\"] .w'),i;for(i=0;i<ws.length;i++)"
                   "if(ws[i].textContent==='fathers')return i;return -1;})()")
        mp.yes("2-55 里有 fathers", isinstance(idx, int) and idx >= 0, str(idx))
        if isinstance(idx, int) and idx >= 0:
            got = tap_word(c, 0, idx)
            mp.eq("fathers 词头", (got or [])[:2], ["father", "fathers"])
        close_sheet(c)

        print("errors", c.errors[:6])
        if mp.FAILS:
            print("失败 %d 项: %s" % (len(mp.FAILS), " / ".join(mp.FAILS)))
            sys.exit(1)
        print("全部通过")
    finally:
        c.close()


if __name__ == "__main__":
    main()
