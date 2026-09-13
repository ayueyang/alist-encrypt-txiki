#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
	echo "Usage: $0 OPENWRT_SDK_DIR" >&2
	exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
SDK_DIR=$1
PACKAGE_NAME=alist-encrypt-tjs
PACKAGE_SOURCE=$PROJECT_DIR/openwrt-tjs/openwrt/package/$PACKAGE_NAME
DIST_DIR=$PROJECT_DIR/openwrt-tjs/dist
OUTPUT_DIR=$PROJECT_DIR/openwrt-tjs/output

# OpenWrt 打包需要两份额外的构建输入，它们不属于本仓库：
#   1) txiki.js 源码树（含 deps/mbedtls/framework/CMakeLists.txt）
#   2) simde 头文件（含 simde/simde-common.h）
# 通过环境变量指定；未指定时给出明确报错，不猜测本地路径。
if [ -z "${TXIKI_SOURCE_DIR:-}" ]; then
	echo "错误：需要设置 TXIKI_SOURCE_DIR 指向 txiki.js 源码树。" >&2
	echo "  例：export TXIKI_SOURCE_DIR=\$HOME/src/txiki.js" >&2
	echo "  获取：git clone --branch v26.6.0 https://github.com/saghul/txiki.js" >&2
	exit 1
fi
if [ -z "${TJS_SIMDE_SOURCE:-}" ]; then
	echo "错误：需要设置 TJS_SIMDE_SOURCE 指向 simde 源码目录。" >&2
	echo "  例：export TJS_SIMDE_SOURCE=\$HOME/src/simde" >&2
	echo "  获取：git clone https://github.com/simd-everywhere/simde" >&2
	exit 1
fi

test -f "$DIST_DIR/server.mjs"
test -f "$DIST_DIR/convert.mjs"
test -f "$DIST_DIR/prga-worker.mjs"
test -d "$DIST_DIR/public"
test -f "$SDK_DIR/Makefile"
test -f "$TXIKI_SOURCE_DIR/CMakeLists.txt"
test -f "$TXIKI_SOURCE_DIR/deps/mbedtls/framework/CMakeLists.txt"
test -f "$TJS_SIMDE_SOURCE/simde/simde-common.h"

rm -rf "$SDK_DIR/package/$PACKAGE_NAME"
cp -R "$PACKAGE_SOURCE" "$SDK_DIR/package/$PACKAGE_NAME"

make -C "$SDK_DIR" package/$PACKAGE_NAME/clean \
	ALIST_ENCRYPT_SOURCE_DIR="$DIST_DIR" \
	TXIKI_SOURCE_DIR="$TXIKI_SOURCE_DIR" \
	TJS_SIMDE_SOURCE="$TJS_SIMDE_SOURCE"
make -C "$SDK_DIR" package/$PACKAGE_NAME/compile \
	ALIST_ENCRYPT_SOURCE_DIR="$DIST_DIR" \
	TXIKI_SOURCE_DIR="$TXIKI_SOURCE_DIR" \
	TJS_SIMDE_SOURCE="$TJS_SIMDE_SOURCE" \
	V=s

mkdir -p "$OUTPUT_DIR"
find "$SDK_DIR/bin/packages" -type f -name "$PACKAGE_NAME-*.apk" -exec cp -f {} "$OUTPUT_DIR/" \;
find "$SDK_DIR/bin/packages" -type f -name "${PACKAGE_NAME}_*.ipk" -exec cp -f {} "$OUTPUT_DIR/" \;

find "$OUTPUT_DIR" -maxdepth 1 -type f \( -name "$PACKAGE_NAME-*.apk" -o -name "${PACKAGE_NAME}_*.ipk" \) -print
