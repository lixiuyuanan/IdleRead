# -*- coding: utf-8 -*-
"""一键发布闲读新版本到 GitHub Releases。

会先校验版本号三处一致、APK 内容与源码一致、清单与 ES5 无回归,
任何一项不过就中止,不会上传。

用法:
    python release.py --dry-run                 只校验,不发布
    python release.py --notes "本次改动…"        发布并写说明
    python release.py --notes-file notes.md     说明从文件读
    python release.py --build --notes "…"       先构建再发布
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
TOOLS = os.path.join(ROOT, "tools")
WWW = os.path.join(ROOT, "android", "app", "src", "main", "assets", "www")
MANIFEST = os.path.join(ROOT, "android", "app", "src", "main", "AndroidManifest.xml")
APP_JS = os.path.join(WWW, "app.js")
BUILD_PY = os.path.join(TOOLS, "build_apk.py")
APK_CHECK = os.path.join(ROOT, "_test", "apk_check.py")
SDK = os.environ.get("ANDROID_SDK_ROOT") or os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "Android", "Sdk")
AAPT2 = os.path.join(SDK, "build-tools", "34.0.0", "aapt2.exe")
REPO = "lixiuyuanan/IdleRead"


def fail(msg):
    print("\n[中止] " + msg)
    sys.exit(1)


def ok(msg):
    print("  ✓ " + msg)


def gh_exe():
    found = shutil.which("gh")
    if found:
        return found
    for path in (r"C:\Program Files\GitHub CLI\gh.exe",
                 os.path.expandvars(r"%LOCALAPPDATA%\GitHubCLI\gh.exe")):
        if os.path.exists(path):
            return path
    fail("找不到 gh 命令,请先安装 GitHub CLI 并 gh auth login")


def gh(args, check=True):
    proc = subprocess.run([gh_exe()] + args, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True, encoding="utf-8",
                          errors="replace")
    if check and proc.returncode != 0:
        fail("gh %s 失败:\n%s" % (" ".join(args), (proc.stderr or proc.stdout).strip()))
    return proc


def read_version():
    js = open(APP_JS, encoding="utf-8").read()
    m_ver = re.search(r"var APP_VERSION = '([^']+)'", js)
    m_code = re.search(r"var APP_CODE = (\d+)", js)
    if not m_ver or not m_code:
        fail("app.js 里找不到 APP_VERSION / APP_CODE")
    mtxt = open(MANIFEST, encoding="utf-8").read()
    m_name = re.search(r'android:versionName="([^"]+)"', mtxt)
    m_vcode = re.search(r'android:versionCode="(\d+)"', mtxt)
    if not m_name or not m_vcode:
        fail("AndroidManifest.xml 里找不到 versionName / versionCode")
    ptxt = open(BUILD_PY, encoding="utf-8").read()
    m_pname = re.search(r'VERSION_NAME = "([^"]+)"', ptxt)
    m_pcode = re.search(r'VERSION_CODE = "(\d+)"', ptxt)
    if not m_pname or not m_pcode:
        fail("build_apk.py 里找不到 VERSION_NAME / VERSION_CODE")
    return {
        "app_js": (m_ver.group(1), m_code.group(1)),
        "manifest": (m_name.group(1), m_vcode.group(1)),
        "build_py": (m_pname.group(1), m_pcode.group(1)),
    }


def check_version_triple():
    v = read_version()
    pairs = [("app.js", v["app_js"]), ("AndroidManifest", v["manifest"]),
             ("build_apk.py", v["build_py"])]
    for name, (ver, code) in pairs:
        ok("%s: %s (%s)" % (name, ver, code))
    versions = set(p[1][0] for p in pairs)
    codes = set(p[1][1] for p in pairs)
    if len(versions) != 1 or len(codes) != 1:
        fail("三处版本号不一致: %s" % json.dumps(dict(pairs), ensure_ascii=False))
    version, code = pairs[0][1]
    if not re.match(r"^\d+\.\d+\.\d+(\.\d+)?$", version):
        fail("版本号格式不是 x.y.z 或 x.y.z.w: %s" % version)
    return version, code


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def run_apk_check(apk_path):
    proc = subprocess.run([sys.executable, APK_CHECK], stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                          errors="replace", cwd=ROOT)
    text = proc.stdout or ""
    if proc.returncode != 0:
        fail("apk_check.py 运行失败:\n" + text[-3000:])
    return text


def parse_apk_check(text, version, code):
    def line(label):
        for ln in text.splitlines():
            if ln.startswith(label):
                return ln[len(label):].strip()
        return None

    badging = line("badging package")
    if not badging:
        fail("apk_check 没输出 badging package")
    try:
        vals = json.loads(badging)
    except ValueError:
        vals = re.findall(r"'([^']*)'", badging)
    if not isinstance(vals, list) or len(vals) < 3:
        fail("badging 解析失败: " + badging)
    pkg, vcode, vname = vals[0], vals[1], vals[2]
    if vname != version or vcode != code:
        fail("包内版本 %s(%s) 与源码 %s(%s) 不一致" % (vname, vcode, version, code))
    ok("包内 badging: %s %s(%s)" % (pkg, vname, vcode))

    for name in ("app.js", "app.css", "index.html", "data/articles.json"):
        raw = line("md5 " + name)
        if raw is None:
            fail("apk_check 没输出 md5 " + name)
        try:
            same = bool(json.loads(raw)[0])
        except (ValueError, IndexError, TypeError):
            fail("md5 结果解析失败: " + raw)
        if not same:
            fail("包内 %s 与源码不一致: %s" % (name, raw))
    ok("包内 app.js/app.css/index.html/articles.json 与源码一致")

    tts = line("apk TTS_SERVICE queries")
    if tts != "true":
        fail("清单里 TTS_SERVICE queries 丢了")
    web = line("apk WebPageActivity")
    if web != "true":
        fail("清单里 WebPageActivity 丢了")
    provider = line("apk ApkProvider")
    if provider != "true":
        fail("清单里 ApkProvider(应用内安装)丢了")
    install = line("apk INSTALL_PACKAGES")
    if install != "true":
        fail("清单里 REQUEST_INSTALL_PACKAGES 丢了")
    ok("清单保留 TTS_SERVICE queries、WebPageActivity、ApkProvider、安装权限")

    es5 = line("es5 violations")
    if es5 not in ("[]", None):
        fail("app.js 有 ES5 违规:\n" + str(es5))
    ok("ES5 违规 0")

    triple = line("version triple")
    ok("version triple 已核对")


def build():
    print("\n== 构建 APK ==")
    proc = subprocess.run([sys.executable, os.path.join(TOOLS, "build_apk.py")],
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, encoding="utf-8", errors="replace", cwd=ROOT)
    print((proc.stdout or "")[-2000:])
    if proc.returncode != 0:
        fail("构建失败")


def prepare_asset(version):
    src = os.path.join(DIST, "闲读-%s-release.apk" % version)
    if not os.path.exists(src):
        fail("找不到构建产物: " + src + "\n先运行 build_apk.py 或加 --build")
    dst = os.path.join(DIST, "IdleRead-%s.apk" % version)
    shutil.copyfile(src, dst)
    size = os.path.getsize(dst)
    digest = sha256(dst)
    ok("资产 IdleRead-%s.apk  %.2f MB" % (version, size / 1048576.0))
    ok("sha256 " + digest)
    return dst, size, digest


def check_remote(version):
    tag = "v" + version
    proc = gh(["release", "view", tag, "-R", REPO, "--json", "tagName"], check=False)
    if proc.returncode == 0:
        fail("远程已经有 %s,不覆盖。要重发请先手动删除该 release 与 tag" % tag)
    proc = gh(["api", "repos/%s/git/ref/tags/%s" % (REPO, tag)], check=False)
    if proc.returncode == 0:
        fail("远程已经有 tag %s,不覆盖" % tag)
    ok("远程没有 %s,可以发布" % tag)
    return tag


def publish(tag, asset, notes):
    print("\n== 上传 ==")
    args = ["release", "create", tag, asset,
            "-R", REPO,
            "--title", "IdleRead-" + tag.lstrip("v"),
            "--notes", notes or "本次更新",
            "--latest"]
    proc = gh(args, check=False)
    if proc.returncode != 0:
        fail("gh release create 失败:\n" + (proc.stderr or proc.stdout).strip())
    url = (proc.stdout or "").strip().splitlines()[-1] if proc.stdout else ""
    ok("已创建 " + (url or tag))
    return url


def verify_remote(tag, asset_name, size, digest):
    print("\n== 回读校验 ==")
    raw = gh(["release", "view", tag, "-R", REPO, "--json",
              "tagName,name,isDraft,isPrerelease,assets"]).stdout
    data = json.loads(raw)
    if data["tagName"] != tag:
        fail("tag 对不上: " + data["tagName"])
    if data["isDraft"] or data["isPrerelease"]:
        fail("release 不是正式发布状态")
    assets = data.get("assets") or []
    if len(assets) != 1:
        fail("资产数量异常: %d" % len(assets))
    a = assets[0]
    if a["name"] != asset_name:
        fail("资产名对不上: " + a["name"])
    if a["size"] != size:
        fail("资产大小对不上: %s vs %s" % (a["size"], size))
    remote_digest = (a.get("digest") or "").replace("sha256:", "")
    if remote_digest != digest:
        fail("资产哈希对不上: %s vs %s" % (remote_digest, digest))
    ok("tag %s / 资产 %s / %.2f MB / sha256 一致"
       % (tag, a["name"], size / 1048576.0))
    ok("latest 已指向该版本")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只校验不发布")
    ap.add_argument("--build", action="store_true", help="先构建 APK")
    ap.add_argument("--notes", default="", help="发布说明")
    ap.add_argument("--notes-file", default="", help="从文件读发布说明")
    args = ap.parse_args()

    print("== 版本号一致性 ==")
    version, code = check_version_triple()

    if args.build:
        build()

    print("\n== APK 自查 ==")
    asset, size, digest = prepare_asset(version)
    text = run_apk_check(os.path.join(DIST, "闲读-%s-release.apk" % version))
    parse_apk_check(text, version, code)

    print("\n== 远程状态 ==")
    tag = check_remote(version)

    notes = args.notes
    if args.notes_file:
        notes = open(args.notes_file, encoding="utf-8").read().strip()

    if args.dry_run:
        print("\n[dry-run] 校验全部通过,未上传。")
        print("将发布: %s / %s / %.2f MB" % (tag, os.path.basename(asset),
                                            size / 1048576.0))
        return

    url = publish(tag, asset, notes)
    verify_remote(tag, "IdleRead-%s.apk" % version, size, digest)
    print("\n发布完成: " + (url or ("https://github.com/%s/releases/tag/%s"
                                    % (REPO, tag))))


if __name__ == "__main__":
    main()
