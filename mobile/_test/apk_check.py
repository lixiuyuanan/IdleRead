# -*- coding: utf-8 -*-
"""A5 自检:核对 APK 版本、内部资源哈希、清单关键项(仅本地校验用)。"""
import hashlib
import json
import os
import re
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SDK = os.environ.get("ANDROID_SDK_ROOT") or os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "Android", "Sdk")
AAPT2 = os.path.join(SDK, "build-tools", "34.0.0", "aapt2.exe")
WWW = os.path.join(ROOT, "android", "app", "src", "main", "assets", "www")
MANIFEST = os.path.join(ROOT, "android", "app", "src", "main", "AndroidManifest.xml")
BUILD_PY = os.path.join(ROOT, "tools", "build_apk.py")
_ver = re.search(r'VERSION_NAME = "([^"]+)"',
                 open(BUILD_PY, encoding="utf-8").read()).group(1)
APK = os.path.join(ROOT, "dist", "闲读-%s-release.apk" % _ver)


def md5(raw):
    return hashlib.md5(raw).hexdigest()


def out(label, value):
    print("%-26s %s" % (label, json.dumps(value, ensure_ascii=True, default=str)))


def main():
    out("apk exists", os.path.exists(APK))
    out("apk size MB", round(os.path.getsize(APK) / 1048576.0, 2))
    zf = zipfile.ZipFile(APK)
    names = zf.namelist()
    out("has classes.dex", "classes.dex" in names)

    # 1) badging
    badging = subprocess.run([AAPT2, "dump", "badging", APK], stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT).stdout.decode("utf-8", "replace")
    pkg = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'",
                    badging)
    out("badging package", list(pkg.groups()) if pkg else badging[:200])
    out("badging label", re.findall(r"application-label:'([^']*)'", badging))

    # 2) 内部资源哈希 vs 源码
    for name in ("app.js", "app.css", "index.html", "data/articles.json"):
        inside = md5(zf.read("assets/www/" + name))
        with open(os.path.join(WWW, name), "rb") as f:
            src = md5(f.read())
        out("md5 " + name, [inside == src, inside, src])

    # 2b) 包内离线数据确实是考研两档
    arts = json.loads(zf.read("assets/www/data/articles.json"))["articles"]
    counts = {}
    for a in arts:
        counts[a["l"]] = counts.get(a["l"], 0) + 1
    out("apk articles total", len(arts))
    out("apk level counts", sorted(counts.items()))
    out("apk old level6 gone", [a["s"] for a in arts
                                if a["s"] in ("12-3", "11-4", "10-8", "11-9",
                                              "12-11", "12-15", "12-16",
                                              "12-19", "12-20")])

    # 3) APK 内清单关键项
    xml = subprocess.run([AAPT2, "dump", "xmltree", "--file", "AndroidManifest.xml", APK],
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT
                        ).stdout.decode("utf-8", "replace")
    out("apk TTS_SERVICE queries", "android.intent.action.TTS_SERVICE" in xml)
    out("apk WebPageActivity", "WebPageActivity" in xml)
    out("apk PLAY_STORE entry", "com.android.vending" in xml)
    # 1.6.4 应用内安装:少了这两项,下完只会停在「点通知安装」或直接崩溃
    out("apk ApkProvider", "com.ldleread.app.apk" in xml and "ApkProvider" in xml)
    out("apk INSTALL_PACKAGES", "REQUEST_INSTALL_PACKAGES" in xml)
    with open(MANIFEST, encoding="utf-8") as f:
        mtxt = f.read()
    out("src TTS_SERVICE queries", "android.intent.action.TTS_SERVICE" in mtxt)
    out("src WebPageActivity", "WebPageActivity" in mtxt)

    # 4) ES5 违规检查
    js = zf.read("assets/www/app.js").decode("utf-8")
    lines = [ln.strip() for ln in js.splitlines()
             if re.search(r"\?\.[a-zA-Z_$]|\?\?|=>|(^|\s)(let|const)\s|`", ln)
             and "```" not in ln]
    out("es5 violations", lines[:6])
    out("APP_VERSION in apk", re.findall(r"var APP_VERSION = '([^']+)'", js))
    out("apk LEVEL_NAMES", re.findall(r"var LEVEL_NAMES = \{[^}]*\}", js))
    out("apk levelOrder", re.findall(r"return \[90[^\]]*\]", js))
    out("apk readLevel range", re.findall(r"\(lv >= 2 && lv <= \d\)", js))
    out("version triple", [pkg.groups() if pkg else None,
                           re.findall(r"VERSION_NAME = \"([^\"]+)\"",
                                      open(os.path.join(ROOT, "tools", "build_apk.py"),
                                         encoding="utf-8").read()),
                           re.findall(r"var APP_VERSION = '([^']+)'", js)])


if __name__ == "__main__":
    main()
