# -*- coding: utf-8 -*-
"""生成闲读正式签名用的 keystore(一台机器只需要跑一次,之后千万别删)。

换了签名之后,老用户必须先卸载旧签名的版本才能装新版,本机阅读进度会一起没掉,
所以这个文件一旦生成就不要再重新生成。
"""
import os
import secrets
import string
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
KEYSTORE = os.path.join(HERE, "release.keystore")
PROPS = os.path.join(HERE, "keystore.properties")
JDK = r"C:\Program Files\Microsoft\jdk-17.0.7.7-hotspot"
KEYTOOL = os.path.join(JDK, "bin", "keytool.exe")


def main():
    if os.path.exists(KEYSTORE):
        print("release.keystore 已经在了,不覆盖。")
        return 0
    if not os.path.exists(KEYTOOL):
        raise SystemExit("找不到 keytool:" + KEYTOOL)

    alphabet = string.ascii_letters + string.digits
    password = "".join(secrets.choice(alphabet) for _ in range(24))
    env = os.environ.copy()
    env["XIAN_KS_PASS"] = password          # 走环境变量,不进命令行参数
    proc = subprocess.run([
        KEYTOOL, "-genkeypair", "-noprompt",
        "-keystore", KEYSTORE,
        "-storepass:env", "XIAN_KS_PASS",
        "-keypass:env", "XIAN_KS_PASS",
        "-alias", "ldleread",
        "-keyalg", "RSA", "-keysize", "2048", "-validity", "10950",
        "-dname", "CN=ldleRead,OU=App,O=ldleRead,L=Local,ST=Local,C=CN",
    ], env=env)
    if proc.returncode != 0:
        raise SystemExit("keytool 没生成 keystore")

    with open(PROPS, "w", encoding="utf-8") as f:
        f.write("# 闲读正式签名。这个文件和 release.keystore 要一起备份,"
                "丢了就再也无法给老用户推送更新。\n")
        f.write("storeFile=release.keystore\n")
        f.write("storePassword=%s\n" % password)
        f.write("keyAlias=ldleread\n")
        f.write("keyPassword=%s\n" % password)
    os.chmod(PROPS, 0o600)
    print("已生成 release.keystore 和 keystore.properties")
    print("密码只写进了 keystore.properties,没有打印到屏幕上。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
