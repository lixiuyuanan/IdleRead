/* 闲读 · 手机版
 * 单页应用:内置语料与词典在 www/data/ 下,进度存在本机 localStorage。
 * 导入的图书、AI 译文存在 IndexedDB;联网只发生在你主动点 AI 的时候。
 */
(function () {
  'use strict';

  /* ---------------- 常量 ---------------- */
  var STAGES = [[1, '初遇'], [4, '再见'], [8, '熟识'], [12, '掌握']];
  var STAGE_STAB = { '初遇': 0.5, '再见': 2.0, '熟识': 8.0, '掌握': 21.0 };
  var IGNORED = 98, WELLKNOWN = 99;
  var KNOWN_FLOOR = 800;
  var HINT_RANK = 6000;
  var REVIEW_CONTEXTS = 15;
  var LEVEL_NAMES = { 1: '小学', 2: '中考', 3: '高中', 4: '四级',
    5: '六级', 6: '考研一', 7: '考研二', 90: '书架' };
  var MODE_LABELS = { xx: '小学', zk: '初中', gk: '高中', cet4: '四级',
    cet6: '六级', advanced: '求索' };
  var MODE_ORDER = ['xx', 'zk', 'gk', 'cet4', 'cet6', 'advanced'];
  // 学习目标只决定“默认已掌握”的词：上一个难度及更低的全部词汇。
  // 小学没有更低档，只靠最常用基础词(KNOWN_FLOOR)保底。
  var TAG_MODES = {
    xx: [], zk: ['xx'], gk: ['xx', 'zk'],
    cet4: ['xx', 'zk', 'gk'], cet6: ['xx', 'zk', 'gk', 'cet4'],
    advanced: ['xx', 'zk', 'gk', 'cet4', 'cet6']
  };
  // 正文划线 = 当前档的“新增词”：带本档标签、不带任何更低档标签。
  // 更低档已覆盖的词不划线，优先突出新词；求索只划没进任何分级表的词。
  var TIER_ORDER = ['xx', 'zk', 'gk', 'cet4', 'cet6', 'ky', 'toefl', 'ielts', 'gre'];
  var GOAL_TIER = { xx: 'xx', zk: 'zk', gk: 'gk', cet4: 'cet4', cet6: 'cet6' };
  var STORE_KEY = 'ldleRead.mobile.v1';
  var AI_KEY_STORE = 'ldleRead.aiKey.v1';
  var DB_NAME = 'ldleRead.mobile';
  var DB_VER = 2;
  var AI_API = 'https://api.deepseek.com/chat/completions';
  var AI_MODEL = 'deepseek-chat';
  var HISTORY_MAX = 200;
  var READPOS_MAX = 300;
  var DEFAULT_FAV = { id: 'def', name: '默认收藏' };
  var DEFAULT_SETTINGS = {
    goal_words: 150, font_size: 19, theme: 'auto', known_mode: 'zk',
    known_rank: 1400, show_trans: false, recent: [], last_review: '',
    tts_rate: 0.9, tts_pitch: 1.0, ttsGuide: 0,
    last_level: 2, home_pos: null, trans_provider: 'tencent', onboarded: 0,
    resume_stem: '',       // 被清后台时正在读的文章;冷启动据此回到原位置
    cont_pill: 1,          // 接着读浮条:1 显示 / 0 关闭(外观设置里可关)
    cont_pill_y: 0.89,     // 浮条纵向位置,0=最上 1=最下
    review_no_first: true,
    update_freq: 'launch', // 自动检查更新:launch / 3 / 7 / never
    update_last: 0,        // 上次成功检查的时间戳 ms
    update_skip: ''        // 点 × 忽略的版本号
  };

  // 词内撇号连着字母才算一个词:rock’n’roll 不拆,结尾撇号(man' / 'I')不吃进词里。
  var WORD_RE = /[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]+(?:[’'][A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]+)*/g;
  // 重音字母折回 ASCII 再查词:cliché→cliche、Ødegaard→odegaard,不然会被截成 clich/degaard。
  var ACC_FOLD = { 'æ': 'ae', 'œ': 'oe', 'ø': 'o', 'ß': 'ss', 'đ': 'd', 'ð': 'd',
    'ł': 'l', 'þ': 'th', 'ı': 'i' };
  function foldAccents(s) {
    s = String(s || '').toLowerCase();
    if (s.normalize) s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return s.replace(/[æœøßđðłþı]/g, function (c) { return ACC_FOLD[c] || c; });
  }
  var URL_RE = /(?:https?:\/\/|www\.)\S+/ig;
  var ORD_RE = /(\d)(?:st|nd|rd|th|s)\b/ig;
  var SENT_SPLIT_RE = /(?<=[.!?])(["”’']?)\s+/g;
  var ABBR_RE = /\b(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|etc|al|No|Fig|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|e\.g|i\.e)\.$/i;
  var SUFFIXES = [['ies', 'y'], ['es', ''], ['s', ''], ['ed', 'e'], ['ed', ''], ['d', ''],
    ['ing', 'e'], ['ing', ''], ['er', 'e'], ['er', ''], ['est', 'e'], ['est', '']];
  var BAD_LEMMA = {
    i: 'zoning', s: 'yrs', t: 'youngest', d: 'wrought', r: 'younger',
    feed: 'fee', number: 'numb', does: 'doe', rent: 'rend', bit: 'bite',
    ground: 'grind'
  };
  var PROPER_RE = /[（(](专名|人名|女子名|男子名|姓氏|地名|国名|城市名|州名|河名|山名|书名|片名|品牌名|公司名|缩写)/;

  /* ---------------- 运行时 ---------------- */
  var CORE_A = [];            // 内置语料
  var A = [];                 // 内置 + 导入 + 番外
  var A_MAP = {};             // stem → 文章
  var DICT = {};              // 词 → [音标, 释义, 词频, 考试标签]
  var LEMMA = {};             // 变形 → 原形
  var BOOKS = [];             // IndexedDB 里的导入图书 / 番外
  var AI_TR = {};             // 主题 → {c:[段落译文]}
  var S = null;               // 存档
  var current = 'read';
  var readerStem = null;
  var showTrans = false;
  var readLevel = null;
  var levelStripScroll = 0;   // 难度条左右拖动的位置
  var homePosTimer = 0;
  var openBooks = {};         // 书架里的折叠状态
  var pendingBook = null;
  var aiBusy = false;
  var aiSeq = 0;
  var aiWait = {};
  var tcWait = {};
  var tcSeq = 0;
  var dictWait = {};
  var dictSeq = 0;
  var upWait = {};
  var upSeq = 0;
  var upBusy = false;
  var upAutoDone = false;   // launch 模式:一次启动最多自动查一次
  var upPopupSeen = false;  // 本次启动是否已经自动弹过更新框(不落盘)
  var idbPromise = null;
  var wbQuery = '', wbFilter = 'all', wbLimit = 160;
  var revWord = '', revList = [], revBatch = [], revReveal = false, revCloze = false;
  var revRanked = null;       // {word, rev, list}
  var revScroll = 0;
  var reviewFrom = 'me';
  // 复习卡片流程:phase = list(今日到期) / ask(待判断) / yes / no / mistake / done。
  // snap0 是判断前的词条快照,「记错了」「撤回」都靠恢复快照,不反推 SRS。
  var fc = { queue: [], i: 0, phase: 'list', sents: [], snap0: null, snapYes: null,
             judge: {}, trBusy: false };
  var scCache = {};           // 原句 → 中文,只存本机,不进导出存档
  var SC_CACHE_MAX = 900;
  var readerFrom = 'read';
  var listScroll = 0;         // 进阅读页前的列表位置,返回时还原
  var readPosTimer = 0;       // 阅读页滚动防抖
  var APP_VERSION = '1.7.3.2';
  var APP_CODE = 47;
  // 更新走 GitHub Release。仓库改名只改这两行,其余地址都是从这里拼出来的。
  // 安装包地址不写死:每个版本的资产名带版本号(IdleRead-1.6.0.apk),只能从接口拿。
  var GH_HOME = 'https://github.com/lixiuyuanan/IdleRead';
  var GH_RELEASES = GH_HOME + '/releases';
  // 镜像只做前缀拼接。2026-10-28 实测保留：gh-proxy.org / gh.ddlc.top /
  // ghproxy.cxkpro.top / gh-proxy.com，四个都支持 Range 分块且并发能叠到 300KB/s 以上；
  // 直连由原生自动垫底。死源（ghfast.top、gh.llkk.cc、github.moeyy.xyz、hub.gitmirror.com、
  // cf.ghproxy.cc、ghps.cc、mirror.ghproxy.com 等）已从内置清单移出。
  var DEFAULT_MIRRORS = [
    { name: 'gh-proxy.org', prefix: 'https://gh-proxy.org/' },
    { name: 'gh.ddlc.top', prefix: 'https://gh.ddlc.top/' },
    { name: 'ghproxy.cxkpro.top', prefix: 'https://ghproxy.cxkpro.top/' },
    { name: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' }
  ];
  // 内置清单的生成日期：用户没同步过远端清单时，用它和远端 updated 比新旧。
  var MIRRORS_BUILT_AT = '2026-10-28';
  // 当前生效的镜像列表（同步成功后会被替换）。
  var GH_MIRRORS = DEFAULT_MIRRORS.slice();
  // 镜像同步的临时状态：{state, text}
  var mirrorSync = null;
  // 远端清单新旧检查：{state: ''|'checking'|'stale'|'ok'|'fail', at: 毫秒}
  var mirrorCheck = { state: '', at: 0 };
  // 最近一次检查到的版本;只在内存里,不写存档。{version,url,notes}
  var latestRel = null;
  // 应用内下载安装的实时状态:{state, text}。state 由原生桥推过来。
  var apkState = null;
  // 跟手翻页的手势状态;busy 期间锁页面滚动、不接新的滑动。
  var swap = { busy: false, dragging: false, mode: '', dir: 1, w: 0, edge: false,
               ghost: null, cur: null, tgt: null, snap: null, tgtTop: null, stripOn: false,
               willCommit: false };
  // 朗读功能总开关:置 false 则按钮不出现、不碰原生桥,随时可整块回退
  var TTS_ON = true;
  // EPUB 解析代码保留,先只开放 TXT。
  var EPUB_ON = false;
  var tts = { on: false, stem: '', idx: 0, sent: 0, seq: 0 };
  var ttsGap = 0;
  var sheetWord = null, sheetDirty = false;
  // 长按划线的浮层状态:ranges = 当前选中的段内字符区间(可拖手柄改),cov = 被选区覆盖的划线 id。
  var pop = { stem: '', para: -1, ranges: [], cov: [], id: '', on: false,
              busy: false, zh: '', fail: false, note: false, confirm: false };
  var hd = { on: false, side: '' };   // 正在拖哪一端的手柄
  var mkSeq = 0;             // 划线 id 的自增后缀
  var mkConfirm = '';        // 收藏卡里「删除」二次确认中的那条 id
  var mkZhBusy = '';
  var favTab = 'arts';       // 收藏页当前 tab:arts=文章 / mk=划线
  var favScroll = { arts: 0, mk: 0 };   // 两个 tab 各自的滚动位置
  var topAction = null;
  var saveTimer = 0;
  var booted = false;

  var headCache = new Map();
  var knownCache = new Map();
  var hiCache = new Map();
  var hintCache = new Map();  // stem → {rev, hint, learn}
  var auditCache = new Map(); // stem → {rev, rate, name, cls} 难易度体检
  var ctxCache = new Map();
  var sentences = null;
  var cachesRev = 0;

  /* ---------------- 工具 ---------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  /* 乱码防御:联网词典、腾讯/DeepSeek 译文、导入的 txt 都可能带进零宽字符、
     控制符或没解开的字面 \r\n。规则与 tools/lint_text.py 对齐,改这里要同步改那边。
     真正的换行要留着:译文是一段一句的。 */
  var ZW_RE = /[\u200b\u200c\u200d\u2060\ufeff\u00ad]/g;
  var CTL_RE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g;
  var LIT_ESC_RE = /\\r\\n|\\r|\\n/g;
  function cleanText(s) {
    if (s == null) return '';
    var t = String(s);
    if (!t) return '';
    t = t.replace(/\r\n?/g, '\n').replace(ZW_RE, '').replace(CTL_RE, '')
      .replace(LIT_ESC_RE, '\n').replace(/\ufffd+/g, '')
      .replace(/[\u00a0\t\f\u000b]+/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+(\n|$)/g, '$1').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n');
    return t.trim();
  }
  // 音标专用:ECDICT 把长音符 ɜː 写成了一串反斜杠加冒号、把 ɡ 写成了 ^。
  function cleanPhon(s) {
    return cleanText(s).replace(/\\{1,}:/g, 'ɜː').replace(/\^/g, 'ɡ')
      // 开头的 . / , 是旧式次重音标记,换成 IPA 的 ˌ;ɒ 统一写成 ɔ(用户看到的两处不一致)。
      .replace(/^\s*[.,]\s*/, 'ˌ').replace(/^ˌ['ˈ]/, 'ˌ').replace(/ɒ/g, 'ɔ');
  }
  // 整段译文列表的原地清洗。老数据(IndexedDB 里 1.5.9 之前存的)也走这一道;
  // 先用一个便宜的探测挡住绝大多数干净段落,别在启动路径上做无谓的正则。
  var DIRTY_RE = /[\u200b\u200c\u200d\u2060\ufeff\u00ad\r\ufffd\u0000-\u0008\u007f-\u009f]|\\[rn]/;
  function cleanTrans(list) {
    if (!list || !list.length) return list;
    for (var i = 0; i < list.length; i++) {
      var x = list[i];
      if (typeof x === 'string' && DIRTY_RE.test(x)) list[i] = cleanText(x);
    }
    return list;
  }

  function fmt(n) { return Number(n || 0).toLocaleString('zh-CN'); }
  function wordsOf(text) { return (String(text || '').match(WORD_RE) || []).length; }
  function notify(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, 1900);
  }

  function isoDate(d) {
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }
  function todayKey() { return isoDate(new Date()); }
  function parseDay(value, fallback) {
    if (value instanceof Date) return value;
    var s = String(value || '').slice(0, 10);
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    return fallback || new Date();
  }
  function addDays(d, n) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() + n);
    return x;
  }
  function dayDiff(a, b) {
    return Math.round((a.getTime() - b.getTime()) / 86400000);
  }

  /* ---------------- 词形 / 词典 ---------------- */
  function stemVariants(w) {
    var out = [];
    for (var i = 0; i < SUFFIXES.length; i++) {
      var suf = SUFFIXES[i][0], add = SUFFIXES[i][1];
      if (w.length > suf.length && w.slice(-suf.length) === suf && w.length - suf.length >= 3) {
        out.push(w.slice(0, -suf.length) + add);
      }
    }
    if (w.length > 4 && w[w.length - 1] === w[w.length - 2] && 'aeiou'.indexOf(w[w.length - 1]) < 0) {
      out.push(w.slice(0, -1));
    }
    return out;
  }

  function headOf(word) {
    var key = String(word || '').toLowerCase().trim().replace(/’/g, "'").replace(/'s$/, '');
    var hit = headCache.get(key);
    if (hit !== undefined) return hit;
    // 缩写先还原再走词典:dict.json 里没有 we'll/didn't 这类写法,不还原会被当成生词。
    // 不规则项(i'll/can't/shan't)查表,'ll / n't 的规则项直接剥后缀。
    var w = own(CONTRACT, key) || key;
    if (!dictOwn(w) && !lemmaOwn(w)) {
      var folded = foldAccents(w);
      if (folded !== w) w = folded;
    }
    if (!dictOwn(w)) {
      if (/'ll$/.test(w)) w = w.slice(0, -3);
      else if (/n't$/.test(w)) w = w.slice(0, -3);
    }
    var bad = own(BAD_LEMMA, w);
    var base = w;
    var lw = lemmaOwn(w);
    if (lw && lw !== bad) {
      base = lw;
    } else {
      var de = dictOwn(w);
      if (de && (de[2] || de[3])) {
        base = w;
      } else {
        var vs = stemVariants(w);
        for (var i = 0; i < vs.length; i++) {
          var cand = lemmaOwn(vs[i]) || vs[i];
          var e = dictOwn(cand);
          if (e && (e[2] || e[3])) { base = cand; break; }
        }
      }
    }
    if (headCache.size > 60000) headCache.clear();
    headCache.set(key, base);
    return base;
  }

  // 所有「词 → 值」的查找表都是普通对象,原型链上有 constructor / toString /
  // valueOf 这些名字。词典里恰好有 constructor 这个词,直接 x[k] 会拿到
  // Object.prototype 上的内置成员(界面上就显示成 function Object() {...})。
  // 取值一律走这里,只认自有属性。
  function own(o, k) {
    return (o && Object.prototype.hasOwnProperty.call(o, k)) ? o[k] : null;
  }
  function dictOwn(key) { return own(DICT, key); }
  function lemmaOwn(key) { return own(LEMMA, key); }
  function dictEntry(head) {
    var v = dictOwn(head);
    return (v && typeof v === 'object') ? v : null;
  }
  function rankOf(word) {
    var v = dictEntry(headOf(word));
    return v && v[2] ? +v[2] || 0 : 0;
  }
  function tagsOf(word) {
    var v = dictEntry(headOf(word));
    if (v && v[3]) return String(v[3]).split(/\s+/).filter(Boolean);
    return [];
  }
  function lookup(word) {
    var v = dictEntry(headOf(word));
    if (v) return [cleanPhon(v[0]), cleanText(v[1])];
    var raw = dictOwn(String(word || '').toLowerCase());
    if (typeof raw === 'string') return ['', cleanText(raw)];
    return ['', ''];
  }
  // 词典音标没带斜杠,显示时统一包一层。ASCII 撇号是历史遗留的主重音标记,换成 IPA 的 ˈ。
  function phonText(p) {
    var s = cleanPhon(p);
    if (!s) return '';
    s = s.replace(/^[\[\/]+|[\]\/]+$/g, '').trim();
    if (!s) return '';
    return '/' + s.replace(/'/g, 'ˈ') + '/';
  }
  function isProper(head) {
    var v = dictEntry(head);
    return !!(v && v[1] && PROPER_RE.test(String(v[1])));
  }

  /* ---------------- 句内词性 ---------------- */
  // 只用来给单词卡挑释义:规则保守,拿不准就完全不标,不影响生词判定。
  var POS_NAME = { n: '名词', v: '动词', a: '形容词', adv: '副词',
    prep: '介词', pron: '代词', num: '数词', conj: '连词', int: '感叹词', art: '冠词' };
  function wordSet(s) {
    var o = {};
    s.split(' ').forEach(function (w) { if (w) o[w] = 1; });
    return o;
  }
  var POS_DET = wordSet('the a an this that these those my your his her its our their '
    + 'some any no each every another such many much more most less least several few');
  var POS_PREP = wordSet('of in on at for with from by about into over under between among '
    + 'through during without within against across behind beyond despite except inside '
    + 'outside toward towards upon via like than till once around above below alongside '
    + 'past onto atop throughout after before');
  var POS_MODAL = wordSet('can could will would shall should may might must');
  var POS_NEG = wordSet("cannot can't couldn't shouldn't won't wouldn't don't doesn't "
    + "didn't isn't aren't wasn't weren't haven't hasn't hadn't mustn't needn't daren't "
    + 'not never neither nobody');
  var POS_SUBJ = wordSet('i you we they he she it');
  var POS_OBJ = wordSet('me him her them us you it');
  var POS_BE = wordSet('is are was were be been being am');
  var POS_HAVE = wordSet('have has had do does did');
  // 完成时助动词单独一份:do/does/did 后面接原形,不能按"后面是分词"处理。
  var POS_HAVEAUX = wordSet('have has had');
  var POS_DEG = wordSet('very so too quite rather extremely really equally just purely simply');
  var POS_CONJ = wordSet('and or but nor yet');
  var POS_REL = wordSet('that which who whom whose');
  var POS_SUBJCONJ = wordSet('when while whereas although though unless until since whether');
  var POS_WHEADV = wordSet('where how why there');
  // 动词后面缺宾语的那个成分:back/down/home 这类方向词按副词处理(go home / scale back)。
  var POS_PART = wordSet('back down off out away up home');
  // 夹在中间的时间/程度副词:主谓之间、be 之后、比较级之前都会落到 adv。
  var POS_ADVFIX = wordSet('now then well far much little all both either neither also '
    + 'even here thus instead always never often once again rather just '
    + 'today yesterday tonight nowadays');
  var POS_QUANTPRON = wordSet('one two three most all some none several many few both each');
  var POS_IDIOMPRP = wordSet('according thanks due');   // according to / thanks to / due to 已经介词化
  var POS_STOP = wordSet('the a an this that these those of in on at for with from by about '
    + 'into over under between among through during without within against to can could will '
    + 'would shall should may might must i you we they he she it is are was were be been '
    + 'being have has had do does did and or but if than as so very too also just only not '
    + 'there here');

  // 词典释义按 " / " 分段,每段开头是 n. / v. / a. / adv. 这类词性标签。
  function posKeyOf(tag) {
    var s = String(tag || '').trim();
    // 词性可能只写「n」不带点;补上点再匹配,免得把 "nasty" 这种词当成 n.。
    if (s && s.charAt(s.length - 1) !== '.') s += '.';
    var m = /^(n|vt|vi|v|a|adj|adv|prep|pron|num|conj|int|art)\./i.exec(s);
    if (!m) return '';
    var p = m[1].toLowerCase();
    if (p === 'vt' || p === 'vi') return 'v';
    if (p === 'adj') return 'a';
    return p;
  }
  function posLines(def) {
    return String(def || '').split(/\s+\/\s+/).map(function (x) { return x.trim(); })
      .filter(Boolean).map(function (line) {
        return { text: line, pos: posKeyOf(line) };
      });
  }

  /* 词典里真有哪些四大类(带缓存):相邻词互推时也要用,别把释义再解析一遍。 */
  var POS_MJ = {};
  function majors(head) {
    if (!head) return [];
    var c = POS_MJ[head];
    if (c) return c;
    var arr = [];
    posLines(lookup(head)[1]).forEach(function (x) {
      if ((x.pos === 'n' || x.pos === 'v' || x.pos === 'a' || x.pos === 'adv')
        && arr.indexOf(x.pos) < 0) arr.push(x.pos);
    });
    POS_MJ[head] = arr;
    return arr;
  }
  function canMaj(head, g) {
    var arr = majors(head), i;
    for (i = 0; i < arr.length; i++) if (arr[i] === g) return 1;
    return 0;
  }
  /* 形态线索:全是通用后缀/单复数,不列具体单词。 */
  function posPlural(w) {
    return w.length > 3 && /(?:ies|es|s)$/.test(w) && !/(?:ss|us|is|as|os|ous|bus)$/.test(w);
  }
  /* 光加 -s 的不规则复数只能列出来:people Act / when people take 后面照样是谓语。 */
  function posPluralX(w) {
    return posPlural(w) || /^(?:people|men|women|children|feet|teeth|geese|dice|police)$/.test(w);
  }
  function posNounMorph(w) {
    return /(?:tion|sion|ment|ness|ity|ety|ance|ence|ship|hood|ism|ist|dom|cy|ure|er)$/.test(w);
  }
  function posAdjMorph(w) {
    return /(?:ous|ful|less|ive|able|ible|ical|ic|ary|ish|ent|ant|al|ar|ward|wards)$/.test(w);
  }
  function posAdvMorph(w) { return w.length > 4 && /ly$/.test(w); }
  /* 相邻词的粗略类别,只在能确定时给结论,否则空(并列、主谓互推用)。 */
  function roughCls(w, h) {
    if (!w || !h) return '';
    if (canMaj(h, 'adv') && posAdvMorph(w) && !canMaj(h, 'n')) return 'adv';
    if (posPlural(w)) return canMaj(h, 'n') ? 'n' : (canMaj(h, 'v') ? 'v' : '');
    if (posNounMorph(w) && canMaj(h, 'n') && !/(?:ing|ed)$/.test(w)) return 'n';
    if (posAdjMorph(w) && canMaj(h, 'a')) return 'a';
    if (/(?:ize|ise|ify)$/.test(w) && canMaj(h, 'v')) return 'v';
    if (canMaj(h, 'n') && !canMaj(h, 'v') && !canMaj(h, 'a') && !canMaj(h, 'adv')) return 'n';
    if (canMaj(h, 'v') && !canMaj(h, 'n') && !canMaj(h, 'a')) return 'v';
    if (canMaj(h, 'a') && !canMaj(h, 'n') && !canMaj(h, 'v')) return 'a';
    return '';
  }

  // 评测台用:带 posdebug 参数才留痕,正常启动只是两个模块内变量。
  var POS_DEBUG = /[?&]posdebug=1/.test(location.search);
  var POS_TRACE = null;

  /* 判断一个词在句中的词性:先按标点/虚词切出名词短语,看这个词是中心词还是定语,
     再用助动词/be/have/限定词/介词/所有格/wh/连字符这些通用线索定位,最后才看后缀。
     候选只允许词典里真有的四大类;0 分或平分就弃权。 */
  function guessPos(sent, word) {
    var txt = String(sent || ''), toks = [], m, i;
    // 每次调用都先清掉上一次的痕迹,弃权时才不会看到旧数据。
    if (POS_DEBUG) POS_TRACE = null;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(txt))) {
      toks.push({ w: m[0], h: headOf(m[0]), a: m.index, b: m.index + m[0].length });
    }
    if (toks.length < 2) return '';
    // 卡片传进来的是 head,不能再引理一次:building→build、laying→lay 这类二次还原
    // 会让下面的匹配落空。先按原词找,找不到才走 headOf。
    var head = String(word || '').toLowerCase().trim().replace(/’/g, "'").replace(/'s$/, '');
    var at = -1;
    for (i = 0; i < toks.length; i++) if (toks[i].h === head) { at = i; break; }
    if (at < 0) {
      head = headOf(word);
      for (i = 0; i < toks.length; i++) if (toks[i].h === head) { at = i; break; }
    }
    if (at < 0) return '';
    var low = function (j) {
      // 弯引号先换成直引号:can’t / who’s 在词表里是按 ASCII 撇登记的,不换就查不到。
      return toks[j] ? toks[j].w.toLowerCase().replace(/[^a-z'’]/g, '').replace(/’/g, "'") : '';
    };
    // 两个词之间的原文:标点算小句边界,单个连字符算复合词接缝。
    var gap = function (j) {
      return (j > 0 && toks[j]) ? txt.slice(toks[j - 1].b, toks[j].a) : ' ';
    };
    var w = low(at), prev = low(at - 1), next = low(at + 1), prev2 = low(at - 2);
    var isCmp = /^(more|most|less|least)$/.test(w);   // 级别标记,不是限定词也不是形容词
    // 每次调用都先留个空壳,免得提前返回时看到上一次的痕迹。
    if (POS_DEBUG) POS_TRACE = { w: w, head: head, at: at, early: '',
      ctx: [prev2, prev, w, next, low(at + 2)].join(' ') };
    if (!w || POS_STOP[w]) return '';
    var dbg = function (why) { if (POS_DEBUG) POS_TRACE.early = why; };
    // 介词化的短语、代词化的量词、从句连词:这些位置不该给 n/v/a/adv。
    if (POS_IDIOMPRP[w] && next === 'to') { dbg('idiom'); return ''; }
    if (POS_QUANTPRON[w] && next === 'of') { dbg('quant'); return ''; }
    if (POS_SUBJCONJ[w]) { dbg('conj'); return ''; }
    var avail = {};
    var mj = majors(head);
    for (i = 0; i < mj.length; i++) avail[mj[i]] = 1;
    if (!avail.n && !avail.v && !avail.a && !avail.adv) return '';
    var isFun = function (j) {
      var t = low(j);
      if (!t) return true;
      if (POS_STOP[t] || POS_DET[t] || POS_PREP[t] || POS_MODAL[t] || POS_NEG[t] || POS_BE[t]
        || POS_HAVE[t] || POS_CONJ[t] || POS_SUBJ[t] || POS_OBJ[t] || POS_REL[t]
        || POS_WHEADV[t] || POS_SUBJCONJ[t] || POS_IDIOMPRP[t]) return true;
      if (/'s$|’s$/.test(toks[j].w.toLowerCase()) && !POS_SUBJ[t]) return true;
      return roughCls(t, toks[j].h) === 'adv';
    };
    var punctAt = function (j) {
      return /[,.;:!?"'“”‘’()\[\]—–…]/.test(gap(j));
    };
    var isBoundary = function (j) { return isFun(j) || (j > at && punctAt(j)); };
    // 动词后的小品词按副词处理(scale back / bring down / carved out / top-down)。
    if (POS_PART[w] && avail.adv && prev && !isFun(at - 1)) return 'adv';
    // 所有格:光秃秃的 '(scientists')或 's 结尾。剥掉 's 剩下代词/助动词时是缩写
    // (it's / who's),不是所有格——搞混会漏掉 who's producing 这种进行时。
    var possStem = /'s$/.test(prev) ? prev.replace(/'s$/, '') : '';
    var contraction = !!possStem && (POS_SUBJ[possStem] || POS_REL[possStem]
      || POS_BE[possStem] || POS_HAVE[possStem] || POS_MODAL[possStem]);
    // 结尾撇号不再被 WORD_RE 吃进词里(scientists’ 只剩 scientists),改看两词之间的原文。
    // 词缝里的 ’ 也可能是引号的右半边:前面还有没合上的单引号,这一撇就是闭合不是所有格。
    // ‘desire paths’—or ‘desire lines’—these 这种跨词的引号,靠相邻一个词看不出来。
    var openQuote = function (j) {
      var n = 0, k, q, g, ch;
      for (k = 1; k < j; k++) {
        g = gap(k);
        for (q = 0; q < g.length; q++) {
          ch = g.charAt(q);
          if (ch === '‘') n++;
          else if (ch === '’') { if (n > 0) n--; }
          else if (ch === "'") { if (n > 0) n--; else n++; }
        }
      }
      return n;
    };
    var aposPrev = at > 0 && /^[’']/.test(gap(at)) && !openQuote(at);
    // 这一撇确实是引号的右半边时,前一个词是引号里的标题,不是复数主语。
    var quoteEnd = at > 0 && /^[’']/.test(gap(at)) && !!openQuote(at);
    var possPrev = aposPrev || (possStem !== '' && !contraction);
    // 主语后面挂助动词缩写:i've found / we'll see / she'd rather。
    // 've 'll 'd 后面必定是动词词形,'m 're 相当于 be。
    var clitic = (function () {
      var mm = /'(ve|re|m|ll|d|s)$/.exec(prev);
      if (!mm || mm.index === 0) return '';
      var stem = prev.slice(0, mm.index);
      return (POS_SUBJ[stem] || POS_REL[stem] || POS_BE[stem] || POS_HAVE[stem]
        || POS_MODAL[stem]) ? mm[1] : '';
    })();
    var hardAux = clitic === 've' || clitic === 'll' || clitic === 'd';
    // 's 缩写两头跑:who's producing 是 has/进行,it's good / there's another 是 be。
    // 后面那个词真是分词形态(ing 或词典里对不上原形)才当 has,否则按 be。
    var nextPart = /ing$/.test(next) || (!!next && headOf(next) !== next
      && /(?:ed|d|t|n|en)$/.test(next));
    var cliticBe = clitic === 're' || clitic === 'm' || (clitic === 's' && !nextPart);
    // more/most/less/least 挂在名词前是比较级标记,不是限定词。
    var prevCmp = /^(?:more|most|less|least)$/.test(prev);
    // 光杆所有格复数(victorians' makes up):撇号落在词与词之间,词形本身就是复数。
    var prevPlural = posPluralX(prev);
    // be/have 和分词之间常夹一个副词:is now found / has long been。
    // 逗号后面的副词是评述全句的(Ultimately, desire paths),不算这种夹心结构。
    var midAdv = (POS_ADVFIX[prev] || posAdvMorph(prev)) && !punctAt(at);
    // 副词后面又跟一个副词/比较级标记时,它修饰的是后面那个词(energy use far more sustainable)。
    var advChain = midAdv && !!next && (POS_ADVFIX[next] || POS_DEG[next] || isCmp || posAdvMorph(next));
    var advBefore = midAdv && !advChain;
    var bePrev = POS_BE[prev] || (midAdv && POS_BE[prev2]) || cliticBe;
    var havePrev = POS_HAVE[prev] || (midAdv && POS_HAVE[prev2]) || hardAux;
    // where/how/why 引导从句时就是关系副词;只有被限定词撑着(the where and when)才是名词。
    if (POS_WHEADV[w] && avail.adv && !(POS_DET[prev] || possPrev || posPlural(w))) return 'adv';
    // 往右收集连续实词:段内最后一个通常是中心名词,前面的都是定语。
    var end = at;
    while (end + 1 < toks.length && !isBoundary(end + 1)) end++;
    var isHead = (end === at), after = low(end + 1);
    var prevReal = at > 0 && !isFun(at - 1);
    var nextReal = at + 1 < toks.length && !isFun(at + 1);
    // 量词代词化:限定词撑着后面却没宾语(quite a few)、或者直接当主语接情态动词(one must),
    // 这种不是四大类里的任何一类,弃权。
    // 介词后面的 all/both 带逗号(After all,)、或者后面不接名词的 one(no one / past one)
    // 同样是代词/固定短语,该弃权。
    if (POS_QUANTPRON[w] && ((POS_DET[prev] && !nextReal) || POS_MODAL[next]
      || (POS_PREP[prev] && at > 0 && punctAt(at + 1))
      || ((POS_DET[prev] || POS_PREP[prev]) && !posPlural(next) && !POS_DET[next]
        && roughCls(next, toks[at + 1] ? toks[at + 1].h : '') !== 'n'))) {
      dbg('quantPron'); return '';
    }
    // 句子开头的光杆介词插入语(Of course, / For example,):整块是状语,别按中心名词判。
    if (POS_PREP[prev] && !POS_DET[prev2] && !possPrev && isHead && !nextReal
      && (at === 1 || punctAt(at - 1)) && at > 0 && punctAt(at + 1)) {
      dbg('prepSet'); return '';
    }
    // 介词表里的词直接管着宾语(half past seven / feel like a personal attack),
    // 而自己前面没有冠词/所有格撑着(the past / the like)时,它就是介词——四大类装不下,弃权。
    if (POS_PREP[w] && prevReal && !POS_DET[prev] && !possPrev
      && (nextReal || POS_DET[next] || POS_OBJ[next])) {
      dbg('prepUse'); return '';
    }
    var sc = { n: 0, v: 0, a: 0, adv: 0 };
    var pg = prev ? roughCls(prev, toks[at - 1].h) : '';
    var ng = next ? roughCls(next, toks[at + 1].h) : '';
    var coord = (POS_CONJ[prev] && prev2) ? roughCls(prev2, toks[at - 2].h) : '';
    // that 既可能是指示限定词也可能是关系代词:前面是实词(或逗号)时是从句引导词,
    // 后面的词就不该享受"限定词后接名词"的加分。
    var relThat = prev === 'that' && at > 1 && !isFun(at - 2);
    var dashL = /-$/.test(gap(at));          // 复合词右半边:carbon-negative
    var dashR = at + 1 < toks.length && /^-/.test(gap(at + 1));   // 左半边:top-down
    /* --- 动词:谓语 / 不定式 / 完成 / 被动 / 带宾语的 -ing --- */
    // 词典里对不上原形 = 屈折形式(found/built/grown),be 后面是分词而不是表语形容词。
    var infl = !!w && headOf(w) !== w && !posPlural(w);
    // "those planned by ..." 是省了关系代词的被动从句,不是"限定词+名词"。
    var partPassive = infl && next === 'by';
    // 分词形态:词典里对不上原形(found/been/grown)或过去式尾。
    // nothing/ceiling 这类词典原形不是分词,have 后面只有长成这样才是完成时。
    var partForm = infl || /(?:ed|d|t)$/.test(w);
    // 这几条是硬语法线索(不定式、助动词、关系代词、复数主语后面必有谓语),
    // 给到 5 分才压得过"段首名词/定语"那些统计性加分。
    // be 后面接 to 是"主语+系表+不定式"(was shocked to learn),不是动词。
    // to 和动词之间夹个副词也算(to seamlessly cover),但复数词不可能是原形(to silly mistakes)。
    // to 后面只剩介词或什么都没有(go to school / go to bed)时,to 是介词,后面是名词。
    // 反过来,next 才是 to 时:只有 to 前面那个词自己能当主语,后面这个才是动词原形;
    // "leads smart people to develop" 里的 people 前面挂着定语,它是被不定式修饰的名词。
    var prevGoverned = prevReal && !!prev2 && !POS_SUBJ[prev2] && !POS_MODAL[prev2]
      && !POS_NEG[prev2] && !POS_HAVE[prev2] && !POS_DET[prev2] && !POS_CONJ[prev2]
      && !POS_PREP[prev2] && !POS_REL[prev2] && !posPluralX(prev2) && !/(?:ed|ing)$/.test(prev2);
    var toInf = prev === 'to' && !!next && !POS_PREP[next];
    if ((next === 'to' && !bePrev && !POS_DET[prev] && !possPrev && !prevGoverned) || toInf
      || (advBefore && prev2 === 'to' && !posPlural(w))
      || POS_MODAL[prev] || POS_NEG[prev]) sc.v += 5;
    if (havePrev && partForm) sc.v += 4;
    if (clitic === 'll' || clitic === 'd') sc.v += 5;       // we'll see / she'd rather
    if (POS_OBJ[prev] && nextReal) sc.v += 5;               // make us fade away
    if (POS_SUBJ[prev]) sc.v += 4;                            // i think / we must
    if (POS_REL[prev] && (prev !== 'that' || relThat)) sc.v += 5;
    if (contraction && !cliticBe) sc.v += 4;             // who's producing / it's coming
    // 复数主语后面通常是谓语;固定副词(now/then 这类)除外。
    // 主语和谓语之间夹个副词时要往前多看一个词(walkers consistently deviate)。
    // 后面是虚词时不算"宾语",但从句引导词(where/when/that)、程度副词/比较级
    // (delays matter so acutely)、介词短语(deviate from formal walkways)后面照样是谓语。
    var nextClausal = !!(next && (POS_WHEADV[next] || POS_SUBJCONJ[next] || POS_REL[next]));
    var subjIdx = (advBefore && at > 1 && !isFun(at - 2)) ? at - 2 : at - 1;
    var subjWord = subjIdx > 0 ? low(subjIdx) : '';
    var subjPre = subjIdx > 0 ? low(subjIdx - 1) : '';
    // 名词短语的尾巴:整段最后一个实词是限定词开头或复数名词,这段就是"定语+中心名词"。
    var npTail = !isHead && (POS_DET[low(end)] || posPluralX(low(end)));
    // 主语自己前面挂着副词时(often takes place),那个 -s 是第三人称单数而不是复数名词。
    if (((subjIdx === at - 1 && prevReal) || advBefore)
      && posPluralX(/'$/.test(subjWord) ? subjWord.replace(/'$/, '') : subjWord)
      && !(POS_ADVFIX[subjPre] || posAdvMorph(subjPre))
      && (nextReal || nextClausal || POS_DEG[next] || POS_ADVFIX[next] || posAdvMorph(next)
        || (POS_PREP[next] && at + 2 < toks.length && !isFun(at + 2)))
      && !(npTail && avail.a && !infl) && !POS_ADVFIX[w] && !posAdvMorph(w)) sc.v += 5;
    // 单数主语 + 动词第三人称单数(praise leads smart people):-s 词对不上原形、
    // 前面是光杆单数名词、后面整段又是名词短语时,它是谓语动词,不是复数名词。
    if (/s$/.test(w) && headOf(w) !== w && npTail && canMaj(headOf(w), 'v')
      && prevReal && !POS_DET[prev] && !possPrev && !posPluralX(prev)
      && canMaj(toks[at - 1].h, 'n') && !canMaj(toks[at - 1].h, 'a')) sc.v += 5;
    // 主语+谓语+复数宾语(i play games / engineers develop techniques):
    // 前一个词自己挂在主语/情态/过去式动词后面且是原形,这个复数词只能是宾语。
    var prevVerb = prevReal && !posPluralX(prev) && !POS_DET[prev] && !possPrev && !POS_ADVFIX[prev]
      && headOf(prev) === prev && canMaj(toks[at - 1].h, 'v')
      && at > 1 && (POS_SUBJ[prev2] || POS_MODAL[prev2] || POS_NEG[prev2] || POS_REL[prev2]
        || POS_HAVE[prev2] || posPluralX(prev2) || /ed$/.test(prev2));
    if (prevVerb && posPlural(w) && avail.n) sc.n += 5;
    if (bePrev) {
      if (next === 'to' && !/ing$/.test(w) && avail.a) sc.a += 4;   // was shocked to learn
      else if (/ing$/.test(w) || infl) sc.v += 4;           // is now entering / is now found
      else if (/ed$/.test(w)) sc.v += 4;
      else if (!POS_ADVFIX[w]) sc.a += 4;                   // work is complex
    }
    if (next === 'by' && (/(?:ed|d|t)$/.test(w) || infl)) sc.v += 4;   // 被动的施事由 by 引出
    if (/ing$/.test(w) && (!prev || POS_PREP[prev] || POS_SUBJCONJ[prev]
      || (POS_CONJ[prev] && coord === 'v') || midAdv)) sc.v += 4;
    // 逗号后孤零零一个 -ing:伴随状语,不是名词(thrives on ..., limiting emissions)。
    if (/ing$/.test(w) && at > 0 && punctAt(at) && !isFun(at - 1)) sc.v += 4;
    if (advBefore) { sc.v += 3; sc.a += 2; }                 // often takes / deeply worried
    // 主语 + 夹心副词 + 原形动词(i often talk / and even live longer):副词后面等着谓语。
    if (advBefore && avail.v && !infl && !posPlural(w)
      && (POS_SUBJ[prev2] || POS_MODAL[prev2] || POS_NEG[prev2] || POS_REL[prev2]
        || POS_CONJ[prev2] || posPluralX(prev2))) sc.v += 4;
    // 句首评述副词后面跟一个原形动词再接副词:Yet look closely at...(祈使句)。
    if (midAdv && advChain && avail.v && !possPrev && !POS_DET[prev2]) sc.v += 3;
    // 并列谓语:and/or 后面那个 -ed/-ing 形式,和前面那个动词同级(erected..., or posted signs)。
    if (POS_CONJ[prev] && (/(?:ing|ed)$/.test(w) || infl) && nextReal) sc.v += 4;
    // 并列谓语另一种写法:and/or 后面是原形,后面要么直接挂状语(and finish at four),
    // 要么带着自己的宾语(or play basketball with them)。
    var coordVerb = POS_CONJ[prev] && avail.v && !infl && !posPlural(w) && !posNounMorph(w)
      && !posAdjMorph(w) && (POS_PREP[next] || POS_PART[next] || POS_ADVFIX[next]
        || posAdvMorph(next)
        || (nextReal && (POS_PREP[low(at + 2)] || POS_DET[low(at + 2)] || POS_OBJ[low(at + 2)])));
    if (coordVerb) sc.v += 4;
    // 名词+形容词+名词:形容词不会被名词修饰,所以中间这个是谓语(demand significant amounts)。
    // 段尾得真是名词,否则是 energy use far more sustainable 这种副词接在后面的情况。
    if (!isHead && ng === 'a' && prevReal && pg !== 'a' && !posAdjMorph(w) && !coord
      && (posPlural(low(end)) || roughCls(low(end), toks[end].h) === 'n')) sc.v += 4;
    if (at === 0 && (/(?:ed|d|t)$/.test(w) || infl) && !possPrev) sc.v += 3;  // Known to urbanists, ...
    // 前一个是限定式过去式动词(前面跟着主语/助动词,或者自己就是句首),
    // 后面挂个 -ing 是它的补足语(i started posting them),不是名词。
    var prevFinite = /ed$/.test(prev) && !POS_CONJ[prev] && !POS_DET[prev]
      && (at > 1 ? (POS_SUBJ[prev2] || POS_MODAL[prev2] || POS_NEG[prev2] || POS_HAVE[prev2]
        || POS_REL[prev2] || POS_BE[prev2] || prevPlural) : true);
    if (prevFinite && /ing$/.test(w)) sc.v += 4;
    // 谓语+宾语:前面是实义主语、后面跟着限定词/宾格/复数名词。
    // 前面自己就是谓语(rel/modal/aux/主语代词/分词/to 后的原形)时,这个词是宾语(wire fences、use power)。
    var prevIsVerb = at > 1 && (POS_REL[prev2] || POS_MODAL[prev2] || POS_NEG[prev2]
      || POS_HAVE[prev2] || POS_BE[prev2] || POS_SUBJ[prev2] || prev2 === 'to'
      || /(?:ing|ed)$/.test(prev));
    if (isHead && prevReal && pg !== 'n' && !prevIsVerb
      && (POS_DET[next] || POS_OBJ[next] || posPlural(next))) sc.v += 3;
    // -and/or 之后紧跟 -ate/-ize 这类纯动词形:并列谓语(designate)。
    if (/(?:ize|ise|ify|ate)$/.test(w) && avail.v && (POS_CONJ[prev] || POS_REL[prev]
      || POS_SUBJ[prev] || POS_MODAL[prev] || POS_NEG[prev]
      || (prevReal && posPlural(prev)))) sc.v += 5;
    /* --- 名词:名词短语的中心词 --- */
    if (isHead) {
      // have/has/had 后面不成分词的光杆词是宾语(had fun),不是动词。
      if (POS_HAVEAUX[prev] && !partForm && avail.n) sc.n += 4;
      if ((POS_DET[prev] && !relThat && !partPassive && !prevCmp) || (possPrev && !partPassive)
        || pg === 'a') sc.n += 4;
      if (POS_PREP[prev] || prev === 'to') sc.n += 3;      // into action / go to school
      if (after && (POS_PREP[after] || POS_REL[after] || POS_BE[after]
        || POS_HAVE[after] || POS_MODAL[after]) && !(POS_PREP[prev] && POS_PREP[next])) {
        sc.n += 3;  // the hope that / amount of
      }
      if (!after) sc.n += 2;
      // the + 程度副词 + X:形容词名词化(At the very least)。
      if (POS_DEG[prev] && POS_DET[prev2]) sc.n += 5;
      if (prevReal && sc.v < 3) sc.n += 3;                  // 复合名词中心词:campus landscape
      if (coord && !coordVerb) sc[coord] += 3;              // 并列项跟着前一项走
      // 名词 + to 不定式(the way to do):词典里没动词大类,那它就是名词。
      if (next === 'to' && !avail.v && !bePrev) sc.n += 3;
    } else {
      sc.n += 2;
    }
    // 自带所有格尾巴的词一定是名词(10 minute's break)。
    var selfStem = /'s$|’s$/.test(toks[at].w) ? w.replace(/'s$|’s$/, '') : '';
    if (!!selfStem && !(POS_SUBJ[selfStem] || POS_REL[selfStem] || POS_BE[selfStem]
      || POS_HAVE[selfStem] || POS_MODAL[selfStem]) && avail.n) sc.n += 5;
    // 限定词/介词/to + 形容词 + 复数名词:中心名词是复数,不是比较级尾巴(a few mistakes)。
    if (!isHead && posPlural(w) && avail.n && pg === 'a'
      && (POS_DET[prev2] || POS_PREP[prev2] || prev2 === 'to' || prevCmp)) sc.n += 5;
    if (posPlural(w) && ng === 'v') sc.n += 4;      // millions of pedestrians navigate
    // 一串复数并列;引号刚合上的那个词是标题不是并列主语('Smiling Victorians' makes up)。
    if (posPlural(w) && prevReal && posPlural(prev) && !quoteEnd) sc.n += 5;
    if (at > 0 && /^[A-Z]/.test(toks[at].w) && isHead && !isFun(at - 1)) sc.n += 3;
    if (posNounMorph(w) && !infl && (isHead || !avail.a)) sc.n += 2;
    // 复合词左半边:后面接名词的高/净/反(night-、high-)是修饰语,接小品词的(top-down)是名词。
    if (dashR) {
      if (avail.a && !POS_PART[next]) sc.a += 5; else sc.n += 4;
    }
    // 紧贴在复数/名词前面、词典里同时有动词大类的光杆词是名词作定语(desire paths / wire fences),
    // 不是谓语;前面自己就是复数主语时也不行(engineers develop techniques 是谓语+宾语)。
    // 前面是虚词时更不可能是定语:主语代词后面是谓语(i play games),连词后面也是(or play)。
    // 所有格撑着的不算复数主语:The farmers' market 里的 farmers' 是定语,不是主语。
    // 有 a. 大类的(old paper / human movement)交给下面形容词那条,这里不碰;
    // to 后面是动词原形(to use power),-ing 直接带宾语是分行结构(limiting emissions)。
    if (!isHead && prevReal && avail.v && !avail.a && prev !== 'to' && !/ing$/.test(w)
      && !posAdjMorph(w) && !advBefore && (!posPlural(prev) || possPrev) && !POS_SUBJ[prev]
      && !POS_CONJ[prev] && (posPlural(next) || ng === 'n')) sc.n += 5;
    /* --- 形容词:定语位置,或有程度副词/be 撑着 --- */
    // more/most 后面跟形容词时是比较级(become more human),这条要先定,免得被定语加分抢走。
    var cmpAdv = isCmp && avail.adv && next && !posPlural(next) && !POS_DET[next]
      && !POS_PREP[next] && (ng === 'a' || ng === 'adv' || posAdjMorph(next)
        || posAdvMorph(next) || (toks[at + 1] && canMaj(toks[at + 1].h, 'a')));
    if (!isHead) {
      if (avail.a && !(isCmp && cmpAdv) && !(advBefore && avail.v && !infl && !posPlural(w))) sc.a += 4;
      else if (sc.v < 3 && !advBefore) sc.n += 3;
    }
    // 往回找最近的 be:中间只允许限定词和虚词(i'm 13 years old)。
    var beAhead = false;
    for (var bi = at - 2; bi >= 0 && bi > at - 5; bi--) {
      var bj = low(bi);
      if (POS_BE[bj] || /'(m|re|s)$/.test(bj)) { beAhead = true; break; }
      if (!POS_DET[bj] && !isFun(bi)) break;
    }
    // 数量短语后面的表语形容词(i'm 13 years old)。
    if (beAhead && isHead && avail.a && posPlural(prev) && !nextReal) sc.a += 4;
    if (dashL && avail.a && !POS_PART[w]) sc.a += 4;
    if (POS_DEG[prev] && !isCmp) sc.a += 4;
    if (prevCmp && avail.a) sc.a += 4;                       // more human / most efficient
    if (posAdjMorph(w)) sc.a += 2;
    if (/est$/.test(w) && POS_DET[prev]) sc.a += 3;
    if (coord === 'a' && /(?:ing|ed)$/.test(w) && avail.a) sc.a += 5;   // awkward and frustrating
    // 介词后面光秃秃一个 -ing 是动名词(preoccupied with looking for),不是名词。
    if (/ing$/.test(w) && infl && POS_PREP[prev] && !POS_DET[prev2] && !possPrev) sc.n = 0;
    /* --- 副词 --- */
    if (posAdvMorph(w)) sc.adv += 2;
    if (POS_ADVFIX[w] && avail.adv) {
      if (at === 0 || bePrev || havePrev || POS_MODAL[prev] || POS_NEG[prev]
        || POS_CONJ[prev]) sc.adv += 5;
      if (prevReal && nextReal) sc.adv += 5;          // 夹在主谓之间
      if (POS_DET[next] || POS_DEG[next] || ng === 'adv' || ng === 'v') sc.adv += 3;
      if (POS_PREP[next] && prevReal) sc.adv += 3;   // both in their labs
      if (after === 'and' || after === 'or') sc.adv += 3;   // both ... and
    }
    // at/in + half + past:时间说法里的 half 是副词(at half past seven)。
    if (POS_PREP[prev] && POS_PREP[next] && avail.adv && !POS_DET[prev2] && !possPrev) sc.adv += 5;
    // 动词后面紧跟介词的光杆词是方式副词:must think hard about...
    // 词典里没有名词大类、前面又确实是动词(情态/助动词/主语代词之后)才敢这么判;
    // 后面直接跟 be/助动词的是从句成分(transforming what was once),不是副词。
    if (avail.adv && !avail.n && prevReal && !nextReal && !POS_DET[next]
      && !POS_BE[next] && !POS_HAVE[next] && !POS_MODAL[next] && !POS_NEG[next]
      && (POS_MODAL[prev2] || POS_HAVE[prev2] || POS_SUBJ[prev2] || POS_REL[prev2]
        || roughCls(prev, toks[at - 1].h) === 'v')) sc.adv += 4;
    // more/most/less/least 后面不是名词时是级别标记,不是限定词(more human)。
    if (cmpAdv) sc.adv += 5;
    if (nextReal && /(?:ing|ed)$/.test(next) && ng === 'v') sc.adv += 3;  // well spent
    if (POS_DEBUG) {
      POS_TRACE = { w: w, head: head, at: at, isHead: isHead, after: after, mj: mj.join('/'),
        prev: prev, next: next, prev2: prev2, end: end, pg: pg, ng: ng, coord: coord,
        relThat: relThat, dashL: dashL, dashR: dashR, possPrev: possPrev, midAdv: midAdv,
        bePrev: bePrev, havePrev: havePrev, prevReal: prevReal, nextReal: nextReal, infl: infl,
        clitic: clitic, prevCmp: prevCmp, prevPlural: prevPlural, prevFinite: prevFinite,
        cmpAdv: cmpAdv, partForm: partForm,
        ctx: [prev2, prev, w, next, low(at + 2)].join(' '),
        sc: { n: sc.n, v: sc.v, a: sc.a, adv: sc.adv } };
    }
    var best = '', bestN = 0, tie = false;
    ['n', 'v', 'a', 'adv'].forEach(function (g) {
      if (!avail[g]) return;
      if (sc[g] > bestN) { best = g; bestN = sc[g]; tie = false; }
      else if (sc[g] === bestN && sc[g] > 0) tie = true;
    });
    if (bestN < 3) { dbg('weak'); return ''; }
    if (tie) { dbg('tie'); return ''; }
    return best;
  }
  function tagset() {
    var m = mode();
    if (m === 'rank') return null;
    // 空数组也是有效设定(小学档只认基础词),别用 || 回落到 zk。
    return TAG_MODES[m] ? TAG_MODES[m] : TAG_MODES.zk;
  }
  function isLearning(word) {
    var m = mode();
    var tags = tagsOf(word), i, k;
    if (m === 'advanced') {
      // 求索:只划没进任何分级表的词;ky/toefl/gre 这些有档可依的不算。
      for (i = 0; i < tags.length; i++) if (TIER_ORDER.indexOf(tags[i]) >= 0) return false;
      return true;
    }
    var want = GOAL_TIER[m];
    if (!want) return false;
    var ti = TIER_ORDER.indexOf(want), hitGoal = false;
    for (i = 0; i < tags.length; i++) {
      k = TIER_ORDER.indexOf(tags[i]);
      if (k < 0) continue;
      if (k < ti) return false;      // 更低档已包含,不算本档新词
      if (k === ti) hitGoal = true;
    }
    return hitGoal;
  }
  function mode() {
    var m = S && S.settings.known_mode;
    return (m === 'rank' || TAG_MODES[m]) ? m : 'zk';
  }
  function knownRank() {
    return clamp(parseInt(S && S.settings.known_rank, 10) || 1400, 500, 20000);
  }

  function isKnown(word) {
    var h = headOf(word);
    var hit = knownCache.get(h);
    if (hit !== undefined) return hit;
    var val = computeKnown(h);
    knownCache.set(h, val);
    return val;
  }

  function computeKnown(h) {
    var rec = S.words[h];
    if (rec) {
      var st = +rec.st || 0;
      if (st === IGNORED || st === WELLKNOWN) return true;
      if (+rec.no) return false;
    }
    if (isProper(h)) return true;
    var inTable = inTableOf(h);
    if (rec) {
      var chk = +rec.chk || 0, pas = +rec.pass || 0;
      var graduated = chk ? (pas >= Math.max(3, chk * 2)) : (pas >= 3);
      if (chk > 0 && !inTable && !graduated) return false;
      if (pas >= 3) return true;
    }
    return inTable;
  }

  /* 词表判定:词频保底 ∪ 累积考试标签。派生词带自己的词条却没带标签时
     (traveling / cancelled),退一步查去掉词尾的原形。 */
  function inTableOf(h) {
    var cands = [h].concat(stemVariants(h).filter(function (c) { return c !== h; }));
    var rankMode = mode() === 'rank';
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i], rank = rankOf(c);
      if (rankMode) {
        if (rank && rank <= knownRank()) return true;
        continue;
      }
      if (rank && rank <= KNOWN_FLOOR) return true;
      var want = tagset(), tags = tagsOf(c);
      for (var j = 0; j < tags.length; j++) {
        if (want.indexOf(tags[j]) >= 0) return true;
      }
    }
    return false;
  }

  function hiTag(word) {
    var key = String(word || '').toLowerCase();
    var hit = hiCache.get(key);
    if (hit !== undefined) return hit;
    var tag = computeHiTag(word);
    hiCache.set(key, tag);
    return tag;
  }
  function computeHiTag(word) {
    var rec = S.words[headOf(word)];
    if (!rec) {
      if (isKnown(word)) return '';
      if (isProper(headOf(word))) return '';
      // 大写开头又没点过的词,多半是人名/地名。词典对 Wendy 这类名字的
      // 词频不可靠,靠大小写兜一下,免得正文里一半名字都带虚线。
      if (/^[A-Z]/.test(word) && word.length > 1) return '';
      if (isLearning(word)) return 'learn';
      var r = rankOf(word);
      return (!r || r > HINT_RANK) ? 'hint' : '';
    }
    if (+rec.no) return 'no';
    var st = +rec.st || 0;
    if (st === IGNORED || st === WELLKNOWN) return '';
    if (isKnown(word)) return '';
    var n = Math.max(+rec.n || 0, 1);
    if (n >= 8) return '';
    var name = stageOf(n);
    var idx = 0;
    for (var i = 0; i < STAGES.length; i++) if (STAGES[i][1] === name) idx = i;
    return 's' + (idx + 1);
  }

  function stageOf(n) {
    var label = '';
    for (var i = 0; i < STAGES.length; i++) if (n >= STAGES[i][0]) label = STAGES[i][1];
    return label;
  }
  function stageText(rec) {
    var st = +rec.st || 0;
    if (st === WELLKNOWN) return '已掌握';
    if (st === IGNORED) return '已忽略';
    if (+rec.no) return '不会';
    return stageOf(Math.max(+rec.n || 0, 1));
  }
  function stageClass(rec) {
    var t = stageText(rec);
    if (t === '已掌握') return 'known';
    if (t === '已忽略') return 'known';
    if (t === '不会') return 'no';
    var map = { '初遇': 's1', '再见': 's2', '熟识': 's3', '掌握': 's4' };
    return map[t] || '';
  }
  function isLeech(rec) {
    if (!rec) return false;
    var st = +rec.st || 0;
    if (st === IGNORED || st === WELLKNOWN) return false;
    var chk = +rec.chk || 0;
    return chk >= 4 && chk > (+rec.pass || 0);
  }

  /* ---------------- SRS ---------------- */
  function stabOf(rec) {
    var v = parseFloat(rec && rec.stab);
    if (!isFinite(v) || v <= 0) v = 1;
    return clamp(v, 0.5, 365);
  }
  function interval(stab) {
    if (stab < 1) return 0;
    return Math.max(1, Math.round(stab));
  }
  function dueOf(rec, fallback) {
    var last = parseDay((rec && (rec.last || rec.first || rec.due)) || fallback, new Date());
    return addDays(last, interval(stabOf(rec)));
  }
  function ensureSrs(rec, day) {
    day = day || new Date();
    if (!rec.stab) rec.stab = 1;
    if (!rec.last) rec.last = String(rec.first || isoDate(day)).slice(0, 10);
    if (rec.chk === undefined) rec.chk = (+rec.n || 0) >= 1 ? 1 : 0;
    if (rec.pass === undefined) rec.pass = 0;
    rec.due = isoDate(dueOf(rec, day));
    return rec;
  }
  function onCheck(rec) {
    var day = new Date();
    ensureSrs(rec, day);
    rec.stab = Math.round(Math.max(0.5, stabOf(rec) * 0.6) * 1000) / 1000;
    rec.last = isoDate(day);
    rec.chk = (+rec.chk || 0) + 1;
    rec.pass = 0;
    rec.due = isoDate(dueOf(rec, day));
    return rec;
  }
  function onPass(rec) {
    var day = new Date();
    ensureSrs(rec, day);
    rec.stab = Math.round(Math.min(365, Math.max(1, stabOf(rec)) * 1.8) * 1000) / 1000;
    rec.last = isoDate(day);
    rec.pass = (+rec.pass || 0) + 1;
    rec.due = isoDate(dueOf(rec, day));
    return rec;
  }
  function dueLabel(rec) {
    if (!rec) return '—';
    var st = +rec.st || 0;
    if (st === IGNORED || st === WELLKNOWN) return '—';
    // 两边都归到当天零点再比;直接拿 due 的零点减“现在”会少算一天。
    var n = dayDiff(parseDay(rec.due, new Date()), parseDay(todayKey()));
    if (n === 0) return '今天到期';
    if (n < 0) return '逾期 ' + (-n) + ' 天';
    return n + ' 天后';
  }

  /* ---------------- 存档 ---------------- */
  function freshSettings() {
    var s = {};
    for (var k in DEFAULT_SETTINGS) s[k] = Array.isArray(DEFAULT_SETTINGS[k])
      ? DEFAULT_SETTINGS[k].slice() : DEFAULT_SETTINGS[k];
    return s;
  }
  function defaultState() {
    return {
      version: 4, settings: freshSettings(), articles: {}, days: {}, words: {},
      read_words: {}, total_words: 0, last_stem: null, hidden_books: {},
      favorites: { folders: [{ id: DEFAULT_FAV.id, name: DEFAULT_FAV.name }], map: {} },
      readPos: {},
      marks: [],
      history: [],
      mirrors: null      // 同步源镜像清单；null 表示用内置那份
    };
  }
  /* 把 JSON 解析出来的普通对象换成无原型对象。
     普通对象的原型链上有 constructor / toString / valueOf 这些名字,词典里
     恰好有 constructor 这个词:直接 words['constructor'] 会拿到
     Object.prototype.constructor,界面上就渲染成
     「function Object() { [native code] }」,释义还会显示「词典未收录」。
     去掉原型之后,任何 x[k] 都不可能再命中内置成员。 */
  function bare(o) {
    if (!o || typeof o !== 'object') return Object.create(null);
    var n = Object.create(null), k;
    for (k in o) {
      if (Object.prototype.hasOwnProperty.call(o, k)) n[k] = o[k];
    }
    return n;
  }
  function loadState() {
    var base = defaultState();
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return base;
      var obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        if (obj.settings) for (var k in base.settings) {
          if (obj.settings[k] !== undefined) base.settings[k] = obj.settings[k];
        }
        ['articles', 'days', 'words', 'read_words', 'readPos'].forEach(function (k) {
          if (obj[k] && typeof obj[k] === 'object') base[k] = obj[k];
        });
        base.total_words = +obj.total_words || 0;
        base.last_stem = obj.last_stem || null;
        if (obj.hidden_books && typeof obj.hidden_books === 'object') base.hidden_books = obj.hidden_books;
        if (obj.favorites && typeof obj.favorites === 'object') base.favorites = obj.favorites;
        if (Array.isArray(obj.marks)) base.marks = obj.marks;
        if (Array.isArray(obj.history)) base.history = obj.history;
        if (obj.mirrors && typeof obj.mirrors === 'object'
            && Array.isArray(obj.mirrors.list)) base.mirrors = obj.mirrors;
      }
    } catch (e) { /* 存档坏了就当新档,不弹窗挡人 */ }
    return base;
  }
  function normalizeState() {
    var st = S.settings;
    st.font_size = clamp(Math.round(+st.font_size || 19), 15, 28);
    st.goal_words = clamp(Math.round(+st.goal_words || 150), 25, 1000);
    if (st.theme !== 'light' && st.theme !== 'dark') st.theme = 'auto';
    if (!TAG_MODES[st.known_mode]) st.known_mode = 'zk';
    if (!Array.isArray(st.recent)) st.recent = [];
    if (!S.words || typeof S.words !== 'object') S.words = {};
    if (!S.articles || typeof S.articles !== 'object') S.articles = {};
    if (!S.days || typeof S.days !== 'object') S.days = {};
    if (!S.read_words || typeof S.read_words !== 'object') S.read_words = {};
    if (!S.readPos || typeof S.readPos !== 'object') S.readPos = {};
    if (!S.hidden_books || typeof S.hidden_books !== 'object') S.hidden_books = {};
    // 这几张表都用「词/文章名」当键,得挡掉原型链上的 constructor 之类。
    S.words = bare(S.words);
    S.articles = bare(S.articles);
    S.days = bare(S.days);
    S.read_words = bare(S.read_words);
    S.readPos = bare(S.readPos);
    S.hidden_books = bare(S.hidden_books);
    delete S.deleted_books;
    delete S.deleted_articles;
    var fav = S.favorites;
    if (!fav || typeof fav !== 'object') fav = S.favorites = {};
    if (!Array.isArray(fav.folders)) fav.folders = [];
    fav.folders = fav.folders.filter(function (f) { return f && f.id; });
    if (!fav.folders.length) fav.folders.push({ id: DEFAULT_FAV.id, name: DEFAULT_FAV.name });
    if (!fav.map || typeof fav.map !== 'object') fav.map = {};
    var ids = {};
    fav.folders.forEach(function (f) { ids[f.id] = 1; });
    Object.keys(fav.map).forEach(function (s) {
      if (!ids[fav.map[s]]) fav.map[s] = fav.folders[0].id;
    });
    if (!Array.isArray(S.history)) S.history = [];
    S.history = S.history.filter(function (x) { return x && typeof x.s === 'string'; })
      .slice(0, HISTORY_MAX);
    normalizeMarks();
  }
  // 划线记录:文章 stem + 段落号 + 句范围 + 段内字符偏移;旧存档没这个字段就是空。
  function normalizeMarks() {
    if (!Array.isArray(S.marks)) S.marks = [];
    S.marks = S.marks.filter(function (m) {
      return !!(m && typeof m.i === 'string' && typeof m.s === 'string'
        && +m.p >= 0 && Array.isArray(m.r) && m.r.length);
    }).map(function (m) {
      var rs = [];
      for (var i = 0; i < m.r.length; i++) {
        var a = +m.r[i][0] || 0, b = +m.r[i][1] || 0;
        if (b > a) rs.push([a, b]);
      }
      m.r = rs;
      m.p = +m.p;
      m.a = +m.a || 0;
      m.b = +m.b || 0;
      m.n = typeof m.n === 'string' ? m.n.slice(0, 800) : '';
      m.t = +m.t || 0;
      return m;
    });
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 180);
  }
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { /* 满了也只丢本次 */ }
  }
  function dropCaches() {
    knownCache.clear();
    hiCache.clear();
    hintCache.clear();
    cachesRev++;
  }

  /* ---------------- 收藏 / 历史 ---------------- */
  function favFolders() { return S.favorites.folders; }
  function favFolderName(id) {
    var list = favFolders();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].name;
    return '';
  }
  function favFolderOf(stem) { return S.favorites.map[stem] || ''; }
  function isFav(stem) { return !!favFolderOf(stem); }
  function favCount() {
    return Object.keys(S.favorites.map).filter(function (s) { return !!A_MAP[s]; }).length;
  }
  function ensureDefaultFolder() {
    if (!favFolders().length) favFolders().push({ id: DEFAULT_FAV.id, name: DEFAULT_FAV.name });
    return favFolders()[0].id;
  }
  function toggleFav(stem) {
    var art = A_MAP[stem];
    if (!art) return;
    if (isFav(stem)) {
      delete S.favorites.map[stem];
      notify('已取消收藏');
    } else {
      var id = ensureDefaultFolder();
      S.favorites.map[stem] = id;
      notify('已收藏到「' + favFolderName(id) + '」');
    }
    saveNow();
  }

  function recordHistory(stem) {
    var list = (S.history || []).filter(function (x) { return x && x.s !== stem; });
    list.unshift({ s: stem, at: Date.now() });
    S.history = list.slice(0, HISTORY_MAX);
  }
  function timeLabel(ts) {
    var d = new Date(+ts || 0);
    if (!isFinite(d.getTime()) || !+ts) return '';
    var t = (d.getHours() < 10 ? '0' : '') + d.getHours() + ':'
      + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
    var key = isoDate(d);
    if (key === todayKey()) return '今天 ' + t;
    if (key === isoDate(addDays(new Date(), -1))) return '昨天 ' + t;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  /* ---------------- 本地书库(IndexedDB) ---------------- */
  function idbOpen() {
    if (idbPromise) return idbPromise;
    idbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('这台设备不支持本地书库')); return; }
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('ai')) db.createObjectStore('ai', { keyPath: 'k' });
        if (!db.objectStoreNames.contains('sc')) db.createObjectStore('sc', { keyPath: 'k' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('本地书库打不开')); };
    });
    return idbPromise;
  }
  function idbTx(store, mode, fn) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, mode);
        var os = tx.objectStore(store);
        var out;
        try { out = fn(os); } catch (e) { reject(e); return; }
        tx.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        tx.onerror = function () { reject(tx.error || new Error('本地书库写入失败')); };
        tx.onabort = function () { reject(tx.error || new Error('本地书库操作取消')); };
      });
    });
  }
  function idbPut(store, val) {
    return idbTx(store, 'readwrite', function (os) { return os.put(val); });
  }
  function idbDel(store, key) {
    return idbTx(store, 'readwrite', function (os) { return os.delete(key); });
  }
  function idbAll(store) {
    return idbTx(store, 'readonly', function (os) { return os.getAll(); });
  }

  function loadExtras() {
    return Promise.all([idbAll('books'), idbAll('ai')]).then(function (res) {
      BOOKS = (res[0] || []).filter(function (b) {
        return b && b.id && b.chapters && b.chapters.length;
      });
      BOOKS.sort(function (a, b) { return (+a.added || 0) - (+b.added || 0); });
      AI_TR = {};
      (res[1] || []).forEach(function (r) { if (r && r.k) AI_TR[r.k] = r; });
    }).catch(function () {
      BOOKS = [];
      AI_TR = {};
    });
  }

  // 复习句子的中文缓存:开页时捞一次,写满上限就不再落盘。
  function loadSentCache() {
    return idbAll('sc').then(function (rows) {
      (rows || []).forEach(function (r) { if (r && r.k && r.z) scCache[r.k] = r.z; });
    }).catch(function () {});
  }
  function keepSentTrans(sent, zh) {
    scCache[sent] = zh;
    if (sentCacheCount() > SC_CACHE_MAX) return;
    idbPut('sc', { k: sent, z: zh }).catch(function () {});
  }
  // 重译的词义也放在 sc 库里,别把句子译文的上限挤掉。
  function sentCacheCount() {
    var keys = Object.keys(scCache), n = 0;
    for (var i = 0; i < keys.length; i++) if (keys[i].slice(0, 3) !== 'dw:') n++;
    return n;
  }
  function dictOverrideKey(head) {
    return 'dw:' + String(head || '').toLowerCase();
  }
  function ovLines(head) {
    var ov = dictOverride(head);
    if (!ov) return [];
    return ov.trs.map(function (t) {
      var pos = cleanText((t && t.pos) || '');
      var tran = cleanText((t && t.tran) || '');
      return { pos: posKeyOf(pos), text: (pos ? pos + ' ' : '') + tran };
    }).filter(function (x) { return !!x.text; });
  }
  // 联网重译过的词优先显示覆盖结果;内置词典文件本身不动。
  function dictOverride(head) {
    var raw = scCache[dictOverrideKey(head)];
    if (raw && String(raw).charAt(0) === '{') {
      try {
        var obj = JSON.parse(raw);
        var trs = obj && obj.trs;
        if (trs && trs.length) {
          return { phon: String(obj.phon || ''), trs: Array.prototype.slice.call(trs) };
        }
      } catch (e) { /* 坏数据当没有,回内置词典 */ }
    }
    // 1.5.6 只存了一串整词译文,兼容成一条不带词性的释义。
    var legacy = scCache['w:' + String(head || '').toLowerCase()];
    if (legacy && String(legacy).charAt(0) !== '{') {
      return { phon: '', trs: [{ pos: '', tran: String(legacy) }] };
    }
    return null;
  }
  function saveDictOverride(head, obj) {
    var key = dictOverrideKey(head), val = JSON.stringify(obj || {});
    scCache[key] = val;
    idbPut('sc', { k: key, z: val }).catch(function () {});
  }
  function dropDictOverride(head) {
    var keys = [dictOverrideKey(head), 'w:' + String(head || '').toLowerCase()];
    for (var i = 0; i < keys.length; i++) {
      delete scCache[keys[i]];
      idbDel('sc', keys[i]).catch(function () {});
    }
  }
  // 只影响释义显示:生词判定、挖空、词频统计仍然看内置词典。
  function defLinesOf(head) {
    var lines = ovLines(head);
    return lines.length ? lines : posLines(lookup(head)[1]);
  }
  function defText(head) {
    var lines = ovLines(head);
    if (lines.length) return lines.map(function (x) { return x.text; }).join(' / ');
    return lookup(head)[1];
  }

  function bookArticle(book, bookIndex, ch, i) {
    var paras = (ch.paras && ch.paras.length) ? ch.paras : paragraphsFromText(ch.text || '');
    var stem = 'ib:' + book.id + ':' + i;
    var tr = cleanTrans(((AI_TR['tr:' + stem] || {}).c) || ch.c || []);
    var level = book.level === 0 ? 0 : 90;
    var rec = {
      s: stem, l: level, q: (level === 0 ? 400000 : 500000) + bookIndex * 2000 + i,
      t: ch.t || ('第 ' + (i + 1) + ' 章'), w: wordsOf(paras.join(' ')),
      p: paras, c: tr, k: true, ib: 1, bk: book.id
    };
    if (level === 90) {
      rec.b = book.id;
      rec.bt = book.title || '导入图书';
      rec.cn = i + 1;
    }
    return rec;
  }

  function sortA(a, b) {
    var qa = (a.o === undefined) ? a.q : a.o;
    var qb = (b.o === undefined) ? b.q : b.o;
    return (a.l - b.l) || (qa - qb) || (a.s < b.s ? -1 : 1);
  }

  function rebuildA() {
    A = CORE_A.filter(function (a) {
      return !(a.l === 90 && a.b && S && S.hidden_books && S.hidden_books[a.b]);
    });
    for (var i = 0; i < BOOKS.length; i++) {
      var b = BOOKS[i];
      for (var j = 0; j < b.chapters.length; j++) A.push(bookArticle(b, i, b.chapters[j], j));
    }
    A.sort(sortA);
    A_MAP = {};
    for (var k = 0; k < A.length; k++) A_MAP[A[k].s] = A[k];
    sentences = null;
    ctxCache.clear();
    dropCaches();
  }

  function bookOf(stem) {
    var a = A_MAP[stem];
    if (!a || !a.bk) return null;
    for (var i = 0; i < BOOKS.length; i++) if (BOOKS[i].id === a.bk) return BOOKS[i];
    return null;
  }
  function importedBookCount() {
    return BOOKS.filter(function (b) { return b.kind !== 'epi'; }).length;
  }

  /* ---------------- DeepSeek ---------------- */
  function aiKey() {
    try { return String(localStorage.getItem(AI_KEY_STORE) || '').trim(); } catch (e) { return ''; }
  }
  function setAiKey(k) {
    try {
      if (k) localStorage.setItem(AI_KEY_STORE, k);
      else localStorage.removeItem(AI_KEY_STORE);
    } catch (e) { /* 隐私模式下存不了,只影响本次 */ }
  }
  function maskedKey() {
    var k = aiKey();
    if (!k) return '';
    if (k.length <= 10) return '已保存';
    return k.slice(0, 4) + '…' + k.slice(-4);
  }
  function transProvider() {
    return S && S.settings && S.settings.trans_provider === 'deepseek'
      ? 'deepseek' : 'tencent';
  }

  function aiCall(messages, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var key = opts.key || aiKey();
      if (!key) { reject(new Error('还没有设置 DeepSeek API Key')); return; }
      var body = JSON.stringify({
        model: AI_MODEL, messages: messages, stream: false,
        temperature: opts.temperature === undefined ? 0.3 : opts.temperature,
        max_tokens: opts.max_tokens || 4000
      });
      if (window.Android && typeof window.Android.aiChat === 'function') {
        var id = 'ai' + (++aiSeq) + '-' + Date.now();
        var timer = setTimeout(function () {
          if (!aiWait[id]) return;
          delete aiWait[id];
          reject(new Error('请求超时,请检查网络后重试'));
        }, opts.timeout || 180000);
        aiWait[id] = {
          resolve: function (text) { clearTimeout(timer); resolve(text); },
          reject: function (err) { clearTimeout(timer); reject(err); }
        };
        try { window.Android.aiChat(id, body, key); }
        catch (e) {
          clearTimeout(timer);
          delete aiWait[id];
          reject(new Error('无法连接网络组件'));
        }
        return;
      }
      // 浏览器里直接调;Android 外壳会走上面的原生桥,避开 CORS。
      fetch(AI_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: body
      }).then(function (r) {
        return r.text().then(function (raw) {
          if (!r.ok) throw new Error('接口返回 ' + r.status + ' ' + raw.slice(0, 160));
          var obj = JSON.parse(raw);
          var txt = obj && obj.choices && obj.choices[0] && obj.choices[0].message
            && obj.choices[0].message.content;
          if (!txt) throw new Error('接口没有返回内容');
          resolve(String(txt));
        });
      }).catch(function (e) {
        var msg = String(e && e.message || e);
        if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
          msg = '浏览器直连被拦截了;装成 App 后会走系统网络';
        }
        reject(new Error(msg));
      });
    });
  }

  // 原生外壳把结果回调到这里。
  window.__aiResult = function (id, payload) {
    var waiter = aiWait[id];
    if (!waiter) return;
    delete aiWait[id];
    try {
      var obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
      if (obj && obj.ok) waiter.resolve(String(obj.content || ''));
      else waiter.reject(new Error((obj && obj.error) || '请求失败'));
    } catch (e) {
      waiter.reject(new Error('请求结果看不懂'));
    }
  };

  // 有道公开词典(免 Key):一次点击一个请求,只拿词性 + 中文释义。
  window.__dictResult = function (id, payload) {
    var waiter = dictWait[id];
    if (!waiter) return;
    delete dictWait[id];
    try {
      var obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
      if (obj && obj.ok) waiter.resolve(String(obj.content || ''));
      else waiter.reject(new Error((obj && obj.error) || '请求失败'));
    } catch (e) {
      waiter.reject(new Error('请求结果看不懂'));
    }
  };

  function youdaoDict(word) {
    return new Promise(function (resolve, reject) {
      if (!window.Android || typeof window.Android.dictWord !== 'function') {
        reject(new Error('当前环境不能调用联网词典'));
        return;
      }
      var id = 'dw' + (++dictSeq) + '-' + Date.now();
      var timer = setTimeout(function () {
        if (!dictWait[id]) return;
        delete dictWait[id];
        reject(new Error('联网词典请求超时'));
      }, 20000);
      dictWait[id] = {
        resolve: function (text) { clearTimeout(timer); resolve(text); },
        reject: function (err) { clearTimeout(timer); reject(err); }
      };
      try { window.Android.dictWord(id, String(word || '')); }
      catch (e) {
        clearTimeout(timer);
        delete dictWait[id];
        reject(new Error('无法连接网络组件'));
      }
    }).then(function (raw) {
      var obj;
      try { obj = JSON.parse(raw); }
      catch (e) { throw new Error('词典返回的内容看不懂'); }
      var arr = obj && obj.trs, trs = [];
      for (var i = 0; arr && i < arr.length; i++) {
        var tran = cleanText((arr[i] || {}).tran);
        if (!tran) continue;
        trs.push({ pos: cleanText(arr[i].pos), tran: tran });
      }
      if (!trs.length) throw new Error('词典没给出释义');
      return { phon: cleanPhon(obj.phon), trs: trs };
    });
  }

  /* ---------------- 检查更新 ---------------- */
  // 版本号比较:1.5.10 > 1.5.9。缺位当 0 处理。
  function verCmp(a, b) {
    var x = String(a || '0').split('.'), y = String(b || '0').split('.');
    for (var i = 0; i < Math.max(x.length, y.length); i++) {
      var m = parseInt(x[i], 10), n = parseInt(y[i], 10);
      m = isNaN(m) ? 0 : m; n = isNaN(n) ? 0 : n;
      if (m !== n) return m > n ? 1 : -1;
    }
    return 0;
  }

  window.__updateResult = function (id, payload) {
    var waiter = upWait[id];
    if (!waiter) return;
    delete upWait[id];
    try {
      var obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
      if (obj && obj.ok) waiter.resolve(obj);
      else waiter.reject(new Error((obj && obj.error) || '请求失败'));
    } catch (e) {
      waiter.reject(new Error('检查结果异常，请稍后重试'));
    }
  };

  // 原生壳读 GitHub Release;接口不通时原生会退到重定向地址取 tag,再退到镜像。
  function checkUpdate() {
    return new Promise(function (resolve, reject) {
      if (!window.Android || typeof window.Android.checkUpdate !== 'function') {
        reject(new Error('请在安装版 App 中检查更新'));
        return;
      }
      var id = 'up' + (++upSeq) + '-' + Date.now();
      var timer = setTimeout(function () {
        if (!upWait[id]) return;
        delete upWait[id];
        reject(new Error('检查更新超时'));
      }, 15000);
      upWait[id] = {
        resolve: function (o) { clearTimeout(timer); resolve(o); },
        reject: function (err) { clearTimeout(timer); reject(err); }
      };
      try { window.Android.checkUpdate(id); }
      catch (e) {
        clearTimeout(timer);
        delete upWait[id];
        reject(new Error('无法连接网络组件'));
      }
    });
  }

  // 只更新内存里的最新版;下载按钮直接吃这份缓存。
  function rememberRelease(rel) {
    latestRel = { version: rel.version, url: rel.url || '', notes: rel.notes || '',
                  sha: rel.sha || '', size: +rel.size || 0 };
  }

  // 检查成功后的公共收尾:记时间、存缓存。返回去掉 v 的版本号。
  function applyRelease(rel) {
    var version = String(rel && rel.version || '').replace(/^v/i, '');
    if (!version) return '';
    S.settings.update_last = Date.now();
    saveNow();
    rememberRelease({ version: version, url: rel.url, notes: rel.notes,
                      sha: rel.sha, size: rel.size });
    return version;
  }

  // 手动检查:有新版弹层,没新版提示;失败给一行提示。
  function runUpdateCheck() {
    if (upBusy) return;
    upBusy = true;
    setUpdateBusy(true);
    checkUpdate().then(function (rel) {
      var version = applyRelease(rel);
      upBusy = false;
      if (!version) {
        notify('未获取到版本号，请稍后重试');
      } else if (verCmp(version, APP_VERSION) > 0) {
        updateSheet(version);
      } else {
        notify('已是最新版本 ' + APP_VERSION);
      }
      if (current === 'set-update') renderUpdate();
    }).catch(function (e) {
      upBusy = false;
      notify(String(e && e.message || e).indexOf('安装版 App') >= 0
        ? '请在安装版 App 中检查更新' : '检查失败,请检查网络后重试');
      if (current === 'set-update') renderUpdate();
    });
  }

  // 启动后的静默检查:不弹 toast,失败不出声,更新时间只记成功。
  function autoUpdateCheck() {
    if (upAutoDone || !S) return;
    upAutoDone = true;
    var freq = String(S.settings.update_freq || 'launch');
    if (freq === 'never') return;
    if (freq !== 'launch') {
      var due = Date.now() - (+S.settings.update_last || 0) >= (+freq) * 86400000;
      if (!due) return;
    }
    if (upBusy) return;
    var bannerBefore = updateBannerHTML();
    checkUpdate().then(function (rel) {
      var version = applyRelease(rel);
      if (!version || !rel.url) return;
      // 首页已经画完了才补提示条;不在别的页面打扰,提示条由下次回首页时自然带出。
      if (!bannerBefore && updateBannerHTML() && current === 'read' && !readerStem) renderRead();
      // 当前页直接弹更新框:压在最顶层,但别盖掉已经打开的面板。
      if (verCmp(version, APP_VERSION) > 0
          && S.settings.update_skip !== version
          && !upPopupSeen
          && $('#sheet').classList.contains('hidden')) {
        upPopupSeen = true;
        updateSheet(version);
      }
    }).catch(function () { /* 静默 */ });
  }

  function updateSheet(version) {
    var notes = cleanText(latestRel && latestRel.notes || '').slice(0, 300);
    sheetDirty = false;
    showSheet('<div class="sheet-grip"></div>'
      + '<div class="confirm-title">发现新版本 v' + esc(version) + '</div>'
      + '<div class="confirm-text">当前 ' + esc(APP_VERSION) + '</div>'
      + (notes ? '<div class="about-row"><p>' + esc(notes) + '</p></div>' : '')
      + '<div class="sheet-actions">'
      + '<button class="btn ghost" data-sheet-act="update-later">稍后</button>'
      + '<button class="btn primary" data-sheet-act="update-download">下载安装</button>'
      + '</div>');
    $('#sheet').classList.add('sheet-top');
    $('#backdrop').classList.add('sheet-top');
  }

  // 点下载(官方/镜像):有缓存直接下;没缓存先静默查一次。
  // 同版本也放行 —— 重装、换机都要能下;失败只提示,不开浏览器。
  function downloadLatestPage(mirrorIdx) {
    if (upBusy) return;
    var rel = latestRel;
    if (rel && rel.url) {
      startApkDownload(rel.url);
      return;
    }
    upBusy = true;
    setUpdateBusy(true);
    checkUpdate().then(function (r) {
      var version = String(r && r.version || '').replace(/^v/i, '');
      if (version) {
        S.settings.update_last = Date.now();
        saveNow();
        rememberRelease({ version: version, url: r.url, notes: r.notes,
                          sha: r.sha, size: r.size });
      }
      upBusy = false;
      if (!r.url) {
        notify('检查失败,暂时拿不到下载地址,请稍后重试');
        if (current === 'set-update') renderUpdate();
        return;
      }
      if (current === 'set-update') renderUpdate();
      startApkDownload(r.url);
    }).catch(function () {
      upBusy = false;
      notify('检查失败,暂时拿不到下载地址,请稍后重试');
      if (current === 'set-update') renderUpdate();
    });
  }

  function openGH(url) {
    if (window.Android && typeof window.Android.openUrl === 'function') {
      window.Android.openUrl(url);
    } else if (window.open) {
      window.open(url, '_blank');
    }
  }

  // 只改「检查新版本」按钮的文案,不整页重绘(重绘会丢滚动位置)。
  function setUpdateBusy(busy) {
    var btn = document.querySelector('[data-act="update-check"]');
    if (!btn) return;
    btn.disabled = !!busy;
    btn.textContent = busy ? '检查中…' : '检查';
  }

  /* ---------------- 镜像源：列表、同步、取用 ---------------- */

  function mirrorName(prefix) {
    return String(prefix).replace(/^https:\/\//i, '').replace(/\/+$/, '');
  }

  // 当前生效的前缀数组，交给原生做测速选源。
  function mirrorPrefixes() {
    var out = [];
    for (var i = 0; i < GH_MIRRORS.length; i++) {
      if (GH_MIRRORS[i] && GH_MIRRORS[i].prefix) out.push(GH_MIRRORS[i].prefix);
    }
    return out;
  }

  function mirrorsJson() { return JSON.stringify(mirrorPrefixes()); }

  // 把一份清单洗成 [{name,prefix}]；洗不出东西就返回 false，保持原样。
  // 同步是「合并」不是「替换」：远端测过的排前面，内置的只要没重名就留着，
  // 免得远端某个时间点测漏了几条，用户反而候选变少。
  function applyMirrorList(list, updated) {
    var clean = [];
    var seen = {};
    for (var i = 0; i < list.length && clean.length < 16; i++) {
      var item = list[i];
      var prefix = '';
      if (typeof item === 'string') prefix = item;
      else if (item && item.prefix) prefix = String(item.prefix);
      prefix = prefix.replace(/^\s+|\s+$/g, '');
      if (!/^https:\/\//i.test(prefix)) continue;
      if (prefix.charAt(prefix.length - 1) !== '/') prefix += '/';
      if (seen[prefix]) continue;
      seen[prefix] = 1;
      clean.push({ name: mirrorName(prefix), prefix: prefix });
    }
    if (!clean.length) return false;
    for (var k = 0; k < DEFAULT_MIRRORS.length && clean.length < 16; k++) {
      var def = DEFAULT_MIRRORS[k];
      if (seen[def.prefix]) continue;
      seen[def.prefix] = 1;
      clean.push({ name: def.name, prefix: def.prefix });
    }
    S.mirrors = { list: clean, updated: updated || '' };
    GH_MIRRORS = clean;
    saveNow();
    return true;
  }

  function resetMirrors() {
    S.mirrors = null;
    GH_MIRRORS = DEFAULT_MIRRORS.slice();
    saveNow();
  }

  // 启动时把上次同步到的清单装上；坏了就静默回落到内置那份。
  function applySavedMirrors() {
    var saved = S && S.mirrors;
    if (!saved || !saved.list || !saved.list.length) {
      GH_MIRRORS = DEFAULT_MIRRORS.slice();
      return;
    }
    var clean = [];
    for (var i = 0; i < saved.list.length && clean.length < 16; i++) {
      var item = saved.list[i];
      var prefix = item && item.prefix ? String(item.prefix) : '';
      if (!/^https:\/\//i.test(prefix)) continue;
      if (prefix.charAt(prefix.length - 1) !== '/') prefix += '/';
      clean.push({ name: mirrorName(prefix), prefix: prefix });
    }
    GH_MIRRORS = clean.length ? clean : DEFAULT_MIRRORS.slice();
  }

  function syncMirrors() {
    if (!window.Android || typeof window.Android.syncMirrors !== 'function') {
      notify('请在安装版 App 中同步');
      return;
    }
    mirrorSync = { state: 'busy', text: '正在同步…' };
    paintMirrorSync();
    window.Android.syncMirrors(mirrorsJson());
  }

  // 原生回报同步结果：json 是远端清单原文，error 非空表示没拉到。
  window.__mirrorSync = function (json, error) {
    var msg = String(error || '');
    if (msg) {
      mirrorSync = { state: 'fail', text: '同步失败：' + msg };
      paintMirrorSync();
      return;
    }
    var data = null;
    try { data = JSON.parse(json); } catch (e) { data = null; }
    var list = data ? (data.mirrors || data.list) : null;
    if (!list || !list.length) {
      mirrorSync = { state: 'fail', text: '同步失败：清单是空的' };
      paintMirrorSync();
      return;
    }
    var ok = applyMirrorList(list, data.updated || '');
    mirrorSync = ok
      ? { state: 'ok', text: '已更新，现在有 ' + GH_MIRRORS.length + ' 个源' }
      : { state: 'fail', text: '同步失败：清单格式不对' };
    if (ok) mirrorCheck = { state: 'ok', at: Date.now() };
    if (ok && current === 'set-update') notify('下载源已更新：' + GH_MIRRORS.length + ' 个源');
    if (current === 'set-mirror') renderMirrorSettings();
    else if (current === 'set-update') renderUpdate();
    else paintMirrorSync();
  };

  /* 远端镜像清单是否比本地生效的这份新。只查不用：真正替换要用户点「同步」。 */
  function localMirrorsUpdated() {
    return (S.mirrors && S.mirrors.updated) || MIRRORS_BUILT_AT;
  }

  function checkMirrorsStale(force) {
    if (!window.Android || typeof window.Android.checkMirrors !== 'function') return;
    if (!force && mirrorCheck.at && Date.now() - mirrorCheck.at < 5 * 60 * 1000) return;
    mirrorCheck = { state: 'checking', at: Date.now() };
    window.Android.checkMirrors(mirrorsJson());
  }

  window.__mirrorCheck = function (json, error) {
    if (error) { mirrorCheck = { state: 'fail', at: Date.now() }; return; }
    var data = null;
    try { data = JSON.parse(json); } catch (e) { data = null; }
    var remote = data && data.updated ? String(data.updated) : '';
    var stale = !!remote && remote > localMirrorsUpdated();
    var was = mirrorCheck.state;
    mirrorCheck = { state: stale ? 'stale' : 'ok', at: Date.now() };
    if (stale !== (was === 'stale') && current === 'set-update') renderUpdate();
  };

  function paintMirrorSync() {
    var box = $('#mirrorSyncLine');
    if (!box) return;
    if (!mirrorSync || !mirrorSync.text) {
      box.setAttribute('hidden', '');
      box.textContent = '';
      return;
    }
    box.removeAttribute('hidden');
    box.className = 'apk-state' + (mirrorSync.state === 'fail' ? ' warn' : '');
    box.textContent = mirrorSync.text;
  }

  /* ---------------- 应用内下载 ---------------- */

  function startApkDownload(url) {
    var version = String((latestRel && latestRel.version) || '').replace(/^v/i, '');
    var name = 'IdleRead' + (version ? '-' + version : '') + '.apk';
    if (window.Android && typeof window.Android.downloadApk === 'function') {
      apkState = { state: 'downloading', text: '正在测速选源', pct: 0 };
      paintApkState();
      // 哈希一起交给原生:下完立刻比对,不用页面再算一遍。
      // 镜像列表也一起给：原生会逐条测速，挑最快的几条一起下。
      window.Android.downloadApk(url, name, updateHash(), mirrorsJson());
    } else {
      notify('请在安装版 App 中操作');
      var m = GH_MIRRORS[0];
      openGH(m ? m.prefix + url : url);
    }
  }

  function pauseApkDownload() {
    if (!window.Android || typeof window.Android.pauseApkDownload !== 'function') return;
    window.Android.pauseApkDownload();
  }

  function resumeApkDownload() {
    if (!window.Android || typeof window.Android.resumeApkDownload !== 'function') return;
    window.Android.resumeApkDownload();
  }

  // 原生桥回报下载进度:只动进度条和百分比,不重绘整页。
  window.__apkProgress = function (done, total) {
    var d = +done || 0, t = +total || 0;
    var pct = t > 0 ? Math.min(99, Math.round(d / t * 100)) : 0;
    apkState = { state: 'downloading', pct: pct,
                 text: t > 0 ? '正在下载 ' + pct + '%' : '正在下载…' };
    paintApkState();
  };

  // 原生桥回报校验/安装结果。
  window.__apkResult = function (state, text) {
    var prev = apkState || {};
    var name = String(state || '');
    apkState = { state: name, text: String(text || ''),
                 pct: name === 'ok' || name === 'installing' ? 100 : (prev.pct || 0) };
    if (name === 'badhash' || name === 'fail') notify(apkState.text || '下载没成功');
    paintApkState();
  };

  // 状态配色:通过/正在安装走绿,校验失败/缺权限走红,其余中性。
  var APK_TONE = { ok: 'ok', installing: 'ok', badhash: 'warn',
                   fail: 'warn', permission: 'warn' };

  // 进度条 + 状态行 + 暂停/安装按钮常驻渲染(空则 hidden),点下载后只原地改,不重绘整页。
  function apkStateHTML() {
    var has = !!(apkState && apkState.text);
    var tone = has ? (APK_TONE[apkState.state] || '') : '';
    var pct = apkPercent();
    var st = has ? apkState.state : '';
    var ready = st === 'ok';
    var downloading = st === 'downloading';
    var paused = st === 'paused';
    return '<div class="apk-panel" id="apkPanel"' + (has ? '' : ' hidden') + '>'
      + '<div class="apk-bar' + (tone ? ' ' + tone : '') + '" id="apkBar">'
      + '<i id="apkBarFill" style="width:' + pct + '%"></i></div>'
      + '<div class="apk-line">'
      + '<span class="apk-state' + (tone ? ' ' + tone : '') + '" id="apkState">'
      + (has ? esc(apkState.text) : '') + '</span>'
      + '<button class="btn small soft" id="apkPauseBtn" data-act="apk-pause"'
      + (downloading ? '' : ' hidden') + '>暂停</button>'
      + '<button class="btn small primary" id="apkResumeBtn" data-act="apk-resume"'
      + (paused ? '' : ' hidden') + '>继续</button>'
      + '<button class="btn small primary" id="apkInstallBtn" data-act="apk-install"'
      + (ready ? '' : ' hidden') + '>安装</button>'
      + '</div>'
      + '<div class="apk-tip" id="apkTip"' + (downloading || paused ? '' : ' hidden') + '>'
      + (paused ? '已暂停，已下载部分会保留，点「继续」可续传'
                : '下载期间请勿退出 App；切到后台或熄屏可能导致中断')
      + '</div></div>';
  }

  function apkPercent() {
    if (!apkState) return 0;
    if (apkState.state === 'ok' || apkState.state === 'installing') return 100;
    return Math.max(0, Math.min(100, +apkState.pct || 0));
  }

  function paintApkState() {
    var panel = $('#apkPanel');
    if (!panel || !apkState) return;
    var has = !!apkState.text;
    if (has) panel.removeAttribute('hidden');
    else panel.setAttribute('hidden', '');

    var st = apkState.state;
    var tone = APK_TONE[st] || '';
    var text = $('#apkState');
    if (text) {
      text.className = 'apk-state' + (tone ? ' ' + tone : '');
      text.textContent = apkState.text || '';
    }
    var bar = $('#apkBar');
    if (bar) bar.className = 'apk-bar' + (tone ? ' ' + tone : '');
    var fill = $('#apkBarFill');
    if (fill) fill.style.width = apkPercent() + '%';

    var install = $('#apkInstallBtn');
    if (install) {
      if (st === 'ok') install.removeAttribute('hidden');
      else install.setAttribute('hidden', '');
    }
    var pause = $('#apkPauseBtn');
    if (pause) {
      if (st === 'downloading') pause.removeAttribute('hidden');
      else pause.setAttribute('hidden', '');
    }
    var resume = $('#apkResumeBtn');
    if (resume) {
      if (st === 'paused') resume.removeAttribute('hidden');
      else resume.setAttribute('hidden', '');
    }
    var tip = $('#apkTip');
    if (tip) {
      var showTip = st === 'downloading' || st === 'paused';
      if (showTip) tip.removeAttribute('hidden');
      else tip.setAttribute('hidden', '');
      tip.textContent = st === 'paused'
        ? '已暂停，已下载部分会保留，点「继续」可续传'
        : '下载期间请勿退出 App；切到后台或熄屏可能导致中断';
    }
  }

  // 首页顶部的新版本提示条:检查到新版且没被 × 掉才显示。
  function updateBannerHTML() {
    var r = latestRel;
    if (!r || !r.version || verCmp(r.version, APP_VERSION) <= 0
        || S.settings.update_skip === r.version) return '';
    return '<div class="up-banner">发现新版本 ' + esc(r.version)
      + '<span class="grow"></span>'
      + '<button class="btn small soft" data-act="update-view">查看</button>'
      + '<button class="up-close" data-act="update-banner-close" aria-label="忽略">×</button>'
      + '</div>';
  }

  function tencentBody(list) {
    return JSON.stringify({
      header: { fn: 'auto_translation', client_key: 'browser-chrome-120.0.0-Windows-10' },
      type: 'plain',
      model_category: 'normal',
      source: { lang: 'en', text_list: list },
      target: { lang: 'zh' }
    });
  }

  window.__tcResult = function (id, payload) {
    var waiter = tcWait[id];
    if (!waiter) return;
    delete tcWait[id];
    try {
      var obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
      if (obj && obj.ok) waiter.resolve(String(obj.content || ''));
      else {
        var msg = (obj && obj.error) || '请求失败';
        var err = new Error(msg);
        if (/接口返回\s*(429|403)\b/.test(msg)) err.fatal = true;
        waiter.reject(err);
      }
    } catch (e) {
      waiter.reject(new Error('请求结果看不懂'));
    }
  };

  function tencentTranslate(list) {
    return new Promise(function (resolve, reject) {
      if (!window.Android || typeof window.Android.translate !== 'function') {
        reject(new Error('当前环境不能调用腾讯翻译'));
        return;
      }
      var id = 'tc' + (++tcSeq) + '-' + Date.now();
      var timer = setTimeout(function () {
        if (!tcWait[id]) return;
        delete tcWait[id];
        reject(new Error('腾讯翻译请求超时'));
      }, 90000);
      tcWait[id] = {
        resolve: function (text) { clearTimeout(timer); resolve(text); },
        reject: function (err) { clearTimeout(timer); reject(err); }
      };
      try { window.Android.translate(id, tencentBody(list)); }
      catch (e) {
        delete tcWait[id];
        clearTimeout(timer);
        reject(new Error('无法连接网络组件'));
      }
    }).then(function (raw) {
      var obj;
      try { obj = JSON.parse(raw); }
      catch (e) { throw new Error('腾讯返回的内容看不懂'); }
      if (obj && obj.header && obj.header.ret_code
          && obj.header.ret_code !== 'succ') {
        throw new Error('腾讯返回 ' + obj.header.ret_code);
      }
      var arr = obj && obj.auto_translation;
      if (!Array.isArray(arr) || arr.length !== list.length) {
        throw new Error('段落数对不上(要 ' + list.length + ' 段)');
      }
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        var zh = typeof arr[i] === 'string' ? cleanText(arr[i]) : '';
        if (!zh) throw new Error('译文有空段');
        out.push(zh);
      }
      return out;
    });
  }

  function translateChunkTencent(paras, index, total) {
    var out = [], items = [];
    for (var i = 0; i < paras.length; i++) {
      out[i] = '';
      if (String(paras[i] || '').trim()) items.push({ i: i, text: String(paras[i]) });
    }
    if (!items.length) return Promise.resolve(out);
    function texts(list) {
      return list.map(function (x) { return x.text; });
    }
    function fill(list, arr) {
      for (var j = 0; j < list.length; j++) out[list[j].i] = arr[j];
      return out;
    }
    function attempt(k) {
      setBusyText('第 ' + (index + 1) + '/' + total + ' 块 · '
        + (k ? '重试…' : '腾讯翻译中…'));
      return tencentTranslate(texts(items)).catch(function (err) {
        if (err && err.fatal) throw err;
        if (k < 1) return attempt(k + 1);
        throw err;
      });
    }
    return attempt(0).then(function (arr) {
      return fill(items, arr);
    }).catch(function (err) {
      if ((err && err.fatal) || items.length < 2) throw err;
      var mid = Math.ceil(items.length / 2);
      var a = items.slice(0, mid), b = items.slice(mid);
      setBusyText('第 ' + (index + 1) + '/' + total + ' 块 · 拆成两半重试…');
      return tencentTranslate(texts(a)).then(function (ra) {
        return new Promise(function (resolve) { setTimeout(resolve, 300); }).then(function () {
          return tencentTranslate(texts(b));
        }).then(function (rb) {
          return fill(items, ra.concat(rb));
        });
      });
    });
  }

  function parseJsonArray(text, n) {
    var t = String(text || '').trim();
    t = t.replace(/^\s*```[a-zA-Z]*\s*/, '').replace(/\s*```\s*$/, '');
    var lo = t.indexOf('['), hi = t.lastIndexOf(']');
    if (lo < 0 || hi <= lo) return null;
    try {
      var arr = JSON.parse(t.slice(lo, hi + 1));
      if (!Array.isArray(arr) || arr.length !== n) return null;
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        var x = arr[i];
        if (x && typeof x === 'object') x = x.zh || x.chinese || x.translation || '';
        var zh = typeof x === 'string' ? cleanText(x) : '';
        if (!zh) return null;
        out.push(zh);
      }
      return out;
    } catch (e) { return null; }
  }

  /* ---------------- 图书解析 ---------------- */
  function cleanBookText(t) { return cleanText(t); }

  function sentenceChunks(block, target) {
    var parts = String(block || '').match(/[^.!?。！？]+[.!?。！？]+["”’']?|[^.!?。！？]+$/g) || [block];
    var out = [], buf = [], n = 0;
    for (var i = 0; i < parts.length; i++) {
      var s = parts[i].trim();
      if (!s) continue;
      buf.push(s);
      n += wordsOf(s);
      if (n >= target) {
        out.push(buf.join(' '));
        buf = [];
        n = 0;
      }
    }
    if (buf.length) out.push(buf.join(' '));
    return out;
  }

  function paragraphsFromText(text, target) {
    target = target || 95;
    var t = cleanBookText(text);
    if (!t) return [];
    var blocks = t.split(/\n\s*\n/).map(function (b) {
      return b.replace(/\n+/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
    }).filter(Boolean);
    if (blocks.length < 2) {
      var lines = t.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
      if (lines.length > 3) blocks = lines;
    }
    var out = [];
    for (var i = 0; i < blocks.length; i++) {
      if (wordsOf(blocks[i]) <= 145) out.push(blocks[i]);
      else out = out.concat(sentenceChunks(blocks[i], target));
    }
    return out.filter(function (x) { return wordsOf(x) >= 1; });
  }

  var TXT_HEAD_CN = /^第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[章节回卷部篇集](?:\s|[:：、.·—-]|$)[^\n]{0,40}$/;
  var TXT_HEAD_SPECIAL = /^(?:序章|序言|前言|引子|楔子|尾声|后记|附录|番外|prologue|epilogue)\s*[^\n]{0,36}$/i;
  var TXT_HEAD_EN = /^(?:chapter|part|book|section)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b[^\n]{0,50}$/i;
  var TXT_HEAD_NUM = /^\d{1,3}[.、]\s*[^\n]{1,36}$/;

  function isTxtHeading(line, prevBlank) {
    var t = String(line || '').trim();
    if (!t || t.length > 62) return false;
    if (TXT_HEAD_CN.test(t) || TXT_HEAD_SPECIAL.test(t) || TXT_HEAD_EN.test(t)) return true;
    if (prevBlank && TXT_HEAD_NUM.test(t) && wordsOf(t) <= 8) return true;
    return false;
  }

  function txtChapters(text, fallbackTitle) {
    var t = cleanBookText(text);
    var lines = t.split('\n');
    var heads = [];
    for (var i = 0; i < lines.length; i++) {
      var prev = i === 0 || !lines[i - 1].trim();
      if (isTxtHeading(lines[i], prev)) heads.push(i);
    }
    // 一两个目录行不算章节,至少要有两章才拆。
    if (heads.length < 2) heads = [];
    var chapters = [];
    if (heads.length) {
      var intro = lines.slice(0, heads[0]).join('\n').trim();
      if (wordsOf(intro) >= 40) chapters.push({ t: '前言', paras: paragraphsFromText(intro) });
      for (var h = 0; h < heads.length; h++) {
        var title = lines[heads[h]].trim().replace(/\s+/g, ' ');
        var end = h + 1 < heads.length ? heads[h + 1] : lines.length;
        var body = lines.slice(heads[h] + 1, end).join('\n').trim();
        if (wordsOf(body) < 8) continue;
        chapters.push({ t: title.slice(0, 60), paras: paragraphsFromText(body) });
      }
    }
    if (!chapters.length) {
      var all = paragraphsFromText(t);
      if (!all.length) return [];
      var words = wordsOf(all.join(' '));
      // 没有章节标记的大文件按 1800 词左右切,免得一页塞十万词。
      if (words > 4500) {
        var cur = [], n = 0, part = 1;
        for (var p = 0; p < all.length; p++) {
          cur.push(all[p]);
          n += wordsOf(all[p]);
          if (n >= 1800) {
            chapters.push({ t: fallbackTitle + ' · ' + part, paras: cur });
            cur = []; n = 0; part++;
          }
        }
        if (cur.length) chapters.push({ t: fallbackTitle + ' · ' + part, paras: cur });
      } else {
        chapters.push({ t: fallbackTitle, paras: all });
      }
    }
    return chapters.filter(function (c) { return c.paras && c.paras.length; });
  }

  // 复制给 AI 的导入规则,和上面的解析代码保持一致;改解析先同步改这里。
  var IMPORT_RULES_TEXT = [
    '请生成一个纯文本 .txt 文件,给「闲读」App 导入图书用。规则如下:',
    '',
    '1) 文件格式:只要纯文本 .txt;不要 Word/PDF/EPUB;不要目录、页码、插图说明、页眉页脚。',
    '2) 编码:推荐 UTF-8;App 也能自动识别 UTF-8 BOM、UTF-16 LE/BE(带 BOM)、GB18030/GBK。',
    '3) 章节标题:必须单独占一行,且至少要有 2 个章节标题才会拆章(只有 1 个不拆)。标题行不超过 62 个字符。可识别的写法:',
    '   - 「第X章」「第X节」「第X回」「第X卷」「第X部」「第X篇」「第X集」,X 是阿拉伯数字或中文数字(零〇一二三四五六七八九十百千万两),后面可以跟空格、冒号、顿号、点、·、—、-,或直接结束;整行不超过 40 字。例:第一章、第 12 章 归途、第3节:出发',
    '   - 序章、序言、前言、引子、楔子、尾声、后记、附录、番外、prologue、epilogue 开头,后面不超过 36 字',
    '   - Chapter / Part / Book / Section + 数字、罗马数字或英文数字单词(one…twenty),后面不超过 50 个字符。例:Chapter 1、CHAPTER IV、Part Two',
    '   - 「1. 标题」「1、标题」这种数字编号,整行不超过 36 字且不超过 8 个单词,并且这一行前面必须有一个空行',
    '4) 每章正文至少 8 个单词,太短的会被丢掉;第一个章节标题之前的内容如果超过 40 词,会作为「前言」保留。',
    '5) 段落:用空行分段;段内不要手动硬换行(单个换行会被合并成一个空格);连续空格会被合并;单段超过 145 词会被按句子(. ! ? 。 ! ?)自动切成约 95 词的小段,所以建议每段控制在 145 词以内。',
    '6) 如果整篇没有任何章节标题:会按段落整篇处理;全文超过 4500 词时按每约 1800 词自动切分。',
    '7) 按以上规则输出完整正文,不要加解释、不要加 Markdown 标记,直接给 .txt 内容。'
  ].join('\n');

  function decodeBytes(buf) {
    var u8 = new Uint8Array(buf);
    try {
      if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) {
        return new TextDecoder('utf-8').decode(u8.subarray(3));
      }
      if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8.subarray(2));
      if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8.subarray(2));
      try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); }
      catch (e) { return new TextDecoder('gb18030').decode(u8); }
    } catch (e) {
      return new TextDecoder('utf-8').decode(u8);
    }
  }

  function readFileBuf(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('文件读不出来')); };
      fr.readAsArrayBuffer(file);
    });
  }

  function u16(buf, off) { return new DataView(buf).getUint16(off, true); }
  function u32(buf, off) { return new DataView(buf).getUint32(off, true); }

  function zipEntries(buf) {
    var u8 = new Uint8Array(buf), len = u8.length;
    var eocd = -1;
    for (var i = len - 22; i >= Math.max(0, len - 65557); i--) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) {
        eocd = i; break;
      }
    }
    if (eocd < 0) throw new Error('这个 EPUB 不是有效的压缩包');
    var count = u16(buf, eocd + 10);
    var pos = u32(buf, eocd + 16);
    var entries = [];
    for (var k = 0; k < count && pos + 46 <= len; k++) {
      if (u32(buf, pos) !== 0x02014b50) break;
      var method = u16(buf, pos + 10);
      var compSize = u32(buf, pos + 20);
      var rawSize = u32(buf, pos + 24);
      var nameLen = u16(buf, pos + 28);
      var extraLen = u16(buf, pos + 30);
      var cmtLen = u16(buf, pos + 32);
      var local = u32(buf, pos + 42);
      var name = new TextDecoder('utf-8').decode(u8.subarray(pos + 46, pos + 46 + nameLen));
      entries.push({ name: name, method: method, compSize: compSize, size: rawSize, local: local });
      pos += 46 + nameLen + extraLen + cmtLen;
    }
    return entries;
  }

  function zipRead(buf, entry) {
    if (entry.method === 0) {
      var start = entry.local + 30 + u16(buf, entry.local + 26) + u16(buf, entry.local + 28);
      return Promise.resolve(buf.slice(start, start + entry.compSize));
    }
    if (entry.method !== 8) return Promise.reject(new Error('EPUB 里有不支持的压缩方式'));
    if (typeof DecompressionStream !== 'function') {
      return Promise.reject(new Error('系统 WebView 太旧,解不开 EPUB'));
    }
    var s = entry.local + 30 + u16(buf, entry.local + 26) + u16(buf, entry.local + 28);
    var data = new Uint8Array(buf.slice(s, s + entry.compSize));
    try {
      var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream).arrayBuffer();
    } catch (e) {
      return Promise.reject(new Error('EPUB 解压失败'));
    }
  }

  function dirOf(path) {
    var i = String(path || '').lastIndexOf('/');
    return i < 0 ? '' : path.slice(0, i + 1);
  }
  function resolveHref(base, href) {
    href = decodeURIComponent(String(href || '').replace(/#.*$/, ''));
    var full = href.charAt(0) === '/' ? href.slice(1) : base + href;
    var parts = full.split('/'), out = [];
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i] || parts[i] === '.') continue;
      if (parts[i] === '..') out.pop(); else out.push(parts[i]);
    }
    return out.join('/');
  }

  function parseXml(text, type) {
    var doc = new DOMParser().parseFromString(text, type || 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('EPUB 里的说明文件坏了');
    return doc;
  }

  function htmlChapters(html, fallbackTitle) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var body = doc.body;
    if (!body) return [];
    Array.prototype.slice.call(body.querySelectorAll('script,style,nav,svg')).forEach(function (n) {
      n.parentNode && n.parentNode.removeChild(n);
    });
    var nodes = Array.prototype.slice.call(body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre'));
    var blocks = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.querySelector && n.querySelector('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre')) continue;
      var txt = String(n.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt) continue;
      blocks.push({ text: txt, head: /^H[1-3]$/.test(n.tagName), level: /^H/.test(n.tagName) });
    }
    if (!blocks.length) {
      var plain = String(body.textContent || '').replace(/\s+/g, ' ').trim();
      var ps = paragraphsFromText(plain);
      return ps.length ? [{ t: fallbackTitle, paras: ps }] : [];
    }
    var hcount = blocks.filter(function (b) { return b.head; }).length;
    var chapters = [];
    if (hcount >= 2) {
      var cur = { t: '', paras: [] };
      for (var j = 0; j < blocks.length; j++) {
        var b = blocks[j];
        if (b.head && wordsOf(b.text) <= 18) {
          if (cur.paras.length) chapters.push(cur);
          cur = { t: b.text.slice(0, 70), paras: [] };
        } else {
          cur.paras.push(b.text);
        }
      }
      if (cur.paras.length) chapters.push(cur);
      if (hcount >= 3 && chapters.length > 1 && wordsOf(chapters[0].paras.join(' ')) < 12) chapters.shift();
    } else {
      var title = '';
      for (var q = 0; q < blocks.length; q++) if (blocks[q].head) { title = blocks[q].text; break; }
      var paras = blocks.filter(function (x) { return !x.head || wordsOf(x.text) > 18; })
        .map(function (x) { return x.text; });
      chapters.push({ t: (title && title.length <= 70 ? title : fallbackTitle), paras: paras });
    }
    var out = [];
    for (var c = 0; c < chapters.length; c++) {
      if (!chapters[c].paras.length) continue;
      out.push({
        t: chapters[c].t || (fallbackTitle + ' · ' + (out.length + 1)),
        paras: paragraphsFromText(chapters[c].paras.join('\n\n'))
      });
    }
    return out;
  }

  function epubBook(buf, fileTitle, onStep) {
    var entries = zipEntries(buf);
    var byName = {};
    entries.forEach(function (e) { byName[e.name] = e; });
    function find(name) {
      if (byName[name]) return byName[name];
      var lower = String(name).toLowerCase();
      for (var k in byName) if (k.toLowerCase() === lower) return byName[k];
      return null;
    }
    var cont = find('META-INF/container.xml');
    if (!cont) throw new Error('EPUB 缺少 container.xml');
    onStep('正在读目录…');
    return zipRead(buf, cont).then(function (ab) {
      var doc = parseXml(decodeBytes(ab));
      var root = doc.querySelector('rootfile');
      if (!root) throw new Error('EPUB 目录里没有 OPF');
      var opfPath = root.getAttribute('full-path');
      var opfEntry = find(opfPath);
      if (!opfEntry) throw new Error('EPUB 找不到内容清单');
      return zipRead(buf, opfEntry).then(function (ab2) {
        var opf = parseXml(decodeBytes(ab2));
        var title = fileTitle;
        var tEl = opf.getElementsByTagName('dc:title')[0] || opf.getElementsByTagName('title')[0];
        if (tEl && tEl.textContent.trim()) title = tEl.textContent.trim();
        var items = {};
        Array.prototype.slice.call(opf.getElementsByTagName('item')).forEach(function (it) {
          items[it.getAttribute('id')] = {
            href: it.getAttribute('href') || '',
            type: it.getAttribute('media-type') || ''
          };
        });
        var base = dirOf(opfPath);
        var docs = [];
        Array.prototype.slice.call(opf.getElementsByTagName('itemref')).forEach(function (ref) {
          var it = items[ref.getAttribute('idref')];
          if (!it || !/html|xml/i.test(it.type)) return;
          docs.push(resolveHref(base, it.href));
        });
        var chapters = [];
        var seq = Promise.resolve();
        docs.forEach(function (path, idx) {
          seq = seq.then(function () {
            var ent = find(path);
            if (!ent) return;
            onStep('正在拆书 ' + (idx + 1) + '/' + docs.length + '…');
            return zipRead(buf, ent).then(function (raw) {
              var html = decodeBytes(raw);
              var fallback = '第 ' + (chapters.length + 1) + ' 章';
              var got = htmlChapters(html, fallback);
              got.forEach(function (ch) {
                if (ch.paras && ch.paras.length) chapters.push(ch);
              });
            }).catch(function () { /* 单章坏掉不影响整本 */ });
          });
        });
        return seq.then(function () {
          if (!chapters.length) throw new Error('这本书里没提取到正文');
          // 去掉只有书名/作者的小页面,并给没标题的章节补编号。
          chapters = chapters.filter(function (c) { return wordsOf(c.paras.join(' ')) >= 12; });
          if (!chapters.length) throw new Error('这本书里没提取到正文');
          chapters.forEach(function (c, i) {
            if (!c.t || c.t === title) c.t = '第 ' + (i + 1) + ' 章';
          });
          return { title: title, chapters: chapters };
        });
      });
    });
  }

  function parseBookFile(file) {
    var name = String(file.name || '导入图书').replace(/\.[^.]+$/, '');
    var ext = (String(file.name || '').match(/\.([^.]+)$/) || [])[1];
    ext = ext ? ext.toLowerCase() : '';
    return readFileBuf(file).then(function (buf) {
      if (ext === 'epub') return epubBook(buf, name, setBusyText);
      var text = decodeBytes(buf);
      setBusyText('正在分章…');
      var chapters = txtChapters(text, name);
      if (!chapters.length) throw new Error('没读到正文;请确认是纯文本 TXT');
      return { title: name, chapters: chapters };
    });
  }
  function todayDay() {
    var k = todayKey();
    if (!S.days[k]) S.days[k] = { words: 0, checks: 0 };
    return S.days[k];
  }
  function addWords(n) {
    todayDay().words = (+todayDay().words || 0) + n;
    S.total_words = (+S.total_words || 0) + n;
  }
  function articleRec(stem) {
    if (!S.articles[stem]) S.articles[stem] = { read: [], done: false };
    return S.articles[stem];
  }
  function wordRec(head) {
    return S.words[head];
  }
  function ensureWord(head) {
    var rec = S.words[head];
    if (!rec) {
      rec = S.words[head] = { n: 1, first: todayKey(), contexts: [], note: '' };
      ensureSrs(rec);
      // 新词第一次是「查词」,chk 由 onCheck 记 1;这里先归零,
      // 否则首查会变成 2 次,复习排序和「反复查」判断都偏高。
      rec.chk = 0;
    }
    return rec;
  }
  function metDays() {
    var goal = Math.max(+S.settings.goal_words || 150, 1), n = 0;
    for (var k in S.days) if ((+S.days[k].words || 0) >= goal) n++;
    return n;
  }
  function streak() {
    var d = new Date();
    if (!(S.days[isoDate(d)] && +S.days[isoDate(d)].words)) d = addDays(d, -1);
    var n = 0;
    while (S.days[isoDate(d)] && +S.days[isoDate(d)].words) {
      n++; d = addDays(d, -1);
    }
    return n;
  }

  /* ---------------- 启动 ---------------- */
  function setBoot(text) {
    var el = $('#bootText');
    if (el) el.textContent = text;
  }
  function boot() {
    setBoot('正在装书…');
    fetch('data/articles.json').then(function (r) {
      if (!r.ok) throw new Error('articles');
      return r.json();
    }).then(function (obj) {
      CORE_A = (obj && obj.articles) || [];
      CORE_A.sort(sortA);
      setBoot('正在装词典…');
      return fetch('data/dict.json');
    }).then(function (r) {
      if (!r.ok) throw new Error('dict');
      return r.json();
    }).then(function (obj) {
      DICT = obj || {};
      setBoot('正在装词形…');
      return fetch('data/lemma.json');
    }).then(function (r) {
      if (!r.ok) throw new Error('lemma');
      return r.json();
    }).then(function (obj) {
      LEMMA = obj || {};
      setBoot('正在打开书架…');
      return loadExtras().then(loadSentCache);
    }).then(function () {
      // 内置文章如果之前用 AI 翻译过,直接把缓存贴回去。
      CORE_A.forEach(function (art) {
        var hit = AI_TR['tr:' + art.s];
        if (hit && hit.c && hit.c.length) art.c = hit.c;
        cleanTrans(art.c);
      });
      S = loadState();
      normalizeState();
      applySavedMirrors();
      applyTheme();
      applyReaderFont();
      buildTabs();
      rebuildA();
      booted = true;
      go('read');
      $('#boot').classList.add('hidden');
      $('#app').classList.remove('hidden');
      // 要等 #app 显示后才有布局尺寸;冷启动只恢复这一次,之后切 tab / 返回都按常规回到顶部。
      restoreHomePos();
      if (S.settings.home_pos) centerLevelChip();
      syncChipsEdge($('#levelStrip .chips'));
      // 上次是直接清后台退出的:回到那篇文章的原位置,列表位置留给返回键。
      resumeReaderOnBoot();
      // 冷启动时 go() 早于 #app 显示,量不到底栏高度,这里补摆一次浮条。
      renderContPill();
      // 自动检查更新:等首屏画完、不影响启动手感;静默,失败不出声。
      setTimeout(autoUpdateCheck, 1800);
      setTimeout(function () {
        if (!S || +S.settings.onboarded) return;
        // 先落盘再弹,进程被杀也不会重复引导。
        S.settings.onboarded = 1;
        saveNow();
        onboardSheet();
      }, 400);
      if (window.Android && typeof window.Android.onReady === 'function') {
        try { window.Android.onReady(); } catch (e) { /* 外壳没接上也不影响页面 */ }
      }
    }).catch(function (err) {
      setBoot('数据没找到:' + (err && err.message ? err.message : '载入失败'));
    });
  }

  /* ---------------- 主题 / 字号 ---------------- */
  var mediaDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function applyTheme() {
    if (!S) return;
    var pref = S.settings.theme || 'auto';
    var dark = pref === 'dark' || (pref === 'auto' && mediaDark && mediaDark.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    var meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', dark ? '#131519' : '#f7f7f4');
    if (window.Android && typeof window.Android.setTheme === 'function') {
      try { window.Android.setTheme(dark); } catch (e) { /* 外壳没接上也不影响页面 */ }
    }
  }
  function applyReaderFont() {
    var size = clamp(+S.settings.font_size || 19, 15, 28);
    document.documentElement.style.setProperty('--reader', size + 'px');
  }
  if (mediaDark && mediaDark.addEventListener) {
    mediaDark.addEventListener('change', function () {
      if (S && (S.settings.theme || 'auto') === 'auto') applyTheme();
    });
  }

  /* ---------------- 图标 ---------------- */
  var ICONS = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    read: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 016.5 3H20v16H6.5A2.5 2.5 0 004 21.5z"/><path d="M4 5.5v16"/><path d="M8 7h8M8 11h6"/></svg>',
    words: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h9a4 4 0 014 4v12H9a4 4 0 01-4-4z"/><path d="M5 4v12a4 4 0 004 4"/><path d="M9 8h6M9 12h5"/></svg>',
    review: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 109-9"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/></svg>',
    stats: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
    flash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7.5" width="13" height="13" rx="3"/><path d="M7.5 4h9a3 3 0 013 3v9"/><path d="M7 14h6"/></svg>',
    me: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"/></svg>',
    starOn: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"/></svg>',
    speaker: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9.5h3.4L12 6v12l-4.6-3.5H4z"/></svg>',
    speakerOn: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9.5h3.4L12 6v12l-4.6-3.5H4z"/><path d="M15.2 8.6a5 5 0 010 6.8M17.8 6.2a8.4 8.4 0 010 11.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>'
  };
  var TABS = [
    { id: 'read', label: '阅读', icon: 'read' },
    { id: 'flash', label: '复习', icon: 'flash' },
    { id: 'stats', label: '统计', icon: 'stats' },
    { id: 'me', label: '我的', icon: 'me' }
  ];

  function buildTabs() {
    $('#tabbar').innerHTML = TABS.map(function (t) {
      return '<button class="tab' + (t.id === 'read' ? ' on' : '') + '" data-tab="' + t.id + '">'
        + ICONS[t.icon] + '<span>' + t.label + '</span></button>';
    }).join('');
    $('#tabbar').addEventListener('click', function (e) {
      var b = e.target.closest('.tab');
      if (!b || swap.busy) return;
      var name = b.dataset.tab;
      if (readerStem) { closeReader(true); go(name); return; }
      var ids = TABS.map(function (t) { return t.id; });
      var i = ids.indexOf(current), j = ids.indexOf(name);
      if (i >= 0 && j >= 0 && i !== j && slideTo('tabs', j > i ? 1 : -1, name)) return;
      go(name);
    });
    $('#backBtn').innerHTML = ICONS.back;
    $('#backBtn').addEventListener('click', goBack);
    $('#actionBtn').addEventListener('click', function () {
      if (topAction && topAction.fn) topAction.fn();
    });
    $('#favBtn').addEventListener('click', toggleFavCurrent);
    $('#ttsBtn').addEventListener('click', toggleTTS);
    $('#backdrop').addEventListener('click', closeSheet);
  }

  function goBack() {
    if (readerStem) { closeReader(); return; }
    // 所有 set-xxx 子页都退回设置主页；以前是白名单,漏掉 set-voice/set-mirror 会掉到阅读。
    if (current.indexOf('set-') === 0) { goPop('set'); return; }
    if (current === 'review') { goPop(reviewFrom || 'me'); return; }
    if (current === 'words' || current === 'history' || current === 'done'
        || current === 'favs' || current === 'set') {
      goPop('me');
      return;
    }
    goPop('read');
  }

  function setTop(title, opts) {
    opts = opts || {};
    $('#topTitle').textContent = title || '';
    var back = $('#backBtn'), act = $('#actionBtn');
    back.classList.toggle('hidden', !opts.back);
    $('#favBtn').classList.add('hidden');
    $('#ttsBtn').classList.add('hidden');
    act.classList.add('text');
    if (opts.action) {
      act.classList.remove('hidden');
      act.textContent = opts.action.label || '操作';
      act.classList.toggle('on', !!opts.action.active);
      act.classList.toggle('plus', opts.action.label === '＋');
      topAction = opts.action;
    } else {
      act.classList.add('hidden');
      act.classList.remove('plus');
      topAction = null;
    }
  }
  function activeTab(name) {
    $$('.tab').forEach(function (t) { t.classList.toggle('on', t.dataset.tab === name); });
  }

  var VIEWS = {
    read: '阅读', flash: '复习', stats: '统计', me: '我的',
    words: '生词本', review: '语境复习',
    history: '历史记录', done: '已读完', favs: '收藏夹', set: '设置', 'set-appearance': '外观设置',
    'set-voice': '语音朗读', 'set-data': '数据与 API Key',
    'set-update': '软件更新与发布地址', 'set-mirror': '下载镜像源', 'set-about': '关于'
  };
  var TAB_IDS = ['read', 'flash', 'stats', 'me'];

  var ANIM_ON = true;            // 三档转场总开关,要回退改成 false
  var viewAnimTimer = 0;
  // 返回键那一次跳转:子页→子页也算往回走,用轻推退场而不是从右推入。
  var popNext = false;
  // 只给 #view 换内容时临时挂动画类;#view 的 transform 平时留给 swap 手势,
  // 所以用 @keyframes、播完即摘,拖动开始时也要立刻摘(见 swapStart)。
  function playViewAnim(cls) {
    clearTimeout(viewAnimTimer);
    viewEl.classList.remove('anim-push', 'anim-pop');
    void viewEl.offsetWidth;
    viewEl.classList.add(cls);
    viewAnimTimer = setTimeout(function () {
      viewEl.classList.remove('anim-push', 'anim-pop');
    }, cls === 'anim-push' ? 260 : (cls === 'anim-pop' ? 220 : 160));
  }

  /* 两层转场:旧页整体搬进 ghost 留在原地平移出去,#view 渲染新页从侧面推入。
     只有 go() 走这套;tab 之间仍是 slideTo,文章内跳转不再动画。 */
  var viewSwapTimer = 0;

  function viewSwapKind(prev, name) {
    if (!ANIM_ON || swap.busy || swap.dragging || prev === name) return '';
    var prevTab = TAB_IDS.indexOf(prev) >= 0, isTab = TAB_IDS.indexOf(name) >= 0;
    if (prevTab && !isTab) return 'push';
    if (prev === 'set' && name.indexOf('set-') === 0) return 'push';
    if (!prevTab && isTab) return 'pop';
    if (prev.indexOf('set-') === 0 && name === 'set') return 'pop';
    if (!prevTab && !isTab) return popNext ? 'pop' : 'push';
    return '';
  }

  function detachViewForSwap() {
    clearTimeout(viewSwapTimer);
    var old = document.querySelector('.view-ghost-anim');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var st = viewEl.scrollTop;            // 必须在搬走子节点之前读
    var r = viewEl.getBoundingClientRect();
    var g = document.createElement('div');
    g.className = 'view-ghost view-ghost-anim';
    g.style.left = r.left + 'px';
    g.style.top = r.top + 'px';
    g.style.width = r.width + 'px';
    g.style.height = r.height + 'px';
    while (viewEl.firstChild) g.appendChild(viewEl.firstChild);
    document.body.appendChild(g);
    g.scrollTop = st;
    return g;
  }

  function playViewSwap(g, kind) {
    viewEl.classList.remove('anim-push', 'anim-pop');
    void viewEl.offsetWidth;
    if (kind === 'push') viewEl.classList.add('anim-push');
    else viewEl.classList.add('anim-pop');
    g.style.animation = (kind === 'push' ? 'viewGhostOut var(--t-push)'
      : 'viewGhostBack var(--t-pop)') + ' var(--ease) both';
    clearTimeout(viewAnimTimer);
    viewAnimTimer = setTimeout(function () {
      viewEl.classList.remove('anim-push', 'anim-pop');
    }, kind === 'push' ? 330 : 290);
    viewSwapTimer = setTimeout(function () {
      if (g.parentNode) g.parentNode.removeChild(g);
    }, kind === 'push' ? 350 : 310);
  }

  function go(name, resetScroll) {
    if (!booted) return;
    if (!VIEWS[name]) name = 'read';
    var prev = current;
    current = name;
    var kind = viewSwapKind(prev, name);
    var oldView = kind ? detachViewForSwap() : null;
    // 生词本/已读完/历史/收藏/设置都从「我的」进来,底部高亮留在「我的」。
    activeTab(TAB_IDS.indexOf(name) >= 0 ? name
      : (name === 'me' || name === 'words' || name === 'history' || name === 'done'
        || name === 'favs'
        || name.indexOf('set') === 0 ? 'me' : ''));
    document.body.classList.remove('reader');
    readerStem = null;
    setTop(VIEWS[name], { back: TAB_IDS.indexOf(name) < 0 });
    if (name === 'read') renderRead();
    else if (name === 'flash') renderFlash();
    else if (name === 'words') renderWords();
    else if (name === 'review') renderReview(revWord, { keep: true });
    else if (name === 'stats') renderStats();
    else if (name === 'history') renderHistory();
    else if (name === 'done') renderDone();
    else if (name === 'favs') { favTab = 'arts'; renderFavorites(); }
    else if (name === 'set') renderSettings();
    else if (name === 'set-appearance') renderAppearance();
    else if (name === 'set-voice') renderVoiceSettings();
    else if (name === 'set-data') renderDataSettings();
    else if (name === 'set-update') renderUpdate();
    else if (name === 'set-mirror') renderMirrorSettings();
    else if (name === 'set-about') renderAbout();
    else renderMe();
    // 转场:从一级页进子页从右推入,退回 tab 从左轻推,tab 之间瞬切;
    // swap 手势内部调用的不动画。
    if (oldView) playViewSwap(oldView, kind);
    if (name !== 'read') $('#levelStrip').classList.add('hidden');
    if (resetScroll !== false) $('#view').scrollTop = 0;
    // 换页后浮条回到「按页面决定」的状态:列表展开,其它页面缩边。
    contPill.open = null;
    renderContPill();
  }

  // 返回键走的跳转都从这里过:让动画方向和「往前进」相反。
  function goPop(name) {
    popNext = true;
    try { go(name); } finally { popNext = false; }
  }

  /* ---------------- 阅读列表 ---------------- */
  function levelCount(l) {
    var n = 0;
    for (var i = 0; i < A.length; i++) if (A[i].l === l) n++;
    return n;
  }
  function levelArts(l) {
    return A.filter(function (a) { return a.l === l; });
  }
  // 主题标签:一篇一个内容类(1 科普 2 人物 3 社会 4 文化 5 故事 6 新闻),7 是「考试真题」筛选。
  var TOPIC_NAMES = { 1: '科普', 2: '人物', 3: '社会', 4: '文化', 5: '故事', 6: '新闻', 7: '考试真题' };
  var TOPIC_EXAM = 7;
  var topicPick = {};   // level -> 当前筛选(0=全部)
  function topicOf(a) { return (a && a.tp) || 0; }
  function isExamArt(a) {
    return !!a && (a.e === 1 || (a.e === undefined && a.o !== undefined && a.o !== null));
  }
  function topicsIn(arts) {
    var seen = {}, hasExam = false;
    for (var i = 0; i < arts.length; i++) {
      var t = topicOf(arts[i]);
      if (t) seen[t] = 1;
      if (isExamArt(arts[i])) hasExam = true;
    }
    var out = [];
    for (var k = 1; k <= 6; k++) if (seen[k]) out.push(k);
    if (hasExam) out.push(TOPIC_EXAM);
    return out;
  }
  function byTopic(arts, pick) {
    if (!pick) return arts;
    if (pick === -1) return arts.filter(function (a) { return !topicOf(a); });
    return arts.filter(function (a) {
      return pick === TOPIC_EXAM ? isExamArt(a) : topicOf(a) === pick;
    });
  }
  function hasUntagged(arts) {
    for (var i = 0; i < arts.length; i++) if (!topicOf(arts[i])) return true;
    return false;
  }
  function topicChipsHTML(l, arts, pick) {
    var list = topicsIn(arts);
    if (!list.length && !hasUntagged(arts)) return '';
    var html = '<div class="chips topic-chips">'
      + '<button class="chip' + (pick ? '' : ' on') + '" data-act="topic" data-lv="' + l + '" data-topic="0">全部</button>';
    for (var i = 0; i < list.length; i++) {
      html += '<button class="chip' + (pick === list[i] ? ' on' : '') + '" data-act="topic" data-lv="' + l
        + '" data-topic="' + list[i] + '">' + TOPIC_NAMES[list[i]] + '</button>';
    }
    // 自己导入的书没有标签,单独一档,免得筛任何类都像"书不见了"。
    if (hasUntagged(arts)) {
      html += '<button class="chip' + (pick === -1 ? ' on' : '') + '" data-act="topic" data-lv="' + l
        + '" data-topic="-1">未分类</button>';
    }
    return html + '</div>';
  }
  function levelListHTML(l) {
    var all = levelArts(l);
    var pick = topicPick[l] || 0;
    var arts = byTopic(all, pick);
    var doneN = arts.filter(function (a) { return (S.articles[a.s] || {}).done; }).length;
    var out = updateBannerHTML();
    // 「接着读」不再占列表顶部:改成浮条(#contPill),跨页面都能点到。
    out += '<div class="sec-head"><span class="sec-title">' + levelName(l) + '</span>'
      + '<span class="sec-note">' + arts.length + ' 篇 · 已读 ' + doneN + '</span></div>';
    out += topicChipsHTML(l, all, pick);
    out += l === 90 ? shelfHTML(arts) : artListHTML(arts, true);
    return out;
  }
  function levelName(l) { return LEVEL_NAMES[l] || (l + ' 级'); }
  function bookTitleOf(a) { return (a.bt || '').trim(); }
  function artTitle(a) {
    return a && a.bt ? '《' + a.bt + '》 ' + (a.t || a.s) : ((a && (a.t || a.s)) || '');
  }

  /* ---------------- 接着读浮条 ---------------- */
  // 阅读列表页展开成卡片(文章名 + 接着读),其他页面缩成右侧窄条;
  // 可上下拖,纵向位置记在 settings.cont_pill_y;外观设置里能整体关掉。
  // 进出是「从右侧滑出/滑入」,跟着页面转场一起动,落位时正好到位。
  var contPill = { open: null, drag: false, moved: false, y0: 0, top0: 0, top: 0,
                   min: 0, max: 0, kind: '', stem: '', shown: false, cardH: 0 };
  var CONT_IN = 220;    // 从屏幕外滑进来
  var CONT_OUT = 160;   // 滑出去
  // 默认纵向位置:0=顶栏下沿 1=底栏上沿。0.89 落在「列表页原来位置到底栏」的中点。
  var CONT_Y_DEFAULT = 0.89;
  var contPillTimer = 0;
  var contPillFadeT = 0;

  function contPillStem() {
    var stem = S && S.last_stem;
    return stem && A_MAP[stem] ? stem : '';
  }
  // 可放的纵向范围:顶栏(有难度条再加一条)之下、底部 tab 之上。
  // 难度条和底栏在切页那一瞬可能还没布局完(offsetHeight 是 0),量到 0 就沿用
  // 上次量到的值:否则同一篇文章在列表页和其它页会差一截,拖动算出来的比例也是
  // 按错的高度算的,冷启动就回不到原位。
  // h 取「最高的那个形态」的高度:位置按它算,卡片和窄条就落在同一条线上,
  // 互换形态时不会上下跳。76 ≈ 两行标题的卡片,窄条 44。
  var contPillH = { strip: 48, bar: 58, h: 76 };
  function contPillSpan() {
    var strip = $('#levelStrip');
    if (strip && !strip.classList.contains('hidden') && strip.offsetHeight > 0) {
      contPillH.strip = strip.offsetHeight;
    }
    var bar = $('#tabbar');
    if (bar && bar.offsetHeight > 0) contPillH.bar = bar.offsetHeight;
    var top = 60 + contPillH.strip;
    var bottom = (window.innerHeight || 640) - contPillH.bar - 10;
    return { top: top + 6, bottom: Math.max(top + 60, bottom) };
  }
  function contPillPlace() {
    var el = $('#contPill');
    if (!el || el.classList.contains('hidden')) return;
    // 字号变了卡片会变高,顺手同步 --cont-h,窄条才能一直跟卡片等高。
    contPillMeas(el, el.querySelector('.cont-card'));
    var sp = contPillSpan();
    var h = el.offsetHeight || 0;
    if (h > contPillH.h) contPillH.h = h;      // 换了大字号就跟着长
    var hRef = contPillH.h;
    var min = sp.top, max = Math.max(min, sp.bottom - hRef);
    var ratio = +S.settings.cont_pill_y;
    if (!(ratio >= 0 && ratio <= 1)) ratio = CONT_Y_DEFAULT;
    contPill.min = min;
    contPill.max = max;
    contPill.top = Math.round(min + (max - min) * ratio);
    el.style.top = contPill.top + 'px';
  }
  // 浮条该是什么形态:'' 表示不该出现。contPill.open 是用户手动收起/展开,优先于按页面决定。
  function contPillWant() {
    if (!S || !+S.settings.cont_pill) return '';
    if (!contPillStem() || readerStem) return '';
    if (contPill.open === false) return 'rail';
    if (contPill.open === true) return 'card';
    return current === 'read' ? 'card' : 'rail';
  }
  // 造一个形态节点(不插入)。
  function contPillNode(kind) {
    var d = document.createElement('div');
    if (kind === 'card') {
      d.className = 'cont-card';
      d.innerHTML = '<div class="grow"><div class="cont-k">接着读</div>'
        + '<div class="cont-t">' + esc(artTitle(A_MAP[contPillStem()])) + '</div></div>'
        + '<button class="cont-fold" data-act="cont-fold" aria-label="收起">›</button>';
    } else {
      // 收起状态只留展开图标,不再带「接着读」三个字。
      d.className = 'cont-rail';
      d.innerHTML = '<button class="cont-chev" data-act="cont-open" aria-label="展开">‹</button>';
    }
    return d;
  }
  // 换形态。fade=true 时新旧两个叠在同一格里交叉淡入淡出(原地变形,不滑走);
  // false 就直接替换,用在「换文章重画标题」这种内容更新上。
  function contPillSet(kind, fade) {
    var el = $('#contPill');
    if (!el) return;
    var cur = el.querySelector('.cont-card, .cont-rail');
    var neu = contPillNode(kind);
    contPill.kind = kind;
    contPill.stem = kind === 'card' ? contPillStem() : '';
    // 卡片高度记进 --cont-h:旧卡片一摘容器就从 57 塌到 44,顶部不动、
    // 底部短一截,看着就是「展开和缩回后上下边界不一致」。用卡片实测高度
    // 撑住容器,窄条跟着 stretch 到同一高度。
    contPillMeas(el, kind === 'card' ? neu : cur);
    if (!cur) { el.appendChild(neu); return; }
    if (!fade) { el.replaceChild(neu, cur); return; }
    neu.classList.add('cont-in');
    cur.classList.add('cont-out');
    el.appendChild(neu);
    // contPillIn 用了 both,opacity 会被锁在 1。不摘掉的话这个节点下次当
    // 旧节点时 cont-out 的 opacity:0 压不过它 —— 展开时窄条一动不动叠在
    // 卡片上面,就是「弹出新窗口再展开老窗口」。用 animationend 摘最准。
    neu.addEventListener('animationend', function onIn(e) {
      if (e.target !== neu || e.animationName !== 'contPillIn') return;
      neu.removeEventListener('animationend', onIn);
      neu.classList.remove('cont-in');
    });
    clearTimeout(contPillFadeT);
    contPillFadeT = setTimeout(function () {
      contPillFadeT = 0;
      if (cur.parentNode) cur.parentNode.removeChild(cur);
    }, 200);
  }
  // 把卡片实测高度写进容器的 --cont-h。传进来的不是卡片就什么都不做。
  function contPillMeas(el, node) {
    if (!node || !node.classList || !node.classList.contains('cont-card')) return;
    var h = node.offsetHeight;
    if (h > 0 && h !== contPill.cardH) {
      contPill.cardH = h;
      el.style.setProperty('--cont-h', h + 'px');
    }
  }
  // 换过文章也要重画一次标题,所以 stem 一起比。
  function contPillBuild(kind) {
    var stem = kind === 'card' ? contPillStem() : '';
    if (contPill.kind === kind && contPill.stem === stem) return;
    contPillSet(kind, false);
  }
  // 时长走 CSS 变量,这样 .dragging 的 transition:none 还能盖住它。
  function contPillDur(ms) {
    var el = $('#contPill');
    if (el) el.style.setProperty('--cont-in', ms + 'ms');
  }
  // 刚换完形态的那一帧,标题可能还按「折两行」算高度(75px),布局落定才回到 57px;
  // 这时量到的 max 会偏小,拖动比例跟着算错。下一帧再量一次。
  function contPillRelayout() {
    requestAnimationFrame(function () {
      if (contPill.shown && !contPill.drag) contPillPlace();
    });
  }
  function renderContPill() {
    var el = $('#contPill');
    if (!el || !S) return;
    // 换页途中浮条完全不动,等 swapEnd 落位了再同步形态。
    // 之前跟着转场一起动,拖动时浮条先变一半、回弹再变回来,看着就是闪。
    if (swap.busy) return;
    clearTimeout(contPillTimer);
    contPillTimer = 0;
    var want = contPillWant();
    if (!want) {
      if (!contPill.shown) return;
      contPill.shown = false;
      contPillDur(CONT_OUT);
      el.classList.add('hidden');
      return;
    }
    // 已经在屏上、形态也一样:只挪位置,不重播动画 —— 切 tab 不会闪。
    if (contPill.shown && want === contPill.kind) {
      contPillBuild(want);   // 换了文章才会真的重画,其余情况是空操作
      contPillPlace();
      return;
    }
    if (contPill.shown) {
      // 阅读 ↔ 其它页:原地交叉淡入淡出。以前是「滑出去→换形态→滑回来」,
      // 中间必然有一段什么都没有,看着就是「消失一下」。
      contPillSet(want, true);
      contPillPlace();
      return;
    }
    // 本来就在屏幕外:形态先定好,再滑进来。
    contPillBuild(want);
    contPill.shown = true;
    contPillDur(CONT_IN);
    el.classList.remove('hidden');
    contPillPlace();
    contPillRelayout();
  }
  (function bindContPill() {
    var el = $('#contPill');
    if (!el) return;
    el.addEventListener('click', function (e) {
      if (contPill.moved) return;        // 拖动收尾那一下会补一个 click,吃掉
      var t = e.target;
      if (t.closest('[data-act="cont-fold"]')) { contPill.open = false; renderContPill(); return; }
      if (t.closest('[data-act="cont-open"]')) { contPill.open = true; renderContPill(); return; }
      // 收起状态只有展开图标,点不进去;必须先展开成卡片才能接着读。
      if (contPill.kind !== 'card') return;
      var stem = contPillStem();
      if (stem) openReader(stem, true);   // 接着读:回到上次退出位置
    });
    el.addEventListener('touchstart', function (e) {
      var t = e.touches[0];
      if (!t) return;
      // 起拖这一刻布局肯定稳了,按当前真实高度重算一次范围:
      // 转场那帧量到的高度可能偏大,比例会算歪,冷启动就回不到原位。
      contPillPlace();
      contPill.drag = true;
      contPill.moved = false;
      contPill.y0 = t.clientY;
      contPill.top0 = contPill.top || el.offsetTop || 0;
      el.classList.add('dragging');
    }, { passive: true });
    el.addEventListener('touchmove', function (e) {
      if (!contPill.drag) return;
      var t = e.touches[0];
      if (!t) return;
      var dy = t.clientY - contPill.y0;
      if (!contPill.moved && Math.abs(dy) < 6) return;   // 小抖动不算拖动
      contPill.moved = true;
      if (e.cancelable) e.preventDefault();
      contPill.top = Math.round(clamp(contPill.top0 + dy, contPill.min, contPill.max));
      el.style.top = contPill.top + 'px';
    }, { passive: false });
    el.addEventListener('touchend', function () {
      if (!contPill.drag) return;
      contPill.drag = false;
      el.classList.remove('dragging');
      if (!contPill.moved) return;
      var span = Math.max(1, contPill.max - contPill.min);
      S.settings.cont_pill_y = Math.round(clamp((contPill.top - contPill.min) / span, 0, 1) * 1000) / 1000;
      save();
    }, { passive: true });
    window.addEventListener('resize', contPillPlace);
  })();

  function artRowHTML(a) {
    var st = S.articles[a.s] || {};
    var meta = '<span>' + fmt(a.w) + ' 词</span>';
    if (a.bk) meta += '<span>第 ' + (a.cn || 1) + ' 章</span>';
    else meta += '<span>' + levelName(a.l) + '</span>';
    meta += verdictHTML(a, false);
    if (st.done) meta += '<span class="art-done">已读完</span>';
    if (+st.times > 1) meta += '<span>读过 ' + st.times + ' 遍</span>';
    if (isFav(a.s)) meta += '<span class="fav-mark">★ 已收藏</span>';
    if (a.c && a.c.some(function (x) { return x && String(x).trim(); })) meta += '<span>有译文</span>';
    return '<div class="art" data-stem="' + esc(a.s) + '">'
      + '<div class="art-main"><div class="art-title">' + esc(a.t || a.s) + '</div>'
      + '<div class="art-meta">' + meta + '</div></div>'
      + '<div class="art-side">' + (st.done
        ? '<button class="btn small soft" data-reread="' + esc(a.s) + '">再读一遍</button>'
        : '<div>阅读</div>')
      + '</div></div>';
  }

  function doneLast(arts) {
    var fresh = [], done = [];
    arts.forEach(function (a) {
      ((S.articles[a.s] || {}).done ? done : fresh).push(a);
    });
    done.sort(function (x, y) {
      return (+(S.articles[y.s] || {}).times || 1) - (+(S.articles[x.s] || {}).times || 1);
    });
    return fresh.concat(done);
  }

  function artListHTML(arts, sortDone) {
    if (!arts.length) return '<div class="empty">这个等级还没有文章</div>';
    var list = sortDone ? doneLast(arts) : arts;
    return '<div class="art-list">' + list.map(artRowHTML).join('') + '</div>';
  }

  var shelfGroups = null;   // 最近一次书架渲染的分组,展开某本时只重画那一组

  function shelfGroupsOf(arts) {
    var groups = [], cur = null;
    for (var i = 0; i < arts.length; i++) {
      var a = arts[i], key = a.b || ('x:' + bookTitleOf(a));
      if (!cur || cur.key !== key) {
        cur = { key: key, title: bookTitleOf(a) || '未命名图书', imported: !!a.bk,
          id: a.bk || a.b || '', arts: [] };
        groups.push(cur);
      }
      cur.arts.push(a);
    }
    for (var n = 0; n < groups.length; n++) {
      groups[n].arts.sort(function (x, y) {
        var cx = (x.cn === undefined || x.cn === null) ? 1000000 : x.cn;
        var cy = (y.cn === undefined || y.cn === null) ? 1000000 : y.cn;
        return (cx - cy) || (x.q - y.q);
      });
    }
    groups.sort(function (x, y) {
      return String(x.title).localeCompare(String(y.title), 'zh-Hans-CN', { numeric: true });
    });
    return groups;
  }

  function bookBodyHTML(b) {
    return '<div class="book-body">' + artListHTML(b.arts) + '</div>';
  }

  function bookGroupHTML(b) {
    var open = !!openBooks[b.key];
    var done = b.arts.filter(function (x) { return (S.articles[x.s] || {}).done; }).length;
    var allDone = b.arts.length > 0 && done === b.arts.length;
    return '<div class="book-group' + (open ? ' open' : '') + '">'
      + '<div class="book-head" data-book-toggle="' + esc(b.key) + '">'
      + '<span class="chev">›</span><span class="book-name">《' + esc(b.title) + '》</span>'
      + '<span class="book-meta">' + b.arts.length + ' 章 · 已读 ' + done + '</span>'
      + (allDone && b.id ? '<button class="book-reread" data-reread-book="' + esc(b.id) + '">再读一遍</button>' : '')
      + (b.id ? '<button class="book-del" data-del-book="' + esc(b.id) + '"'
        + (b.imported ? '' : ' data-keep="1"') + '>' + (b.imported ? '删除' : '移除') + '</button>' : '')
      + '</div>'
      + (open ? bookBodyHTML(b) : '')
      + '</div>';
  }

  function groupOfKey(key) {
    var gs = shelfGroups || [];
    for (var i = 0; i < gs.length; i++) if (gs[i].key === key) return gs[i];
    return null;
  }

  function shelfHTML(arts) {
    if (!arts.length) {
      var hidden = S && S.hidden_books ? Object.keys(S.hidden_books).length : 0;
      return '<div class="empty">书架还是空的<br><span class="tiny">'
        + (hidden ? '内置书已收起 · 点右上角「＋」→「管理图书」恢复' : '点右上角「＋」导入自己的书')
        + '</span></div>';
    }
    shelfGroups = shelfGroupsOf(arts);
    var html = '';
    for (var g = 0; g < shelfGroups.length; g++) html += bookGroupHTML(shelfGroups[g]);
    return html;
  }

  function hiddenBookCount() {
    return S && S.hidden_books ? Object.keys(S.hidden_books).length : 0;
  }
  function readMenuSheet() {
    var n = importedBookCount() + hiddenBookCount();
    showSheet('<div class="sheet-grip"></div>'
      + '<div class="menu-title">阅读</div>'
      + '<button class="menu-row" data-menu-act="import-book">'
      + '<span class="menu-icon">⇩</span><span class="grow"><b>导入图书</b>'
      + '<small>支持 TXT,分好章后放进书架</small></span><span class="menu-arrow">›</span></button>'
      + '<button class="menu-row" data-menu-act="import-rules">'
      + '<span class="menu-icon">≡</span><span class="grow"><b>复制导入规则（必看！）</b>'
      + '<small>把规则复制给 AI,让它生成能识别的 TXT</small></span><span class="menu-arrow">›</span></button>'
      + (n ? '<button class="menu-row" data-menu-act="manage-books">'
        + '<span class="menu-icon">▤</span><span class="grow"><b>管理图书</b>'
        + '<small>删除导入的书,恢复内置书</small></span><span class="menu-arrow">›</span></button>' : '')
      + '<div class="sheet-note">导入的书只存在这台手机;内置文章不会被改动。</div>');
  }

  function copyImportRules() {
    var done = function () { notify('导入规则已复制'); closeSheet(); };
    if (window.Android && typeof window.Android.copyText === 'function') {
      window.Android.copyText(IMPORT_RULES_TEXT);
      done();
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(IMPORT_RULES_TEXT).then(done);
    } else {
      notify('当前环境不能复制');
    }
  }

  // 书架排在最前,后面是七个难度档。chips 和左右滑动共用同一顺序。
  function levelOrder() {
    return [90, 1, 2, 3, 4, 5, 6, 7].filter(function (l) {
      return l === 90 || levelCount(l) > 0;
    });
  }

  function selectLevel(l, topic) {
    readLevel = +l;
    if (topic !== undefined && topic !== null) topicPick[readLevel] = +topic;
    S.settings.last_level = readLevel;
    S.settings.home_pos = { l: readLevel, y: 0 };
    saveNow();
    renderRead(true);
    $('#view').scrollTop = 0;
  }

  // 一个难度里"可滑过的页"顺序:全部 → 6 个内容类 → 考试真题 → 未分类。
  // 跟手翻页按这个顺序走完当前档,再进下一档的第一个分类(全部)。
  function topicSteps(l) {
    var arts = levelArts(l);
    var out = [0].concat(topicsIn(arts));
    if (hasUntagged(arts)) out.push(-1);
    return out;
  }

  /* ---------------- 跟手翻页 ---------------- */
  var SWAP_RATIO = 0.6;   // 拖过 60% 屏宽算完成
  var SWAP_VEL = 0.5;     // 或同向速度 ≥ 0.5 px/ms
  var SWAP_DAMP = 0.3;    // 首尾页继续向外拖的阻尼
  var SWAP_MS = 200;
  var SWAP_LOCK = 8;      // 先走 8px 再判横竖

  // dir=1 看后一页(目标页从右边进来),dir=-1 看前一页。
  function swapTarget(mode, dir, key) {
    if (mode === 'levels') {
      // 语境复习页(从生词本/我的进来)左滑退回阅读列表,不然进去就是死胡同。
      if (key === undefined && current === 'review') {
        return dir < 0 ? { page: 'read' } : null;
      }
      var order = levelOrder(), i = order.indexOf(readLevel);
      if (i < 0) return null;
      if (key === undefined) {
        // 同一档内先按主题分类走,走完再进下一档,最后一档走完接底部「复习」tab。
        var steps = topicSteps(readLevel), cur = topicPick[readLevel] || 0;
        var si = steps.indexOf(cur);
        if (si < 0) si = 0;
        if (dir > 0) {
          if (si < steps.length - 1) return { level: readLevel, topic: steps[si + 1] };
          var nx = order[i + 1];
          if (nx === undefined) return { tab: 'flash' };
          return { level: nx, topic: 0 };
        }
        if (si > 0) return { level: readLevel, topic: steps[si - 1] };
        var pv = order[i - 1];
        if (pv === undefined) return null;
        var ps = topicSteps(pv);
        return { level: pv, topic: ps[ps.length - 1] };
      }
      var lv = +key;
      if (lv === undefined || order.indexOf(lv) < 0) return null;
      return { level: lv };
    }
    var ids = TABS.map(function (t) { return t.id; });
    var j = ids.indexOf(current);
    if (j < 0) return null;
    var name = (key === undefined) ? ids[j + dir] : key;
    if (!name || ids.indexOf(name) < 0) return null;
    return { tab: name };
  }

  function swapSnap() {
    var bar = $('.chips');
    var on = $('#tabbar').querySelector('.tab.on');
    return {
      current: current, level: readLevel, topic: topicPick[readLevel] || 0, action: topAction,
      title: $('#topTitle').textContent,
      back: !$('#backBtn').classList.contains('hidden'),
      tab: on ? on.dataset.tab : '',
      scroll: viewEl.scrollTop,
      strip: bar ? bar.scrollLeft : 0,
      last_level: S.settings.last_level,
      home_pos: S.settings.home_pos
    };
  }

  function swapTx(el, x) { if (el) el.style.transform = 'translateX(' + x + 'px)'; }

  // 等级条在 #view 外面,翻页时本来就不动;拖动期间只切选中态,不滚条子,居中留到落位。
  function paintLevelStrip(l, scroll) {
    var box = $('#levelStrip .chips');
    if (!box) return;
    $$('.chip', box).forEach(function (c) {
      c.classList.toggle('on', +c.dataset.level === +l);
    });
    if (scroll !== undefined) box.scrollLeft = scroll;
    syncChipsEdge(box);
  }

  // 旧页整体搬进 ghost(连监听和状态一起走),#view 用来渲染目标页,两者一起平移。
  // 搬走后触摸还在 document 上冒泡,所以手势监听挂在 document 而不是 #view。
  function swapStart(mode, dir, key, noCenter) {
    swap.busy = true;
    swap.dragging = true;
    swap.noCenter = !!noCenter;
    swap.willCommit = false;
    // 转场动画播到一半就开始拖的话,立刻摘掉动画类,不然会盖住手势的 transform。
    clearTimeout(viewAnimTimer);
    viewEl.classList.remove('anim-push', 'anim-pop');
    // 两层转场可能还留着上一页的 ghost,同样立刻清掉,别让它跟着一起滑。
    clearTimeout(viewSwapTimer);
    var staleGhost = document.querySelector('.view-ghost-anim');
    if (staleGhost && staleGhost.parentNode) staleGhost.parentNode.removeChild(staleGhost);
    swap.dir = +dir > 0 ? 1 : -1;
    swap.w = Math.max(120, viewEl.clientWidth || window.innerWidth);
    swap.ghost = null;
    swap.cur = null;
    swap.tgt = null;
    swap.snap = null;
    swap.tgtTop = null;
    swap.stripOn = false;
    swap.tgtTab = false;
    var tgt = swapTarget(mode, swap.dir, key);
    if (!tgt) {
      swap.edge = true;
      swap.cur = viewEl;
      return;
    }
    swap.edge = false;
    swap.mode = mode;
    swap.tgtTab = !!(tgt.tab || tgt.page);
    swap.snap = swapSnap();
    var r = viewEl.getBoundingClientRect();
    var g = document.createElement('div');
    g.className = 'view-ghost';
    g.style.left = r.left + 'px';
    g.style.top = r.top + 'px';
    g.style.width = r.width + 'px';
    g.style.height = r.height + 'px';
    while (viewEl.firstChild) g.appendChild(viewEl.firstChild);
    document.body.appendChild(g);
    g.scrollTop = swap.snap.scroll;
    swap.ghost = g;
    swap.cur = g;
    swap.tgt = viewEl;
    swap.stripOn = !$('#levelStrip').classList.contains('hidden');
    // 整页切换(tab 或 page):顶栏、tab 高亮、等级条都按旧页摆,落位再切。
    if (tgt.tab) go(tgt.tab);
    else if (tgt.page) {
      go(tgt.page);
      // 从阅读滑进来的,返回键要能退回阅读而不是掉到「我的」。
      if (tgt.page === 'review') reviewFrom = swap.snap.current || 'read';
    }
    else selectLevel(tgt.level, tgt.topic);
    if (tgt.tab || tgt.page) {
      // 顶栏标题和 tab 高亮先按旧页留着,动画落位再切,回弹时不会闪一下。
      var on = $('#tabbar').querySelector('.tab.on');
      swap.tgtTop = {
        title: $('#topTitle').textContent,
        back: !$('#backBtn').classList.contains('hidden'),
        action: topAction,
        tab: on ? on.dataset.tab : ''
      };
      setTop(swap.snap.title, { back: swap.snap.back, action: swap.snap.action });
      activeTab(swap.snap.tab);
    }
    if (mode === 'levels') {
      // 目标是切到统计页时等级条必须一路收起;再 remove 一次会先收后展闪一下。
      // 整页目标(tab / 复习页)同理:目标页自己已经把条子摆好,别再插手。
      if (!swap.tgtTab) {
        $('#levelStrip').classList.remove('hidden');
        // 手势换档:转场里仍显示旧档,落位再切。点 chip 换档不能画回旧档——
        // selectLevel 已把选中态落到新档并居中,再画回旧档会让蓝色选中框 A-B-A 来回跳。
        if (!swap.noCenter) paintLevelStrip(swap.snap.level, swap.snap.strip);
      }
    } else {
      $('#levelStrip').classList.toggle('hidden', !swap.stripOn);
    }
    swapTx(g, 0);
    swapTx(viewEl, swap.dir * swap.w);
  }

  // 拖动中「这一下会不会落位」的实时判定:与 touchend 的提交条件完全一致(far || flick)。
  // 只读状态,不碰 DOM;swapFollow 用它驱动选中框,swapSettle 用它兜底。
  function swapWillCommit(dx) {
    if (swap.edge) return false;
    var far = Math.abs(dx) >= swap.w * SWAP_RATIO;
    var flick = Math.abs(swipe.v) >= SWAP_VEL && ((swipe.v < 0) === (dx < 0));
    return far || flick;
  }

  function swapFollow(dx) {
    if (swap.edge) { swapTx(viewEl, dx * SWAP_DAMP); return; }
    swapTx(swap.cur, dx);
    swapTx(swap.tgt, dx + swap.dir * swap.w);
    // 选中框跟手:跨过提交阈值立刻画到目标档,退回阈值内画回原档。
    // 只在状态翻转时动一次 .on,不重排 DOM;难度条本身不滚,居中留到落位。
    var now = swapWillCommit(dx);
    if (now !== swap.willCommit) {
      swap.willCommit = now;
      if (swap.mode === 'levels' && swap.stripOn && !swap.tgtTab && !swap.noCenter) {
        paintLevelStrip(now ? readLevel : swap.snap.level, swap.snap.strip);
      }
    }
  }

  // 走完剩余行程;动画期间不再跟手。
  function swapSettle(commit) {
    swap.dragging = false;
    // 起手落位前先把选中框定到最终状态:touchend 的判定才是权威,
    // 最后一次 touchmove 与抬手之间可能差几毫秒(快速甩动),不能让条子停在旧结论上。
    if (swap.snap && swap.mode === 'levels' && swap.stripOn && !swap.tgtTab && !swap.noCenter) {
      swap.willCommit = !!commit;
      paintLevelStrip(commit ? readLevel : swap.snap.level, swap.snap.strip);
    }
    var d = swap.dir, w = swap.w;
    var els = swap.tgt ? [swap.cur, swap.tgt] : [swap.cur];
    els.forEach(function (el) {
      el.style.transition = 'transform ' + SWAP_MS + 'ms ease-out';
    });
    void viewEl.offsetWidth;
    requestAnimationFrame(function () {
      swapTx(swap.cur, commit ? -d * w : 0);
      if (swap.tgt) swapTx(swap.tgt, commit ? 0 : d * w);
    });
    setTimeout(function () { swapEnd(commit); }, SWAP_MS + 20);
  }

  function swapEnd(commit) {
    var g = swap.ghost, s = swap.snap, tt = swap.tgtTop, so = swap.stripOn;
    if (!commit && g) {
      // 目标页只是预览,直接丢掉;旧页搬回 #view 才能保住原有节点。
      viewEl.innerHTML = '';
      while (g.firstChild) viewEl.appendChild(g.firstChild);
    }
    if (g && g.parentNode) g.parentNode.removeChild(g);
    viewEl.style.transition = '';
    viewEl.style.transform = '';
    swap.ghost = null;
    swap.cur = null;
    swap.tgt = null;
    swap.snap = null;
    swap.tgtTop = null;
    swap.stripOn = false;
    swap.noCenter = false;
    swap.willCommit = false;
    swap.edge = false;
    swap.dragging = false;
    swap.busy = false;
    if (commit) {
      // 落位才切标题、tab 高亮和等级条选中,起拖时都还按旧页留着。
      if (tt) {
        setTop(tt.title, { back: tt.back, action: tt.action });
        activeTab(tt.tab);
      }
      var listPage = !readerStem && current === 'read';
      $('#levelStrip').classList.toggle('hidden', !listPage);
      if (listPage) {
        paintLevelStrip(readLevel);
        // 换档落位后把选中的 chip 居中;点 chip 起的换档开局已居中,这里再跑一遍是幂等的。
        centerLevelChip();
      }
      renderContPill();     // 落位后按新页面重新摆浮条
      return;
    }
    if (!s) { renderContPill(); return; }
    // 回弹:旧页放回原位,标题、tab 高亮、列表位置和设置全部还原。
    current = s.current;
    readLevel = s.level;
    topicPick[s.level] = s.topic || 0;   // 回弹时把主题筛选也放回去
    S.settings.last_level = s.last_level;
    S.settings.home_pos = s.home_pos;
    saveNow();
    viewEl.scrollTop = s.scroll;
    levelStripScroll = s.strip;
    $('#levelStrip').classList.toggle('hidden', !so);
    if (s.current === 'read') paintLevelStrip(s.level, s.strip);
    activeTab(s.tab);
    setTop(s.title, { back: s.back, action: s.action });
    renderContPill();       // 回弹后浮条也要回到原页面状态
  }

  // 底部 tab 点击走同一套滑动过渡;没有邻居或正在忙就返回 false。
  function slideTo(mode, dir, key, noCenter) {
    if (swap.busy || !swapTarget(mode, dir, key)) return false;
    swapStart(mode, dir, key, noCenter);
    // 起始位要先画出一帧,否则同一任务里改 transform 不会触发过渡。
    requestAnimationFrame(function () {
      if (swap.busy) swapSettle(true);
    });
    return true;
  }

  function stepLevel(dir) { slideTo('levels', dir); }

  function restoreHomePos() {
    var pos = S.settings.home_pos;
    if (!pos || +pos.l !== readLevel || !(+pos.y > 0)) return;
    $('#view').scrollTop = Math.min(+pos.y || 0, $('#view').scrollHeight);
  }

  // 返回刚量到的可滚范围,让调用方顺手判边缘,省掉再一次强制布局。
  function centerLevelChip() {
    var bar = $('.chips');
    if (!bar) return -1;
    var on = bar.querySelector('.chip.on');
    if (!on) return -1;
    // offsetLeft 相对外层容器,直接算会带上边距,用实测矩形才准。
    var br = bar.getBoundingClientRect(), cr = on.getBoundingClientRect();
    var delta = (cr.left + cr.width / 2) - (br.left + br.width / 2);
    var max = Math.max(0, bar.scrollWidth - bar.clientWidth);
    levelStripScroll = clamp(bar.scrollLeft + delta, 0, max);
    bar.scrollLeft = levelStripScroll;
    return max;
  }

  // 到头就不再画那边渐隐:书架选中时左边那颗蓝色 chip 不该被底色盖成米色。
  function syncChipsEdge(el, max) {
    if (!el) return;
    if (max === undefined || max < 0) max = Math.max(0, el.scrollWidth - el.clientWidth);
    el.classList.toggle('at-start', el.scrollLeft <= 2);
    el.classList.toggle('at-end', el.scrollLeft >= max - 2);
  }

  function renderRead(scrollToSelected) {
    current = 'read';
    readerStem = null;
    document.body.classList.remove('reader');
    activeTab('read');
    setTop('阅读', { action: { label: '＋ 导入', fn: readMenuSheet } });
    if (readLevel === null) {
      var lv = +S.settings.last_level;
      readLevel = (lv === 90 || (lv >= 1 && lv <= 7)) ? lv : 2;
    }
    $('#view').innerHTML = levelListHTML(readLevel);
    renderLevelStrip(scrollToSelected);
  }

  // 等级条在顶栏下面单独一行,不进 #view:翻页、上下滚动都不会把它带跑。
  function renderLevelStrip(scrollToSelected) {
    var strip = $('#levelStrip');
    if (!strip) return;
    var box = $('#levelStrip .chips');
    if (!box) return;
    // 手势换档途中(swap.busy 且不是点 chip):选中态由实时提交判定驱动 ——
    // 没跨阈值按旧档、跨了按目标档,跟手指同步;居中不做,滚动锁在起拖位置,
    // 免得拖动中条子自己跑。点 chip(noCenter)和普通渲染仍按 readLevel。
    var dragging = !!(swap.busy && !swap.noCenter && swap.snap);
    var sel = dragging ? (swap.willCommit ? readLevel : swap.snap.level) : readLevel;
    box.innerHTML = levelOrder().map(function (l) {
      return '<button class="chip' + (sel === l ? ' on' : '') + '" data-level="' + l + '">'
        + levelName(l) + ' ' + levelCount(l) + '</button>';
    }).join('');
    strip.classList.remove('hidden');
    var max = (scrollToSelected && !dragging) ? centerLevelChip() : -1;
    box.scrollLeft = dragging ? swap.snap.strip : levelStripScroll;
    syncChipsEdge(box, max);
    // 启动时 #app 还藏着,量不到宽度,等显示出布局后再算一次到头状态。
    requestAnimationFrame(function () { syncChipsEdge(box, -1); });
  }

  /* ---------------- 阅读器 ---------------- */
  function hasTrans(art, i) {
    return !!(art && art.c && art.c[i] && String(art.c[i]).trim());
  }
  function missingTrans(art) {
    var out = [];
    if (!art || !art.p) return out;
    for (var i = 0; i < art.p.length; i++) if (!hasTrans(art, i)) out.push(i);
    return out;
  }
  function saveTransOverride(stem, art) {
    var rec = { k: 'tr:' + stem, stem: stem, c: art.c.slice(), at: Date.now() };
    AI_TR[rec.k] = rec;
    idbPut('ai', rec).catch(function () {});
  }
  // 空串也要占位,启动时 hit.c.length 才能压住内置译文。
  function ensureTransList(art) {
    if (!Array.isArray(art.c)) art.c = [];
    for (var i = 0; i < art.p.length; i++) {
      if (typeof art.c[i] !== 'string') art.c[i] = '';
    }
    art.c.length = art.p.length;
    return art.c;
  }
  function deleteTransAt(stem, idx) {
    var art = A_MAP[stem];
    if (!art || !art.p || idx < 0 || idx >= art.p.length || !hasTrans(art, idx)) return;
    askConfirm('删除这段译文', '只删这一段，之后点右上「AI 译」可以只补这一段。', true, function () {
      ensureTransList(art);
      art.c[idx] = '';
      saveTransOverride(stem, art);
      if (readerStem === stem) renderReader(stem, true);
      notify('已删除这段译文，点右上「AI 译」可重翻');
    });
  }
  function clearArticleTrans(stem) {
    var art = A_MAP[stem];
    if (!art || !art.p) return;
    askConfirm('清除本篇译文', '这篇的译文会全部清空（包括内置译文），之后可以点「AI 译」重译。免费接口有限额，别反复清空重译。', true, function () {
      var c = [];
      for (var i = 0; i < art.p.length; i++) c.push('');
      art.c = c;
      saveTransOverride(stem, art);
      showTrans = false;
      if (readerStem === stem) renderReader(stem, true);
      notify('已清除译文，点右上「AI 译」可重译');
    });
  }
  function setReaderTop(art) {
    var miss = missingTrans(art).length;
    var toggle = function () {
      showTrans = !showTrans;
      renderReader(readerStem, true);
    };
    setTop(artTitle(art), {
      back: true,
      action: miss
        ? { label: 'AI 译', fn: function () { aiTranslateSheet(readerStem); } }
        : { label: showTrans ? '原文' : '译', active: showTrans, fn: toggle }
    });
    var fb = $('#favBtn');
    var on = isFav(art.s);
    fb.innerHTML = on ? ICONS.starOn : ICONS.star;
    fb.classList.toggle('on', on);
    fb.setAttribute('aria-label', on ? '取消收藏' : '收藏');
    fb.classList.remove('hidden');
    var tb = $('#ttsBtn');
    if (TTS_ON && nativeTTS()) {
      tb.classList.remove('hidden');
      syncTTSBtn();
    } else {
      tb.classList.add('hidden');
    }
  }
  function toggleFavCurrent() {
    if (!readerStem || !A_MAP[readerStem]) return;
    toggleFav(readerStem);
    setReaderTop(A_MAP[readerStem]);
  }

  function nativeTTS() {
    return !!(window.Android && typeof window.Android.ttsSpeak === 'function');
  }
  // 查词时顺手把单词读一遍。引擎不可用就不发声，不弹提示——查词本身还能用。
  function speakWordOnce(word) {
    if (!TTS_ON || !word) return;
    if (tts.on) return;
    if (!window.Android || typeof window.Android.ttsSayWord !== 'function') return;
    if (typeof window.Android.ttsStatus === 'function'
        && String(window.Android.ttsStatus() || '') !== 'ok') return;
    applyVoiceSettings();
    window.Android.ttsSayWord(String(word));
  }
  // 只给朗读用：返回每句在段落里的 [start, end)，与 art.p[i] 的下标一一对应。
  // 不合并小写续句——多切一刀只是多停顿一次，不会读错内容。
  function sentenceRanges(text) {
    var out = [], start = 0, m;
    SENT_SPLIT_RE.lastIndex = 0;
    while ((m = SENT_SPLIT_RE.exec(text))) {
      var before = text.slice(Math.max(0, m.index - 12), m.index);
      if (ABBR_RE.test(before) || /[A-Z]\.$/.test(before)) continue;
      var end = m.index + (m[1] ? 1 : 0);
      out.push({ start: start, end: end });
      start = SENT_SPLIT_RE.lastIndex;
    }
    if (start < text.length) out.push({ start: start, end: text.length });
    return out;
  }
  // 点到的字符在段落文本里的偏移；art.p[i] 与段落 textContent 是逐字对应的。
  function tapCharOffset(paraEl, x, y) {
    var range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(x, y);
    } else if (document.caretPositionFromPoint) {
      var pos = document.caretPositionFromPoint(x, y);
      if (pos) range = { startContainer: pos.offsetNode, startOffset: pos.offset };
    }
    if (!range || !range.startContainer || !paraEl.contains(range.startContainer)) return -1;
    var walker = document.createTreeWalker(paraEl, NodeFilter.SHOW_TEXT, null, false);
    var node, total = 0;
    while ((node = walker.nextNode())) {
      if (node === range.startContainer) return total + range.startOffset;
      total += node.textContent.length;
    }
    return -1;
  }
  function sentenceAt(text, offset) {
    var ranges = sentenceRanges(text);
    for (var i = 0; i < ranges.length; i++) {
      if (offset < ranges[i].end) return i;
    }
    return Math.max(0, ranges.length - 1);
  }
  // 段落里每个词 span 的字符区间;朗读高亮和跳转高亮共用。
  function wordSpans(paraEl) {
    var out = [], pos = 0, kids = paraEl.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var node = kids[i];
      var len = (node.textContent || '').length;
      if (node.nodeType === 1 && node.classList && node.classList.contains('w')) {
        out.push({ el: node, start: pos, end: pos + len });
      }
      pos += len;
    }
    return out;
  }
  // 点词时取它所在的句子,交给单词卡判断词性。
  function tapSentence(paraEl, x, y) {
    if (!paraEl || !readerStem) return '';
    var art = A_MAP[readerStem];
    if (!art || !art.p) return '';
    var idx = +paraEl.dataset.para;
    var text = art.p[idx];
    if (!text) return '';
    var off = tapCharOffset(paraEl, x, y);
    if (off < 0) return '';
    var ranges = sentenceRanges(text);
    for (var i = 0; i < ranges.length; i++) {
      if (off < ranges[i].end) return text.slice(ranges[i].start, ranges[i].end).trim();
    }
    return '';
  }
  function syncTTSBtn() {
    var btn = $('#ttsBtn');
    if (!btn) return;
    btn.classList.toggle('on', tts.on);
    btn.innerHTML = tts.on ? ICONS.speakerOn : ICONS.speaker;
    btn.setAttribute('aria-label', tts.on ? '停止朗读' : '朗读');
  }
  function ttsClearGap() {
    if (ttsGap) { clearTimeout(ttsGap); ttsGap = 0; }
  }
  function toggleTTS() {
    if (tts.on) stopTTS();
    else startTTS();
  }
  function ttsUnavailableSheet(reason) {
    var canOpen = window.Android && typeof window.Android.ttsOpenSettings === 'function';
    showSheet('<div class="sheet-grip"></div>'
      + '<div class="confirm-title">朗读用不了</div>'
      + '<div class="confirm-text">' + esc(reason) + '。闲读用的是手机自带的语音引擎，'
      + '装一个带英文语音的引擎（比如系统自带的语音合成）就能用。</div>'
      + '<div class="sheet-actions">'
      + (canOpen ? '<button class="btn primary wide" data-tts-act="open">打开语音设置</button>' : '')
      + '<button class="btn ghost wide" data-tts-act="ok">知道了</button>'
      + '</div>');
  }
  function ttsVoiceInfo() {
    if (!window.Android || typeof window.Android.ttsVoiceInfo !== 'function') return null;
    try { return JSON.parse(window.Android.ttsVoiceInfo() || 'null'); } catch (e) { return null; }
  }
  function applyVoiceSettings() {
    if (!window.Android || typeof window.Android.ttsSetVoice !== 'function') return;
    var rate = +S.settings.tts_rate || 0.9;
    var pitch = +S.settings.tts_pitch || 1.0;
    window.Android.ttsSetVoice(rate, pitch);
  }
  // 第一次点朗读时弹一次,把人引到语音设置页。
  function maybeVoiceGuide() {
    if (!TTS_ON || S.settings.ttsGuide) return false;
    S.settings.ttsGuide = 1;
    saveNow();
    voiceGuideSheet();
    return true;
  }
  function voiceGuideSheet() {
    showSheet('<div class="sheet-grip"></div>'
      + '<div class="confirm-title">先把朗读调顺</div>'
      + '<div class="confirm-text">安卓自带的语音引擎往往比较生硬。想听得自然，推荐装「Speech Services by Google」，再选英文音色。配置路线在语音设置页里也有一份。</div>'
      + '<div class="about-row"><b>1 · 安装</b><p>Speech Services by Google</p></div>'
      + '<div class="about-row"><b>2 · 打开系统语音设置</b><p>本页「系统语音设置 → 打开」</p></div>'
      + '<div class="about-row"><b>3 · 首选引擎</b><p>选「Google 语音识别和语音合成」</p></div>'
      + '<div class="about-row"><b>4 · 语言</b><p>返回上一级 → 语言 → 英语（英国）或英语（美国）</p></div>'
      + '<div class="sheet-actions">'
      + '<button class="btn ghost" data-tts-act="guide-later">先这样用</button>'
      + '<button class="btn primary" data-tts-act="guide-go">去语音设置</button>'
      + '</div>');
  }
  function startTTS() {
    if (!TTS_ON || !nativeTTS() || !readerStem) return;
    var st = 'ok';
    if (typeof window.Android.ttsStatus === 'function') st = String(window.Android.ttsStatus() || 'ok');
    if (st !== 'ok') {
      if (st === 'initializing') { notify('语音引擎还在启动，稍等一下再点'); return; }
      ttsUnavailableSheet(st);
      return;
    }
    var art = A_MAP[readerStem];
    if (!art || !art.p || !art.p.length) return;
    var view = $('#view');
    var top = view.getBoundingClientRect().top - 8;
    var paras = $$('.para', view);
    var start = 0;
    for (var i = 0; i < paras.length; i++) {
      if (paras[i].getBoundingClientRect().top >= top) {
        start = +paras[i].dataset.para || 0;
        break;
      }
    }
    maybeVoiceGuide();
    tts.on = true;
    tts.stem = readerStem;
    tts.idx = start;
    tts.sent = 0;
    syncTTSBtn();
    applyVoiceSettings();
    speakUnit();
  }
  // 朗读按句高亮:段落只留很淡的底,当前这句的每个词标出来。
  function markTtsSent(idx, sent) {
    $$('.para.tts-cur').forEach(function (el) { el.classList.remove('tts-cur'); });
    $$('.w.tts-sent').forEach(function (el) { el.classList.remove('tts-sent'); });
    var el = $('.para[data-para="' + idx + '"]');
    if (!el) return;
    el.classList.add('tts-cur');
    var art = A_MAP[tts.stem];
    if (!art || !art.p) return;
    var ranges = sentenceRanges(art.p[idx] || '');
    var r = ranges[sent];
    if (!r) return;
    var first = null, last = null;
    wordSpans(el).forEach(function (s) {
      if (s.end <= r.start || s.start >= r.end) return;
      s.el.classList.add('tts-sent');
      if (!first) first = s.el;
      last = s.el;
    });
    if (!first) return;
    var vr = $('#view').getBoundingClientRect();
    var top = first.getBoundingClientRect().top;
    var bottom = (last || first).getBoundingClientRect().bottom;
    if (top < vr.top + 44 || bottom > vr.bottom - 20) {
      first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
  function speakUnit() {
    ttsClearGap();
    if (!tts.on) return;
    var art = A_MAP[tts.stem];
    if (!art || !art.p || tts.idx < 0 || tts.idx >= art.p.length) { stopTTS(); return; }
    var ranges = sentenceRanges(art.p[tts.idx]);
    if (!ranges.length || tts.sent >= ranges.length) {
      tts.idx++;
      tts.sent = 0;
      if (tts.idx >= art.p.length) { stopTTS(); notify('朗读结束'); return; }
      return speakUnit();
    }
    var text = art.p[tts.idx].slice(ranges[tts.sent].start, ranges[tts.sent].end).trim();
    if (!text) { tts.sent++; return speakUnit(); }
    markTtsSent(tts.idx, tts.sent);
    window.Android.ttsSpeak(text);
  }
  function stopTTS() {
    ttsClearGap();
    tts.on = false;
    tts.stem = '';
    tts.idx = 0;
    tts.sent = 0;
    $$('.para.tts-cur').forEach(function (el) { el.classList.remove('tts-cur'); });
    $$('.w.tts-sent').forEach(function (el) { el.classList.remove('tts-sent'); });
    if (TTS_ON && window.Android && typeof window.Android.ttsStop === 'function') {
      window.Android.ttsStop();
    }
    syncTTSBtn();
  }
  window.onTTS = function (state, payload) {
    if (!TTS_ON) return;
    if (state === 'start') return;
    if (state === 'done') {
      if (!tts.on) return;
      tts.sent++;
      ttsClearGap();
      ttsGap = setTimeout(function () { ttsGap = 0; speakUnit(); }, 120);
      return;
    }
    if (state === 'error') {
      stopTTS();
      notify(payload || '朗读不可用');
    }
  };
  /* ---------------- 每篇的退出位置 ---------------- */
  function readPosOf(stem) {
    var p = S.readPos ? S.readPos[stem] : null;
    if (!p || typeof p !== 'object') return null;
    var i = +p.p;
    if (!(i >= 0)) return null;
    // o 允许负值:首段顶边还在视口上沿之下也是合法位置。
    var o = +p.o || 0;
    if (o > 9999) o = 9999;
    if (o < -9999) o = -9999;
    return { p: i, o: o };
  }
  function readPosPut(stem, pos) {
    if (!S.readPos || typeof S.readPos !== 'object') S.readPos = {};
    if (!pos) { delete S.readPos[stem]; save(); return; }
    S.readPos[stem] = { p: pos.p, o: Math.round(pos.o), t: Date.now() };
    var keys = Object.keys(S.readPos);
    if (keys.length > READPOS_MAX) {
      keys.sort(function (a, b) {
        return (+((S.readPos[a] || {}).t) || 0) - (+((S.readPos[b] || {}).t) || 0);
      });
      for (var i = 0; i < keys.length - READPOS_MAX; i++) delete S.readPos[keys[i]];
    }
    save();
  }
  // 锚点 = 视口上沿那一段,o = 该段被滚出视口的高度。回到顶部视作没有位置。
  function captureReadPos() {
    if (!readerStem || swap.busy) return;
    var view = $('#view');
    if (view.scrollTop <= 2) { readPosPut(readerStem, null); return; }
    var paras = $$('.para[data-para]', view);
    if (!paras.length) return;
    var top = view.getBoundingClientRect().top;
    // 首段还没滚出视口时循环会立刻 break,所以 elTop 要先取第一段,不能留 0。
    var el = paras[0], elTop = paras[0].getBoundingClientRect().top;
    for (var i = 0; i < paras.length; i++) {
      var r = paras[i].getBoundingClientRect();
      if (r.top > top + 2) break;
      el = paras[i]; elTop = r.top;
    }
    readPosPut(readerStem, { p: +el.dataset.para || 0, o: top - elTop });
  }
  // 冷启动回到「上次被清后台时正在读的那篇」。退出阅读器就清掉,免得下次又跳进去。
  // 位置本身不用这里记,readPos 那套已经在管。
  function setResumeStem(stem) {
    if (!S || !S.settings) return;
    if (S.settings.resume_stem === stem) return;
    S.settings.resume_stem = stem || '';
    saveNow();
  }
  function resumeReaderOnBoot() {
    var stem = S.settings && S.settings.resume_stem;
    if (!stem) return;
    if (!A_MAP[stem]) { S.settings.resume_stem = ''; saveNow(); return; }
    // 第三参数:冷启动恢复不播推入动画,不然像用户刚点进来。
    openReader(stem, true, true);
  }
  function applyReadPos(stem) {
    var view = $('#view');
    var pos = readPosOf(stem);
    if (!pos) { view.scrollTop = 0; return; }
    var el = $('.para[data-para="' + pos.p + '"]', view);
    if (el) {
      // 用实测矩形算,不依赖 offsetParent:#view 是滚动容器,滚到该段上方 pos.o 处。
      var vr = view.getBoundingClientRect(), er = el.getBoundingClientRect();
      var y = view.scrollTop + (er.top - vr.top) + pos.o;
      view.scrollTop = y < 0 ? 0 : y;
      return;
    }
    var art = A_MAP[stem];
    var total = (art && art.p && art.p.length) || 1;
    var max = Math.max(0, view.scrollHeight - view.clientHeight);
    view.scrollTop = Math.min(max, (pos.p / total) * max);
  }

  // 只有目录 / 历史 / 收藏 / 继续阅读这四类入口要恢复位置,列表直接点开一律从顶部。
  function rememberEntry(el) {
    if (current === 'history' || current === 'favs') return true;
    // 接着读浮条自己走 openReader(stem, true),这里只剩列表点开的常规情况。
    return false;
  }

  // keepPos:从目录 / 历史 / 收藏 / 继续阅读进来时恢复到上次退出位置,其余从顶部开始。
  // noAnim:冷启动恢复用,不播推入动画。
  function openReader(stem, keepPos, noAnim) {
    var art = A_MAP[stem];
    if (!art) return;
    clearTimeout(readPosTimer);
    readPosTimer = 0;
    if (readerStem && readerStem !== stem) captureReadPos();
    stopTTS();
    if (!readerStem) {
      readerFrom = current;
      listScroll = $('#view').scrollTop;
    }
    var wasReader = !!readerStem;
    readerStem = stem;
    current = 'read';
    S.last_stem = stem;
    setResumeStem(stem);
    recordHistory(stem);
    save();
    document.body.classList.add('reader');
    $('#levelStrip').classList.add('hidden');
    renderContPill();          // 正文页不显示浮条
    showTrans = false;
    renderReader(stem, false);
    // 先归零:applyReadPos 是在当前 scrollTop 上叠加的,不清零会带着上一页的位置跳。
    $('#view').scrollTop = 0;
    if (keepPos) applyReadPos(stem);
    else $('#view').scrollTop = 0;
    // 列表→文章是层级进入,推入一帧;文章内跳转(目录)不再动画。
    if (ANIM_ON && !wasReader && !swap.busy && !noAnim) playViewAnim('anim-push');
  }
  // 跳转后的高亮:有词就用 jump-word,整段兜底用 jump-hl;语境复习和划线共用这一套。
  function flashSpans(el, nodes) {
    var vr = $('#view').getBoundingClientRect();
    var target = nodes.length ? nodes[0] : el;
    var er = target.getBoundingClientRect();
    $('#view').scrollTop += er.top - vr.top - Math.round(vr.height * 0.35);
    if (nodes.length) {
      nodes.forEach(function (n) { n.classList.add('jump-word'); });
      setTimeout(function () {
        nodes.forEach(function (n) { n.classList.remove('jump-word'); });
      }, 2400);
    } else {
      el.classList.add('jump-hl');
      setTimeout(function () { el.classList.remove('jump-hl'); }, 1800);
    }
  }
  function openReaderAt(stem, para, word) {
    openReader(stem);
    if (!readerStem) return;
    para = +para;
    if (!(para >= 0)) return;
    var el = $('.para[data-para="' + para + '"]');
    if (!el) return;
    var head = word ? headOf(word) : '';
    var marks = [];
    if (head) {
      wordSpans(el).forEach(function (s) {
        if (headOf(s.el.dataset.w) === head) marks.push(s.el);
      });
    }
    flashSpans(el, marks);
  }
  function closeReader(viaTab) {
    captureReadPos();
    stopTTS();
    closePop();
    readerStem = null;
    setResumeStem('');
    document.body.classList.remove('reader');
    contPill.open = null;
    if (viaTab) { renderContPill(); return; }
    var back = (readerFrom && VIEWS[readerFrom]) ? readerFrom : 'read';
    // 进正文挂了一帧 anim-push(见 openReader),出正文必须有对应的 pop,
    // 否则进出不对称:正文和列表的视图名都是 read,go() 的 viewSwapKind
    // 看到 prev===name 直接跳过转场,退出时就是硬切一下。
    var sameView = (back === current);
    go(back, false);          // go() 里会重新摆浮条
    $('#view').scrollTop = listScroll;
    if (ANIM_ON && sameView) playViewAnim('anim-pop');
  }
  function rereadArticle(stem) {
    var art = A_MAP[stem];
    if (!art) return;
    var rec = articleRec(stem);
    rec.done = false;
    rec.read = [];
    delete rec.done_at;
    readPosPut(stem, null);
    save();
    openReader(stem);
    notify('从头再读一遍');
  }
  function rereadCurrent() {
    if (!readerStem) return;
    var rec = articleRec(readerStem);
    rec.done = false;
    rec.read = [];
    delete rec.done_at;
    readPosPut(readerStem, null);
    save();
    renderReader(readerStem, true);
    notify('从头再读一遍');
  }
  function rereadBook(id) {
    var arts = A.filter(function (a) { return (a.bk || a.b) === id; });
    arts.forEach(function (a) {
      var rec = articleRec(a.s);
      rec.done = false;
      rec.read = [];
      delete rec.done_at;
    });
    save();
    renderRead(true);
    notify('这本书可以重新读了');
  }

  function countMarks(art) {
    var c = hintCache.get(art.s);
    if (c && c.rev === cachesRev) return c;
    var seen = {}, hint = 0, learn = 0;
    for (var i = 0; i < art.p.length; i++) {
      var toks = art.p[i].match(WORD_RE) || [];
      for (var j = 0; j < toks.length; j++) {
        var w = toks[j], key = w.toLowerCase();
        if (seen[key]) continue;
        seen[key] = 1;
        var tag = hiTag(w);
        if (tag === 'hint') hint++;
        else if (tag === 'learn') learn++;
      }
    }
    var out = { rev: cachesRev, hint: hint, learn: learn };
    hintCache.set(art.s, out);
    return out;
  }

  /* ---------------- 难易度体检(照搬桌面版 audit.py 的生词率与分档) ---------------- */
  var VERDICT_BANDS = [[0.02, '太简单', 'ez'], [0.035, '合适', 'ok'],
                       [0.08, '吃力', 'mid'], [Infinity, '太难', 'no']];
  var STOP_SET = {};
  ('a an the and but or so if because while when where what who whom whose why how '
    + 'then than now just only very too also still again once soon later always never '
    + 'sometimes often usually here there this that these those he she it they we you i '
    + 'his her its their our my your him them us me '
    + 'is are was were be been being am do does did have has had will would can could '
    + 'may might must shall should '
    + 'not no yes all some any many much more most other another each both few several '
    + 'such same own last next first second third '
    + 'at in on for with from to of by about after before over under up down out off '
    + 'one two three four five six seven eight nine ten '
    + 'morning evening night day week month year time way man men woman women '
    + 'girl boy child children old new little big small good bad great long short '
    + 'said says asked told came went looked saw').split(/\s+/)
    .forEach(function (w) { STOP_SET[w] = 1; });

  /* 缩写先展开再判断(don't → do):词典里没有 don't,
     不展开的话对话体文章的生词率会凭空高一截。和桌面版 audit.py 同一张表。 */
  var CONTRACT = {
    "don't": "do", "doesn't": "do", "didn't": "do", "can't": "can", "won't": "will",
    "shan't": "shall", "ain't": "be", "mustn't": "must", "needn't": "need",
    "wouldn't": "would", "couldn't": "could", "shouldn't": "should", "isn't": "is",
    "aren't": "are", "wasn't": "was", "weren't": "were", "haven't": "have",
    "hasn't": "have", "hadn't": "have", "i'm": "i", "i've": "i", "i'll": "i",
    "i'd": "i", "you'd": "you", "he'd": "he", "she'd": "she", "it'd": "it",
    "we'd": "we", "they'd": "they", "that'd": "that",
    "it's": "it", "that's": "that", "there's": "there", "he's": "he", "she's": "she",
    "we'll": "we", "they'll": "they", "he'll": "he", "she'll": "she", "it'll": "it",
    "you'll": "you", "that'll": "that", "there'll": "there",
    "we're": "we", "they're": "they", "you're": "you", "let's": "let",
    "there're": "there", "who've": "who", "you've": "you", "we've": "we",
    "they've": "they", "what's": "what", "where's": "where", "when's": "when",
    "why's": "why", "how's": "how", "who's": "who", "could've": "could",
    "would've": "would", "should've": "should", "might've": "might", "must've": "must",
    "who'd": "who", "who'll": "who", "who're": "who"
  };

  function normWord(word) {
    return String(word || '').toLowerCase().replace(/’/g, "'");
  }

  /* 生词率口径的预处理:去网址、折叠重音、剥掉数字后的序数/复数尾巴。只影响统计。 */
  function foldLatin(text) {
    var s = String(text || '').replace(URL_RE, ' ');
    s = foldAccents(s);
    return s.replace(ORD_RE, '$1');
  }

  /* 人名/地名不进词典,靠大写比例认:全程大写的词才算专名,句首才大写的不算。
     只出现一次的词,若那次出现在句中大写,也按专名处理。 */
  function findNames(text) {
    text = foldLatin(text);
    var cap = {}, mid = {}, total = {};
    var sents = text.split(/\n+|[.!?]["'”’]?[ \t]+/);
    for (var s = 0; s < sents.length; s++) {
      var sent = sents[s];
      if (sent.length > 3 && sent === sent.toUpperCase()) continue;
      var sw = sent.match(WORD_RE) || [];
      for (var i = 0; i < sw.length; i++) {
        var w = sw[i], lw = normWord(w);
        if (lw.length < 2 || lw === 'i') continue;
        total[lw] = (total[lw] || 0) + 1;
        if (w[0] !== w[0].toLowerCase()) {
          cap[lw] = (cap[lw] || 0) + 1;
          if (i > 0) mid[lw] = (mid[lw] || 0) + 1;
        }
      }
    }
    var names = {};
    for (var key in total) {
      var t = total[key];
      if (STOP_SET[key]) continue;
      if (t === 1) {
        if (mid[key]) names[key] = 1;
        continue;
      }
      if ((cap[key] || 0) / t >= 0.9 || (mid[key] || 0) / t >= 0.5) names[key] = 1;
    }
    return names;
  }

  function verdictBand(rate) {
    for (var i = 0; i < VERDICT_BANDS.length; i++) {
      if (rate <= VERDICT_BANDS[i][0]) return VERDICT_BANDS[i];
    }
    return VERDICT_BANDS[VERDICT_BANDS.length - 1];
  }

  function auditOf(art) {
    var hit = auditCache.get(art.s);
    if (hit && hit.rev === cachesRev) return hit;
    var text = foldLatin(art.p.join(' '));
    var names = findNames(text);
    var book = bookOf(art.s);
    var epi = !!(book && book.kind === 'epi');
    var targets = {};
    if (epi) {
      (book.targets || []).forEach(function (w) {
        var lw = String(w || '').toLowerCase();
        if (lw) { targets[lw] = 1; targets[headOf(lw)] = 1; }
      });
    }
    var toks = text.match(WORD_RE) || [], unk = 0, scored = 0;
    for (var i = 0; i < toks.length; i++) {
      var w = toks[i], lw = normWord(w);
      if (w.length < 2 || names[lw]) continue;
      var plain = own(CONTRACT, lw) || lw;
      var isTarget = targets[headOf(plain)] === 1 || targets[lw] === 1;
      if (!isTarget) scored++;
      if (isKnown(plain) || isTarget) continue;
      unk++;
    }
    var rate = scored ? unk / scored : 0;
    var band = epi ? [0, '定制', 'epi'] : verdictBand(rate);
    var out = { rev: cachesRev, rate: rate, name: band[1], cls: band[2] };
    auditCache.set(art.s, out);
    return out;
  }

  function verdictHTML(art, withRate) {
    var a = auditOf(art);
    return '<span class="vd ' + a.cls + '">' + a.name
      + (withRate ? ' ' + (Math.round(a.rate * 1000) / 10) + '%' : '') + '</span>';
  }

  function tokensHTML(text, rs) {
    var out = '', pos = 0, m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(text))) {
      out += esc(text.slice(pos, m.index));
      var w = m[0], cls = hiTag(w);
      if (rs && rs.length && rangesHit(rs, m.index, m.index + w.length)) cls += (cls ? ' ' : '') + 'mk';
      out += '<span class="w' + (cls ? ' ' + cls : '') + '" data-w="' + esc(w) + '">'
        + esc(w) + '</span>';
      pos = WORD_RE.lastIndex;
    }
    out += esc(text.slice(pos));
    return out;
  }

  function renderReader(stem, keepScroll) {
    var art = A_MAP[stem];
    if (!art) { closeReader(); return; }
    closePop();
    var scroll = keepScroll ? $('#view').scrollTop : 0;
    var st = articleRec(stem);
    var marks = countMarks(art);
    var meta = '<span>' + levelName(art.l) + '</span><span>' + fmt(art.w) + ' 词</span>';
    meta += verdictHTML(art, true);
    if (marks.hint) meta += '<span>' + marks.hint + ' 个提示词</span>';
    if (marks.learn) meta += '<span>' + marks.learn + ' 个学习词</span>';
    if (st.done) meta += '<span class="art-done">已读完</span>';
    var body = '', anyTrans = false;
    var mkRs = paraMarkRanges(stem);
    for (var i = 0; i < art.p.length; i++) {
      var tr = art.c && art.c[i] ? art.c[i] : '';
      if (tr && String(tr).trim()) anyTrans = true;
      body += '<p class="para" data-para="' + i + '">'
        + tokensHTML(art.p[i], mkRs[i]) + '</p>';
      if (tr) {
        body += '<div class="trans" data-tr="' + i + '"' + (showTrans ? '' : ' hidden') + '>'
          + esc(tr) + '</div>';
      }
    }
    var seq = readerSequence(art);
    var at = seq.indexOf(art);
    var chapter = !!(art.b || art.bk);
    var nav = '<div class="reader-nav">'
      + '<button class="btn ghost" data-act="prev"' + (at > 0 ? '' : ' disabled') + '>'
      + (chapter ? '上一章' : '上一篇') + '</button>'
      + '<button class="btn nav-toc" data-act="toc">目录</button>'
      + '<button class="btn soft" data-act="next"'
      + (at >= 0 && at + 1 < seq.length ? '' : ' disabled') + '>'
      + (chapter ? '下一章' : '下一篇') + '</button></div>';
    var foot;
    if (st.done) {
      foot = '<div class="done-card"><b>这篇读完了</b>'
        + (st.done_at ? '完成于 ' + esc(st.done_at) : '')
        + '<div class="done-again"><button class="btn small soft" data-act="reread">再读一遍</button></div>'
        + '</div>' + nav;
    } else {
      foot = '<button class="btn primary block" data-act="finish">我读完了</button>'
        + '<div class="tiny muted center">读完才计入今天,也才会更新词的出现次数</div>'
        + nav;
    }
    if (anyTrans) {
      foot += '<button class="btn ghost small block" data-act="clear-trans">清除本篇译文</button>'
        + '<div class="tiny muted center">长按某段译文可以只删那一段</div>';
    }
    if (missingTrans(art).length) {
      body += '<div class="trans-tip">这篇还有 ' + missingTrans(art).length
        + ' 段没有译文 · 点右上「AI 译」补齐译文</div>';
    }
    $('#view').innerHTML = '<div class="reader-wrap">'
      + '<div class="reader-head"><div class="reader-title">' + esc(artTitle(art)) + '</div>'
      + '<div class="reader-meta">' + meta + '</div></div>'
      + '<div class="reader-body">' + body + '</div>'
      + '<div class="reader-end">' + foot + '</div></div>';
    setReaderTop(art);
    if (keepScroll) $('#view').scrollTop = scroll;
    if (tts.on && tts.stem === stem) markTtsSent(tts.idx, tts.sent);
  }

  /* ---------------- 目录面板 ---------------- */
  function tocSheet() {
    var art = A_MAP[readerStem];
    if (!art) return;
    var list = readerSequence(art);
    if (!list.length) return;
    var chapter = !!(art.b || art.bk);
    var doneN = 0, i;
    for (i = 0; i < list.length; i++) if ((S.articles[list[i].s] || {}).done) doneN++;
    var rows = '';
    for (i = 0; i < list.length; i++) {
      var a = list[i], st = S.articles[a.s] || {};
      rows += '<div class="toc-row' + (a.s === art.s ? ' on' : '') + '"'
        + ' data-toc-stem="' + esc(a.s) + '">'
        + '<span class="toc-no">' + (chapter ? (a.cn || (i + 1)) : (i + 1)) + '</span>'
        + '<span class="toc-name">' + esc(a.t || a.s) + '</span>'
        + '<span class="toc-state' + (st.done ? ' read' : '') + '">'
        + (st.done ? '已读完' : '未读') + '</span></div>';
    }
    sheetDirty = false;
    showSheet('<div class="sheet-grip"></div>'
      + '<div class="confirm-title">' + esc(chapter ? (bookTitleOf(art) || '目录') : levelName(art.l))
      + '</div>'
      + '<div class="tiny muted center toc-sum">共 ' + list.length + ' '
      + (chapter ? '章' : '篇') + ' · 已读 ' + doneN + '</div>'
      + '<div class="toc-list">' + rows + '</div>');
    var sheet = $('#sheet');
    sheet.scrollTop = 0;
    var on = $('.toc-row.on', sheet);
    if (on) {
      // 面板还在下滑动画里,但 transform 对 row 与 sheet 是同一个位移,差值不受影响。
      sheet.scrollTop += on.getBoundingClientRect().top - sheet.getBoundingClientRect().top
        - (sheet.clientHeight - on.offsetHeight) / 2;
    }
  }

  function finishArticle(stem) {
    var art = A_MAP[stem];
    if (!art) return;
    stopTTS();
    var rec = articleRec(stem);
    if (rec.done) { notify('这篇已经读完了'); return; }
    rec.done = true;
    rec.done_at = todayKey();
    rec.times = (+rec.times || 0) + 1;
    rec.read = [];
    for (var i = 0; i < art.p.length; i++) rec.read.push(i);
    var n = +art.w || wordsOf(art.p.join(' '));
    addWords(n);

    // 全文出现过的词:词频次数 +1,并记一次"遇到没查"。
    var seen = {};
    for (var p = 0; p < art.p.length; p++) {
      var toks = art.p[p].match(WORD_RE) || [];
      for (var j = 0; j < toks.length; j++) {
        var h = headOf(toks[j]);
        if (!h || seen[h]) continue;
        seen[h] = 1;
        var wr = S.words[h];
        if (!wr) continue;
        var ws = +wr.st || 0;
        if (ws === IGNORED || ws === WELLKNOWN) continue;
        wr.n = (+wr.n || 0) + 1;
        onPass(wr);
      }
    }
    // 全文词种进「读过」池。
    var pool = S.read_words || (S.read_words = {});
    var heads = {}, uniq = 0, fresh = 0, day = todayKey();
    for (var q = 0; q < art.p.length; q++) {
      var ts = art.p[q].match(WORD_RE) || [];
      for (var k = 0; k < ts.length; k++) {
        var hd = headOf(ts[k]);
        if (!hd || heads[hd] || isProper(hd)) continue;
        heads[hd] = 1;
        var rr = pool[hd];
        if (!rr || typeof rr !== 'object') {
          rr = pool[hd] = { n: 0, first: day, last: day };
          fresh++;
        }
        rr.n = (+rr.n || 0) + 1;
        rr.last = day;
        uniq++;
      }
    }
    dropCaches();
    saveNow();
    renderReader(stem, true);
    notify('读完 +' + fmt(n) + ' 词 · 读过 ' + fmt(uniq) + ' 个词(新 ' + fresh + ')');
  }

  function readerSequence(art) {
    if (!art) return [];
    if (art.bk) return A.filter(function (a) { return a.bk === art.bk; });
    if (art.b) return A.filter(function (a) { return a.b === art.b; });
    return A.filter(function (a) { return a.l === art.l; });
  }

  function stepArticle(delta) {
    if (!readerStem) return;
    stopTTS();
    var art = A_MAP[readerStem];
    var list = readerSequence(art);
    var idx = list.indexOf(art);
    var next = idx < 0 ? -1 : idx + delta;
    if (next < 0) { notify('已经是第一篇了'); return; }
    if (next >= list.length) {
      notify((art.b || art.bk) ? '已经是这本书的最后一章了' : '已经是最后一篇了');
      return;
    }
    openReader(list[next].s);
    $('#view').scrollTop = 0;
  }
  function nextArticle() { stepArticle(1); }
  function prevArticle() { stepArticle(-1); }

  /* ---------------- AI 翻译 ---------------- */
  function aiTranslateSheet(stem) {
    var art = A_MAP[stem];
    if (!art) return;
    var provider = transProvider();
    if (provider === 'deepseek' && !aiKey()) {
      keySheet({ after: function () { aiTranslateSheet(stem); } });
      return;
    }
    var miss = missingTrans(art);
    if (!miss.length) {
      showTrans = !showTrans;
      renderReader(stem, true);
      return;
    }
    var have = art.p.length - miss.length;
    var label = provider === 'deepseek' ? 'DeepSeek 翻译' : '腾讯翻译（免费）';
    showSheet('<div class="sheet-grip"></div>'
      + '<div class="confirm-title">补齐这篇的译文</div>'
      + '<div class="confirm-text">还有 ' + miss.length + ' 段没有中文。会用 ' + label + ','
      + '只发送这些英文段落,完成后存在本机。' + (have ? '已有 ' + have + ' 段译文会保留。' : '') + '</div>'
      + '<div class="sheet-actions">'
      + (have ? '<button class="btn ghost" data-trans-act="view">先看已有译文</button>' : '')
      + '<button class="btn primary' + (have ? '' : ' wide') + '" data-trans-act="go">开始翻译</button>'
      + '</div>'
      + '<div class="sheet-note">'
      + (provider === 'deepseek'
        ? 'AI 译文可能有误,只当阅读辅助。'
        : '腾讯翻译是免费接口：译得偏直、偶尔漏句，而且有频率限制。别短时间内反复翻译长文，免得被限流。')
      + '</div>');
  }

  function translateChunk(paras, index, total) {
    if (transProvider() === 'tencent') return translateChunkTencent(paras, index, total);
    return translateChunkDeepSeek(paras, index, total);
  }

  function translateChunkDeepSeek(paras, index, total) {
    var n = paras.length;
    var payload = JSON.stringify(paras, null, 1);
    var prompt = 'Translate each English paragraph below into natural, faithful Simplified Chinese.\n\n'
      + 'OUTPUT FORMAT: return ONLY a JSON array of strings, no markdown, no explanation. '
      + 'The array must contain EXACTLY ' + n + ' items, one per input paragraph, in the same order. '
      + 'Never merge or split paragraphs. If a paragraph is a heading, still return one item.\n\n'
      + 'RULES: Simplified Chinese, read like a published translation; keep names natural; '
      + 'keep numbers and punctuation faithful; no notes or bracketed glosses.\n\n'
      + 'INPUT — a JSON array of ' + n + ' English paragraphs:\n' + payload;
    var budget = Math.max(1200, Math.min(8000, Math.round(payload.length * 1.4)));
    function attempt(k) {
      setBusyText('第 ' + (index + 1) + '/' + total + ' 块 · ' + (k ? '重试…' : '正在翻译…'));
      return aiCall([
        { role: 'system', content: 'You are a professional English-to-Chinese literary translator for graded readers. Follow the output format exactly.' },
        { role: 'user', content: prompt }
      ], { temperature: 0.3, max_tokens: budget }).then(function (raw) {
        var arr = parseJsonArray(raw, n);
        if (!arr) throw new Error('段落数对不上(要 ' + n + ' 段)');
        return arr;
      }).catch(function (err) {
        if (k < 1) return attempt(k + 1);
        throw err;
      });
    }
    return attempt(0);
  }

  function aiTranslateArticle(stem) {
    if (aiBusy) return;
    var art = A_MAP[stem];
    if (!art) return;
    var todo = missingTrans(art);
    if (!todo.length) { aiTranslateSheet(stem); return; }
    var provider = transProvider();
    if (provider === 'deepseek' && !aiKey()) {
      keySheet({ after: function () { aiTranslateArticle(stem); } });
      return;
    }
    aiBusy = true;
    if (!art.c) art.c = [];
    for (var z = 0; z < art.p.length; z++) if (art.c[z] === undefined) art.c[z] = '';
    var maxSeg = provider === 'tencent' ? 10 : 24;
    var maxChars = provider === 'tencent' ? 1800 : 8200;
    var chunks = [], cur = [], chars = 0;
    for (var i = 0; i < todo.length; i++) {
      var idx = todo[i], text = art.p[idx];
      if (cur.length && (cur.length >= maxSeg || chars + text.length > maxChars)) {
        chunks.push(cur); cur = []; chars = 0;
      }
      cur.push({ idx: idx, text: text });
      chars += text.length;
    }
    if (cur.length) chunks.push(cur);
    showBusy('AI 翻译中', '共 ' + todo.length + ' 段,分 ' + chunks.length + ' 块发送…');
    var done = 0, chain = Promise.resolve();
    chunks.forEach(function (chunk, ci) {
      chain = chain.then(function () {
        if (provider === 'tencent' && ci > 0) {
          return new Promise(function (resolve) { setTimeout(resolve, 300); });
        }
      }).then(function () {
        return translateChunk(chunk.map(function (x) { return x.text; }), ci, chunks.length)
          .then(function (arr) {
            for (var j = 0; j < chunk.length; j++) art.c[chunk[j].idx] = arr[j];
            done += chunk.length;
            setBusyText('已翻 ' + done + '/' + todo.length + ' 段…');
          });
      });
    });
    chain.then(function () {
      var rec = { k: 'tr:' + stem, stem: stem, c: art.c.slice(), at: Date.now() };
      AI_TR[rec.k] = rec;
      return idbPut('ai', rec).then(function () {
        showTrans = true;
        aiBusy = false;
        if (readerStem === stem) renderReader(stem, true);
        closeSheet();
        notify('译文已补好,点段落可以单独收起');
      });
    }).catch(function (err) {
      aiBusy = false;
      // 翻好的先存下来,下次只补没翻的。
      if (done) {
        var rec2 = { k: 'tr:' + stem, stem: stem, c: art.c.slice(), at: Date.now() };
        AI_TR[rec2.k] = rec2;
        idbPut('ai', rec2).catch(function () {});
      }
      if (readerStem === stem) renderReader(stem, true);
      showErrorSheet('翻译没完成', (done ? '已保存前 ' + done + ' 段。' : '') + (err.message || err));
    });
  }

  /* ---------------- AI 番外 ---------------- */
  function dueTargets() {
    var today = parseDay(todayKey());
    var rows = activeWords().filter(function (x) {
      var rec = x[1], st = +rec.st || 0;
      if (st === IGNORED || st === WELLKNOWN) return false;
      return true;
    });
    var due = rows.filter(function (x) {
      var d = parseDay(x[1].due, new Date(0));
      return d.getTime() <= today.getTime();
    });
    var pool = due.length ? due : rows.filter(function (x) { return !!+x[1].no; });
    pool.sort(function (a, b) {
      var na = +a[1].no ? 1 : 0, nb = +b[1].no ? 1 : 0;
      if (na !== nb) return nb - na;
      var da = parseDay(a[1].due, new Date(0)).getTime();
      var db = parseDay(b[1].due, new Date(0)).getTime();
      if (da !== db) return da - db;
      return (+b[1].chk || 0) - (+a[1].chk || 0);
    });
    return pool.slice(0, 6).map(function (x) { return x[0]; });
  }

  function epilogueSheet() {
    if (!aiKey()) { keySheet({ after: epilogueSheet }); return; }
    var t = dueTargets();
    if (!t.length) {
      showInfoSheet('还没有可以用的词', '先读几篇、点几个不认识的词,攒出到期词后再来生成番外。');
      return;
    }
    showSheet('<div class="sheet-grip"></div>'
      + '<div class="confirm-title">生成今日番外</div>'
      + '<div class="confirm-text">会用下面这些词写一篇 200–320 词的小故事,尽量避开别的生词。'
      + '生成后放进「番外」,可以正常点词、读完和复习。</div>'
      + '<div class="ai-targets">' + t.map(function (w) {
        return '<span class="badge blue">' + esc(w) + '</span>';
      }).join('') + '</div>'
      + '<div class="sheet-actions">'
      + '<button class="btn ghost" data-epi-act="cancel">取消</button>'
      + '<button class="btn primary" data-epi-act="gen">开始写</button></div>'
      + '<div class="sheet-note">会消耗一次 DeepSeek 请求;不满意可以再生成。</div>');
  }

  function epiPrompt(targets, feedback) {
    var b = { zk: ['A1-A2', 'junior-high-school level in China'],
      gk: ['A2-B1', 'senior-high-school level in China'],
      cet4: ['B1', 'CET-4 level in China'],
      cet6: ['B1-B2', 'CET-6 level in China'],
      rank: ['A2', 'beginner level'] }[mode()] || ['A1-A2', 'junior-high-school level in China'];
    return 'Write one short story for a Chinese adult who is learning English by reading for pleasure.\n\n'
      + 'READER knows about 1600 English word families (' + b[0] + ', ' + b[1] + '). '
      + 'If a page has more than one unfamiliar word in thirty, he gives up.\n\n'
      + 'TARGET WORDS — the story exists so the reader meets these: ' + targets.join(', ') + '\n\n'
      + 'RULES\n'
      + '1. Length 200-320 words, 3-5 paragraphs, one blank line between paragraphs.\n'
      + '2. Each target word appears 2-4 times, in different sentences and situations, never twice in one paragraph. '
      + 'Never define, translate or quote the target words.\n'
      + '3. Apart from the targets, at most 4 other words may be unfamiliar to this reader. '
      + 'Use only very common, everyday English. No rare nouns, no abstract words, no synonyms for flavour.\n'
      + '4. Sentences average 6-10 words, none longer than 18. One idea per sentence.\n'
      + '5. Simple present or simple past only. No perfect tenses, no passive voice, no idioms, no phrasal verbs.\n'
      + '6. At most 3 names. Introduce each once with a short description, then just use the name.\n'
      + '7. One small concrete scene from ordinary life. Something small goes wrong and gets fixed. '
      + 'No flashback, no dream, no twist, no moral.\n'
      + '8. Plain text only. No title, no numbering, no markdown, no notes.\n'
      + (feedback ? '\nYour previous draft failed these checks. Fix all of them:\n' + feedback : '');
  }

  function checkEpilogue(text, targets) {
    var words = wordsOf(text);
    var paras = text.split(/\n\s*\n/).filter(function (x) { return x.trim(); }).length;
    var fails = [];
    if (words < 150) fails.push('字数只有 ' + words + ',要 200–320 词');
    if (words > 380) fails.push('字数到了 ' + words + ',太长了');
    if (paras < 2 || paras > 7) fails.push('段落数是 ' + paras + ',要 3–5 段');
    var lower = ' ' + text.toLowerCase().replace(/[^a-z']+/g, ' ') + ' ';
    var missing = targets.filter(function (w) {
      return lower.indexOf(' ' + String(w).toLowerCase() + ' ') < 0;
    });
    if (missing.length) fails.push('这些目标词没出现:' + missing.join(', '));
    var toks = text.match(WORD_RE) || [], unknown = 0;
    var targetSet = {};
    targets.forEach(function (w) { targetSet[headOf(w)] = 1; });
    for (var i = 0; i < toks.length; i++) {
      var h = headOf(toks[i]);
      if (targetSet[h] || isKnown(h) || isProper(h)) continue;
      if (/^[A-Z]/.test(toks[i]) && toks[i].length > 1) continue;
      unknown++;
    }
    var rate = toks.length ? unknown / toks.length : 1;
    if (rate > 0.08) fails.push('生词率 ' + Math.round(rate * 100) + '%,太高了,换更常见的词');
    return { ok: !fails.length, fails: fails, rate: rate };
  }

  function normalizeStory(text) {
    var t = String(text || '').replace(/\r\n?/g, '\n')
      .replace(/^\s*```[a-zA-Z]*\s*/, '').replace(/\s*```\s*$/, '')
      .replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();
    var blocks = t.split(/\n\s*\n/).map(function (x) { return x.replace(/\s+/g, ' ').trim(); })
      .filter(Boolean);
    if (blocks.length > 1 && wordsOf(blocks[0]) <= 8 && !/[.!?]$/.test(blocks[0])) blocks.shift();
    var paras = [];
    blocks.forEach(function (b) {
      if (wordsOf(b) <= 150) paras.push(b);
      else paras = paras.concat(sentenceChunks(b, 100));
    });
    return paras;
  }

  function generateEpilogue(targets) {
    if (aiBusy) return;
    aiBusy = true;
    var attempt = 0, feedback = '', lastText = '';
    showBusy('正在写番外', '第 1 轮…');
    function round() {
      attempt++;
      return aiCall([
        { role: 'system', content: 'You are an ESL graded-reader author. You write short, warm, concrete stories for adult beginners and follow hard constraints exactly.' },
        { role: 'user', content: epiPrompt(targets, feedback) }
      ], { temperature: 0.8, max_tokens: 1400, timeout: 120000 }).then(function (raw) {
        lastText = String(raw || '').trim();
        var paras = normalizeStory(lastText);
        var text = paras.join('\n\n');
        var report = checkEpilogue(text, targets);
        if (report.ok || attempt >= 3) return { text: text, paras: paras, report: report };
        feedback = '- ' + report.fails.join('\n- ');
        setBusyText('第 ' + (attempt + 1) + ' 轮 · 上一稿要改…');
        return round();
      });
    }
    round().then(function (res) {
      if (!res.paras.length) throw new Error('模型没有写出正文');
      var title = '番外 · ' + (new Date().getMonth() + 1) + '-' + new Date().getDate();
      var book = {
        id: 'ep-' + Date.now().toString(36), kind: 'epi', level: 0,
        title: title, added: Date.now(), targets: targets,
        chapters: [{ t: title, paras: res.paras }]
      };
      return idbPut('books', book).then(function () {
        BOOKS.push(book);
        rebuildA();
        readLevel = 0;
        S.settings.last_level = 0;
        saveNow();
        aiBusy = false;
        var stem = 'ib:' + book.id + ':0';
        closeSheet();
        openReader(stem);
        if (res.report.ok) notify('番外写好了 · 用到了 ' + targets.length + ' 个词');
        else notify('番外写好了,但校验没全过,读的时候留意一下');
      });
    }).catch(function (err) {
      aiBusy = false;
      showErrorSheet('番外没生成', err.message || String(err));
    });
  }

  /* ---------------- 单词面板 ---------------- */
  function openWord(surface, countCheck, ctx) {
    surface = String(surface || '').toLowerCase().replace(/^[^a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]+|[^a-z'\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]+$/g, '');
    if (!surface) return;
    var head = headOf(surface);
    var rec = ensureWord(head);
    if (countCheck) {
      onCheck(rec);
      todayDay().checks = (+todayDay().checks || 0) + 1;
      dropCaches();
    }
    sheetWord = { head: head, surface: surface, ctx: String(ctx || '') };
    sheetDirty = false;
    showSheet(wordSheetHTML());
    save();
  }

  function wordSheetHTML() {
    if (!sheetWord) return '';
    var head = sheetWord.head, surface = sheetWord.surface;
    var rec = S.words[head] || {};
    var lk = lookup(head);
    var ov = dictOverride(head);
    var phon = phonText((ov && ov.phon) || lk[0]);
    var sayBtn = TTS_ON
      ? '<button class="icon-btn on sheet-say" data-sheet-act="say" aria-label="朗读">' + ICONS.speakerOn + '</button>'
      : '';
    var stage = stageText(rec);
    var rank = rankOf(head);
    var lines = defLinesOf(head);
    var bare = !lines.length;          // 内置词典和重译缓存都没有释义
    var guess = sheetWord.ctx ? guessPos(sheetWord.ctx, head) : '';
    // 本句词性命中的那条提到最前显示,lines 本身不动,重译/恢复词典不受影响。
    var ordered = lines;
    if (guess) {
      for (var oi = 0; oi < lines.length; oi++) {
        if (lines[oi].pos === guess) {
          ordered = [lines[oi]];
          for (var oj = 0; oj < lines.length; oj++) if (oj !== oi) ordered.push(lines[oj]);
          break;
        }
      }
    }
    var badges = '<span class="badge">遇到 ' + (+rec.n || 0) + ' 次</span>'
      + '<span class="badge ' + (stage === '不会' ? 'red' : 'blue') + '">' + esc(stage) + '</span>'
      + '<span class="badge">' + esc(dueLabel(rec)) + '</span>';
    if (rank) badges += '<span class="badge">词频 ' + fmt(rank) + '</span>';
    if (rec.first) badges += '<span class="badge">首遇 ' + esc(rec.first) + '</span>';
    if (isProper(head)) badges += '<span class="badge">专名</span>';
    var actions = '<button class="btn danger" data-sheet-act="no">我不会</button>'
      + '<button class="btn ok" data-sheet-act="known">已掌握</button>'
      + '<button class="btn dim" data-sheet-act="ignore">忽略此词</button>'
      + '<button class="btn soft" data-sheet-act="review">语境复习</button>';
    var extra = '';
    var st = +rec.st || 0;
    if (st === WELLKNOWN || st === IGNORED) {
      extra = '<button class="btn ghost wide" data-sheet-act="restore">恢复为生词</button>';
    } else if (S.words[head]) {
      extra = '<button class="btn ghost wide" data-sheet-act="clear">清除这个词的记录</button>';
    }
    var trBox = '';
    if (bare) {
      trBox = '<div class="sheet-tr">'
        + (sheetWord.trBusy ? '<span class="faint">联网词典查询中…</span>'
          : '<span class="sheet-miss" data-sheet-act="tr">该词汇未收录，点我翻译</span>')
        + (sheetWord.trFail ? '<div class="faint">稍后再试</div>' : '')
        + '</div>';
    }
    // 有释义的词:低调给一个「重译」,查过之后旁边再给「恢复词典」。
    var ovRow = bare ? '' : '<div class="sheet-ov">'
      + '<button class="lnk" data-sheet-act="redict">重译</button>'
      + (ov ? '<button class="lnk" data-sheet-act="undict">恢复词典</button>'
        + '<span class="tiny muted">现在显示的是联网释义</span>' : '')
      + (sheetWord.trBusy ? '<span class="tiny muted">联网词典查询中…</span>' : '')
      + (sheetWord.trFail && !bare ? '<span class="tiny muted">稍后再试</span>' : '')
      + '</div>';
    return '<div class="sheet-grip"></div>'
      + '<div class="sheet-head">'
      + '<div class="sheet-word">' + esc(wordLabel(head))
      + (surface !== head ? ' <span class="tiny muted">' + esc(surface) + '</span>' : '') + '</div>'
      + sayBtn + '</div>'
      + (phon ? '<div class="sheet-phon">' + esc(phon) + '</div>' : '')
      + (guess ? '<div class="pos-note">本句里作' + POS_NAME[guess] + '</div>' : '')
      + (lines.length ? '<div class="sheet-mean">' + ordered.map(function (x) {
        var on = guess && x.pos === guess;
        return '<div class="mean-line' + (on ? ' on' : '') + '">' + esc(x.text) + '</div>';
      }).join('') + '</div>' : '')
      + ovRow
      + trBox
      + '<div class="sheet-meta">' + badges + '</div>'
      + '<div class="sheet-actions">' + actions + extra + '</div>'
      + '<div class="sheet-note">点过的词会自动进生词本;标「我不会」的词会优先出现在复习里。</div>';
  }

  // 点一次只发一个请求:先问联网词典,拿不到再退回腾讯翻译,还不行只留一行提示。
  function fetchDictMeaning() {
    if (!sheetWord || sheetWord.trBusy) return;
    var head = sheetWord.head;
    sheetWord.trBusy = true;
    sheetWord.trFail = false;
    refreshWordSheet();
    function done(obj, zh) {
      if (!sheetWord || sheetWord.head !== head) return;
      sheetWord.trBusy = false;
      if (obj) saveDictOverride(head, obj);
      else if (zh) saveDictOverride(head, { phon: '', trs: [{ pos: '', tran: zh }] });
      else sheetWord.trFail = true;
      refreshWordSheet();
    }
    youdaoDict(head).then(function (obj) { done(obj, ''); }, function () {
      translateChunk([head], 0, 1).then(function (arr) {
        done(null, String((arr && arr[0]) || '').trim());
      }).catch(function () { done(null, ''); });
    });
  }

  function refreshWordSheet() {
    if (!sheetWord) return;
    sheetDirty = true;
    var scroll = $('#sheet').scrollTop;
    $('#sheet').innerHTML = wordSheetHTML();
    $('#sheet').scrollTop = scroll;
  }

  function markUnknown(head) {
    var rec = ensureWord(head);
    rec.no = 1;
    rec.st = 0;
    rec.stab = 0.5;
    rec.last = todayKey();
    rec.chk = Math.max(+rec.chk || 0, 1);
    rec.n = Math.max(+rec.n || 0, 1);
    rec.first = rec.first || todayKey();
    ensureSrs(rec);
    dropCaches();
    saveNow();
  }
  function markKnown(head) {
    var rec = ensureWord(head);
    rec.no = 0;
    rec.st = WELLKNOWN;
    rec.n = Math.max(+rec.n || 0, 12);
    rec.stab = 365;
    rec.last = todayKey();
    rec.first = rec.first || todayKey();
    ensureSrs(rec);
    dropCaches();
    saveNow();
  }
  function markIgnored(head) {
    var rec = ensureWord(head);
    rec.no = 0;
    rec.st = IGNORED;
    rec.n = Math.max(+rec.n || 0, 1);
    rec.first = rec.first || todayKey();
    ensureSrs(rec);
    dropCaches();
    saveNow();
  }
  function restoreWord(head) {
    var rec = ensureWord(head);
    rec.st = 0;
    rec.no = 0;
    rec.n = Math.max(+rec.n || 0, 1);
    rec.stab = 1;
    rec.last = todayKey();
    ensureSrs(rec);
    dropCaches();
    saveNow();
  }

  function refreshCurrentView() {
    if (readerStem) { renderReader(readerStem, true); return; }
    if (current === 'words') renderWordbookList();
    else if (current === 'done') renderDone();
    else if (current === 'flash') renderFlash();
    else if (current === 'review') renderReview(revWord, { keep: true, keepScroll: true });
    else if (current === 'stats') renderStats();
    else if (current === 'read') renderRead();
  }

  /* ---------------- 面板控件 ---------------- */
  var sheetAnim = 0;
  function showSheet(html) {
    var sheet = $('#sheet'), back = $('#backdrop');
    sheet.classList.remove('sheet-top');
    back.classList.remove('sheet-top');
    closePop();
    var token = ++sheetAnim;
    sheet.innerHTML = html;
    sheet.classList.remove('hidden');
    back.classList.remove('hidden');
    // 先渲染一帧再加 show,否则 transition 会被合并掉。
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        // 如果中间已经关闭 / 换成别的内容,别再把旧面板弹出来。
        if (token !== sheetAnim) return;
        sheet.classList.add('show');
        back.classList.add('show');
      });
    });
  }
  function closeSheet() {
    var sheet = $('#sheet'), back = $('#backdrop');
    sheetAnim++;
    sheet.classList.remove('sheet-top');
    back.classList.remove('sheet-top');
    if (sheet.classList.contains('hidden')) return;
    sheet.classList.remove('show');
    back.classList.remove('show');
    setTimeout(function () {
      if (!sheet.classList.contains('show')) {
        sheet.classList.add('hidden');
        back.classList.add('hidden');
      }
    }, 210);
    if (sheetDirty) {
      sheetDirty = false;
      refreshCurrentView();
    }
  }
  function askConfirm(title, text, danger, onYes) {
    sheetDirty = false;
    showSheet('<div class="sheet-grip"></div>'
      + '<div class="confirm-title">' + esc(title) + '</div>'
      + '<div class="confirm-text">' + esc(text) + '</div>'
      + '<div class="sheet-actions">'
      + '<button class="btn ghost" data-confirm="no">取消</button>'
      + '<button class="btn ' + (danger ? 'danger' : 'primary') + '" data-confirm="yes">确定</button>'
      + '</div>');
    var sheet = $('#sheet');
    sheet._confirm = function (yes) {
      closeSheet();
      if (yes && onYes) onYes();
    };
  }

  function showBusy(title, text) {
    showSheet('<div class="sheet-grip"></div><div class="busy-box">'
      + '<div class="spinner"></div><div class="busy-title">' + esc(title) + '</div>'
      + '<div class="busy-text" id="busyText">' + esc(text || '') + '</div></div>');
  }
  function setBusyText(text) {
    var el = $('#busyText');
    if (el) el.textContent = text;
  }
  function showInfoSheet(title, text, after) {
    sheetDirty = false;
    showSheet('<div class="sheet-grip"></div>'
      + '<div class="confirm-title">' + esc(title) + '</div>'
      + '<div class="confirm-text">' + esc(text) + '</div>'
      + '<button class="btn primary block" data-close="1">知道了</button>');
    $('#sheet')._closeAfter = after || null;
  }
  function showErrorSheet(title, text) {
    showInfoSheet(title, text || '请稍后再试', null);
  }

  function onboardSheet() {
    sheetDirty = false;
    showSheet('<div class="sheet-grip"></div>'
      + '<div class="confirm-title">欢迎来到闲读</div>'
      + '<div class="confirm-text">第一次用？花 1 分钟看一下操作指引：点词查义、朗读、语境复习都在里面。</div>'
      + '<button class="onboard-guide" data-onboard="guide">我是新用户，查看指引</button>'
      + '<button class="onboard-skip" data-onboard="skip">我是老用户，直接跳过</button>');
  }

  function keySheet(opts) {
    opts = opts || {};
    var after = opts.after || null;
    var stored = aiKey();
    sheetDirty = false;
    showSheet('<div class="sheet-grip"></div>'
      + '<div class="confirm-title">DeepSeek API Key</div>'
      + '<div class="confirm-text">填一次就能在手机里用 AI 翻译。Key 只存在这台手机,'
      + '不会写进导出的存档;只有你点 AI 时才会发给 DeepSeek。</div>'
      + '<input class="field" id="aiKeyInput" type="password" autocomplete="off" spellcheck="false"'
      + ' placeholder="' + (stored ? '已保存 ' + esc(maskedKey()) + ',输入新 Key 可覆盖' : 'sk-…') + '">'
      + '<div class="sheet-actions">'
      + '<button class="btn soft" data-key-act="test">测试连接</button>'
      + '<button class="btn primary" data-key-act="save">保存</button>'
      + (stored ? '<button class="btn ghost wide" data-key-act="clear">清除已保存的 Key</button>' : '')
      + '</div>'
      + '<div class="sheet-note">在 platform.deepseek.com 创建 Key。平时阅读完全离线,不用联网。</div>');
    $('#sheet')._afterKey = after;
  }

  function pickBookFile() {
    var f = $('#bookFile');
    if (!f) return;
    f.value = '';
    f.click();
  }

  function importBookFile(file) {
    if (!file) return;
    var ext = (String(file.name || '').match(/\.([^.]+)$/) || [])[1];
    var isEpub = (ext && ext.toLowerCase() === 'epub') || /epub/i.test(String(file.type || ''));
    if (isEpub && !EPUB_ON) {
      showInfoSheet('EPUB 导入暂停了', '请先转成 TXT 再导入。');
      return;
    }
    pendingBook = null;
    showBusy('正在导入图书', '读取文件…');
    parseBookFile(file).then(function (book) {
      book.id = 'bk-' + Date.now().toString(36);
      book.kind = 'book';
      book.level = 90;
      book.added = Date.now();
      book.title = String(book.title || '导入图书').trim().slice(0, 60) || '导入图书';
      if (!book.chapters.length) throw new Error('没读到章节');
      pendingBook = book;
      previewBook();
    }).catch(function (err) {
      pendingBook = null;
      showErrorSheet('导入失败', err && err.message ? err.message : String(err));
    });
  }

  function previewBook() {
    if (!pendingBook) return;
    var chs = pendingBook.chapters, words = 0;
    chs.forEach(function (c) { words += wordsOf((c.paras || []).join(' ')); });
    sheetDirty = false;
    showSheet('<div class="sheet-grip"></div>'
      + '<div class="confirm-title">加入书架</div>'
      + '<div class="confirm-text">已经分好 ' + chs.length + ' 章,共 ' + fmt(words)
      + ' 词。书名可以改,导入后随时能删。</div>'
      + '<input class="field" id="bookTitleInput" value="' + esc(pendingBook.title) + '" maxlength="60">'
      + '<div class="import-preview">' + chs.slice(0, 4).map(function (c, i) {
        return '<div><span class="tiny faint">' + (i + 1) + '</span> ' + esc(c.t || ('第 ' + (i + 1) + ' 章')) + '</div>';
      }).join('') + (chs.length > 4 ? '<div class="tiny faint">… 还有 ' + (chs.length - 4) + ' 章</div>' : '')
      + '</div>'
      + '<div class="sheet-actions">'
      + '<button class="btn ghost" data-close="1">取消</button>'
      + '<button class="btn primary" data-import-act="save">放进书架</button></div>'
      + '<div class="sheet-note">只存文字,不导入书里的插图;原文件可以留在手机别处。</div>');
  }

  function savePendingBook() {
    if (!pendingBook) return;
    var inp = $('#bookTitleInput');
    if (inp && inp.value.trim()) pendingBook.title = inp.value.trim().slice(0, 60);
    var book = pendingBook;
    showBusy('正在放进书架', '写入本地书库…');
    idbPut('books', book).then(function () {
      BOOKS.push(book);
      BOOKS.sort(function (a, b) { return (+a.added || 0) - (+b.added || 0); });
      pendingBook = null;
      rebuildA();
      openBooks[book.id] = true;
      readLevel = 90;
      S.settings.last_level = 90;
      saveNow();
      closeSheet();
      go('read');
      notify('《' + book.title + '》已加入书架');
    }).catch(function (err) {
      showErrorSheet('没存进去', (err && err.message) || '本地书库写入失败');
    });
  }

  function builtinBooks() {
    var seen = {}, out = [];
    CORE_A.forEach(function (a) {
      if (a.l !== 90 || !a.b || seen[a.b]) return;
      seen[a.b] = 1;
      out.push({ id: a.b, title: a.bt || a.t || a.b });
    });
    return out;
  }
  function bookWords(b) {
    var words = 0;
    (b.chapters || []).forEach(function (c) { words += wordsOf((c.paras || []).join(' ')); });
    return words;
  }
  function manageBooksSheet() {
    sheetDirty = false;
    var hidden = S && S.hidden_books ? S.hidden_books : {};
    var hiddenRows = builtinBooks().filter(function (b) { return hidden[b.id]; });
    if (!BOOKS.length && !hiddenRows.length) {
      showInfoSheet('还没有导入的书', '在阅读页右上角「＋」里选「导入图书」,只支持 TXT。');
      return;
    }
    var rows = BOOKS.slice().sort(function (a, b) { return (+b.added || 0) - (+a.added || 0); });
    var html = '<div class="sheet-grip"></div><div class="menu-title">管理图书</div>';
    if (rows.length) {
      html += '<div class="manage-cap">导入的书</div>'
        + rows.map(function (b) {
          return '<div class="manage-row">'
            + '<div class="grow"><div class="manage-title ellipsis">《' + esc(b.title) + '》</div>'
            + '<div class="manage-sub">' + (b.kind === 'epi' ? 'AI 番外' : (b.chapters.length + ' 章'))
            + ' · ' + fmt(bookWords(b)) + ' 词</div></div>'
            + '<button class="btn small danger" data-del-book="' + esc(b.id) + '">删除</button></div>';
        }).join('');
    }
    if (hiddenRows.length) {
      html += '<div class="manage-cap">已收起的内置书</div>'
        + hiddenRows.map(function (b) {
          return '<div class="manage-row">'
            + '<div class="grow"><div class="manage-title ellipsis">《' + esc(b.title) + '》</div>'
            + '<div class="manage-sub">内置 · 进度还在</div></div>'
            + '<button class="btn small soft" data-restore-book="' + esc(b.id) + '">恢复</button></div>';
        }).join('');
    }
    html += '<div class="sheet-note">删除导入的书会清掉它的进度和 AI 译文;内置书只是收起,随时能恢复。</div>';
    showSheet(html);
  }

  function hideBuiltinBook(id) {
    var title = id;
    for (var i = 0; i < CORE_A.length; i++) if (CORE_A[i].b === id) { title = CORE_A[i].bt || CORE_A[i].t || id; break; }
    askConfirm('收起《' + title + '》',
      '这本书会从书架收起,内置原文和阅读进度都还在。要找回时,点阅读页右上角「＋」→「管理图书」。',
      false, function () {
        var wasReading = readerStem && A_MAP[readerStem] && A_MAP[readerStem].b === id;
        if (!S.hidden_books) S.hidden_books = {};
        S.hidden_books[id] = title;
        delete openBooks[id];
        if (wasReading) {
          readerStem = null;
          document.body.classList.remove('reader');
        }
        rebuildA();
        if (S.last_stem && !A_MAP[S.last_stem]) S.last_stem = null;
        saveNow();
        if (current === 'me') renderMe();
        else go('read');
        notify('已收起《' + title + '》');
      });
  }

  function restoreBuiltinBook(id) {
    if (!S.hidden_books || !S.hidden_books[id]) return;
    var title = S.hidden_books[id];
    delete S.hidden_books[id];
    rebuildA();
    saveNow();
    closeSheet();
    go('read');
    notify('《' + title + '》已回到书架');
  }

  function deleteBook(id, after) {
    var book = null;
    for (var i = 0; i < BOOKS.length; i++) if (BOOKS[i].id === id) { book = BOOKS[i]; break; }
    if (!book) { hideBuiltinBook(id); return; }
    askConfirm('删除《' + book.title + '》',
      '这本书会从书架移除,它在本机的阅读进度和 AI 译文缓存也一起删掉。内置文章不受影响。',
      true, function () {
        var wasReading = readerStem && A_MAP[readerStem] && A_MAP[readerStem].bk === id;
        // 清掉这本书各章的阅读记录,统计里的「已读篇数」也会跟着减。
        Object.keys(A_MAP).forEach(function (stem) {
          if (A_MAP[stem] && A_MAP[stem].bk === id) delete S.articles[stem];
        });
        idbDel('books', id).catch(function () {});
        Object.keys(AI_TR).forEach(function (k) {
          if (k.indexOf('tr:ib:' + id + ':') === 0) {
            delete AI_TR[k];
            idbDel('ai', k).catch(function () {});
          }
        });
        BOOKS = BOOKS.filter(function (b) { return b.id !== id; });
        delete openBooks[id];
        if (wasReading) {
          readerStem = null;
          document.body.classList.remove('reader');
        }
        rebuildA();
        if (S.last_stem && !A_MAP[S.last_stem]) S.last_stem = null;
        saveNow();
        if (current === 'me') renderMe();
        else go('read');
        notify('已删除《' + book.title + '》');
        if (after) after();
      });
  }

  $('#sheet').addEventListener('click', function (e) {
    // 更新弹层:下载安装 / 稍后。data-act 的委托在 #view 上,够不到 #sheet。
    var upBtn = e.target.closest('[data-sheet-act="update-download"],'
      + '[data-sheet-act="update-later"]');
    if (upBtn) {
      closeSheet();
      if (upBtn.dataset.sheetAct === 'update-download') downloadLatestPage(false);
      return;
    }
    var folderOk = e.target.closest('[data-folder-ok]');
    if (folderOk) {
      var fi = $('#folderNameInput');
      var name = fi ? fi.value.trim().slice(0, 20) : '';
      if (!name) { notify('收藏夹名字不能为空'); return; }
      var fn = $('#sheet')._folderOk;
      $('#sheet')._folderOk = null;
      closeSheet();
      if (fn) fn(name);
      return;
    }
    var favTo = e.target.closest('[data-fav-to]');
    if (favTo) {
      var target = favTo.dataset.favTo, fstem = favTo.dataset.favStem;
      closeSheet();
      setFavFolder(fstem, target);
      return;
    }
    var onboard = e.target.closest('[data-onboard]');
    if (onboard) {
      var toGuide = onboard.dataset.onboard === 'guide';
      closeSheet();
      if (toGuide) setTimeout(function () { go('set-about'); }, 210);
      return;
    }
    var close = e.target.closest('[data-close]');
    if (close) {
      var afterClose = $('#sheet')._closeAfter;
      $('#sheet')._closeAfter = null;
      closeSheet();
      if (afterClose) setTimeout(afterClose, 210);
      return;
    }
    var keyAct = e.target.closest('[data-key-act]');
    if (keyAct) {
      var inp = $('#aiKeyInput');
      var typed = inp ? inp.value.trim() : '';
      var kind = keyAct.dataset.keyAct;
      if (kind === 'clear') {
        setAiKey('');
        notify('已清除 API Key');
        closeSheet();
        if (current === 'set-data') renderDataSettings();
        return;
      }
      if (kind === 'save') {
        if (!typed || typed.length < 8) { notify('请填入完整的 API Key'); return; }
        setAiKey(typed);
        var afterSave = $('#sheet')._afterKey;
        closeSheet();
        notify('API Key 已保存在本机');
        if (current === 'set-data') renderDataSettings();
        if (afterSave) setTimeout(afterSave, 230);
        return;
      }
      if (kind === 'test') {
        var testKey = typed || aiKey();
        if (!testKey) { notify('先填一个 API Key'); return; }
        showBusy('正在测试连接', '只发一句 OK,确认网络和 Key 能不能用…');
        aiCall([{ role: 'user', content: 'Reply with exactly: OK' }],
          { key: testKey, temperature: 0, max_tokens: 8, timeout: 45000 }).then(function (txt) {
          setAiKey(testKey);
          var afterTest = $('#sheet')._afterKey || null;
          showInfoSheet('连接成功', 'DeepSeek 返回:' + String(txt || '').slice(0, 40), afterTest);
        }).catch(function (err) {
          showErrorSheet('连接失败', err.message || String(err));
        });
        return;
      }
      return;
    }
    var importAct = e.target.closest('[data-import-act]');
    if (importAct && importAct.dataset.importAct === 'save') { savePendingBook(); return; }
    var transAct = e.target.closest('[data-trans-act]');
    if (transAct) {
      if (transAct.dataset.transAct === 'view') {
        closeSheet();
        showTrans = true;
        if (readerStem) renderReader(readerStem, true);
      } else if (transAct.dataset.transAct === 'go') {
        aiTranslateArticle(readerStem);
      }
      return;
    }
    var epiAct = e.target.closest('[data-epi-act]');
    if (epiAct) {
      if (epiAct.dataset.epiAct === 'gen') generateEpilogue(dueTargets());
      else closeSheet();
      return;
    }
    var del = e.target.closest('[data-del-book]');
    if (del) { deleteBook(del.dataset.delBook); return; }
    var restore = e.target.closest('[data-restore-book]');
    if (restore) { restoreBuiltinBook(restore.dataset.restoreBook); return; }
    var tocRow = e.target.closest('[data-toc-stem]');
    if (tocRow) {
      var tStem = tocRow.dataset.tocStem;
      closeSheet();
      if (tStem !== readerStem) openReader(tStem, true);
      return;
    }
    var menuAct = e.target.closest('[data-menu-act]');
    if (menuAct) {
      var m = menuAct.dataset.menuAct;
      if (m === 'import-book') { closeSheet(); setTimeout(pickBookFile, 210); }
      else if (m === 'import-rules') copyImportRules();
      else if (m === 'epilogue') { closeSheet(); setTimeout(epilogueSheet, 210); }
      else if (m === 'manage-books') { manageBooksSheet(); }
      return;
    }
    var ttsAct = e.target.closest('[data-tts-act]');
    if (ttsAct) {
      var ta = ttsAct.dataset.ttsAct;
      if (ta === 'open') {
        closeSheet();
        if (window.Android && typeof window.Android.ttsOpenSettings === 'function') {
          window.Android.ttsOpenSettings();
        }
      } else if (ta === 'guide-go') {
        closeSheet();
        go('set-voice');
      } else {
        closeSheet();
      }
      return;
    }
    var cf = e.target.closest('[data-confirm]');
    if (cf) {
      var fn = $('#sheet')._confirm;
      if (fn) fn(cf.dataset.confirm === 'yes');
      return;
    }
    var b = e.target.closest('[data-sheet-act]');
    if (!b || !sheetWord) return;
    var act = b.dataset.sheetAct;
    var head = sheetWord.head;
    if (act === 'say') { speakWordOnce(head); return; }
    if (act === 'tr' || act === 'redict') { fetchDictMeaning(); return; }
    if (act === 'undict') {
      dropDictOverride(head);
      sheetWord.trFail = false;
      refreshWordSheet();
      return;
    }
    if (act === 'no') { markUnknown(head); refreshWordSheet(); }
    else if (act === 'known') { markKnown(head); refreshWordSheet(); }
    else if (act === 'ignore') { markIgnored(head); refreshWordSheet(); }
    else if (act === 'restore') { restoreWord(head); refreshWordSheet(); }
    else if (act === 'review') {
      var w = head;
      sheetDirty = false;
      closeSheet();
      reviewWord(w);
    } else if (act === 'clear') {
      askConfirm('清除这个词', '把「' + head + '」的遇到次数、阶段和复习进度全部删掉?这个操作不能撤销。', true, function () {
        delete S.words[head];
        dropCaches();
        saveNow();
        refreshCurrentView();
        notify('已清除「' + head + '」');
      });
    }
  });

  /* ---------------- 生词本 ---------------- */
  function activeWords() {
    var out = [];
    for (var w in S.words) {
      var rec = S.words[w];
      if (rec && typeof rec === 'object') out.push([w, rec]);
    }
    return out;
  }
  function sortWords(rows) {
    rows.sort(function (a, b) {
      var ra = a[1], rb = b[1];
      var sa = +ra.st || 0, sb = +rb.st || 0;
      var deadA = sa === IGNORED || sa === WELLKNOWN ? 1 : 0;
      var deadB = sb === IGNORED || sb === WELLKNOWN ? 1 : 0;
      if (deadA !== deadB) return deadA - deadB;
      var da = parseDay(ra.due, new Date()).getTime();
      var db = parseDay(rb.due, new Date()).getTime();
      if (da !== db) return da - db;
      return (+rb.n || 0) - (+ra.n || 0);
    });
    return rows;
  }
  function matchesFilter(rec, f) {
    if (f === 'all') return true;
    var st = +rec.st || 0;
    if (f === 'known') return st === WELLKNOWN || stageText(rec) === '掌握';
    if (f === 'ignored') return st === IGNORED;
    if (f === 'no') return !!+rec.no && st !== WELLKNOWN && st !== IGNORED;
    return stageText(rec) === f;
  }
  function filteredWords() {
    var q = wbQuery.trim().toLowerCase();
    var rows = activeWords().filter(function (x) {
      var rec = x[1];
      if (!matchesFilter(rec, wbFilter)) return false;
      if (!q) return true;
      if (x[0].indexOf(q) >= 0) return true;
      var mean = defText(x[0]);
      return mean && mean.toLowerCase().indexOf(q) >= 0;
    });
    return sortWords(rows);
  }

  function wordRowHTML(w, rec) {
    var mean = defText(w) || '词典未收录';
    if (mean.length > 36) mean = mean.slice(0, 36) + '…';
    return '<div class="word-row" data-word="' + esc(w) + '">'
      + '<div class="word-main"><div class="word-en">' + esc(wordLabel(w)) + '</div>'
      + '<div class="word-cn ellipsis">' + esc(mean) + '</div></div>'
      + '<div class="word-side"><span class="stage ' + stageClass(rec) + '">'
      + esc(stageText(rec)) + '</span><div style="margin-top:4px">' + esc(dueLabel(rec)) + '</div></div>'
      + '</div>';
  }

  function renderWordbookList() {
    var rows = filteredWords();
    var shown = rows.slice(0, wbLimit);
    var html = '';
    var q = wbQuery.trim();
    if (q && !S.words[headOf(q)] && defText(q)) {
      var h = headOf(q);
      html += '<div class="dict-hit" data-word="' + esc(h) + '">'
        + '<div class="tiny muted">词典里找到 · 点开可加入生词本</div>'
        + '<div class="row" style="margin-top:6px"><div class="grow">'
        + '<div class="word-en">' + esc(h) + '</div>'
        + '<div class="word-cn">' + esc((defText(h) || '').slice(0, 80)) + '</div>'
        + '</div><span class="btn small soft">查看</span></div></div>';
    }
    if (!rows.length) {
      html += '<div class="empty">' + (q ? '没找到「' + esc(q) + '」' : '生词本还是空的')
        + '<br><span class="tiny">阅读时点一下不认识的词,它就会出现在这里</span></div>';
    } else {
      html += '<div class="word-list">' + shown.map(function (x) { return wordRowHTML(x[0], x[1]); }).join('') + '</div>';
      if (rows.length > shown.length) {
        html += '<button class="btn ghost block" style="margin-top:10px" data-act="wb-more">显示更多('
          + (rows.length - shown.length) + ')</button>';
      }
    }
    $('#wbList').innerHTML = html;
    var count = $('#wbCount');
    if (count) count.textContent = rows.length + ' 个词' + (rows.length > shown.length
      ? ' · 显示 ' + shown.length : '');
  }

  function renderWords() {
    current = 'words';
    activeTab('me');
    setTop('生词本', { back: true });
    var all = activeWords();
    var filters = [
      ['all', '全部'], ['no', '不会'], ['初遇', '初遇'], ['再见', '再见'],
      ['熟识', '熟识'], ['掌握', '掌握'], ['ignored', '已忽略']
    ];
    $('#view').innerHTML = '<div class="sticky-tools">'
      + '<div class="tiny muted" id="wbCount" style="padding:2px 2px 6px"></div>'
      + '<div class="search-wrap">'
      + '<input class="field" id="wbInput" type="search" placeholder="搜索单词或释义" value="' + esc(wbQuery) + '">'
      + ICONS.search + '</div>'
      + '<div class="chips" style="padding-top:8px">'
      + filters.map(function (f) {
        return '<button class="chip' + (wbFilter === f[0] ? ' on' : '') + '" data-wb-filter="'
          + f[0] + '">' + f[1] + '</button>';
      }).join('') + '</div></div>'
      + '<div id="wbList"></div>';
    renderWordbookList();
    var inp = $('#wbInput');
    var timer = 0;
    inp.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        wbQuery = inp.value;
        wbLimit = 160;
        renderWordbookList();
      }, 140);
    });
  }

  /* ---------------- 语境复习 ---------------- */
  function splitSentences(text) {
    text = String(text || '').trim();
    if (!text) return [];
    var out = [], start = 0, m;
    SENT_SPLIT_RE.lastIndex = 0;
    while ((m = SENT_SPLIT_RE.exec(text))) {
      var before = text.slice(Math.max(0, m.index - 12), m.index);
      if (ABBR_RE.test(before) || /[A-Z]\.$/.test(before)) continue;
      var end = m.index + (m[1] ? 1 : 0);
      var seg = text.slice(start, end).trim();
      start = SENT_SPLIT_RE.lastIndex;
      if (!seg) continue;
      var first = seg[0];
      if (out.length && (first.toLowerCase() === first || ',;:)]}'.indexOf(first) >= 0)) {
        out[out.length - 1] = (out[out.length - 1] + ' ' + seg).trim();
      } else {
        out.push(seg);
      }
    }
    var tail = text.slice(start).trim();
    if (tail) {
      if (out.length && (tail[0].toLowerCase() === tail[0] || ',;:)]}'.indexOf(tail[0]) >= 0)) {
        out[out.length - 1] = (out[out.length - 1] + ' ' + tail).trim();
      } else out.push(tail);
    }
    return out;
  }

  function allSentences() {
    if (sentences) return sentences;
    sentences = [];
    for (var i = 0; i < A.length; i++) {
      var art = A[i];
      for (var p = 0; p < art.p.length; p++) {
        var ss = splitSentences(art.p[p]);
        for (var j = 0; j < ss.length; j++) sentences.push([art.s, ss[j]]);
      }
    }
    return sentences;
  }

  function ctxPool(word) {
    var head = headOf(word);
    if (ctxCache.has(head)) return ctxCache.get(head);
    var pool = [], seen = {};
    var all = allSentences();
    for (var i = 0; i < all.length; i++) {
      var sent = all[i][1];
      var toks = sent.match(WORD_RE) || [];
      if (toks.length < 3) continue;
      var hit = false;
      for (var t = 0; t < toks.length; t++) {
        if (headOf(toks[t]) === head) { hit = true; break; }
      }
      if (!hit) continue;
      var key = all[i][0] + '\u0001' + sent;
      if (seen[key]) continue;
      seen[key] = 1;
      pool.push([all[i][0], sent]);
    }
    if (ctxCache.size > 24) ctxCache.clear();
    ctxCache.set(head, pool);
    return pool;
  }

  function ctxSource(stem) {
    var art = A_MAP[stem] || {};
    if (art.bt) {
      return '《' + art.bt + '》' + (art.cn ? ' 第 ' + art.cn + ' 章' : '');
    }
    var t = String(art.t || stem).replace(/^\d+-\d+\s*/, '');
    return t.length > 26 ? t.slice(0, 26) + '…' : t;
  }

  function ctxPara(stem, sent) {
    var art = A_MAP[stem];
    if (!art || !art.p) return 0;
    for (var k = 0; k < art.p.length; k++) {
      if (String(art.p[k]).indexOf(sent) >= 0) return k;
    }
    return 0;
  }

  function rankContexts(word, head) {
    if (revRanked && revRanked.word === head && revRanked.rev === cachesRev) return revRanked.list.slice();
    var pool = ctxPool(head);
    if (pool.length > 800) pool = sample(pool, 800);
    var scored = [];
    for (var i = 0; i < pool.length; i++) {
      var sent = pool[i][1];
      var toks = sent.match(WORD_RE) || [];
      if (toks.length < 3) continue;
      var unknown = 0, hits = 0;
      for (var t = 0; t < toks.length; t++) {
        var h = headOf(toks[t]);
        if (h === head) hits++;
        else if (!isProper(h) && !isKnown(h)) unknown++;
      }
      if (!hits) continue;
      var score = unknown + Math.abs(toks.length - 16) / 50 + Math.max(0, hits - 2) * 0.25;
      scored.push([score, sent.length, pool[i][0], sent]);
    }
    scored.sort(function (a, b) { return (a[0] - b[0]) || (a[1] - b[1]); });
    var top = scored.slice(0, 90).map(function (x) { return [x[2], x[3]]; });
    if (revRanked && revRanked.word !== head) revRanked = null;
    revRanked = { word: head, rev: cachesRev, list: top };
    return top.slice();
  }

  function sample(arr, n) {
    var a = arr.slice(), out = [];
    n = Math.min(n, a.length);
    for (var i = 0; i < n; i++) {
      var j = i + Math.floor(Math.random() * (a.length - i));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
      out.push(a[i]);
    }
    return out;
  }

  function clozeText(sent, head) {
    var out = '', pos = 0, m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(sent))) {
      if (headOf(m[0]) === head) {
        out += esc(sent.slice(pos, m.index)) + '______';
        pos = WORD_RE.lastIndex;
      }
    }
    out += esc(sent.slice(pos));
    return out;
  }
  function markedText(sent, head) {
    var out = '', pos = 0, m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(sent))) {
      if (headOf(m[0]) === head) {
        out += esc(sent.slice(pos, m.index)) + '<mark>' + esc(m[0]) + '</mark>';
        pos = WORD_RE.lastIndex;
      }
    }
    out += esc(sent.slice(pos));
    return out;
  }

  function reviewWord(word) {
    if (!word) return;
    revWord = String(word).toLowerCase().trim();
    revList = []; revBatch = []; revReveal = false; revRanked = null;
    if (S) {
      S.settings.last_review = revWord;
      var rec = S.settings.recent || (S.settings.recent = []);
      rec = rec.filter(function (x) { return x !== revWord; });
      rec.unshift(revWord);
      S.settings.recent = rec.slice(0, 10);
      save();
    }
    if (current !== 'review') {
      reviewFrom = VIEWS[current] ? current : 'me';
      go('review');
    } else { renderReview(revWord, { reroll: true }); }
    $('#view').scrollTop = 0;
  }

  function renderReview(word, opts) {
    opts = opts || {};
    current = 'review';
    activeTab('me');
    setTop('语境复习', { back: true });
    if (word !== undefined) revWord = word || '';
    if (!revWord && S.settings.last_review) revWord = S.settings.last_review;
    var scroll = opts.keepScroll ? $('#view').scrollTop : 0;
    var rec = revWord ? S.words[headOf(revWord)] : null;
    var recent = (S.settings.recent || []).filter(function (w) {
      return w !== revWord && lookup(w)[1];
    }).slice(0, 8);
    var html = '<div class="review-search">'
      + '<input class="field" id="revInput" type="search" autocapitalize="off" '
      + 'placeholder="输入一个词,回看它在全书里的句子" value="' + esc(revWord) + '">'
      + '<button class="btn primary" data-act="rev-go">复习</button></div>';
    if (recent.length) {
      html += '<div class="recent">' + recent.map(function (w) {
        return '<button class="chip" data-rev-word="' + esc(w) + '">' + esc(w) + '</button>';
      }).join('') + '</div>';
    }
    if (!revWord) {
      html += '<div class="empty">输入一个词开始<br><span class="tiny">也可以从阅读页点词,或在生词本里点一行</span></div>';
      $('#view').innerHTML = html;
      attachRevInput();
      if (opts.keepScroll) $('#view').scrollTop = scroll;
      return;
    }

    var head = headOf(revWord);
    var lk = lookup(head);
    var rov = dictOverride(head);
    var meta = [];
    if (rec) {
      var readN = +(((S.read_words || {})[head] || {}).n || 0);
      meta.push('遇到 ' + (+rec.n || 0) + ' 次');
      meta.push('读过 ' + readN + ' 篇');
      meta.push(stageText(rec));
      meta.push(dueLabel(rec));
    } else {
      meta.push('还没标过');
    }
    if (lk[1]) meta.push(isProper(head) ? '专名' : '');
    meta = meta.filter(Boolean);

    var hide = revCloze && !revReveal;
    var total = ctxPool(head).length;
    var list;
    if (!opts.reroll && revList.length && revList._word === head) {
      list = revList.slice();
    } else {
      var ranked = rankContexts(revWord, head);
      // 换一批时优先避开上一批;同一批只留几条旧的补满。
      var avoid = revList._word === head ? revBatch.slice() : [];
      list = pickBatch(ranked, avoid);
      list._word = head;
      revList = list;
      revBatch = list.slice();
    }

    var revPhon = hide ? '' : phonText((rov && rov.phon) || lk[0]);
    html += '<div class="rev-head">'
      + '<div class="rev-word" data-word="' + esc(head) + '">'
      + (hide ? '＿＿＿＿＿＿' : esc(wordLabel(head)))
      + (revPhon ? ' <span class="rev-phon">' + esc(revPhon) + '</span>' : '')
      + '</div>'
      + '<div class="rev-mean">' + (hide ? '先想想它的意思,点句子看答案'
        : esc(defText(head) || (rec ? '词典未收录' : '这个词还没在词典里'))) + '</div>'
      + '<div class="rev-meta">' + meta.map(function (m) { return '<span>' + esc(m) + '</span>'; }).join('') + '</div>'
      + '</div>'
      + '<div class="rev-tools">'
      + '<button class="btn small soft" data-act="rev-reroll">随机切换</button>'
      + '<label class="switch"><input type="checkbox" id="revCloze"' + (revCloze ? ' checked' : '')
      + '><i></i>挖空自测</label>'
      + '</div>'
      + '<div class="rev-marks">'
      + '<button class="btn small danger" data-act="rev-no">我不会</button>'
      + '<button class="btn ok small" data-act="rev-known">已掌握</button>'
      + '</div>'
      + '<div class="filter-note">语境 ' + list.length + ' 条 · 共 ' + total + ' 句'
      + (total > list.length ? ' · 点「随机切换」换一批' : ' · 已全部显示') + '</div>';

    if (!list.length) {
      html += '<div class="empty">语料里暂时找不到这个词的句子<br><span class="tiny">词典里可能有它,但读过的书里还没出现过</span></div>';
    } else {
      for (var i = 0; i < list.length; i++) {
        var stem = list[i][0], sent = list[i][1];
        html += '<div class="ctx" data-ctx="1" data-stem="' + esc(stem)
          + '" data-para="' + ctxPara(stem, sent) + '">'
          + '<div class="ctx-src">' + esc(ctxSource(stem)) + '<span class="ctx-side">'
          + (revCloze ? '' : '<button class="ctx-tr" data-ctx-tr="' + i + '">译</button>')
          + '<span class="ctx-go">原文 ›</span></span></div>'
          + '<div class="ctx-text">' + (hide ? clozeText(sent, head) : markedText(sent, head)) + '</div>'
          + '<div class="ctx-zh" data-ctx-zh hidden></div>'
          + '</div>';
      }
    }
    if (hide) html += '<div class="reveal-hint">点任意句子显示答案</div>';

    $('#view').innerHTML = html;
    attachRevInput();
    var sw = $('#revCloze');
    if (sw) sw.addEventListener('change', function () {
      revCloze = sw.checked;
      revReveal = false;
      renderReview(revWord, { keep: true, keepScroll: true });
    });
    if (opts.keepScroll) $('#view').scrollTop = scroll;
  }

  function attachRevInput() {
    var inp = $('#revInput');
    if (!inp) return;
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        reviewWord(inp.value.trim());
      }
    });
  }

  function pickBatch(ranked, avoid) {
    var out;
    if (avoid && avoid.length) {
      var keys = {};
      avoid.forEach(function (x) { keys[x[0] + '\u0001' + x[1]] = 1; });
      var fresh = ranked.filter(function (x) { return !keys[x[0] + '\u0001' + x[1]]; });
      var old = ranked.filter(function (x) { return keys[x[0] + '\u0001' + x[1]]; });
      if (fresh.length >= REVIEW_CONTEXTS) {
        out = sample(fresh, REVIEW_CONTEXTS);
      } else {
        out = fresh.concat(sample(old, Math.min(REVIEW_CONTEXTS - fresh.length, old.length)));
        shuffle(out);
      }
    } else {
      out = sample(ranked, REVIEW_CONTEXTS);
    }
    return out;
  }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ---------------- 复习卡片 ---------------- */
  function cloneRec(head) {
    var r = S.words[head];
    return r ? JSON.parse(JSON.stringify(r)) : null;
  }
  // 撤回 = 把判断前拍下的词条快照整个放回去,不去做 SRS 的逆运算。
  function putRec(head, snap) {
    if (snap) S.words[head] = JSON.parse(JSON.stringify(snap));
    else delete S.words[head];
    dropCaches();
    saveNow();
  }
  function dueQueue(noFirst) {
    var today = parseDay(todayKey());
    var rows = activeWords().filter(function (x) {
      var st = +x[1].st || 0;
      if (st === IGNORED || st === WELLKNOWN) return false;
      return parseDay(x[1].due, new Date(0)).getTime() <= today.getTime();
    });
    rows.sort(function (a, b) {
      if (noFirst) {
        var na = +a[1].no ? 1 : 0, nb = +b[1].no ? 1 : 0;
        if (na !== nb) return nb - na;
      }
      var da = parseDay(a[1].due, new Date(0)).getTime();
      var db = parseDay(b[1].due, new Date(0)).getTime();
      if (da !== db) return da - db;
      return (+b[1].chk || 0) - (+a[1].chk || 0);
    });
    return rows.map(function (x) { return x[0]; });
  }

  // 卡面上只放最近遇到的那一句,其余句子交给语境复习页逐句翻,避免一次打多个请求。
  function cardContexts(head) {
    var list = rankContexts(head, head);
    var order = {}, h = S.history || [];
    for (var i = 0; i < h.length; i++) if (order[h[i].s] === undefined) order[h[i].s] = i;
    var idx = [];
    for (var j = 0; j < list.length; j++) idx.push(j);
    idx.sort(function (a, b) {
      var ra = order[list[a][0]], rb = order[list[b][0]];
      ra = ra === undefined ? 9999 : ra;
      rb = rb === undefined ? 9999 : rb;
      return ra !== rb ? ra - rb : a - b;
    });
    return idx.slice(0, 1).map(function (k) { return list[k]; });
  }

  function fetchOneSentence(sent, cb) {
    if (scCache[sent]) { cb(scCache[sent]); return; }
    translateChunk([sent], 0, 1).then(function (arr) {
      var zh = String((arr && arr[0]) || '').trim();
      if (zh) keepSentTrans(sent, zh);
      cb(zh);
    }).catch(function () { cb(''); });
  }
  // 一个卡片的句子一次批量发出;429/失败就停,只留一行提示,不自动重试。
  function fetchSentences(sents) {
    var todo = [];
    for (var i = 0; i < sents.length; i++) {
      var s = sents[i][1];
      if (scCache[s] || todo.indexOf(s) >= 0) continue;
      todo.push(s);
    }
    if (!todo.length || fc.trBusy) return;
    fc.trBusy = true;
    translateChunk(todo, 0, 1).then(function (arr) {
      for (var j = 0; j < todo.length; j++) {
        if (arr && arr[j]) keepSentTrans(todo[j], String(arr[j]).trim());
      }
    }).catch(function () {}).then(function () {
      fc.trBusy = false;
      if (current === 'flash' && fc.phase !== 'list') renderFlash();
    });
  }

  function fcCount() {
    var y = 0, n = 0;
    for (var k in fc.judge) {
      if (fc.judge[k] === 'y') y++;
      else if (fc.judge[k] === 'n') n++;
    }
    return { y: y, n: n };
  }
  function fcOpenCard() {
    fc.sents = cardContexts(fc.queue[fc.i]);
    renderFlash();
  }
  /* 复习页的纵向进出。和 playViewAnim 一样只挂 @keyframes、播完即摘:
     #view 的 transform 平时留给 swap 手势,类留着会挡住 tab 横滑。 */
  var fcAnimTimer = 0;
  var fcEndTimer = 0;
  function fcPlayAnim(cls, ms) {
    var v = $('#view');
    if (!v) return;
    clearTimeout(fcAnimTimer);
    v.classList.remove('fc-rise', 'fc-fall');
    void v.offsetWidth;              // 强制回流,同一段动画连播两次才重放
    v.classList.add(cls);
    fcAnimTimer = setTimeout(function () {
      fcAnimTimer = 0;
      var el = $('#view');
      if (el) el.classList.remove('fc-rise', 'fc-fall');
    }, ms);
  }
  function fcStart() {
    var q = dueQueue(!!S.settings.review_no_first);
    if (!q.length) { notify('今天没有到期的词'); return; }
    fc.queue = q; fc.i = 0; fc.judge = {}; fc.snap0 = null; fc.snapYes = null;
    fc.phase = 'ask';
    fcOpenCard();
    // 卡片从下方升起:复习是「进入」下一件事,和停在主页区分开。
    fcPlayAnim('fc-rise', 280);
  }
  function fcNext() {
    fc.snap0 = null; fc.snapYes = null;
    if (fc.i + 1 >= fc.queue.length) { fc.phase = 'done'; fc.sents = []; renderFlash(); return; }
    fc.i++;
    fc.phase = 'ask';
    fcOpenCard();
  }
  function fcEnd() {
    // 先让当前内容沉下去,落完再换回今日 —— 和开始的升起对称。
    // 落下途中重复点「结束」不再叠加,免得 timer 越排越多。
    if (fcEndTimer) return;
    fcPlayAnim('fc-fall', 200);
    fcEndTimer = setTimeout(function () {
      fcEndTimer = 0;
      // 不管切没切走都要摘类:fc-fall 是 both,留在 #view 上会让
      // 紧接着渲染的任何页面都停在 opacity:0。
      clearTimeout(fcAnimTimer);
      fcAnimTimer = 0;
      var v = $('#view');
      if (v) v.classList.remove('fc-rise', 'fc-fall');
      fc.phase = 'list'; fc.sents = []; fc.queue = []; fc.i = 0;
      // 落下途中切到别的 tab 了:状态照样清掉,但别把人拉回复习页。
      if (current === 'flash') renderFlash();
    }, 190);
  }
  function fcJudge(pass) {
    var head = fc.queue[fc.i];
    if (!head) return;
    fc.snap0 = cloneRec(head);
    if (pass) {
      onPass(S.words[head] || ensureWord(head));
      fc.snapYes = cloneRec(head);
      fc.judge[fc.i] = 'y';
      fc.phase = 'yes';
    } else {
      markUnknown(head);
      fc.judge[fc.i] = 'n';
      fc.phase = 'no';
    }
    saveNow();
    renderFlash();
    fetchSentences(fc.sents);
  }
  function fcMistake() {
    var head = fc.queue[fc.i];
    if (!head) return;
    putRec(head, fc.snap0);
    markUnknown(head);
    fc.judge[fc.i] = 'n';
    fc.phase = 'mistake';
    renderFlash();
  }
  function fcUndo() {
    var head = fc.queue[fc.i];
    if (!head) return;
    putRec(head, fc.snapYes);
    fc.judge[fc.i] = 'y';
    fc.phase = 'yes';
    renderFlash();
  }

  function fcSentZh(i) {
    var zh = scCache[fc.sents[i][1]];
    if (zh) return esc(zh);
    if (fc.trBusy) return '<span class="faint">翻译中…</span>';
    return '<span class="faint">译文没取到,稍后再试</span>';
  }
  function fcRevealHTML(head) {
    return '<div class="fc-reveal"><div class="fc-mean">'
      + esc(defText(head) || (wordRec(head) ? '词典未收录' : '这个词还没进词典'))
      + '</div></div>';
  }
  function fcNextLabel() {
    return fc.i + 1 >= fc.queue.length ? '看完小结' : '下一词';
  }
  function fcJudgeHTML() {
    if (fc.phase === 'ask') {
      return '<div class="fc-judge">'
        + '<button class="btn ok" data-act="fc-pass">认识</button>'
        + '<button class="btn danger" data-act="fc-fail">不认识</button></div>';
    }
    // 「记错了」改判后也要能继续:两个灰按钮只作状态,下一词必须跟着出现,否则卡在这。
    if (fc.phase === 'mistake') {
      return '<div class="fc-judge">'
        + '<button class="btn ok faded" disabled>认识</button>'
        + '<button class="btn danger faded" disabled>已记为不会</button>'
        + '<button class="btn primary block" data-act="fc-next">' + fcNextLabel() + '</button></div>'
        + '<div class="fc-links"><button class="btn small ghost" data-act="fc-undo">撤回</button></div>';
    }
    return '<div class="fc-judge"><button class="btn primary block" data-act="fc-next">'
      + fcNextLabel() + '</button></div>'
      + (fc.phase === 'yes'
        ? '<div class="fc-links"><button class="btn small ghost" data-act="fc-mistake">记错了</button></div>'
        : '');
  }
  function fcCardHTML() {
    var head = fc.queue[fc.i];
    var rec = wordRec(head);
    var lk = lookup(head);
    var judged = fc.phase !== 'ask';
    var badges = '<span class="badge">' + esc(dueLabel(rec || {})) + '</span>';
    if (rec && +rec.no) badges += '<span class="badge red">不会</span>';
    var fcPhon = phonText((dictOverride(head) || {}).phon || lk[0]);
    var html = '<div class="fc-bar"><span class="fc-pos">' + (fc.i + 1) + ' / ' + fc.queue.length
      + '</span><button class="btn small ghost" data-act="fc-home">结束</button></div>';
    html += '<div class="card fc-card">'
      + '<div class="rev-word"' + (judged ? ' data-word="' + esc(head) + '"' : '') + '>' + esc(wordLabel(head))
      + (judged && fcPhon ? ' <span class="rev-phon">' + esc(fcPhon) + '</span>' : '')
      + '</div><div class="rev-meta">' + badges + '</div>';
    if (judged) html += fcRevealHTML(head);
    html += '</div>';
    if (fc.sents.length) {
      // 判定之后例句才可点:点正文看这个词的卡,右上角「原文 ›」跳回那句话。
      // 两个入口都带自己的 data 属性,靠 closest 分派,互不抢。
      html += '<div class="fc-sents">' + fc.sents.map(function (x, i) {
        return '<div class="fc-sent"' + (judged ? ' data-fc-sent="' + i + '"' : '')
          + '><div class="ctx-text">' + markedText(x[1], head) + '</div>'
          + (judged
            ? '<div class="fc-zh">' + fcSentZh(i) + '</div>'
              + '<button class="fc-go" data-fc-go="' + i + '">原文 ›</button>'
            : '')
          + '</div>';
      }).join('') + '</div>'
        + '<div class="fc-links"><button class="btn small ghost" data-act="fc-more">更多原句</button></div>';
    } else {
      html += '<div class="filter-note">这本书里还没遇到过这个词的句子</div>';
    }
    html += fcJudgeHTML();
    return html;
  }
  // 复习卡例句:点正文开单词卡(不计数),点「原文」跳回那篇文章的那一段。
  function fcSentOpen(i) {
    if (fc.phase === 'ask') return;
    var row = fc.sents[i];
    var head = fc.queue[fc.i];
    if (!row || !head) return;
    openWord(head, false, row[1]);
  }
  function fcSentGo(i) {
    var row = fc.sents[i];
    var head = fc.queue[fc.i];
    if (!row || !head) return;
    openReaderAt(row[0], ctxPara(row[0], row[1]), head);
  }
  // 复习页下面铺一排生词:按生词本顺序取前 12 个,不够就少铺,点开走原来的单词浮层。
  function fcScatterHTML() {
    var rows = sortWords(activeWords()).slice(0, 12);
    if (!rows.length) return '';
    return '<div class="card fc-scatter"><div class="card-title">生词速览</div>'
      + '<div class="scatter-grid">' + rows.map(function (x) {
        return '<button class="scatter-w" data-word="' + esc(x[0]) + '">' + esc(wordLabel(x[0])) + '</button>';
      }).join('') + '</div>'
      + '<div class="set-foot">按到期先后挑的 ' + rows.length + ' 个 · 点一下看释义</div></div>';
  }
  /* ---------------- 复习主页搜词 ---------------- */
  // 固定短语/专名的展示写法:字典键一律小写,只在界面按原名大小写显示。
  var WORD_LABEL = {
    "arknights": "Arknights",
    "arknights: endfield": "Arknights: Endfield"
  };
  function wordLabel(w) {
    var k = String(w || "").toLowerCase();
    // WORD_LABEL 也是普通对象,直接索引会把 constructor 取成 Object 函数,
    // 渲染出来就是「function Object() { [native code] }」。
    return (Object.prototype.hasOwnProperty.call(WORD_LABEL, k) ? WORD_LABEL[k] : '') || w;
  }
  // 候选池 = 生词本 ∪ 内置词典 ∪ 重译过的词。每次重绘复习主页重建一次,
  // 这样刚查过的词马上能搜到;建池只是一次 3 万多次字符串比较,不值得做缓存失效逻辑。
  var fcPoolCache = null;
  var fcZhCache = null;                 // 中文搜释义用的 [词, 释义] 表,首次中文查询时建一次
  var fcSearch = { q: '', list: [] };   // q 保留用户原样输入(大小写不动),list 是当前结果
  function isZhQuery(q) { return /[\u4e00-\u9fff]/.test(String(q || '')); }
  function fcPool() {
    if (fcPoolCache) return fcPoolCache;
    // 去重表加 '#' 前缀:词典里确实有 constructor 这种词,裸键会被原型链当成「已存在」丢掉。
    var seen = {}, out = [], k;
    function add(w) {
      w = String(w || '').toLowerCase();
      if (!w || seen['#' + w]) return;
      seen['#' + w] = 1;
      out.push(w);
    }
    for (k in S.words) add(k);
    for (k in DICT) add(k);
    // scCache 里整句译文是拿句子做键的,只有 'dw:' / 'w:' 开头的才是重译过的词。
    for (k in scCache) {
      if (k.indexOf('dw:') === 0) add(k.slice(3));
      else if (k.indexOf('w:') === 0) add(k.slice(2));
    }
    fcPoolCache = out;
    return out;
  }
  // 中文结果的排序权重:考试档和词频取「更靠后」的那个。
  // 这样 abandon(gk,词频 14530) 排在 disclaimer(gre,1558) 前面,
  // 而 disease(zk,1351) 和 ill(xx,4320) 同档,再看释义长短决胜。
  function zhScore(rank, tags) {
    var t = 9, ts = String(tags || '').split(/\s+/);
    for (var i = 0; i < ts.length; i++) {
      var k = TIER_ORDER.indexOf(ts[i]);
      if (k >= 0 && k < t) t = k;
    }
    var band = rank ? Math.min(9, Math.floor(rank / 3000)) : 9;
    return t > band ? t : band;
  }
  // 中文搜词:反向查释义。词典是静态的,表只建一次;6 万多条 indexOf 真机也跟手。
  function fcZhPool() {
    if (fcZhCache) return fcZhCache;
    var out = [];
    for (var k in DICT) {
      var v = DICT[k];
      if (v && typeof v === 'object' && v[1]) {
        out.push([k, String(v[1]), +v[2] || 0, zhScore(+v[2] || 0, v[3])]);
      }
    }
    fcZhCache = out;
    return out;
  }
  // 命中位置在释义里是不是一个完整义项:是的话记下它是第几个义项(越靠前越相关)。
  // 边界要认空白:首条义项前面是词性前缀 "vt. ",不是分隔符。
  var ZH_SEP_RE = /[，,；;、\/]/;
  var ZH_EDGE_RE = /[\s，,；;、\/：:]/;
  function zhItemIndex(def, at, len) {
    if (at > 0 && !ZH_EDGE_RE.test(def.charAt(at - 1))) return 999;
    var tail = at + len < def.length ? def.charAt(at + len) : '';
    // 「美丽的/疾病地」这类派生后缀仍算义项开头,不要因为多一个字就判成嵌在词中。
    if (tail && !ZH_EDGE_RE.test(tail) && '的地得性化者们子儿'.indexOf(tail) < 0) return 999;
    var n = 0;
    for (var i = 0; i < at; i++) if (ZH_SEP_RE.test(def.charAt(i))) n++;
    return n > 99 ? 99 : n;
  }
  function fcZhRun(q) {
    var pool = fcZhPool(), hits = [];
    for (var i = 0; i < pool.length; i++) {
      var at = pool[i][1].indexOf(q);
      if (at >= 0) {
        hits.push([pool[i][0], at, pool[i][1].length, pool[i][2], pool[i][3],
                   zhItemIndex(pool[i][1], at, q.length)]);
      }
    }
    // 完整义项命中的靠前;同一档里先看「考试档/词频」权重,再看词频、释义长短。
    hits.sort(function (a, b) {
      if (a[5] !== b[5]) return a[5] - b[5];
      if (a[4] !== b[4]) return a[4] - b[4];
      var ra = a[3] || 1e9, rb = b[3] || 1e9;
      if (ra !== rb) return ra - rb;
      var ea = a[1] === 0 ? 0 : 1, eb = b[1] === 0 ? 0 : 1;
      if (ea !== eb) return ea - eb;
      if (a[2] !== b[2]) return a[2] - b[2];
      if (a[0].length !== b[0].length) return a[0].length - b[0].length;
      return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0);
    });
    var out = [];
    for (var j = 0; j < hits.length; j++) out.push(hits[j][0]);
    return out;
  }
  // 前缀匹配,不防抖:3 万条同步过滤在真机上也是跟手的。
  function fcSearchRun(raw) {
    var q = String(raw || '').toLowerCase();
    if (!q) return [];
    if (isZhQuery(q)) return fcZhRun(q);
    var pool = fcPool(), hits = [];
    function prefix(s) {
      var out = [];
      for (var i = 0; i < pool.length; i++) {
        var w = pool[i];
        if (w.indexOf(s) === 0) { out.push(w); continue; }
        // 短语条目(Arknights: Endfield)单独一个键,按其中任一词也能搜到。
        if (w.indexOf(" ") >= 0 || w.indexOf(":") >= 0) {
          var parts = w.split(/[\s:]+/);
          for (var j = 0; j < parts.length; j++) {
            if (parts[j] && parts[j].indexOf(s) === 0) { out.push(w); break; }
          }
        }
      }
      return out;
    }
    hits = prefix(q);
    // 带重音的输入(cliché/café)词典里是折成 ASCII 的,原样查不到再折一次。
    if (!hits.length) {
      var fq = foldAccents(q);
      if (fq !== q) { q = fq; hits = prefix(fq); }
    }
    hits.sort(function (a, b) {
      var ea = a === q ? 0 : 1, eb = b === q ? 0 : 1;
      if (ea !== eb) return ea - eb;                     // 完全匹配永远第一
      // 固定短语/专名(Arknights / Arknights: Endfield)只要整键以查询开头就排在普通前缀词前,
      // 否则会被 arkansas 这类词挤到后面。
      var pa = (own(WORD_LABEL, a) && a.indexOf(q) === 0) ? 0 : 1;
      var pb = (own(WORD_LABEL, b) && b.indexOf(q) === 0) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      var wa = S.words[a] ? 0 : 1, wb = S.words[b] ? 0 : 1;
      if (wa !== wb) return wa - wb;                     // 生词本里的靠前
      var ra = rankOf(a) || 999999, rb = rankOf(b) || 999999;
      if (ra !== rb) return ra - rb;                     // 词频序号小的靠前
      if (a.length !== b.length) return a.length - b.length;
      return a < b ? -1 : (a > b ? 1 : 0);
    });
    return hits;
  }
  // 建议行那半行浅色中文:释义只取第一段,顺手去掉 [计] [医] 这类领域标记。
  // 中文查询时截命中位置附近的一段,免得命中的义项在第二行看不到。
  function fcSearchDef(w) {
    var t = String(defText(w) || lookup(w)[1] || '');
    var q = fcSearch.q;
    if (isZhQuery(q)) {
      var at = t.indexOf(q);
      if (at >= 0) {
        var start = Math.max(0, at - 6), end = Math.min(t.length, at + q.length + 10);
        var seg = t.slice(start, end).replace(/[\/;；\n]+/g, ' ').replace(/\s+/g, ' ').trim();
        return (start > 0 ? '…' : '') + seg + (end < t.length ? '…' : '');
      }
    }
    t = t.split(/[\/;；\n]/)[0];
    t = t.replace(/^\s*(\[[^\]]*\]\s*)+/, '').trim();
    if (t.length > 18) t = t.slice(0, 18) + '…';
    return t || '词典未收录';
  }
  function fcSugHTML() {
    if (!fcSearch.q) return '';
    var hits = fcSearch.list;
    var zh = isZhQuery(fcSearch.q);
    if (!hits.length) return '<div class="fc-sug-none">' + (zh ? '没有找到匹配的词' : '没有匹配的单词') + '</div>';
    var rows = hits.slice(0, 12), html = '';
    for (var i = 0; i < rows.length; i++) {
      var w = rows[i], rec = S.words[w];
      html += '<button class="fc-sug-row" data-fc-word="' + esc(w) + '">'
        + '<span class="fc-sug-w">' + esc(wordLabel(w)) + '</span>'
        + '<span class="fc-sug-d">' + esc(fcSearchDef(w)) + '</span>'
        + (rec ? '<span class="fc-sug-tag">'
            + (+rec.st === WELLKNOWN ? '已学' : '生词') + '</span>' : '')
        + '</button>';
    }
    if (hits.length > 12) html += '<div class="fc-sug-more">还有 ' + (hits.length - 12) + ' 个</div>';
    return html;
  }
  function fcSearchHTML() {
    fcPoolCache = null;                  // 每次重绘复习主页重建候选池
    fcSearch.list = fcSearchRun(fcSearch.q);
    var sug = fcSugHTML();
    return '<div class="card fc-search">'
      + '<input class="fc-search-q" id="fcSearchQ" type="search" value="' + esc(fcSearch.q) + '"'
      + ' placeholder="搜单词或中文释义" autocomplete="off" autocorrect="off"'
      + ' autocapitalize="off" spellcheck="false">'
      + '<div class="fc-sug" id="fcSug"' + (sug ? '' : ' hidden') + '>' + sug + '</div>'
      + '</div>';
  }
  // 只换建议容器,不重绘整页:renderFlash() 会把输入框一起换掉,焦点和光标就丢了。
  function paintFcSug() {
    var box = $('#fcSug');
    if (!box) return;
    var sug = fcSugHTML();
    box.innerHTML = sug;
    if (sug) box.removeAttribute('hidden');
    else box.setAttribute('hidden', '');
  }
  function fcListHTML() {
    var due = dueQueue(true);
    var search = fcSearchHTML();         // 搜索卡常驻,今天没到期也能查词
    if (!due.length) {
      return search + '<div class="empty">今天没有到期的词<br><span class="tiny">'
        + '读文章时点几个不认识的词,到期后会出现在这里</span></div>' + fcScatterHTML();
    }
    var noN = due.filter(function (w) { return !!+ (wordRec(w) || {}).no; }).length;
    return search + '<div class="card fc-hero">'
      + '<div class="fc-count">今天到期 <b>' + due.length + '</b> 个词</div>'
      + (noN ? '<div class="fc-sub tiny">' + noN + ' 个标过不会</div>' : '')
      + '<div class="fc-go">'
      + '<label class="switch"><input type="checkbox" id="fcNoFirst"'
      + (S.settings.review_no_first !== false ? ' checked' : '') + '><i></i>不会优先</label>'
      + '<button class="btn primary" data-act="fc-start">开始</button></div></div>' + fcScatterHTML();
  }
  function fcDoneHTML() {
    var c = fcCount();
    return '<div class="card fc-hero"><div class="fc-count">这一轮复习完了</div>'
      + '<div class="fc-sum"><span>认识 <b>' + c.y + '</b></span>'
      + '<span>不认识 <b>' + c.n + '</b></span></div>'
      + '<button class="btn primary block" data-act="fc-home">回到今日</button></div>';
  }
  function renderFlash() {
    current = 'flash';
    activeTab('flash');
    setTop('复习', {});
    // 换内容前把复习页的进出动画收干净:fc-fall 是 both,类留在 #view 上
    // 新内容会继承 opacity:0,整页直接看不见。
    clearTimeout(fcAnimTimer);
    fcAnimTimer = 0;
    clearTimeout(fcEndTimer);
    fcEndTimer = 0;
    var viewBox = $('#view');
    if (viewBox) viewBox.classList.remove('fc-rise', 'fc-fall');
    var html = fc.phase === 'ask' || fc.phase === 'yes' || fc.phase === 'no'
      || fc.phase === 'mistake' ? fcCardHTML()
      : fc.phase === 'done' ? fcDoneHTML() : fcListHTML();
    $('#view').innerHTML = html;
    var sw = $('#fcNoFirst');
    if (sw) sw.addEventListener('change', function () {
      S.settings.review_no_first = sw.checked;
      saveNow();
      renderFlash();
    });
    var q = $('#fcSearchQ');
    if (q) {
      // 每次输入只重算建议,不碰整页,输入框的焦点和光标位置都留着。
      q.addEventListener('input', function () {
        fcSearch.q = String(q.value || '').trim();
        fcSearch.list = fcSearchRun(fcSearch.q);
        paintFcSug();
      });
      // 回车:排序已保证完全匹配排第一,有就开它,没有就开第一条。
      q.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.keyCode !== 13) return;
        e.preventDefault();
        var w = fcSearch.q ? fcSearch.list[0] : '';
        if (!w) return;
        q.blur();
        openWord(w, false, '');
      });
    }
  }

  function toggleCtxZh(ctx, i) {
    var box = ctx.querySelector('[data-ctx-zh]');
    if (!box) return;
    if (!box.hidden) { box.hidden = true; return; }
    var row = revList[i];
    if (!row) return;
    box.hidden = false;
    box.textContent = scCache[row[1]] || '';
    if (box.textContent) return;
    box.textContent = '翻译中…';
    fetchOneSentence(row[1], function (zh) {
      if (!box.parentNode) return;
      box.textContent = zh || '译文没取到,稍后再试';
    });
  }

  /* ---------------- 历史 ---------------- */
  function renderHistory() {
    current = 'history';
    activeTab('me');
    setTop('历史记录', {
      back: true,
      action: S.history.length ? { label: '清空', fn: clearHistory } : null
    });
    var rows = S.history.filter(function (x) { return x && A_MAP[x.s]; });
    if (!rows.length) {
      $('#view').innerHTML = '<div class="empty">还没有阅读记录<br>'
        + '<span class="tiny">打开过的文章会出现在这里,最多留 ' + HISTORY_MAX + ' 篇</span></div>';
      return;
    }
    $('#view').innerHTML = '<div class="art-list">' + rows.map(function (x) {
      var a = A_MAP[x.s];
      var st = S.articles[x.s] || {};
      var meta = '<span>' + timeLabel(x.at) + '</span>'
        + '<span>' + levelName(a.l) + '</span><span>' + fmt(a.w) + ' 词</span>';
      if (st.done) meta += '<span class="art-done">已读完</span>';
      if (isFav(x.s)) meta += '<span class="fav-mark">★ 已收藏</span>';
      return '<div class="art" data-stem="' + esc(x.s) + '">'
        + '<div class="art-main"><div class="art-title">' + esc(artTitle(a)) + '</div>'
        + '<div class="art-meta">' + meta + '</div></div>'
        + '<div class="art-side">打开</div></div>';
    }).join('') + '</div>';
  }

  /* ---------------- 已读完 ---------------- */
  // 读完日期优先用 articles[stem].done_at;老数据没这个字段就拿历史里的时间兜底。
  function renderDone() {
    current = 'done';
    activeTab('me');
    setTop('已读完', { back: true });
    var histAt = {};
    for (var h = 0; h < S.history.length; h++) {
      var item = S.history[h];
      if (item && item.s) histAt[item.s] = +item.at || 0;
    }
    var rows = [];
    for (var stem in S.articles) {
      var st = S.articles[stem];
      if (!st || !st.done || !A_MAP[stem]) continue;
      var day = String(st.done_at || '').slice(0, 10);
      var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
      var ts = dm ? new Date(+dm[1], +dm[2] - 1, +dm[3]).getTime() : 0;
      if (!(ts > 0)) ts = histAt[stem] || 0;
      rows.push({ s: stem, day: day, ts: ts });
    }
    // 新的在前;两样时间都没有的排最后。
    rows.sort(function (x, y) { return y.ts - x.ts; });
    if (!rows.length) {
      $('#view').innerHTML = '<div class="empty">还没有读完的文章<br>'
        + '<span class="tiny">把文章读到最后一屏，会自动记一篇</span></div>';
      return;
    }
    $('#view').innerHTML = '<div class="art-list">' + rows.map(function (x) {
      var a = A_MAP[x.s];
      var when = x.day || (x.ts ? timeLabel(x.ts) : '');
      var meta = (when ? '<span>' + esc(when) + '</span>' : '')
        + '<span>' + levelName(a.l) + '</span><span>' + fmt(a.w) + ' 词</span>'
        + '<span class="art-done">已读完</span>';
      return '<div class="art" data-stem="' + esc(x.s) + '">'
        + '<div class="art-main"><div class="art-title">' + esc(artTitle(a)) + '</div>'
        + '<div class="art-meta">' + meta + '</div></div>'
        + '<div class="art-side">打开</div></div>';
    }).join('') + '</div>';
  }

  function clearHistory() {
    askConfirm('清空历史记录', '只清空最近读过的文章列表,生词、收藏和阅读进度都不动。', true, function () {
      S.history = [];
      saveNow();
      renderHistory();
      notify('历史记录已清空');
    });
  }

  /* ---------------- 收藏夹 ---------------- */
  function favRowsIn(id) {
    return Object.keys(S.favorites.map).filter(function (stem) {
      return S.favorites.map[stem] === id && A_MAP[stem];
    });
  }

  function favRowHTML(stem) {
    var a = A_MAP[stem];
    var st = S.articles[stem] || {};
    var meta = '<span>' + levelName(a.l) + '</span><span>' + fmt(a.w) + ' 词</span>';
    meta += verdictHTML(a, false);
    if (st.done) meta += '<span class="art-done">已读完</span>';
    return '<div class="art" data-stem="' + esc(stem) + '">'
      + '<div class="art-main"><div class="art-title">' + esc(artTitle(a)) + '</div>'
      + '<div class="art-meta">' + meta + '</div></div>'
      + '<div class="art-side"><div class="fav-acts">'
      + '<button class="btn small ghost" data-fav-move="' + esc(stem) + '">移动</button>'
      + '<button class="btn small ghost" data-fav-remove="' + esc(stem) + '">移除</button>'
      + '</div></div></div>';
  }

  function favTabsHTML() {
    return '<div class="fav-tabs">'
      + '<button class="fav-tab' + (favTab === 'arts' ? ' on' : '') + '" data-favtab="arts">文章</button>'
      + '<button class="fav-tab' + (favTab === 'mk' ? ' on' : '') + '" data-favtab="mk">划线</button>'
      + '</div>';
  }

  function renderFavorites() {
    current = 'favs';
    activeTab('me');
    setTop('收藏夹', {
      back: true,
      action: favTab === 'arts' ? { label: '＋', fn: newFolderSheet } : null
    });
    var html = favTabsHTML();
    var html = favTabsHTML();
    if (favTab === 'mk') {
      html += marksTabHTML();
    } else {
      favFolders().forEach(function (f) {
        var rows = favRowsIn(f.id);
        html += '<div class="card fav-folder">'
          + '<div class="fav-head"><div class="grow"><b>' + esc(f.name) + '</b>'
          + '<span class="tiny muted"> · ' + rows.length + ' 篇</span></div>'
          + '<button class="btn small ghost" data-fav-rename="' + esc(f.id) + '">重命名</button>'
          + '<button class="btn small ghost" data-fav-delfolder="' + esc(f.id) + '">删除</button></div>';
        html += rows.length
          ? '<div class="art-list">' + rows.map(favRowHTML).join('') + '</div>'
          : '<div class="fav-empty">这个收藏夹还是空的<br><span class="tiny">在阅读页点右上角的星标加入</span></div>';
        html += '</div>';
      });
      if (!favCount()) {
        html += '<div class="set-foot">每篇文章只属于一个收藏夹;点右上角「＋」可以新建。</div>';
      }
    }
    $('#view').innerHTML = html;
    $('#view').scrollTop = favScroll[favTab] || 0;
  }

  function newFolderSheet() {
    folderNameSheet({
      title: '新建收藏夹', value: '', ok: '创建',
      onOk: function (name) {
        S.favorites.folders.push({ id: 'f' + Date.now().toString(36), name: name });
        saveNow();
        renderFavorites();
        notify('已新建「' + name + '」');
      }
    });
  }

  function renameFolderSheet(id) {
    folderNameSheet({
      title: '重命名收藏夹', value: favFolderName(id), ok: '保存',
      onOk: function (name) {
        favFolders().forEach(function (f) { if (f.id === id) f.name = name; });
        saveNow();
        renderFavorites();
        notify('已改名为「' + name + '」');
      }
    });
  }

  function folderNameSheet(opts) {
    sheetDirty = false;
    showSheet('<div class="sheet-grip"></div>'
      + '<div class="confirm-title">' + esc(opts.title) + '</div>'
      + '<input class="field" id="folderNameInput" maxlength="20" placeholder="收藏夹名字" value="'
      + esc(opts.value || '') + '">'
      + '<div class="sheet-actions">'
      + '<button class="btn ghost" data-close="1">取消</button>'
      + '<button class="btn primary" data-folder-ok="1">' + esc(opts.ok || '保存') + '</button></div>');
    $('#sheet')._folderOk = opts.onOk;
  }

  function deleteFolder(id) {
    var name = favFolderName(id);
    var n = favRowsIn(id).length;
    askConfirm('删除收藏夹「' + name + '」',
      (n ? '夹里的 ' + n + ' 篇收藏会一起移除。' : '')
      + '文章本身和阅读进度都不受影响。确定删除这个收藏夹吗?',
      true, function () {
        S.favorites.folders = favFolders().filter(function (f) { return f.id !== id; });
        Object.keys(S.favorites.map).forEach(function (stem) {
          if (S.favorites.map[stem] === id) delete S.favorites.map[stem];
        });
        if (!favFolders().length) favFolders().push({ id: DEFAULT_FAV.id, name: DEFAULT_FAV.name });
        saveNow();
        renderFavorites();
        notify('已删除「' + name + '」');
      });
  }

  function removeFav(stem) {
    if (!isFav(stem)) return;
    delete S.favorites.map[stem];
    saveNow();
    renderFavorites();
    notify('已取消收藏');
  }

  function moveFavSheet(stem) {
    var cur = favFolderOf(stem);
    sheetDirty = false;
    showSheet('<div class="sheet-grip"></div><div class="menu-title">移到收藏夹</div>'
      + favFolders().map(function (f) {
        return '<button class="menu-row" data-fav-to="' + esc(f.id) + '" data-fav-stem="' + esc(stem) + '">'
          + '<span class="menu-icon">' + (f.id === cur ? '✓' : '') + '</span>'
          + '<span class="grow"><b>' + esc(f.name) + '</b>'
          + '<small>' + favRowsIn(f.id).length + ' 篇</small></span>'
          + '<span class="menu-arrow">›</span></button>';
      }).join('')
      + '<div class="sheet-note">每篇文章只属于一个收藏夹,移动后原夹里不再保留。</div>');
  }

  function setFavFolder(stem, id) {
    if (!A_MAP[stem] || !favFolderName(id)) return;
    S.favorites.map[stem] = id;
    saveNow();
    renderFavorites();
    notify('已移到「' + favFolderName(id) + '」');
  }

  /* ---------------- 统计 ---------------- */
  function stageBuckets() {
    var b = { '初遇': 0, '再见': 0, '熟识': 0, '掌握': 0, '不会': 0, '已忽略': 0 };
    for (var w in S.words) {
      var rec = S.words[w];
      if (!rec || typeof rec !== 'object') continue;
      var st = +rec.st || 0;
      if (st === IGNORED) b['已忽略']++;
      else if (st === WELLKNOWN) b['掌握']++;
      else if (+rec.no) b['不会']++;
      else b[stageOf(Math.max(+rec.n || 0, 1))]++;
    }
    return b;
  }
  function estimateVocab() {
    var pool = [], known = [];
    for (var w in S.words) {
      var rec = S.words[w];
      if (!rec || typeof rec !== 'object') continue;
      var st = +rec.st || 0;
      if (st === WELLKNOWN) { known.push(rankOf(w)); continue; }
      if (st === IGNORED) continue;
      if (!(+rec.no || +rec.chk)) continue;
      if (isKnown(w) || isProper(w)) continue;
      var r = rankOf(w);
      if (r) pool.push(r);
    }
    pool.sort(function (a, b) { return a - b; });
    if (pool.length < 5) return null;
    known = known.filter(Boolean).sort(function (a, b) { return a - b; });
    var q1 = quantile(pool, 0.25);
    var hi = clamp(pool[0], 500, 20000);      // 生词里最高频的那个,作上界
    var lo = known.length ? clamp(known[known.length - 1], 500, 20000) : null;
    var crossed = lo !== null && lo > hi;
    var vocab = clamp(crossed ? q1 : Math.min(q1, hi), 500, 20000);
    return { vocab: Math.round(vocab), n: pool.length, q1: Math.round(q1), band: lo !== null && !crossed, low: lo };
  }
  function quantile(sorted, p) {
    var pos = (sorted.length - 1) * p, base = Math.floor(pos), rest = pos - base;
    if (sorted[base + 1] === undefined) return sorted[base];
    return sorted[base] + (sorted[base + 1] - sorted[base]) * rest;
  }

  function renderStats() {
    current = 'stats';
    activeTab('stats');
    setTop('统计');
    var goal = Math.max(+S.settings.goal_words || 150, 1);
    var today = S.days[todayKey()] || { words: 0, checks: 0 };
    var tw = +today.words || 0;
    var week = 0, days7 = [];
    for (var i = 6; i >= 0; i--) {
      var d = addDays(new Date(), -i), k = isoDate(d);
      var v = +(((S.days[k] || {}).words) || 0);
      days7.push([d, k, v]);
      week += v;
    }
    var peak = Math.max.apply(null, days7.map(function (x) { return x[2]; }).concat([1]));
    var doneN = 0;
    for (var s in S.articles) if (S.articles[s] && S.articles[s].done && A_MAP[s]) doneN++;
    var totalReadWords = Object.keys(S.read_words || {}).length;
    var b = stageBuckets();
    var est = estimateVocab();

    var html = '<div class="stat-grid">'
      + statCard('今日', fmt(tw), '目标 ' + fmt(goal) + ' 词 · 查词 ' + (+today.checks || 0) + ' 次')
      + statCard('达标天数', metDays() + ' 天', '连续 ' + streak() + ' 天')
      + statCard('近 7 天', fmt(week), '平均 ' + fmt(Math.round(week / 7)) + ' 词/天')
      + statCard('累计', fmt(S.total_words || 0), '已读 ' + doneN + ' 篇')
      + '</div>';

    html += '<div class="card" style="margin-top:10px">'
      + '<div class="card-title">近 7 天每天读了多少词</div>'
      + '<div class="bar-box">'
      + days7.map(function (x, idx) {
        var d = x[0], v = x[2];
        var pct = v ? Math.max(4, Math.round(v / peak * 100)) : 0;
        var label = (d.getMonth() + 1) + '/' + d.getDate();
        return '<div class="bar' + (idx === 6 ? ' today' : '') + '" title="' + isoDate(d) + ' · ' + v + ' 词">'
          + '<i style="height:' + pct + '%"></i><span>' + label + '</span></div>';
      }).join('')
      + '</div>'
      + '<div class="tiny faint" style="margin-top:8px">峰值 ' + fmt(peak) + ' 词 · 今天 ' + fmt(tw) + ' 词</div>'
      + '</div>';

    html += '<div class="card" style="margin-top:10px">'
      + '<div class="card-title">生词本</div>'
      + '<div class="meta-grid">'
      + Object.keys(b).map(function (k) {
        return '<div class="meta-cell"><b>' + b[k] + '</b><span>' + k + '</span></div>';
      }).join('')
      + '</div>'
      + '<div class="tiny muted" style="margin-top:10px">读过 ' + fmt(totalReadWords)
      + ' 个词 · 生词本 ' + fmt(activeWords().length) + ' 个词</div>'
      + '</div>';

    if (est) {
      html += '<div class="card" style="margin-top:10px">'
        + '<div class="card-title">词汇量估计</div>'
        + '<div class="stat-v">≈ ' + fmt(est.vocab) + ' <small>词</small></div>'
        + '<div class="tiny muted" style="margin-top:6px">按你标为生词的 ' + est.n + ' 个词反推,'
        + '取下界;标得越多越准。</div></div>';
    }

    html += '<div class="set-foot">读闲书,长词汇 · 本地运行,数据只存这台手机</div>';
    $('#view').innerHTML = html;
  }
  function statCard(k, v, sub) {
    return '<div class="stat"><div class="stat-k">' + esc(k) + '</div>'
      + '<div class="stat-v">' + esc(v) + '</div>'
      + '<div class="stat-sub">' + esc(sub) + '</div></div>';
  }

  /* ---------------- 我的 / 设置 ---------------- */
  var GEAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
    + ' stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/>'
    + '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06'
    + 'a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09'
    + 'a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06'
    + 'a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09'
    + 'a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06'
    + 'a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09'
    + 'a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06'
    + 'a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09'
    + 'a1.65 1.65 0 0 0-1.51 1z"/></svg>';

  function meRow(act, ico, title, sub) {
    var icon = ico.indexOf('<svg') === 0 ? ico : esc(ico);
    return '<button class="me-row" data-act="' + act + '">'
      + '<span class="me-ico">' + icon + '</span>'
      + '<span class="grow"><b>' + esc(title) + '</b><small>' + esc(sub) + '</small></span>'
      + '<span class="chev">›</span></button>';
  }

  function renderMe() {
    current = 'me';
    activeTab('me');
    setTop('我的');
    var doneN = 0;
    for (var s in S.articles) if (S.articles[s] && S.articles[s].done && A_MAP[s]) doneN++;
    var readN = Object.keys(S.read_words || {}).length;
    var wordsN = activeWords().length;
    var favsN = favCount();
    var histN = S.history.length;

    $('#view').innerHTML = '<div class="card profile-card">'
      + '<div class="profile"><div class="profile-mark">闲</div>'
      + '<div><div class="profile-name">闲读</div>'
      + '<div class="profile-sub">已读 ' + doneN + ' 篇 · 读过 ' + fmt(readN) + ' 个词</div></div></div>'
      + '<div class="profile-stats">'
      + '<div data-act="go-done"><b>' + doneN + '</b><span>已读完</span></div>'
      + '<div data-act="go-words"><b>' + fmt(readN) + '</b><span>读过词</span></div>'
      + '<div data-act="go-favs"><b>' + favsN + '</b><span>收藏</span></div>'
      + '</div></div>'
      + goalCardHTML()
      + '<div class="card">'
      + meRow('go-words', '词', '生词本', wordsN ? wordsN + ' 个词 · 到期的优先复习' : '还没有生词')
      + meRow('go-history', '记', '历史记录', histN ? '最近 ' + histN + ' 篇 · 最多留 ' + HISTORY_MAX + ' 篇' : '还没有阅读记录')
      + meRow('go-favs', '★', '收藏夹', favsN ? favsN + ' 篇收藏' : '还没有收藏')
      + meRow('go-set', GEAR_SVG, '设置', '外观、数据与 API Key、关于')
      + '</div>'
      + '<div class="set-foot">闲读 · 手机版 ' + APP_VERSION + '<br>读闲书,长词汇</div>';
  }

  function goalCardHTML() {
    var m = mode();
    return '<div class="card goal-card"><div class="card-title">学习目标</div>'
      + '<div class="goal-grid">' + MODE_ORDER.map(function (k) {
        var cls = 'goal m-' + k + (m === k ? ' on' : '');
        return '<button class="' + cls + '" data-goal="' + k + '">'
          + '<span class="goal-name">' + MODE_LABELS[k] + '</span></button>';
      }).join('') + '</div></div>';
  }

  function setGoal(k) {
    if (!TAG_MODES[k] || mode() === k) return;
    S.settings.known_mode = k;
    dropCaches();
    saveNow();
    notify('学习目标已改为「' + MODE_LABELS[k] + '」');
    renderMe();
  }

  // 设置页入口不带左侧图标,只留文字与右侧箭头。
  function setEntry(act, label, hint) {
    return '<button class="me-row set-entry" data-act="' + act + '">'
      + '<span class="grow"><b>' + esc(label) + '</b><small>' + esc(hint) + '</small></span>'
      + '<span class="chev">›</span></button>';
  }

  function renderSettings() {
    current = 'set';
    activeTab('me');
    setTop('设置', { back: true });
    $('#view').innerHTML = '<div class="card"><div class="card-title">阅读与外观</div>'
      + setEntry('go-appearance', '外观设置', '字号、每日目标、主题')
      + setEntry('go-voice', '语音朗读', '语速、音高、系统语音设置')
      + '</div>'
      + '<div class="card"><div class="card-title">数据与更新</div>'
      + setEntry('go-data', '数据与 API Key', '翻译、导入导出存档、清空进度')
      + setEntry('go-update', '软件更新与发布地址', '自动检查、直接下载、镜像与哈希')
      + setEntry('go-mirror', '下载镜像源', '同步可用加速源，下载更快')
      + '</div>'
      + '<div class="card"><div class="card-title">其他</div>'
      + setEntry('go-about', '关于(必读)', '使用方法、数据与隐私、版权声明')
      + '</div><div class="set-foot">闲读 · 手机版 ' + APP_VERSION + '</div>';
  }

  function renderVoiceSettings() {
    current = 'set-voice';
    activeTab('me');
    setTop('语音朗读', { back: true });
    var rate = +S.settings.tts_rate || 0.9;
    var pitch = +S.settings.tts_pitch || 1.0;
    var info = ttsVoiceInfo();
    var engine = info && info.engine ? String(info.engine) : '';
    var voice = info && info.voice ? String(info.voice) : '';
    var loc = info && info.locale ? String(info.locale) : '';
    var cur = engine ? engine + (loc ? ' · ' + loc : '') : '未就绪';
    $('#view').innerHTML = '<div class="card"><div class="card-title">声音</div>'
      + setRow('当前引擎', '<span class="chip">' + esc(cur) + '</span>', voice || '想换引擎或音色，点下面的「打开」')
      + setRow('语速', stepper('rate', rate.toFixed(2) + '×'), '越大越快，0.90 左右比较舒服')
      + setRow('音高', stepper('pitch', pitch.toFixed(2) + '×'), '越大越尖，1.00 是原声')
      + '</div>'
      + '<div class="card"><div class="card-title">试听与引擎</div>'
      + setRow('听一句', '<button class="btn small" data-act="tts-demo">试听</button>', '调完马上听效果，不用开文章')
      + setRow('系统语音设置', '<button class="btn small" data-act="tts-engine">打开</button>', '换引擎、选音色、下载英文语音包')
      + setRow('重启应用', '<button class="btn small" data-act="app-restart">重启</button>', '换完引擎没生效时点一下,重启后回到这一页')
      + '</div>'
      + ttsPackCard(info)
      + '<div class="set-foot">语速和音高只影响朗读与点词发音，使用系统语音引擎。</div>';
  }

  /* ---------------- Google 语音引擎离线包 ---------------- */
  // 引擎包放 GitHub prerelease（不是 App 版本，不影响更新检查）。
  // 手机上 GitHub 直连常常不通，所以默认走镜像前缀；SHA-256 兜住完整性。
  var TTS_PACK_URL = GH_HOME + '/releases/download/tts-20260928/GoogleTTS-20260928-universal.apk';
  var TTS_PACK_NAME = 'GoogleTTS-20260928-universal.apk';
  var TTS_PACK_SHA = 'a70efe5f1e435de3ff9f121806e93ed0c2dd844adb18ab6cef42d13e2fbb9485';
  var ttsPack = null;   // {state, text, pct}

  // 靠 com.google.android.tts 这个包名判断，不看显示名（各家 ROM 翻译不一样）。
  function ttsPackCard(info) {
    var selected = !!(info && info.googleSelected);
    var installed = selected || !!(info && info.google);
    var head = '<div class="card"><div class="card-title">Google 语音引擎</div>';
    if (selected) {
      return head
        + '<div class="about-row"><b>已启用</b><p>当前首选引擎就是 Google 语音，英文发音最自然</p></div>'
        + '<div class="set-hint">想换音色或下离线语音包，点上面的「系统语音设置」。</div>'
        + '</div>';
    }
    if (installed) {
      return head
        + '<div class="about-row"><b>已安装，但没选中</b><p>引擎装好了，首选引擎还是别的；去系统语音设置里改一下</p></div>'
        + '<div class="about-row"><b>选哪一项</b><p>系统设置 → 无障碍 → 文字转语音 → 首选引擎 → 「Google 语音识别和语音合成」</p></div>'
        + '<button class="btn primary block" data-act="tts-engine">去系统语音设置</button>'
        + '</div>';
    }
    return head
      + '<div class="about-row"><b>1 · 安装</b><p>Speech Services by Google，两个按钮任选一个</p></div>'
      + '<div class="about-row"><b>2 · 首选引擎</b><p>系统设置 → 无障碍 → 文字转语音 → 选「Google 语音识别和语音合成」</p></div>'
      + '<div class="about-row"><b>3 · 语言</b><p>返回上一级 → 语言 → 英语（英国）或英语（美国）</p></div>'
      + '<button class="btn primary block" data-act="tts-pack-download">镜像下载安装（约 36 MB）</button>'
      + '<button class="btn soft block" data-act="tts-store">从 Google 商店安装</button>'
      + '<div class="set-hint" style="margin-top:8px">没有 Play 商店也能用第一个：下载前自动测速挑最快的镜像，'
      + '多源并发下载，可随时暂停，下次继续。下载完成后自动核对 SHA-256，一致后才能安装。'
      + '装的是完整单包，小米手机不用关 MIUI 优化。建议连 Wi-Fi。</div>'
      + ttsPackStateHTML()
      + '</div>';
  }

  window.__ttsPackProgress = function (done, total) {
    var d = +done || 0, t = +total || 0;
    var pct = t > 0 ? Math.min(99, Math.round(d / t * 100)) : 0;
    ttsPack = { state: 'downloading', pct: pct,
                text: t > 0 ? '正在下载 ' + pct + '%' : '正在下载…' };
    paintTtsPack();
  };

  window.__ttsPackResult = function (state, text) {
    var prev = ttsPack || {};
    var name = String(state || '');
    ttsPack = { state: name, text: String(text || ''),
                pct: name === 'ok' ? 100 : (prev.pct || 0) };
    if (name === 'fail' || name === 'badhash' || name === 'unsupported') {
      notify(ttsPack.text || '安装没成功');
    }
    // 成功就整页重画；下载中还藏着入口；其它状态（暂停/失败/缺权限）放回来让用户重试或换商店。
    if (name !== 'ok' && name !== 'downloading') setTtsButtons(true);
    paintTtsPack();
    if (name === 'ok') {
      // 装完重画这一页，卡片会自动变成「已安装，但没选中」
      setTimeout(function () {
        if (current === 'set-voice') renderVoiceSettings();
      }, 700);
    }
  };

  // 下载/校验/安装期间收起两个入口，避免重复点。
  function setTtsButtons(visible) {
    var ids = ['[data-act=tts-pack-download]', '[data-act=tts-store]'];
    for (var i = 0; i < ids.length; i++) {
      var el = document.querySelector(ids[i]);
      if (!el) continue;
      if (visible) el.removeAttribute('hidden');
      else el.setAttribute('hidden', '');
    }
  }

  function ttsPackPct() {
    if (!ttsPack) return 0;
    if (ttsPack.state === 'ok') return 100;
    return Math.max(0, Math.min(100, +ttsPack.pct || 0));
  }

  function ttsPackTone() {
    if (!ttsPack) return '';
    if (ttsPack.state === 'ok') return ' ok';
    if (ttsPack.state === 'fail' || ttsPack.state === 'badhash'
        || ttsPack.state === 'unsupported' || ttsPack.state === 'permission') return ' warn';
    return '';
  }

  // 面板常驻（无内容时 hidden），这样点下载后能原地更新进度，不用重绘整页。
  function ttsPackStateHTML() {
    var has = !!(ttsPack && ttsPack.text);
    var tone = has ? ttsPackTone() : '';
    var st = has ? ttsPack.state : '';
    var downloading = st === 'downloading';
    var paused = st === 'paused';
    return '<div class="apk-panel" id="ttsPackPanel"' + (has ? '' : ' hidden') + '>'
      + '<div class="apk-bar' + tone + '" id="ttsPackBar"><i id="ttsPackFill" style="width:'
      + ttsPackPct() + '%"></i></div>'
      + '<div class="apk-line"><span class="apk-state' + tone + '" id="ttsPackText">'
      + (has ? esc(ttsPack.text) : '') + '</span>'
      + '<button class="btn small soft" id="ttsPackPause" data-act="tts-pause"'
      + (downloading ? '' : ' hidden') + '>暂停</button>'
      + '<button class="btn small primary" id="ttsPackResume" data-act="tts-resume"'
      + (paused ? '' : ' hidden') + '>继续</button>'
      + '</div>'
      + '<div class="apk-tip" id="ttsPackTip"' + (downloading || paused ? '' : ' hidden') + '>'
      + (paused ? '已暂停，已下载部分会保留，点「继续」可续传'
                : '下载期间请勿退出 App；切到后台或熄屏可能导致中断')
      + '</div></div>';
  }

  function paintTtsPack() {
    var panel = $('#ttsPackPanel');
    if (!panel || !ttsPack) return;
    var tone = ttsPackTone();
    var st = ttsPack.state;
    if (ttsPack.text) panel.removeAttribute('hidden');
    else panel.setAttribute('hidden', '');
    var bar = $('#ttsPackBar');
    if (bar) bar.className = 'apk-bar' + tone;
    var fill = $('#ttsPackFill');
    if (fill) fill.style.width = ttsPackPct() + '%';
    var label = $('#ttsPackText');
    if (label) {
      label.className = 'apk-state' + tone;
      label.textContent = ttsPack.text || '';
    }
    var pause = $('#ttsPackPause');
    if (pause) {
      if (st === 'downloading') pause.removeAttribute('hidden');
      else pause.setAttribute('hidden', '');
    }
    var resume = $('#ttsPackResume');
    if (resume) {
      if (st === 'paused') resume.removeAttribute('hidden');
      else resume.setAttribute('hidden', '');
    }
    var tip = $('#ttsPackTip');
    if (tip) {
      var showTip = st === 'downloading' || st === 'paused';
      if (showTip) tip.removeAttribute('hidden');
      else tip.setAttribute('hidden', '');
      tip.textContent = st === 'paused'
        ? '已暂停，已下载部分会保留，点「继续」可续传'
        : '下载期间请勿退出 App；切到后台或熄屏可能导致中断';
    }
  }

  function startTtsPackDownload() {
    if (!window.Android || typeof window.Android.downloadTtsPack !== 'function') {
      notify('请在安装版 App 中操作');
      return;
    }
    ttsPack = { state: 'downloading', pct: 0, text: '正在测速选源' };
    setTtsButtons(false);
    paintTtsPack();
    // 传原始地址 + 全部镜像：原生逐条测速，挑最快的几条并发下。
    window.Android.downloadTtsPack(TTS_PACK_URL, TTS_PACK_NAME, TTS_PACK_SHA, mirrorsJson());
  }

  function pauseTtsPackDownload() {
    if (!window.Android || typeof window.Android.pauseTtsPackDownload !== 'function') return;
    window.Android.pauseTtsPackDownload();
  }

  function resumeTtsPackDownload() {
    if (!window.Android || typeof window.Android.resumeTtsPackDownload !== 'function') return;
    window.Android.resumeTtsPackDownload();
  }
  function speakDemo() {
    if (!TTS_ON) return;
    if (!window.Android || typeof window.Android.ttsSayWord !== 'function') return;
    if (typeof window.Android.ttsStatus === 'function'
        && String(window.Android.ttsStatus() || '') !== 'ok') { notify('语音引擎还没准备好'); return; }
    applyVoiceSettings();
    window.Android.ttsSayWord('This is how it sounds.');
  }

  function renderAppearance() {
    current = 'set-appearance';
    activeTab('me');
    setTop('外观设置', { back: true });
    var goal = +S.settings.goal_words || 150;
    var font = +S.settings.font_size || 19;
    var theme = S.settings.theme || 'auto';
    var pill = !!+S.settings.cont_pill;
    $('#view').innerHTML = '<div class="card"><div class="card-title">阅读</div>'
      + setRow('正文字号', stepper('font', font + ' px'), '在阅读页即时生效')
      + setRow('每日目标', stepper('goal', fmt(goal) + ' 词'), '约半篇文章')
      + '<div class="set-row"><div class="set-label">接着读浮条<div class="set-hint">'
      + '阅读列表页展开显示文章名,其他页面缩到右边;可上下拖动</div></div>'
      + '<label class="switch"><input type="checkbox" id="contPillSw"' + (pill ? ' checked' : '')
      + '><i></i></label></div>'
      + '<div class="set-row"><div class="set-label">外观<div class="set-hint">跟随系统或手动选择</div></div>'
      + '<div class="seg">' + [['auto', '跟随'], ['light', '浅色'], ['dark', '深色']].map(function (x) {
        return '<button class="' + (theme === x[0] ? 'on' : '') + '" data-theme="' + x[0] + '">' + x[1] + '</button>';
      }).join('') + '</div></div></div>';
    var csw = $('#contPillSw');
    if (csw) csw.addEventListener('change', function () {
      S.settings.cont_pill = csw.checked ? 1 : 0;
      saveNow();
      contPill.open = null;
      renderContPill();
    });
  }

  function renderDataSettings() {
    current = 'set-data';
    activeTab('me');
    setTop('数据与 API Key', { back: true });
    var provider = transProvider();
    var transHint = provider === 'deepseek'
      ? (aiKey() ? '更顺,但每次翻译会消耗 DeepSeek 额度。'
        : 'DeepSeek 还没设置 Key,翻译前会先让你填。')
      : '默认。免费、不用 Key；偏直译，长段落偶尔漏小句。免费接口有频率限制，别反复批量翻译。';
    $('#view').innerHTML = '<div class="card"><div class="card-title">翻译</div>'
      + '<div class="seg">'
      + '<button class="' + (provider === 'tencent' ? 'on' : '')
      + '" data-trans-provider="tencent">腾讯翻译（免费）</button>'
      + '<button class="' + (provider === 'deepseek' ? 'on' : '')
      + '" data-trans-provider="deepseek">DeepSeek</button></div>'
      + '<div class="set-hint">' + transHint + '</div></div>'
      + '<div class="card"><div class="card-title">AI</div>'
      + '<div class="set-row"><div class="set-label">DeepSeek API Key<div class="set-hint">'
      + (aiKey() ? '已保存 ' + esc(maskedKey()) + ' · 只存在本机' : '未设置 · 用于 DeepSeek 翻译')
      + '</div></div><button class="btn small' + (aiKey() ? '' : ' soft') + '" data-act="ai-key">'
      + (aiKey() ? '更换' : '设置') + '</button></div></div>'
      + '<div class="card"><div class="card-title">存档</div>'
      + '<div class="set-row"><div class="set-label">导入桌面存档<div class="set-hint">把电脑上的 ldleRead.json 带过来</div></div>'
      + '<button class="btn small" data-act="import">选择文件</button></div>'
      + '<div class="set-row"><div class="set-label">导出存档<div class="set-hint">备份进度、生词和设置;导入的书不随存档走</div></div>'
      + '<button class="btn small" data-act="export">导出</button></div>'
      + '<div class="set-row"><div class="set-label">清空进度<div class="set-hint">只删本机的阅读记录,不能撤销</div></div>'
      + '<button class="btn small danger" data-act="reset">清空</button></div>'
      + '<input type="file" id="importFile" accept=".json,application/json" hidden></div>'
      + '<div class="set-foot">导入的书请保留原文件,存档里不带书。</div>';
  }

  function updateFreqSel() {
    var cur = String(S.settings.update_freq || 'launch');
    var opts = [['launch', '登录时'], ['3', '三天'], ['7', '七天'], ['never', '永不']];
    return '<select id="updateFreq" class="freq-sel">' + opts.map(function (o) {
      return '<option value="' + o[0] + '"' + (cur === o[0] ? ' selected' : '')
        + '>' + o[1] + '</option>';
    }).join('') + '</select>';
  }

  function fmtBytes(n) {
    if (!n) return '';
    if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }

  function updateHash() {
    return latestRel && latestRel.sha
      ? String(latestRel.sha).replace(/^sha256:/i, '') : '';
  }

  // 镜像源：内置一份兜底，用户可以同步远端维护的清单。
  function renderMirrorSettings() {
    current = 'set-mirror';
    activeTab('me');
    setTop('下载镜像源', { back: true });
    var synced = S.mirrors && S.mirrors.list && S.mirrors.list.length;
    var updated = (S.mirrors && S.mirrors.updated) || '';
    var rows = '';
    for (var i = 0; i < GH_MIRRORS.length; i++) {
      rows += '<div class="mirror-row"><span class="mirror-name">'
        + esc(GH_MIRRORS[i].name) + '</span>'
        + '<span class="muted">#' + (i + 1) + '</span></div>';
    }
    $('#view').innerHTML = '<div class="card"><div class="card-title">当前清单</div>'
      + setRow('来源', '<span class="chip">' + (synced ? '同步源' : '内置')
        + '</span>', updated ? '更新于 ' + esc(updated) : '还没同步过远端清单')
      + setRow('可用源', '<span class="chip">' + GH_MIRRORS.length + ' 个</span>',
        '下载前会逐个测速，优先使用较快的源')
      + '<div class="set-row"><div class="set-label">同步远端清单'
      + '<div class="set-hint">从发布页获取最新可用镜像；获取失败时继续使用当前清单</div></div>'
      + '<button class="btn small primary" data-act="mirror-sync">同步</button></div>'
      + '<div class="apk-state" id="mirrorSyncLine" hidden></div>'
      + (synced ? '<button class="btn soft block" data-act="mirror-reset">恢复默认清单</button>' : '')
      + '</div>'
      + '<div class="card"><div class="card-title">清单明细</div>'
      + '<div class="mirror-list">' + rows + '</div>'
      + '<div class="set-hint" style="margin-top:8px">列表顺序与速度无关，每次下载都会重新测速。'
      + '镜像为第三方加速服务，仅负责文件传输；安装前会校验 SHA-256，不一致不会安装。</div>'
      + '</div>';
    paintMirrorSync();
  }

  function renderUpdate() {
    current = 'set-update';
    activeTab('me');
    setTop('软件更新与发布地址', { back: true });
    var rel = latestRel;
    var newVer = rel && verCmp(rel.version, APP_VERSION) > 0;
    var hash = updateHash();
    var verify;
    if (rel && rel.url) {
      verify = '<div class="hash-box"><div class="hash-line"><b>'
        + esc('IdleRead-' + rel.version + '.apk') + '</b>'
        + (rel.size ? '<span class="muted"> · ' + esc(fmtBytes(rel.size)) + '</span>' : '')
        + '</div>'
        + (hash ? '<div class="hash-line mono">' + esc(hash) + '</div>'
          + '<button class="btn small soft" data-act="update-copy-hash">复制哈希</button>'
          : '<div class="hash-line muted">未获取到 SHA-256，可到发布页核对</div>')
        + '</div>';
    } else {
      verify = '<div class="set-hint">先点「检查新版本」获取下载地址和 SHA-256</div>';
    }
    // 远端清单比本地新（或正在更新/更新失败）时，顶部给一条提示，别让用户守着旧源。
    var staleShow = mirrorCheck.state === 'stale'
      || (mirrorSync && (mirrorSync.state === 'busy' || mirrorSync.state === 'fail'));
    var staleBar = staleShow
      ? '<div class="card"><div class="set-row"><div class="set-label">下载源提示'
        + '<div class="set-hint">当前下载源已过期，请点击更新</div></div>'
        + '<button class="btn small primary" data-act="mirror-refresh">更新</button></div>'
        + '<div class="set-hint" id="mirrorSyncLine" hidden></div></div>'
      : '';
    $('#view').innerHTML = staleBar + '<div class="card"><div class="card-title">版本</div>'
      + setRow('当前版本', '<span class="chip">' + esc(APP_VERSION)
        + ' (' + APP_CODE + ')</span>', '自动检查按下面的频率进行')
      + (newVer ? setRow('最新版本', '<span class="chip">v' + esc(rel.version) + '</span>',
        '可暂不升级，旧版仍可正常使用') : '')
      + '<div class="set-row"><div class="set-label">检查新版本'
      + '<div class="set-hint">需要联网，平时按频率自动查</div></div>'
      + '<div class="up-check">' + updateFreqSel()
      + '<button class="btn small' + (newVer ? ' soft' : '') + '" data-act="update-check">'
      + (upBusy ? '检查中…' : (newVer ? '再查一次' : '检查')) + '</button></div></div>'
      + '</div>'
      + '<div class="card"><div class="card-title">安装包</div>'
      + setRow('下载', '<button class="btn small" data-act="update-download">下载</button>',
        '自动测速选源，多源并发下载')
      + setRow('镜像源', '<button class="btn small soft" data-act="go-mirror">管理</button>',
        GH_MIRRORS.length + ' 个候选，每次下载前重新测速')
      + '<div class="set-label" style="margin-top:10px">文件校验</div>'
      + verify
      + apkStateHTML()
      + '<div class="set-hint">GitHub API 返回的 digest 就是官方哈希;下载完会自动比对,'
      + '不一致的包直接删掉、不会装。</div>'
      + '</div>'
      + '<div class="card"><div class="card-title">发布地址</div>'
      + setRow('项目主页', '<button class="btn small" data-act="update-home">打开</button>',
        'github.com/lixiuyuanan/IdleRead')
      + setRow('发布页', '<button class="btn small" data-act="update-release">打开</button>',
        'github.com/lixiuyuanan/IdleRead/releases')
      + '</div>'
      + '<div class="set-foot">闲读 · 手机版 ' + esc(APP_VERSION)
      + '<br>下载前会逐个测速，优先使用较快的镜像并发下载；可随时暂停，下次继续。'
      + '下载完成后自动比对 SHA-256：一致时进度条变绿，点「安装」即可；不一致会改用单一源重新下载，仍不一致则删除。</div>';
    paintMirrorSync();
    checkMirrorsStale(false);
  }

  function renderAbout() {
    current = 'set-about';
    activeTab('me');
    setTop('关于(必读)', { back: true });
    $('#view').innerHTML = '<div class="card about"><div class="card-title">使用方法</div>'
      + aboutRow('阅读', '顶部难度条可以左右拖动,点书架或某一等级进入。书架和导入的书可以折叠,点书名展开章节;点右边的「删除 / 移除」整理书架,内置书移除后还能在「＋」→「管理图书」里恢复。右上角「＋」可以导书。点正文里的词查义,会自动进生词本;读完点文末「我读完了」,本篇词汇会进「读过池」,并更新词的出现次数。')
      + aboutRow('导入图书', '支持 TXT。会自动认「第几章 / Chapter N」这类标题;没有章节标记的长文按篇幅分。右上角「＋」里的「复制导入规则（必看！）」可以把这些规则复制给 AI,让它直接生成能导入的 TXT。')
      + aboutRow('AI', '翻译默认用免费的腾讯翻译;想更顺可以在「我的 → 设置 → 数据与 API Key」里切到 DeepSeek,并填一次 Key。阅读页有缺译文时,右上角会变成「AI 译」。不用 AI 时完全离线。')
      + aboutRow('生词本', '按阶段、到期日和出现次数查看;可以搜索单词或释义,也可以按阶段筛选。点一行改熟练度或去复习。')
      + aboutRow('语境复习', '输入一个词,挑出全书里的 15 条原句。句子按 i+1 排序,生词越少越靠前;点「随机切换」换一批。开「挖空自测」先遮住答案,点句子显示。')
      + aboutRow('历史与收藏', '历史最多留最近 200 篇,可以一键清空。阅读页右上角的星标只收当前这篇文章,默认进「默认收藏」;在「我的 → 收藏夹」里可以新建、重命名、删除收藏夹,也能把某篇文章移到别的夹。删收藏夹只清收藏记录,不影响文章和进度。')
      + aboutRow('统计与设置', '统计看今天读了多少词、达标天数、近 7 天和累计词量。设置分三页:外观设置、数据与 API Key、关于。')
      + '</div>'
      + '<div class="card about"><div class="card-title">数据与隐私</div>'
      + '<p>阅读记录、生词、收藏、历史、导入的书和设置只保存在这台手机上,不登录、不上传、没有统计埋点。</p>'
      + '<p>只有你主动点「AI 译」或「测试连接」时才会联网:选腾讯翻译时,英文段落发给 transmart.qq.com;选 DeepSeek 时,英文段落和 API Key 发给 api.deepseek.com。除了自动检查更新,不点就不联网。</p>'
      + '<p>自动检查更新开启时,启动后会访问 GitHub 的发布信息,只取版本号和哈希,不上传任何本地数据;在「软件更新与发布地址」里选「永不」后,完全不自动联网。</p>'
      + '<p>AI Key 单独保存,不写进导出的存档。换手机或重装前,建议先用「导出存档」留一份进度;导入的书请保留原文件。</p></div>'
      + '<div class="card about"><div class="card-title">版权与使用声明</div>'
      + '<p>自带文章仅供学习与功能演示,版权归原作者和出版方所有。</p>'
      + '<p>请只阅读你合法拥有或有权阅读的文本;请勿传播盗版或未授权内容。</p>'
      + '<p>本工具是个人自用软件,不提供内容分发,不用于商业用途。</p>'
      + '<p>若权利人认为某些内容不宜收录,删除对应文件或卸载应用即可。</p></div>'
      + '<div class="set-foot">闲读 · 手机版 ' + APP_VERSION + '</div>';
  }
  function setRow(label, right, hint) {
    return '<div class="set-row"><div class="set-label">' + esc(label)
      + (hint ? '<div class="set-hint">' + esc(hint) + '</div>' : '') + '</div>'
      + right + '</div>';
  }
  function stepper(kind, text) {
    return '<div class="stepper">'
      + '<button data-act="' + kind + '-dec">−</button><span>' + esc(text) + '</span>'
      + '<button data-act="' + kind + '-inc">+</button></div>';
  }
  function aboutRow(title, text) {
    return '<div class="about-row"><b>' + esc(title) + '</b><p>' + esc(text) + '</p></div>';
  }

  /* ---------------- 导入 / 导出 ---------------- */
  function exportState() {
    var text = JSON.stringify(S, null, 1);
    var name = 'ldleRead-' + todayKey() + '.json';
    if (window.Android && typeof window.Android.saveText === 'function') {
      try {
        window.Android.saveText(name, text);
        notify('已导出到手机的「下载」目录');
        return;
      } catch (e) { /* 退回浏览器下载 */ }
    }
    try {
      var blob = new Blob([text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
      notify('已导出 ' + name);
    } catch (e) {
      notify('导出失败,可以改用桌面版备份');
    }
  }

  function importState(file) {
    if (!file) return;
    var fr = new FileReader();
    fr.onload = function () {
      var obj;
      try { obj = JSON.parse(String(fr.result || '')); } catch (e) { notify('这个文件不是有效的存档'); return; }
      if (!obj || typeof obj !== 'object' || (!obj.words && !obj.articles && !obj.days)) {
        notify('看起来不是闲读的存档'); return;
      }
      askConfirm('导入存档', '会用这个文件替换本机现在的进度、生词和设置。确定继续吗?', false, function () {
        var base = defaultState();
        base.settings = freshSettings();
        if (obj.settings) for (var k in base.settings) {
          if (obj.settings[k] !== undefined) base.settings[k] = obj.settings[k];
        }
        ['articles', 'days', 'words', 'read_words', 'readPos'].forEach(function (k) {
          if (obj[k] && typeof obj[k] === 'object') base[k] = obj[k];
        });
        base.total_words = +obj.total_words || 0;
        base.last_stem = obj.last_stem || null;
        if (obj.hidden_books && typeof obj.hidden_books === 'object') base.hidden_books = obj.hidden_books;
        if (Array.isArray(obj.marks)) base.marks = obj.marks;   // 旧存档没这个字段就是空数组
        S = base;
        normalizeState();
        dropCaches();
        ctxCache.clear();
        revList = []; revBatch = []; revRanked = null; revWord = '';
        saveNow();
        applyTheme();
        applyReaderFont();
        go('me');
        notify('存档导入完成');
      });
    };
    fr.readAsText(file, 'utf-8');
  }

  /* ---------------- 荧光划线 + 笔记 ---------------- */
  // 一条划线记录 = 一篇文章某一段里的同一句话:句范围 a/b 定卡片, r 存段内被划的区间。
  function rangesHit(rs, s, e) {
    for (var i = 0; i < rs.length; i++) if (s < rs[i][1] && e > rs[i][0]) return true;
    return false;
  }
  function mergeRanges(rs) {
    var xs = [];
    for (var i = 0; i < rs.length; i++) {
      var a = +rs[i][0], b = +rs[i][1];
      if (b > a) xs.push([a, b]);
    }
    xs.sort(function (x, y) { return x[0] - y[0]; });
    var out = [];
    for (var j = 0; j < xs.length; j++) {
      var last = out.length ? out[out.length - 1] : null;
      if (last && xs[j][0] <= last[1]) last[1] = Math.max(last[1], xs[j][1]);
      else out.push([xs[j][0], xs[j][1]]);
    }
    return out;
  }
  function markById(id) {
    for (var i = 0; i < S.marks.length; i++) if (S.marks[i].i === id) return S.marks[i];
    return null;
  }
  // 只留还能对上原文的记录:删过的书、改过的段落自然消失。
  function liveMarks() {
    return S.marks.filter(function (m) {
      var a = A_MAP[m.s];
      return !!(a && a.p && a.p[+m.p] && m.r.length);
    }).sort(function (x, y) { return (+y.t || 0) - (+x.t || 0); });
  }
  function paraMarkRanges(stem) {
    var out = {};
    S.marks.forEach(function (m) {
      if (m.s !== stem) return;
      var p = +m.p;
      if (!out[p]) out[p] = [];
      out[p] = out[p].concat(m.r);
    });
    return out;
  }
  function markRangesOf(stem, para) {
    var out = [];
    S.marks.forEach(function (m) {
      if (m.s === stem && +m.p === para) out = out.concat(m.r);
    });
    return out;
  }
  // 选区「覆盖」某条划线:要么整条被选区包住,要么选区完全落在它的某一段里。
  // 只搭边不算,免得拖半个词就冒出「取消划线」。
  function coveredIds(rs) {
    var out = [];
    if (rs[1] <= rs[0]) return out;
    for (var i = 0; i < S.marks.length; i++) {
      var m = S.marks[i];
      if (m.s !== pop.stem || +m.p !== pop.para || !m.r.length) continue;
      var lo = m.r[0][0], hi = m.r[0][1], inside = false;
      for (var j = 0; j < m.r.length; j++) {
        lo = Math.min(lo, m.r[j][0]); hi = Math.max(hi, m.r[j][1]);
        if (rs[0] >= m.r[j][0] && rs[1] <= m.r[j][1]) inside = true;
      }
      if (inside || (rs[0] <= lo && rs[1] >= hi)) out.push(m.i);
    }
    return out;
  }
  // 记笔记时落在哪条:优先选区开头所在的那条,否则取第一条被覆盖的。
  function noteTarget(cov, rs) {
    for (var i = 0; i < cov.length; i++) {
      var m = markById(cov[i]);
      if (m && rangesHit(m.r, rs[0], rs[0] + 1)) return m.i;
    }
    return cov.length ? cov[0] : '';
  }
  // 同文同段同句子视为一条:再划线就并进已有记录,收藏夹里不会出现重复卡片。
  function saveMarkRanges(stem, para, ranges, sent) {
    var rs = mergeRanges(ranges);
    if (!rs.length || !sent) return null;
    var found = null;
    for (var i = 0; i < S.marks.length; i++) {
      var m = S.marks[i];
      if (m.s === stem && +m.p === para && +m.a === sent.start && +m.b === sent.end) {
        found = m;
        break;
      }
    }
    if (found) found.r = mergeRanges(found.r.concat(rs));
    else {
      found = { i: 'm' + Date.now().toString(36) + (mkSeq++), s: stem, p: para,
                a: sent.start, b: sent.end, r: rs, n: '', t: Date.now() };
      S.marks.unshift(found);
    }
    saveNow();
    return found;
  }
  function deleteMark(id) {
    S.marks = S.marks.filter(function (m) { return m.i !== id; });
    saveNow();
  }

  function paintParaMarks(para) {
    var el = $('.para[data-para="' + para + '"]');
    if (!el || !readerStem) return;
    var rs = markRangesOf(readerStem, para);
    wordSpans(el).forEach(function (s) {
      s.el.classList.toggle('mk', rangesHit(rs, s.start, s.end));
    });
  }
  function clearSel() {
    var list = document.querySelectorAll('.w.sel');
    for (var i = 0; i < list.length; i++) list[i].classList.remove('sel');
  }
  function popParaText() {
    var art = A_MAP[pop.stem];
    return art && art.p ? (art.p[pop.para] || '') : '';
  }
  // 拖选手柄始终以一段连续的区间工作;已有划线的 r 可能是多段,只在落库时才拆开。
  function selRange() {
    var rs = mergeRanges(pop.ranges);
    return rs.length ? [rs[0][0], rs[rs.length - 1][1]] : [0, 0];
  }
  function selEls() {
    var el = $('.para[data-para="' + pop.para + '"]');
    if (!el || !pop.on) return [];
    var rs = mergeRanges(pop.ranges), out = [];
    wordSpans(el).forEach(function (s) {
      if (rangesHit(rs, s.start, s.end)) out.push(s.el);
    });
    return out;
  }
  function paintSel() {
    clearSel();
    selEls().forEach(function (el) { el.classList.add('sel'); });
  }
  // 手柄贴在选区首尾两端的外侧;多行时左端跟第一行、右端跟最后一行。
  function handleXY(side) {
    var els = selEls();
    if (!els.length) return null;
    var r = side === 'l' ? els[0].getBoundingClientRect()
                         : els[els.length - 1].getBoundingClientRect();
    return { x: side === 'l' ? r.left : r.right, y: r.bottom + 7 };
  }
  function positionHandles() {
    var show = pop.on && !pop.note;
    [['l', '.sel-hd[data-hd="l"]'], ['r', '.sel-hd[data-hd="r"]']].forEach(function (pair) {
      var el = $(pair[1]);
      if (!el) return;
      var p = show ? handleXY(pair[0]) : null;
      if (!p) { el.hidden = true; return; }
      el.hidden = false;
      el.style.left = Math.round(p.x - 22) + 'px';
      el.style.top = Math.round(p.y - 22) + 'px';
    });
  }
  // 菜单跟着选区走:锚在选区第一行的中间上方。
  function selAnchor() {
    var els = selEls();
    if (!els.length) return null;
    var a = els[0].getBoundingClientRect(), b = els[els.length - 1].getBoundingClientRect();
    var top = a.top, bot = a.bottom;
    for (var i = 1; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      top = Math.min(top, r.top);
      bot = Math.max(bot, r.bottom);
    }
    // b = 选区下沿:菜单放不下上面时要用它垫开,免得压住两端的拖拽手柄。
    return { x: (a.left + b.right) / 2, y: top, b: bot };
  }
  function popText() {
    var text = popParaText(), rs = mergeRanges(pop.ranges), parts = [];
    for (var i = 0; i < rs.length; i++) parts.push(text.slice(rs[i][0], rs[i][1]));
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }
  // 触点落到段内哪个字符:-1 表示这次不动(还在本段框里但没踩着文字)。
  function offsetAt(x, y) {
    var el = $('.para[data-para="' + pop.para + '"]');
    var text = popParaText();
    if (!el || !text.length) return null;
    var off = tapCharOffset(el, x, y);
    if (off >= 0) return clamp(off, 0, text.length);
    var r = el.getBoundingClientRect();
    if (y < r.top || x < r.left) return 0;
    if (y > r.bottom || x > r.right) return text.length;
    return null;
  }
  // 拖完之后重算覆盖关系,菜单和手柄都按新选区走。
  function syncSel() {
    var rs = selRange();
    pop.cov = coveredIds(rs);
    pop.id = noteTarget(pop.cov, rs);
    pop.confirm = false;
    paintSel();
    positionHandles();
    renderPop();
  }

  function unmarkLabel(n, sure) {
    var what = n > 1 ? '取消 ' + n + ' 条划线' : '取消划线';
    return sure ? (n > 1 ? '确认取消 ' + n + ' 条划线' : '确认取消划线') : what;
  }
  function popItems() {
    if (pop.cov.length) {
      return [['sentence', '选中全句'], ['copy', '复制'], ['trans', '翻译'],
              ['note', '✎记笔记'], ['unmark', unmarkLabel(pop.cov.length, pop.confirm)]];
    }
    return [['sentence', '选中全句'], ['copy', '复制'],
            ['trans', '翻译'], ['mark', '✎划线']];
  }
  function popHTML() {
    if (pop.note) {
      var m = markById(pop.id);
      return '<button class="pop-x" data-pop="note-done">×</button>'
        + '<textarea class="pop-note" id="popNote" rows="3" maxlength="800" '
        + 'placeholder="给这句记点笔记">' + esc(m ? m.n : '') + '</textarea>';
    }
    var html = '<div class="pop-items">' + popItems().map(function (x) {
      return '<button class="pop-i' + (x[0] === 'unmark' && pop.confirm ? ' warn' : '')
        + '" data-pop="' + x[0] + '">' + x[1] + '</button>';
    }).join('') + '</div>';
    if (pop.busy || pop.zh) {
      html += '<div class="pop-zh' + (pop.fail ? ' fail' : '') + '">'
        + (pop.busy ? '翻译中…' : esc(pop.zh)) + '</div>';
    }
    return '<button class="pop-x" data-pop="close">×</button>' + html;
  }
  function positionPop() {
    var el = $('#pop');
    var a = selAnchor();
    if (!a) return;
    var r = el.getBoundingClientRect();
    var vw = window.innerWidth || 390, vh = window.innerHeight || 844;
    var left = clamp(a.x - r.width / 2, 10, Math.max(10, vw - r.width - 10));
    var top = a.y - r.height - 12;
    if (top < 62) top = (a.b || a.y) + 26;
    top = clamp(top, 62, Math.max(62, vh - r.height - 12));
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
  }
  function renderPop() {
    var el = $('#pop'), body = $('#popBody');
    if (!el || !body) return;
    if (!pop.on) {
      el.classList.add('hidden');
      body.innerHTML = '';
      positionHandles();
      return;
    }
    body.innerHTML = popHTML();
    el.classList.remove('hidden');
    positionPop();
    positionHandles();
  }
  function resetPop() {
    pop.on = false; pop.stem = ''; pop.para = -1; pop.ranges = [];
    pop.cov = []; pop.id = ''; pop.zh = ''; pop.fail = false; pop.busy = false;
    pop.note = false; pop.confirm = false;
  }
  function closePop() {
    if (pop.note) savePopNote();
    resetPop();
    clearSel();
    renderPop();
  }
  function popOpenFor(span, paraEl) {
    if (!readerStem || swap.busy) return;
    var seg = null;
    wordSpans(paraEl).forEach(function (s) { if (s.el === span) seg = s; });
    if (!seg) return;
    resetPop();
    pop.stem = readerStem;
    pop.para = +paraEl.dataset.para;
    pop.ranges = [[seg.start, seg.end]];
    pop.on = true;
    syncSel();
  }
  // 选区跨句就按句拆成多条记录,每张收藏卡片仍然只装一句话。
  function doMark() {
    var r = selRange(), rs = sentenceRanges(popParaText()), made = null;
    for (var i = 0; i < rs.length; i++) {
      if (r[1] <= rs[i].start || r[0] >= rs[i].end) continue;
      var m = saveMarkRanges(pop.stem, pop.para,
        [[Math.max(r[0], rs[i].start), Math.min(r[1], rs[i].end)]], rs[i]);
      if (m && !made) made = m;
    }
    if (!made) return;
    paintParaMarks(pop.para);
    syncSel();
    clearSel();     // 刚划完先看黄色,手柄留着继续微调
    notify('已划线');
  }
  function dropPopMark() {
    var para = pop.para, ids = pop.cov.slice();
    if (!ids.length) return;
    S.marks = S.marks.filter(function (m) { return ids.indexOf(m.i) < 0; });
    saveNow();
    closePop();
    paintParaMarks(para);
    notify(ids.length > 1 ? '已取消 ' + ids.length + ' 条划线' : '已取消划线');
  }
  function copyPopText() {
    var t = popText();
    if (!t) return;
    if (window.Android && typeof window.Android.copyText === 'function') {
      window.Android.copyText(t);
    } else notify('当前环境不能复制');
  }
  function translatePopText() {
    var t = popText();
    if (!t || pop.busy) return;
    if (scCache[t]) { pop.zh = scCache[t]; pop.fail = false; renderPop(); return; }
    pop.busy = true;
    pop.zh = '';
    renderPop();
    translateChunk([t], 0, 1).then(function (arr) {
      var zh = String((arr && arr[0]) || '').trim();
      pop.busy = false;
      if (zh) keepSentTrans(t, zh);
      if (!pop.on) return;
      pop.fail = !zh;
      pop.zh = zh || '译文没取到,稍后再试';
      renderPop();
    }, function () {
      pop.busy = false;
      if (!pop.on) return;
      pop.fail = true;
      pop.zh = '译文没取到,稍后再试';
      renderPop();
    });
  }
  // 笔记不要手动保存:点 ×、失焦、关掉浮层都写进同一条,也不弹提示。
  function savePopNote() {
    var m = markById(pop.id), el = $('#popNote');
    if (m && el) { m.n = String(el.value).slice(0, 800); saveNow(); }
  }
  function popAct(act) {
    if (act === 'close') { closePop(); return; }
    if (act === 'sentence') {
      var r = selRange(), rs = sentenceRanges(popParaText());
      var lo = r[0], hi = r[1];
      for (var i = 0; i < rs.length; i++) {
        if (r[1] > rs[i].start && r[0] < rs[i].end) {
          lo = Math.min(lo, rs[i].start);
          hi = Math.max(hi, rs[i].end);
        }
      }
      pop.ranges = [[lo, hi]];
      syncSel();
      return;
    }
    if (act === 'copy') { copyPopText(); return; }
    if (act === 'trans') { translatePopText(); return; }
    if (act === 'mark') { doMark(); return; }
    if (act === 'unmark') {
      if (!pop.confirm) { pop.confirm = true; renderPop(); return; }
      dropPopMark();
      return;
    }
    if (act === 'note') {
      pop.note = true;
      renderPop();
      var box = $('#popNote');
      if (box) box.focus();
      return;
    }
    if (act === 'note-done') { savePopNote(); pop.note = false; renderPop(); }
  }

  /* ---- 收藏页「划线」tab ---- */
  function markSnipHTML(text, rs, base) {
    var out = '', pos = 0;
    for (var i = 0; i < rs.length; i++) {
      var a = Math.max(+rs[i][0], base) - base;
      var b = Math.min(+rs[i][1], base + text.length) - base;
      if (b <= a || a < pos) continue;
      out += esc(text.slice(pos, a)) + '<b class="mk-hl">' + esc(text.slice(a, b)) + '</b>';
      pos = b;
    }
    return out + esc(text.slice(pos));
  }
  function markCardHTML(m) {
    var art = A_MAP[m.s];
    var sent = String(art.p[+m.p]).slice(+m.a, +m.b);
    var sure = mkConfirm === m.i;
    return '<div class="mk-card" data-mk="' + esc(m.i) + '">'
      + '<div class="mk-sent">' + markSnipHTML(sent, m.r, +m.a) + '</div>'
      + '<textarea class="mk-note" data-mk-note="' + esc(m.i) + '" rows="1" maxlength="800" '
      + 'placeholder="给这句记点笔记">' + esc(m.n || '') + '</textarea>'
      + '<div class="mk-zh" data-mk-zh="' + esc(m.i) + '" hidden></div>'
      + '<div class="mk-row"><span class="mk-meta">' + esc(artTitle(art)) + ' · '
      + esc(timeLabel(+m.t)) + '</span>'
      + '<button class="lnk" data-act="mk-tr">翻译</button>'
      + '<button class="lnk" data-act="mk-go">查看原文</button>'
      + '<button class="lnk del' + (sure ? ' sure' : '') + '" data-act="mk-del">'
      + (sure ? '确认删除' : '删除') + '</button></div></div>';
  }
  function marksTabHTML() {
    var list = liveMarks();
    if (!list.length) {
      return '<div class="card"><div class="fav-empty">还没有划线<br>'
        + '<span class="tiny">阅读时长住一个词,再拖两端就能划出整句</span></div></div>';
    }
    return '<div class="card mk-sec"><div class="card-title">✎划线句子 '
      + '<span class="tiny muted">' + list.length + ' 条</span></div>'
      + list.map(markCardHTML).join('') + '</div>';
  }
  function saveMarkNote(id, text) {
    var m = markById(id);
    if (!m) return false;
    m.n = String(text || '').slice(0, 800);
    saveNow();
    return true;
  }
  function markCardAct(act, card) {
    var m = markById(card.dataset.mk);
    if (!m) return;
    if (act === 'mk-del') {
      if (mkConfirm !== m.i) { mkConfirm = m.i; renderFavorites(); return; }
      mkConfirm = '';
      deleteMark(m.i);
      renderFavorites();
      notify('已删除划线');
      return;
    }
    if (act === 'mk-go') { openMarkOrigin(m.i); return; }
    if (act === 'mk-tr') { translateMarkCard(m, card); }
  }
  function translateMarkCard(m, card) {
    var box = card.querySelector('[data-mk-zh]');
    if (!box || mkZhBusy) return;
    var sent = String(A_MAP[m.s].p[+m.p]).slice(+m.a, +m.b).trim();
    if (!sent) return;
    box.hidden = false;
    if (scCache[sent]) { box.textContent = scCache[sent]; return; }
    mkZhBusy = m.i;
    box.textContent = '翻译中…';
    fetchOneSentence(sent, function (zh) {
      mkZhBusy = '';
      if (box.parentNode) box.textContent = zh || '译文没取到,稍后再试';
    });
  }
  function openMarkOrigin(id) {
    var m = markById(id);
    if (!m) return;
    openReader(m.s);
    if (!readerStem) return;
    var el = $('.para[data-para="' + (+m.p) + '"]');
    if (!el) return;
    var nodes = [];
    wordSpans(el).forEach(function (s) {
      if (rangesHit(m.r, s.start, s.end)) nodes.push(s.el);
    });
    flashSpans(el, nodes);
  }

  /* ---------------- 事件 ---------------- */
  var viewEl = $('#view');
  // 手机上滚动时浏览器也可能补一个 click，先记下手指位移再决定认不认。
  var tapGuard = { x: 0, y: 0, moved: false, when: 0 };
  var swipe = { on: false, x: 0, y: 0, dx: 0, v: 0, locked: '', mode: '',
                lastX: 0, lastT: 0 };
  function swipeMode() {
    if (swap.busy || readerStem) return '';
    if (document.body.classList.contains('reader')) return '';
    if (!$('#sheet').classList.contains('hidden')) return '';
    if (current === 'read' || current === 'review') return 'levels';
    if (TAB_IDS.indexOf(current) >= 0) return 'tabs';
    return '';
  }
  viewEl.addEventListener('touchstart', function (e) {
    var t = e.touches[0];
    if (!t) return;
    tapGuard.x = t.clientX; tapGuard.y = t.clientY;
    tapGuard.moved = false;
    tapGuard.when = Date.now();
    swipe.on = false;
    swipe.locked = '';
    swipe.mode = swipeMode();
    if (!swipe.mode) return;
    swipe.on = true;
    swipe.x = t.clientX;
    swipe.y = t.clientY;
    swipe.dx = 0;
    swipe.v = 0;
    swipe.lastX = t.clientX;
    swipe.lastT = Date.now();
  }, { passive: true });
  document.addEventListener('touchmove', function (e) {
    var t = e.touches[0];
    if (!t) return;
    // 位移记录要在 swipe.on 判断之前:不翻页的页面(阅读页等)也要防滚动补 click。
    if (Math.abs(t.clientX - tapGuard.x) > 10 || Math.abs(t.clientY - tapGuard.y) > 10) {
      tapGuard.moved = true;
    }
    if (!swipe.on) return;
    var dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
    var now = Date.now();
    var dt = now - swipe.lastT;
    if (dt > 0) {
      swipe.v = (t.clientX - swipe.lastX) / dt;
      swipe.lastX = t.clientX;
      swipe.lastT = now;
    }
    if (!swipe.locked) {
      if (Math.abs(dx) < SWAP_LOCK && Math.abs(dy) < SWAP_LOCK) return;
      if (Math.abs(dy) >= Math.abs(dx)) {
        // 认成上下滚动,本次不再翻页。
        swipe.on = false;
        return;
      }
      swipe.locked = 'h';
      swapStart(swipe.mode, dx < 0 ? 1 : -1);
    }
    swipe.dx = dx;
    if (e.cancelable) e.preventDefault();   // 翻页期间锁住页面滚动
    swapFollow(dx);
  }, { passive: false });
  document.addEventListener('touchend', function (e) {
    if (!swipe.on) return;
    var claimed = swipe.locked === 'h';
    var t = e.changedTouches && e.changedTouches[0];
    var dx = t ? (t.clientX - swipe.x) : swipe.dx;
    swipe.on = false;
    swipe.locked = '';
    if (!claimed) return;
    // 只有真翻页才吃掉这次点击,普通 tap 照常响应。
    tapGuard.moved = true;
    var w = swap.w;
    var far = Math.abs(dx) >= w * SWAP_RATIO;
    var flick = Math.abs(swipe.v) >= SWAP_VEL && ((swipe.v < 0) === (dx < 0));
    swapSettle(!swap.edge && (far || flick));
  }, { passive: true });
  document.addEventListener('touchcancel', function () {
    var claimed = swipe.on && swipe.locked === 'h';
    swipe.on = false;
    swipe.locked = '';
    if (claimed) swapSettle(false);
  }, { passive: true });
  window.stepLevel = stepLevel;

  // 长按译文删除;独立监听,不碰 .para 的点击和朗读播放头。
  var trPress = { timer: 0, x: 0, y: 0 };
  function cancelTransPress() {
    if (trPress.timer) {
      clearTimeout(trPress.timer);
      trPress.timer = 0;
    }
  }
  viewEl.addEventListener('touchstart', function (e) {
    cancelTransPress();
    if (!readerStem) return;
    var t = e.touches[0];
    var el = e.target.closest && e.target.closest('.trans[data-tr]');
    if (!t || !el || el.hidden) return;
    var stem = readerStem, idx = +el.dataset.tr;
    trPress.x = t.clientX;
    trPress.y = t.clientY;
    trPress.timer = setTimeout(function () {
      trPress.timer = 0;
      if (readerStem !== stem) return;
      var sel = window.getSelection && window.getSelection();
      if (sel && sel.removeAllRanges) sel.removeAllRanges();
      tapGuard.moved = true;
      deleteTransAt(stem, idx);
    }, 600);
  }, { passive: true });
  viewEl.addEventListener('touchmove', function (e) {
    if (!trPress.timer) return;
    var t = e.touches[0];
    if (!t) return;
    if (Math.abs(t.clientX - trPress.x) > 10 || Math.abs(t.clientY - trPress.y) > 10) {
      cancelTransPress();
    }
  }, { passive: true });
  viewEl.addEventListener('touchend', cancelTransPress, { passive: true });
  viewEl.addEventListener('touchcancel', cancelTransPress, { passive: true });
  viewEl.addEventListener('contextmenu', function (e) {
    if (e.target.closest && e.target.closest('.trans')) e.preventDefault();
    if (pop.on) e.preventDefault();
  });

  // 长按正文单词:弹自己的划线菜单。500ms 内没移动才算长按,和上下滚动区分开。
  // 弹出之后手指不用抬起,接着左右拖就直接扩选;松手后手柄照旧能细调。
  var lp = { timer: 0, x: 0, y: 0, fired: false, id: -1, a: 0, b: 0, dragging: false };
  function cancelLongPress() {
    if (lp.timer) {
      clearTimeout(lp.timer);
      lp.timer = 0;
    }
  }
  function lpEndDrag() {
    if (!lp.dragging) return;
    lp.dragging = false;
    if (popEl) popEl.classList.remove('dragging');   // 把手柄的命中区放回来
  }
  viewEl.addEventListener('touchstart', function (e) {
    cancelLongPress();
    // 第二根手指落下:退出拖动,也不再重新计时,免得又弹一次菜单。
    if (e.touches.length > 1) {
      lpEndDrag();
      lp.fired = false;
      lp.id = -1;
      return;
    }
    if (!readerStem || swap.busy) return;
    var t = e.touches[0];
    var span = e.target.closest && e.target.closest('.para .w');
    var paraEl = span && span.closest('.para');
    if (!t || !span || !paraEl) return;
    lp.x = t.clientX;
    lp.y = t.clientY;
    lp.fired = false;
    lp.dragging = false;
    lp.id = t.identifier;
    var stem = readerStem;
    lp.timer = setTimeout(function () {
      lp.timer = 0;
      if (readerStem !== stem) return;
      lp.fired = true;
      popOpenFor(span, paraEl);
      // 记下起手那个词的区间,后面按这个锚点往两头扩。
      if (pop.on) {
        var r = selRange();
        lp.a = r[0];
        lp.b = r[1];
      }
    }, 500);
  }, { passive: true });
  viewEl.addEventListener('touchmove', function (e) {
    if (!lp.timer) return;
    var t = e.touches[0];
    if (!t) return;
    if (Math.abs(t.clientX - lp.x) > 10 || Math.abs(t.clientY - lp.y) > 10) cancelLongPress();
  }, { passive: true });
  // 长按之后的同一次手势继续拖动 = 扩选。必须非 passive,否则拦不住滚动和翻页。
  // 只在同一根手指(identifier 相同)上生效,拖动期间给 #pop 挂 dragging 让手柄不吃命中。
  viewEl.addEventListener('touchmove', function (e) {
    if (!lp.fired || !pop.on) return;
    var t = null;
    for (var i = 0; i < e.touches.length; i++) {
      if (e.touches[i].identifier === lp.id) { t = e.touches[i]; break; }
    }
    if (!t) return;
    var dx = t.clientX - lp.x, dy = t.clientY - lp.y;
    if (!lp.dragging) {
      // 竖着走就是滚动,不抢这一下,菜单留在原地等松手。
      if (Math.abs(dy) > Math.abs(dx)) return;
      if (Math.abs(dx) < 8) return;
      lp.dragging = true;
      if (popEl) popEl.classList.add('dragging');
    }
    if (e.cancelable) e.preventDefault();
    var off = offsetAt(t.clientX, t.clientY);
    if (off === null) return;                       // 拖到行间空白:这次不动
    var lo = Math.min(off, lp.a), hi = Math.max(off, lp.b);
    if (lo === hi) return;
    pop.ranges = [[lo, hi]];
    syncSel();
  }, { passive: false });
  viewEl.addEventListener('touchend', function (e) {
    cancelLongPress();
    lpEndDrag();
    // 长按(或拖动)之后浏览器还要补一次 click;菜单是页面自己画的,这次补击直接吃掉。
    if (lp.fired) {
      lp.fired = false;
      if (e.cancelable) e.preventDefault();
    }
  }, { passive: false });
  viewEl.addEventListener('touchcancel', function () {
    cancelLongPress();
    lpEndDrag();
    lp.fired = false;
  }, { passive: true });
  document.addEventListener('touchstart', function (e) {
    if (!pop.on) return;
    if (e.target.closest && e.target.closest('#pop')) return;
    closePop();
  }, { passive: true });
  var popEl = $('#pop');
  if (popEl) popEl.addEventListener('click', function (e) {
    var b = e.target.closest('[data-pop]');
    if (b) popAct(b.dataset.pop);
  });
  // 拖两端手柄改选区:触点用 caretRangeFromPoint 换成段内字符偏移,拖出这一段就截断到段首/段尾。
  // 拖的时候给 #pop 挂 dragging 把手柄改成不吃命中,否则测到的是手柄自己。
  function handleStart(e) {
    if (!pop.on || pop.note || hd.on) return;
    var t = e.touches[0];
    if (!t) return;
    hd.on = true;
    hd.side = e.currentTarget.dataset.hd;
    if (popEl) popEl.classList.add('dragging');
    if (e.cancelable) e.preventDefault();
  }
  function handleMove(e) {
    if (!hd.on) return;
    var t = e.touches[0];
    if (!t) return;
    if (e.cancelable) e.preventDefault();   // 拖手柄不许带动页面滚动,也不给翻页
    var off = offsetAt(t.clientX, t.clientY);
    if (off === null) return;
    var r = selRange(), len = popParaText().length;
    var lo = hd.side === 'l' ? Math.min(off, r[1] - 1) : r[0];
    var hi = hd.side === 'r' ? Math.max(off, r[0] + 1) : r[1];
    lo = clamp(lo, 0, len);
    hi = clamp(hi, 0, len);
    if (hi <= lo || (lo === r[0] && hi === r[1])) return;
    pop.ranges = [[lo, hi]];
    syncSel();
  }
  function handleEnd(e) {
    if (!hd.on) return;
    hd.on = false;
    hd.side = '';
    if (popEl) popEl.classList.remove('dragging');
    // 松手后浏览器会在落点补一次 click,浮层正跟着选区跑,很容易被它点到「记笔记」。
    if (e && e.cancelable) e.preventDefault();
  }
  $$('.sel-hd').forEach(function (el) {
    el.addEventListener('touchstart', handleStart, { passive: false });
    el.addEventListener('touchmove', handleMove, { passive: false });
    el.addEventListener('touchend', handleEnd, { passive: false });
    el.addEventListener('touchcancel', handleEnd, { passive: false });
  });
  // 记笔记时点别处、键盘收起都算失焦:直接落库,不弹提示。
  if (popEl) popEl.addEventListener('focusout', function (e) {
    if (e.target && e.target.id === 'popNote') savePopNote();
  });
  function tapIsSwipe() {
    var moved = tapGuard.moved;
    tapGuard.moved = false;
    return moved;
  }
  viewEl.addEventListener('click', function (e) {
    var ctx = e.target.closest('.ctx');
    if (ctx && current === 'review') {
      if (tapGuard.moved) { tapGuard.moved = false; return; }
      var trBtn = e.target.closest('[data-ctx-tr]');
      if (trBtn) { toggleCtxZh(ctx, +trBtn.dataset.ctxTr); return; }
      var ctxStem = ctx.dataset.stem;
      var ctxIdx = +ctx.dataset.para;
      if (e.target.closest('.ctx-src') || !revCloze) {
        openReaderAt(ctxStem, ctxIdx, revWord);
        return;
      }
      revReveal = !revReveal;
      renderReview(revWord, { keep: true, keepScroll: true });
      return;
    }
    if (tapIsSwipe()) return;
    // 滑动过渡进行中(含动画)不接受任何跳转,否则 ghost 与 #view 的内容会错乱。
    if (swap.busy) return;
    // 复习卡例句:「原文 ›」在整句之上,先认它,否则会被整句那一下吃掉。
    var fcGo = e.target.closest('[data-fc-go]');
    if (fcGo) { fcSentGo(+fcGo.dataset.fcGo); return; }
    var fcSent = e.target.closest('[data-fc-sent]');
    if (fcSent) { fcSentOpen(+fcSent.dataset.fcSent); return; }
    // 复习主页搜词的建议行:开卡片顺手收键盘。
    var fcW = e.target.closest('[data-fc-word]');
    if (fcW) {
      var fcQ = $('#fcSearchQ');
      if (fcQ) fcQ.blur();
      openWord(fcW.dataset.fcWord, false, '');
      return;
    }
    // 菜单还开着时,正文单词的那次补击不算点词(正常已由 touchend 拦掉)。
    if (pop.on && e.target.closest('.para .w')) { tapIsSwipe(); return; }
    // 朗读中点正文 = 拖动播放头，优先于词典和译文展开
    if (tts.on && readerStem) {
      var tapPara = e.target.closest('.para');
      if (tapPara) {
        var tapIdx = +tapPara.dataset.para;
        var artTts = A_MAP[tts.stem];
        if (artTts && artTts.p && tapIdx >= 0 && tapIdx < artTts.p.length) {
          var off = tapCharOffset(tapPara, e.clientX, e.clientY);
          tts.idx = tapIdx;
          tts.sent = off >= 0 ? sentenceAt(artTts.p[tapIdx], off) : 0;
          speakUnit();
        }
        return;
      }
    }
    // 单词:阅读正文里的点查
    var w = e.target.closest('.w');
    if (w && readerStem) {
      e.stopPropagation();
      speakWordOnce(w.dataset.w);
      openWord(w.dataset.w, true, tapSentence(w.closest('.para'), e.clientX, e.clientY));
      return;
    }
    // 段落空白处:展开/收起这一段译文
    var p = e.target.closest('[data-para]');
    if (p && !e.target.closest('.w')) {
      var tr = document.querySelector('.trans[data-tr="' + p.dataset.para + '"]');
      if (tr) tr.hidden = !tr.hidden;
      else if (readerStem && A_MAP[readerStem] && missingTrans(A_MAP[readerStem]).length) {
        notify('这段还没有译文,点右上「AI 译」');
      }
      return;
    }
    // 书架:展开/收起一本书;先判删除,避免点删除时也展开
    var db = e.target.closest('[data-del-book]');
    if (db) { deleteBook(db.dataset.delBook); return; }
    var rb = e.target.closest('[data-reread-book]');
    if (rb) { rereadBook(rb.dataset.rereadBook); return; }
    var bh = e.target.closest('[data-book-toggle]');
    if (bh) {
      var bk = bh.dataset.bookToggle, grp = bh.parentNode;
      var b = groupOfKey(bk);
      openBooks[bk] = !openBooks[bk];
      // 只动这一组:整架 renderRead() 会把几百行全重建,点一次 30ms、逐本点开要 2 秒。
      if (!b || !grp || !grp.classList) { renderRead(); return; }
      grp.classList.toggle('open', !!openBooks[bk]);
      var body = grp.querySelector('.book-body');
      if (openBooks[bk]) { if (!body) grp.insertAdjacentHTML('beforeend', bookBodyHTML(b)); }
      else if (body) grp.removeChild(body);
      return;
    }
    var gl = e.target.closest('[data-goal]');
    if (gl) { setGoal(gl.dataset.goal); return; }
    var transBtn = e.target.closest('[data-trans-provider]');
    if (transBtn) {
      S.settings.trans_provider = transBtn.dataset.transProvider === 'deepseek'
        ? 'deepseek' : 'tencent';
      saveNow();
      renderDataSettings();
      return;
    }
    var themeBtn = e.target.closest('.seg [data-theme]');
    if (themeBtn) {
      S.settings.theme = themeBtn.dataset.theme;
      applyTheme();
      saveNow();
      if (current === 'set-appearance') renderAppearance();
      return;
    }
    var ft = e.target.closest('[data-favtab]');
    if (ft && ft.dataset.favtab !== favTab) {
      favScroll[favTab] = $('#view').scrollTop;
      favTab = ft.dataset.favtab;
      renderFavorites();
      // 划线从右进、文章从左回,方向感和层级推入/返回一致。
      if (ANIM_ON) playViewAnim(favTab === 'mk' ? 'anim-push' : 'anim-pop');
      return;
    }
    var favRemove = e.target.closest('[data-fav-remove]');
    if (favRemove) { removeFav(favRemove.dataset.favRemove); return; }
    var favMove = e.target.closest('[data-fav-move]');
    if (favMove) { moveFavSheet(favMove.dataset.favMove); return; }
    var favRename = e.target.closest('[data-fav-rename]');
    if (favRename) { renameFolderSheet(favRename.dataset.favRename); return; }
    var favDel = e.target.closest('[data-fav-delfolder]');
    if (favDel) { deleteFolder(favDel.dataset.favDelfolder); return; }
    var rr = e.target.closest('[data-reread]');
    if (rr) { rereadArticle(rr.dataset.reread); return; }
    var stem = e.target.closest('[data-stem]');
    if (stem) { openReader(stem.dataset.stem, rememberEntry(stem)); return; }
    var wf = e.target.closest('[data-wb-filter]');
    if (wf) {
      wbFilter = wf.dataset.wbFilter;
      wbLimit = 160;
      renderWords();
      return;
    }
    var wr = e.target.closest('[data-word]');
    if (wr) { openWord(wr.dataset.word, false); return; }
    var rw = e.target.closest('[data-rev-word]');
    if (rw) { reviewWord(rw.dataset.revWord); return; }

    var act = e.target.closest('[data-act]');
    if (!act) return;
    var a = act.dataset.act;
    if (a === 'go-words') go('words');
    else if (a === 'go-done') go('done');
    else if (a === 'go-history') go('history');
    else if (a === 'go-favs') go('favs');
    else if (a === 'go-set') go('set');
    else if (a === 'go-appearance') go('set-appearance');
    else if (a === 'go-voice') go('set-voice');
    else if (a === 'go-data') go('set-data');
    else if (a === 'go-update') go('set-update');
    else if (a === 'go-mirror') go('set-mirror');
    else if (a === 'mirror-sync') syncMirrors();
    else if (a === 'mirror-refresh') {
      mirrorSync = { state: 'busy', text: '正在更新下载源…' };
      renderUpdate();
      syncMirrors();
    }
    else if (a === 'mirror-reset') {
      resetMirrors();
      mirrorSync = { state: 'ok', text: '已恢复默认清单' };
      renderMirrorSettings();
    }
    else if (a === 'update-check') runUpdateCheck();
    else if (a === 'topic') {
      var lv = +act.dataset.lv || readLevel;
      topicPick[lv] = +act.dataset.topic || 0;
      var keepY = $('#view').scrollTop;
      $('#view').innerHTML = levelListHTML(lv);
      $('#view').scrollTop = keepY;
    }
    else if (a === 'update-download') downloadLatestPage(-1);
    else if (a === 'update-mirror1') downloadLatestPage(0);
    else if (a === 'update-mirror2') downloadLatestPage(1);
    else if (a === 'update-home') openGH(GH_HOME);
    else if (a === 'update-release') openGH(GH_RELEASES);
    else if (a === 'update-view') go('set-update');
    else if (a === 'apk-install') {
      if (window.Android && typeof window.Android.installVerified === 'function') {
        window.Android.installVerified();
      } else notify('请在安装版 App 中操作');
    }
    else if (a === 'apk-pause') pauseApkDownload();
    else if (a === 'apk-resume') resumeApkDownload();
    else if (a === 'update-banner-close') {
      if (latestRel) { S.settings.update_skip = latestRel.version; saveNow(); }
      var bn = e.target.closest('.up-banner');
      if (bn) bn.remove();
    }
    else if (a === 'update-copy-hash') {
      var h = updateHash();
      if (!h) { notify('还没拿到哈希'); return; }
      if (window.Android && typeof window.Android.copyText === 'function') {
        window.Android.copyText(h);
        notify('哈希已复制');
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(h).then(function () { notify('哈希已复制'); });
      } else notify('当前环境不能复制');
    }
    else if (a === 'go-about') go('set-about');
    else if (a === 'finish') finishArticle(readerStem);
    else if (a === 'clear-trans') clearArticleTrans(readerStem);
    else if (a === 'reread') rereadCurrent();
    else if (a === 'next') nextArticle();
    else if (a === 'prev') prevArticle();
    else if (a === 'toc') tocSheet();
    else if (a === 'mk-tr' || a === 'mk-go' || a === 'mk-del') {
      var mkCard = e.target.closest('.mk-card');
      if (mkCard) markCardAct(a, mkCard);
    }
    else if (a === 'wb-more') { wbLimit += 200; renderWordbookList(); }
    else if (a === 'fc-start') fcStart();
    else if (a === 'fc-pass') fcJudge(true);
    else if (a === 'fc-fail') fcJudge(false);
    else if (a === 'fc-next') fcNext();
    else if (a === 'fc-mistake') fcMistake();
    else if (a === 'fc-undo') fcUndo();
    else if (a === 'fc-home') fcEnd();
    else if (a === 'fc-more') reviewWord(fc.queue[fc.i]);
    else if (a === 'rev-go') {
      var inp = $('#revInput');
      reviewWord(inp ? inp.value.trim() : '');
    } else if (a === 'rev-reroll') renderReview(revWord, { reroll: true });
    else if (a === 'rev-no') {
      markUnknown(headOf(revWord)); dropCaches();
      notify('已标为「我不会」');
      renderReview(revWord, { keep: true, keepScroll: true });
    } else if (a === 'rev-known') {
      markKnown(headOf(revWord)); dropCaches();
      notify('已标记为「已掌握」');
      renderReview(revWord, { keep: true, keepScroll: true });
    } else if (a === 'font-inc' || a === 'font-dec') {
      var f = clamp((+S.settings.font_size || 19) + (a === 'font-inc' ? 1 : -1), 15, 28);
      S.settings.font_size = f;
      applyReaderFont();
      saveNow();
      renderAppearance();
    } else if (a === 'goal-inc' || a === 'goal-dec') {
      var g = clamp((+S.settings.goal_words || 150) + (a === 'goal-inc' ? 25 : -25), 25, 1000);
      S.settings.goal_words = g;
      saveNow();
      renderAppearance();
    } else if (a === 'rate-inc' || a === 'rate-dec') {
      var r = clamp(Math.round((((+S.settings.tts_rate) || 0.9) + (a === 'rate-inc' ? 0.05 : -0.05)) * 100) / 100, 0.5, 2);
      S.settings.tts_rate = r;
      applyVoiceSettings();
      saveNow();
      renderVoiceSettings();
    } else if (a === 'pitch-inc' || a === 'pitch-dec') {
      var p = clamp(Math.round((((+S.settings.tts_pitch) || 1.0) + (a === 'pitch-inc' ? 0.05 : -0.05)) * 100) / 100, 0.5, 2);
      S.settings.tts_pitch = p;
      applyVoiceSettings();
      saveNow();
      renderVoiceSettings();
    } else if (a === 'tts-demo') {
      speakDemo();
    } else if (a === 'tts-engine') {
      if (window.Android && typeof window.Android.ttsOpenSettings === 'function') window.Android.ttsOpenSettings();
      else notify('这台设备上没有可打开的语音设置');
    } else if (a === 'tts-pack-download') {
      startTtsPackDownload();
    } else if (a === 'tts-pause') {
      pauseTtsPackDownload();
    } else if (a === 'tts-resume') {
      resumeTtsPackDownload();
    } else if (a === 'tts-store') {
      if (window.Android && typeof window.Android.openTtsStore === 'function') window.Android.openTtsStore();
      else notify('请到应用商店搜索「Speech Services by Google」');
    } else if (a === 'tts-download') {
      if (window.Android && typeof window.Android.openStore === 'function') window.Android.openStore('com.google.android.tts');
      else notify('请到应用商店搜索「Speech Services by Google」');
    } else if (a === 'app-restart') {
      flushOnHide();   // 先把位置、进度和设置写干净,再让原生重建 Activity
      if (window.Android && typeof window.Android.restartApp === 'function') {
        window.Android.restartApp('voice');
      } else notify('当前环境不能重启');
    } else if (a === 'import') {
      var fi = $('#importFile');
      if (fi) fi.click();
    } else if (a === 'import-book') {
      pickBookFile();
    } else if (a === 'manage-books') {
      manageBooksSheet();
    } else if (a === 'ai-key') {
      keySheet({});
    } else if (a === 'export') exportState();
    else if (a === 'reset') {
      askConfirm('清空进度', '会删掉本机全部阅读记录、生词和统计,恢复成新装状态。确定吗?', true, function () {
        S = defaultState();
        dropCaches();
        ctxCache.clear();
        revWord = ''; revList = []; revBatch = []; revRanked = null;
        saveNow();
        applyTheme();
        applyReaderFont();
        readLevel = null;
        go('read');
        notify('进度已清空');
      });
    }
  });

  viewEl.addEventListener('scroll', function (e) {
    cancelTransPress();
    if (pop.on) closePop();
    if (swap.busy) return;
    if (readerStem) {
      clearTimeout(readPosTimer);
      readPosTimer = setTimeout(captureReadPos, 400);
    }
    if (current === 'read' && !readerStem) {
      clearTimeout(homePosTimer);
      homePosTimer = setTimeout(function () {
        if (current !== 'read' || readerStem) return;
        S.settings.home_pos = { l: readLevel, y: viewEl.scrollTop };
        save();
      }, 300);
    }
    var top = $('#topbar');
    // 列表页一律不要分隔线;只有读文章滚动时才亮(阅读态)。
    if (top) top.classList.toggle('solid', !!readerStem && viewEl.scrollTop > 6);
  }, true);

  // 等级条不在 #view 里,横滚位置和点击都单独挂。
  $('#levelStrip').addEventListener('scroll', function (e) {
    var box = e.target;
    if (!box || !box.classList || !box.classList.contains('chips')) return;
    levelStripScroll = box.scrollLeft;
    syncChipsEdge(box);
  }, true);
  $('#levelStrip').addEventListener('click', function (e) {
    if (swap.busy) return;
    var chip = e.target.closest('.chip[data-level]');
    if (!chip) return;
    var l = +chip.dataset.level;
    if (l === readLevel) return;
    // 和底部 tab 一样走滑动过渡;方向按 chip 在条上的先后。点选不居中,条子保持原位。
    var order = levelOrder();
    var dir = order.indexOf(l) > order.indexOf(readLevel) ? 1 : -1;
    if (!slideTo('levels', dir, l, true)) selectLevel(l);
  });

  // 导入文件在每次渲染「我的」后重新挂一次。
  viewEl.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'importFile') {
      importState(e.target.files && e.target.files[0]);
      e.target.value = '';
      return;
    }
    // 自动检查更新的频率:换档就落盘,不用保存按钮。
    if (e.target && e.target.id === 'updateFreq') {
      S.settings.update_freq = String(e.target.value || 'launch');
      saveNow();
      return;
    }
    // 划线笔记:失焦就落盘,不弹提示、不重渲染,免得打断打字。
    if (e.target && e.target.dataset && e.target.dataset.mkNote) {
      saveMarkNote(e.target.dataset.mkNote, e.target.value);
    }
  });
  // 打字停顿半秒也存一次,手指懒得点别处也不丢。
  var mkType = 0;
  viewEl.addEventListener('input', function (e) {
    if (!e.target || !e.target.dataset || !e.target.dataset.mkNote) return;
    var id = e.target.dataset.mkNote, val = e.target.value;
    clearTimeout(mkType);
    mkType = setTimeout(function () { saveMarkNote(id, val); }, 500);
  });
  // 选书用的输入框在 #view 外,单独挂一次。
  var bookFileEl = $('#bookFile');
  if (bookFileEl) bookFileEl.addEventListener('change', function () {
    importBookFile(bookFileEl.files && bookFileEl.files[0]);
    bookFileEl.value = '';
  });

  // 退到后台/进程被回收前先落盘,不然防抖里的位置和进度会丢。
  function flushOnHide() {
    clearTimeout(readPosTimer);
    readPosTimer = 0;
    captureReadPos();
    if (current === 'read' && !readerStem) S.settings.home_pos = { l: readLevel, y: viewEl.scrollTop };
    saveNow();
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) flushOnHide();
  });
  window.addEventListener('pagehide', flushOnHide);

  // Android 返回键:由外壳调用。
  window.appBack = function () {
    if (!$('#sheet').classList.contains('hidden')) { closeSheet(); return true; }
    if (pop.on) { closePop(); return true; }
    if (readerStem) { stopTTS(); closeReader(); return true; }
    if (current === 'read' && !readerStem) return false;
    goBack();
    return true;
  };

  /* 文件管理器「打开方式」送进来的书:原生侧存成一次性地址,
     这里取回字节后走和「＋→导入图书」完全相同的那条链路。 */
  window.__nativeImport = function (name, url) {
    fetch(url).then(function (r) {
      if (!r.ok) throw new Error('文件已经失效,再走一次「打开方式」');
      return r.arrayBuffer();
    }).then(function (buf) {
      importBookFile(new File([buf], name || 'book.txt'));
    }).catch(function (err) {
      showErrorSheet('导入失败', err && err.message ? err.message : String(err));
    });
  };

  // 原生重启时带的落点:点「语音设置 → 重启」后直接回到那一页,不用再翻一次设置。
  window.__nativeRoute = function (name) {
    if (name === 'voice' && booted) go('set-voice');
  };

  /* ---------------- 走起 ---------------- */
  boot();

  // 词性规则评测用;正常启动没有 posdebug 参数就不挂。
  if (/[?&]posdebug=1/.test(location.search)) {
    // 段落内每个词的起始偏移,坐标系与 tapCharOffset 一致(art.p[i] 逐字对应)。
    window.__posTokens = function (stem, para) {
      var art = A_MAP[stem], text = art && art.p && art.p[para];
      var out = [], m;
      if (!text) return out;
      WORD_RE.lastIndex = 0;
      while ((m = WORD_RE.exec(text))) out.push({ word: m[0], off: m.index });
      WORD_RE.lastIndex = 0;
      return out;
    };
    // 全部走生产函数:同一段落文本、同一句区间、同一个 guessPos。
    window.__posProbe = function (stem, para, off) {
      var art = A_MAP[stem], text = art && art.p && art.p[para];
      if (!text) return null;
      var ranges = sentenceRanges(text), sent = '', i, t, surface = '';
      for (i = 0; i < ranges.length; i++) {
        if (off < ranges[i].end) {
          sent = text.slice(ranges[i].start, ranges[i].end).trim();
          break;
        }
      }
      WORD_RE.lastIndex = 0;
      while ((t = WORD_RE.exec(text))) {
        if (t.index === off) { surface = t[0]; break; }
        if (WORD_RE.lastIndex > off) break;
      }
      WORD_RE.lastIndex = 0;
      if (!sent || !surface) return null;
      var head = headOf(surface);
      var seen = {}, poss = [];
      posLines(lookup(head)[1]).forEach(function (x) {
        if (x.pos && !seen[x.pos]) { seen[x.pos] = 1; poss.push(x.pos); }
      });
      var major = 0;
      ['n', 'v', 'a', 'adv'].forEach(function (g) { if (seen[g]) major++; });
      return {
        word: surface, head: head, poss: poss, major: major,
        proper: isProper(head), stop: !!POS_STOP[String(head).toLowerCase()],
        abbr: /^[A-Z]{2,}$/.test(surface),
        para: para, off: off, sent: sent, guess: guessPos(sent, head)
      };
    };
    // 调规则用:直接喂一个句子切片,看生产函数给什么、各条信号几分。
    window.__posGuess = function (sent, word) { return guessPos(sent, word); };
    window.__posTrace = function (sent, word) {
      var g = guessPos(sent, word);
      return { guess: g, trace: POS_TRACE };
    };
  }
})();
