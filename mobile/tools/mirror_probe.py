# -*- coding: utf-8 -*-
"""抓取并测速 GitHub 加速镜像，生成 mirrors.json 给 App 同步。

用法：
    python tools/mirror_probe.py                # 测速并写入 dist/mirrors.json
    python tools/mirror_probe.py --publish      # 顺便发到 GitHub prerelease `mirrors`

App 里「设置 → 下载镜像源 → 同步」拉的就是这个文件。加了新镜像只要改下面的
CANDIDATES 再跑一遍，老用户点一下同步就能用上，不用等发版。
"""
import argparse
import concurrent.futures as cf
import json
import os
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
OUT = os.path.join(DIST, "mirrors.json")

REPO = "lixiuyuanan/IdleRead"
TAG = "mirrors"
ASSET = "mirrors.json"

# 测速用的样本：随便挑一个真实存在的发布资产，小文件快。
SAMPLE = ("https://github.com/lixiuyuanan/IdleRead/releases/download/"
          "v1.6.6.2/IdleRead-1.6.6.2.apk")
UA = ("Mozilla/5.0 (Linux; Android 12; IdleRead) AppleWebKit/537.36 "
      "Chrome/120 Mobile Safari/537.36")
NEED = 128 * 1024
TIMEOUT = 8
MAX_KEEP = 12          # 最多保留几个，太多会拖慢 App 里的测速
MIN_SPEED = 12 * 1024  # 低于这个速度的不要，留着只会拖后腿

# 候选镜像（"": 直连 GitHub）。想加新的直接往这里加。
# 2026-10-28 实测：前四个可用且支持 Range；后面的留着当备胎，测速不达标会被 MIN_SPEED 筛掉。
CANDIDATES = [
    "",
    "https://gh-proxy.org/",
    "https://gh.ddlc.top/",
    "https://ghproxy.cxkpro.top/",
    "https://gh-proxy.com/",
    "https://ghproxy.net/",
    "https://ghps.cc/",
    "https://gitproxy.click/",
    "https://ghfast.top/",
    "https://gh.llkk.cc/",
    "https://github.moeyy.xyz/",
    "https://hub.gitmirror.com/",
    "https://cf.ghproxy.cc/",
    "https://gh.xxooo.cf/",
    "https://gh-proxy.net/",
    "https://mirror.ghproxy.com/",
]


def label(prefix):
    if not prefix:
        return "direct"
    return prefix.split("://", 1)[-1].rstrip("/")


def probe(prefix):
    url = prefix + SAMPLE
    start = time.time()
    got = 0
    code = 0
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept-Encoding": "identity",
            "Range": "bytes=0-%d" % (NEED - 1),
        })
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            code = resp.getcode()
            while got < NEED:
                buf = resp.read(65536)
                if not buf:
                    break
                got += len(buf)
                if time.time() - start > TIMEOUT:
                    break
    except Exception as e:  # noqa
        return {"prefix": prefix, "code": -1, "bytes": got, "speed": 0,
                "err": str(e)[:70]}
    cost = max(0.001, time.time() - start)
    return {"prefix": prefix, "code": code, "bytes": got,
            "speed": got / cost, "err": ""}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--publish", action="store_true", help="发到 GitHub prerelease")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    print("测速 %d 个候选…" % len(CANDIDATES))
    with cf.ThreadPoolExecutor(max_workers=args.workers) as pool:
        rows = list(pool.map(probe, CANDIDATES))

    rows.sort(key=lambda r: -r["speed"])
    keep = []
    print("%-26s %5s %9s %10s" % ("镜像", "HTTP", "拿到", "KB/s"))
    for r in rows:
        ok = r["code"] in (200, 206) and r["speed"] >= MIN_SPEED
        print("%-26s %5s %9d %10.0f %s" % (
            label(r["prefix"]), r["code"], r["bytes"], r["speed"] / 1024.0,
            "" if ok else ("跳过" if not r["err"] else r["err"])))
        if ok:
            keep.append(r)

    if not keep:
        print("\n一个可用的都没有，保留旧文件不动。")
        return 1

    keep = keep[:MAX_KEEP]
    # 直连如果可用，永远留在清单里（有些网络直连反而最快）。
    direct = [r for r in rows if not r["prefix"] and r["code"] in (200, 206)]
    if direct and not any(not r["prefix"] for r in keep):
        keep.append(direct[0])

    data = {
        "updated": time.strftime("%Y-%m-%d"),
        "note": "由 tools/mirror_probe.py 生成；App 里点同步即可更新",
        "mirrors": [{"name": label(r["prefix"]), "prefix": r["prefix"],
                     "speed_kbps": int(r["speed"] / 1024)} for r in keep],
    }
    os.makedirs(DIST, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("\n写入 %s（%d 个源）" % (OUT, len(keep)))

    if args.publish:
        return publish()
    return 0


def publish():
    print("发布到 prerelease %s …" % TAG)
    subprocess.run(["gh", "release", "view", TAG, "-R", REPO],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    exists = subprocess.run(["gh", "release", "view", TAG, "-R", REPO],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if not exists:
        subprocess.run(["gh", "release", "create", TAG, "-R", REPO,
                        "--prerelease", "--title", "镜像源清单",
                        "--notes", "App「设置 → 下载镜像源 → 同步」拉取 mirrors.json。"
                                   "由 tools/mirror_probe.py 生成，可随时覆盖。"],
                       check=True)
    subprocess.run(["gh", "release", "upload", TAG, OUT, "-R", REPO, "--clobber"],
                   check=True)
    print("已发布: https://github.com/%s/releases/download/%s/%s" % (REPO, TAG, ASSET))
    return 0


if __name__ == "__main__":
    sys.exit(main())
