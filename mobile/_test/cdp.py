# -*- coding: utf-8 -*-
"""用无头 Chrome 的 DevTools 协议测手机版页面(仅本地测试用)。"""
import base64
import atexit
import json
import os
import subprocess
import sys
import time
import urllib.request

import websocket

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
HERE = os.path.dirname(os.path.abspath(__file__))
# 可用环境变量换端口/profile:上一轮 Chrome 没退干净时会连到旧实例,
# 表现是「旧页面还在、#xxx 突然查不到」这种假红。并发跑探针时各用各的。
PROFILE = os.environ.get("IDLEREAD_CDP_PROFILE") or os.path.join(HERE, "profile")
SHOTS = os.path.join(HERE, "shots")
PORT = int(os.environ.get("IDLEREAD_CDP_PORT") or 9222)


class CDP:
    def __init__(self):
        log = os.environ.get("CDP_LOG")
        err = open(log, "w") if log else subprocess.DEVNULL
        self.proc = subprocess.Popen([
            CHROME, "--headless=new", "--disable-gpu", "--no-first-run",
            "--no-default-browser-check", "--remote-debugging-port=%d" % PORT,
            "--user-data-dir=" + PROFILE, "--window-size=390,844",
            "--hide-scrollbars", "--force-device-scale-factor=2",
            "about:blank",
        ], stdout=subprocess.DEVNULL, stderr=err)
        self.ws = None
        self.msgid = 0
        for _ in range(80):
            try:
                data = json.load(urllib.request.urlopen("http://127.0.0.1:%d/json" % PORT))
                pages = [x for x in data if x.get("type") == "page"]
                # 崩溃恢复会把上一轮的页面一起开回来,优先挑 about:blank 那个。
                page = next((x for x in pages if x.get("url") == "about:blank"),
                            pages[0])
                self.ws = websocket.create_connection(page["webSocketDebuggerUrl"],
                                                     timeout=20)
                break
            except Exception:
                time.sleep(.15)
        if not self.ws:
            raise RuntimeError("Chrome 没起来")
        # Runtime.enable 会让 Chrome 立刻补发页面里已抛出的异常,
        # 所以 errors 必须先就位,否则构造函数自己先崩。
        self.errors = []
        self.call("Page.enable")
        self.call("Runtime.enable")
        self.call("Log.enable")
        # profile 目录是复用的,不禁用缓存会读到上一轮的 app.css / app.js。
        self.call("Network.enable")
        self.call("Network.setCacheDisabled", cacheDisabled=True)
        self.call("Emulation.setDeviceMetricsOverride", width=390, height=844,
                  deviceScaleFactor=2, mobile=True)
        atexit.register(self.close)
        self.errors = []

    def call(self, method, **params):
        self.msgid += 1
        self.ws.send(json.dumps({"id": self.msgid, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("method") == "Runtime.exceptionThrown":
                self.errors.append(str(msg["params"].get("exceptionDetails")))
            if msg.get("method") == "Log.entryAdded":
                ent = msg["params"]["entry"]
                if ent.get("level") in ("error", "warning"):
                    # 本地静态服务器没有 favicon.ico,Chrome 每次都会报 404,与页面无关。
                    if (ent.get("url") or "").endswith("/favicon.ico"):
                        continue
                    self.errors.append(ent.get("text"))
            if msg.get("id") == self.msgid:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg.get("result", {})

    def nav(self, url):
        self.call("Page.navigate", url=url)
        time.sleep(.5)

    def ev(self, expression, awaitp=False):
        r = self.call("Runtime.evaluate", expression=expression, returnByValue=True,
                      awaitPromise=awaitp, userGesture=True)
        if "exceptionDetails" in r:
            raise RuntimeError(r["exceptionDetails"])
        return r.get("result", {}).get("value")

    def shot(self, name, full=False):
        os.makedirs(SHOTS, exist_ok=True)
        if full:
            h = self.ev("Math.max(document.documentElement.scrollHeight,"
                        "document.querySelector('#view').scrollHeight+120)")
            self.call("Emulation.setDeviceMetricsOverride", width=390, height=int(h or 844),
                      deviceScaleFactor=2, mobile=True)
            time.sleep(.25)
        data = self.call("Page.captureScreenshot", format="png")["data"]
        path = os.path.join(SHOTS, name)
        with open(path, "wb") as f:
            f.write(base64.b64decode(data))
        if full:
            self.call("Emulation.setDeviceMetricsOverride", width=390, height=844,
                      deviceScaleFactor=2, mobile=True)
        return path

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass
        # 只 terminate 主进程会留下一串子进程继续占着 profile,下一次启动就抢锁/崩网络进程。
        try:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(self.proc.pid)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        except Exception:
            pass
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def main():
    c = CDP()
    try:
        c.nav("http://127.0.0.1:8765/index.html")
        for _ in range(80):
            ready = c.ev("!document.querySelector('#app').classList.contains('hidden')")
            if ready:
                break
            time.sleep(.2)
        print("ready", c.ev("!document.querySelector('#app').classList.contains('hidden')"))
        print("boot", c.ev("document.querySelector('#bootText').textContent"))
        print("view", c.ev("document.querySelector('#view').textContent.slice(0,120)"))
        print("tabs", c.ev("[...document.querySelectorAll('.tab')].map(x=>x.textContent)"))
        print("errors", c.errors[-6:])
        print(c.shot("01-read.png"))
    finally:
        c.close()


if __name__ == "__main__":
    main()
