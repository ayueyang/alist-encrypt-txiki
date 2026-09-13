#!/bin/sh
# guest 内一键部署脚本（在 OpenWrt guest 里执行，不在宿主执行）：
#   挂载 9p 共享 → 安装运行时依赖与 txiki → 安装应用包 → 修 slirp 网络 → 起服务 → 校验载荷时效。
#
# 用法（guest 内）：
#   sh /mnt/host/tests/guest-deploy.sh              # 默认装 r9
#   APP_RELEASE=r8 sh /mnt/host/tests/guest-deploy.sh
#
# 说明：
#   - 脚本不含任何凭据；AList 端点由 tests/set-alist-endpoint.mjs 另行下发（走进程环境）。
#   - 存在的意义：把此前每次手工敲的挂载/安装/起服务步骤固化，避免 Windows→WSL 命令行里
#     `$VAR`、`$?` 被外层 shell 吞掉（见 docs/openwrt-guest-runbook.md 第 2 节）。

PKG_DIR=/mnt/host/packages
APP_RELEASE="${APP_RELEASE:-r9}"
APP_APK="$PKG_DIR/alist-encrypt-tjs-0.3.0-$APP_RELEASE.apk"

echo "=== guest-deploy start (APP_RELEASE=$APP_RELEASE) ==="

mkdir -p /mnt/host
mount -t 9p -o trans=virtio host0 /mnt/host 2>/dev/null || echo "GUEST_SHARE_ALREADY_MOUNTED"
ls /mnt/host

echo "--- install runtime deps + txiki ---"
apk add --allow-untrusted --network=no --force-non-repository \
  "$PKG_DIR/libatomic1-14.3.0-r5.apk" \
  "$PKG_DIR/libstdcpp6-14.3.0-r5.apk" \
  "$PKG_DIR/txiki-js-26.6.0-r3.apk"
echo "APK_RUNTIME_RC=$?"
/usr/bin/tjs --version

echo "--- install app $APP_RELEASE ---"
ls -la "$APP_APK"
echo "GUEST_APK_MD5 $(md5sum "$APP_APK" | cut -d' ' -f1)"
apk add --allow-untrusted --network=no --force-non-repository "$APP_APK"
echo "APK_APP_RC=$?"

# 时效绑定核对：guest 内载荷必须与本地 dist 一致（runbook 第 4 节的硬规则）
echo "GUEST_SERVER_MD5 $(md5sum /usr/lib/alist-encrypt/server.mjs | cut -d' ' -f1)"

echo "--- fix slirp network ---"
udhcpc -i br-lan -q -n 2>/dev/null
ip -4 addr show br-lan | grep inet

echo "--- restart service ---"
/etc/init.d/alist-encrypt restart
sleep 5
netstat -lntp | grep 5344 || echo "PORT_5344_NOT_LISTENING"

echo "--- guest -> AList reachability ---"
wget -q -O - -T 5 http://10.0.2.2:5244/ping || echo "ALIST_UNREACHABLE_FROM_GUEST"

echo "=== guest-deploy done ==="
