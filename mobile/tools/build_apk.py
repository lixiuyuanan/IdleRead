# -*- coding: utf-8 -*-
"""手工构建闲读 Android APK(不依赖 Gradle)。"""
import os
import shutil
import subprocess
import sys
import zipfile


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT = os.path.join(ROOT, "android", "app", "src", "main")
BUILD = os.path.join(ROOT, "build", "android")
DIST = os.path.join(ROOT, "dist")
TOOLS = os.path.join(ROOT, "tools")

SDK = os.environ.get("ANDROID_SDK_ROOT") or os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "Android", "Sdk")
BUILD_TOOLS = os.path.join(SDK, "build-tools", "34.0.0")
PLATFORM = os.path.join(SDK, "platforms", "android-34", "android.jar")
JDK = os.environ.get("JAVA_HOME") or os.path.join(
    os.environ.get("ProgramFiles", r"C:\Program Files"),
    "Microsoft", "jdk-17.0.7.7-hotspot")

AAPT2 = os.path.join(BUILD_TOOLS, "aapt2.exe")
ZIPALIGN = os.path.join(BUILD_TOOLS, "zipalign.exe")
D8 = os.path.join(BUILD_TOOLS, "d8.bat")
APKSIGNER = os.path.join(BUILD_TOOLS, "apksigner.bat")
JAVAC = os.path.join(JDK, "bin", "javac.exe")
KEYTOOL = os.path.join(JDK, "bin", "keytool.exe")

KEYSTORE = os.path.join(TOOLS, "debug.keystore")
RELEASE_PROPS = os.path.join(TOOLS, "keystore.properties")
VERSION_NAME = "1.7.3.2"
VERSION_CODE = "47"


def run(cmd):
    print("+", " ".join(cmd) if isinstance(cmd, list) else cmd)
    env = os.environ.copy()
    env["JAVA_HOME"] = JDK
    proc = subprocess.run(cmd, env=env, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                          errors="replace")
    if proc.stdout.strip():
        # javac 在中文 Windows 上输出 GBK,按 utf-8 解码会得到替换符,直接 print 会炸。
        enc = getattr(sys.stdout, "encoding", None) or "utf-8"
        print(proc.stdout.strip().encode(enc, "replace").decode(enc, "replace"))
    if proc.returncode != 0:
        raise SystemExit("命令失败,退出码 %s" % proc.returncode)
    return proc.stdout


def check_tools():
    missing = [p for p in (AAPT2, ZIPALIGN, D8, APKSIGNER, JAVAC, KEYTOOL, PLATFORM)
               if not os.path.exists(p)]
    if missing:
        raise SystemExit("缺少构建工具:\n" + "\n".join(missing))


def clean():
    if os.path.isdir(BUILD):
        shutil.rmtree(BUILD)
    os.makedirs(os.path.join(BUILD, "classes"), exist_ok=True)
    os.makedirs(os.path.join(BUILD, "dex"), exist_ok=True)
    os.makedirs(DIST, exist_ok=True)


def compile_resources():
    compiled = os.path.join(BUILD, "res.zip")
    run([AAPT2, "compile", "--dir", os.path.join(PROJECT, "res"), "-o", compiled])
    linked = os.path.join(BUILD, "resources.apk")
    run([
        AAPT2, "link",
        "-o", linked,
        "-I", PLATFORM,
        "--manifest", os.path.join(PROJECT, "AndroidManifest.xml"),
        "-A", os.path.join(PROJECT, "assets"),
        "--auto-add-overlay",
        "--min-sdk-version", "24",
        "--target-sdk-version", "34",
        "--version-code", VERSION_CODE,
        "--version-name", VERSION_NAME,
        compiled,
    ])
    return linked


def compile_java():
    sources = []
    java_root = os.path.join(PROJECT, "java")
    for base, _, names in os.walk(java_root):
        for name in names:
            if name.endswith(".java"):
                sources.append(os.path.join(base, name))
    if not sources:
        raise SystemExit("没有找到 Java 源码")
    out = os.path.join(BUILD, "classes")
    run([
        JAVAC, "-encoding", "UTF-8", "-source", "8", "-target", "8",
        "-bootclasspath", PLATFORM, "-classpath", PLATFORM,
        "-d", out
    ] + sources)
    return out


def make_dex(classes_dir):
    classes = []
    for base, _, names in os.walk(classes_dir):
        for name in names:
            if name.endswith(".class"):
                classes.append(os.path.join(base, name))
    if not classes:
        raise SystemExit("没有编译出 class 文件")
    run([D8, "--lib", PLATFORM, "--release",
         "--output", os.path.join(BUILD, "dex")] + classes)
    dex = os.path.join(BUILD, "dex", "classes.dex")
    if not os.path.exists(dex):
        raise SystemExit("d8 没有生成 classes.dex")
    return dex


def add_dex(resource_apk, dex_path):
    unsigned = os.path.join(BUILD, "unsigned.apk")
    shutil.copyfile(resource_apk, unsigned)
    with open(dex_path, "rb") as source:
        raw = source.read()
    with zipfile.ZipFile(unsigned, "a", zipfile.ZIP_DEFLATED) as apk:
        apk.writestr("classes.dex", raw)
    return unsigned


def ensure_keystore():
    if os.path.exists(KEYSTORE):
        return
    run([
        KEYTOOL, "-genkeypair", "-noprompt",
        "-keystore", KEYSTORE,
        "-storepass", "android",
        "-keypass", "android",
        "-alias", "ldleread",
        "-keyalg", "RSA",
        "-keysize", "2048",
        "-validity", "10000",
        "-dname", "CN=ldleRead Debug,OU=App,O=ldleRead,L=Local,ST=Local,C=CN",
    ])


def signing_config():
    """有 keystore.properties 就用正式签名,否则退回调试签名。"""
    if os.path.exists(RELEASE_PROPS):
        cfg = {}
        with open(RELEASE_PROPS, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    cfg[key.strip()] = value.strip()
        path = cfg.get("storeFile") or "release.keystore"
        if not os.path.isabs(path):
            path = os.path.join(TOOLS, path)
        if os.path.exists(path) and cfg.get("storePassword"):
            return (path, cfg.get("keyAlias") or "ldleread", cfg["storePassword"],
                    cfg.get("keyPassword") or cfg["storePassword"], True)
        print("keystore.properties 在,但 keystore 文件不见了 —— 退回调试签名")
    return KEYSTORE, "ldleread", "android", "android", False


def sign(apk_path):
    aligned = os.path.join(BUILD, "aligned.apk")
    run([ZIPALIGN, "-f", "-p", "4", apk_path, aligned])
    keystore, alias, store_pass, key_pass, release = signing_config()
    if not release:
        ensure_keystore()
    output = os.path.join(DIST, "闲读-%s%s.apk"
                          % (VERSION_NAME, "-release" if release else "-debug"))
    if os.path.exists(output):
        os.remove(output)
    run([APKSIGNER, "sign",
         "--ks", keystore,
         "--ks-key-alias", alias,
         "--ks-pass", "pass:" + store_pass,
         "--key-pass", "pass:" + key_pass,
         "--out", output,
         aligned])
    run([APKSIGNER, "verify", "--print-certs", output])
    return (output, "正式" if release else "调试")


def badging(apk_path):
    return run([AAPT2, "dump", "badging", apk_path])


def main():
    check_tools()
    clean()
    resource_apk = compile_resources()
    classes_dir = compile_java()
    dex_path = make_dex(classes_dir)
    unsigned = add_dex(resource_apk, dex_path)
    output, signed_with = sign(unsigned)
    info = badging(output)
    label = ""
    package = ""
    for line in info.splitlines():
        if line.startswith("application-label:"):
            label = line.split(":", 1)[1].strip().strip("'")
        if line.startswith("package:"):
            package = line.split("name=", 1)[1].split(" ", 1)[0].strip("'")
    size = os.path.getsize(output) / 1024.0 / 1024.0
    print("\nAPK 已生成")
    print("路径:", output)
    print("名称:", label or "闲读")
    print("包名:", package)
    print("签名:", signed_with)
    print("大小: %.1f MB" % size)


if __name__ == "__main__":
    main()
