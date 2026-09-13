# 桌面（Linux / Windows）直接运行 txiki 版 alist-encrypt

> 目标：不经 OpenWrt guest，在桌面 Linux 或 Windows 上用 txiki.js 直接运行同一份适配版（`dist/server.mjs`）。
> 本手册对应的验证记录见 [../tests/run-2026-09-13.md](../tests/run-2026-09-13.md)（R-33）；兼容性条目 C-21 / C-23 见
> [openwrt-tjs-compatibility.md](openwrt-tjs-compatibility.md)。
>
> **结论先行**：可以。`dist/server.mjs` 是自包含 bundle（esbuild 打包，平台适配层已内置），桌面 txiki 只需提供
> `tjs:sqlite` 与标准 tjs API，开箱即用。唯一的平台差异是 **WebDAV 方法支持**，见 §3。

## 0. 不想自己编译？直接用发布包

Release 里已经提供解压即用的桌面包（内含对应平台的 `tjs`、应用文件与启动脚本）：

| 平台 | 架构 | 包 |
|---|---|---|
| Linux | x86_64 | `alist-encrypt-txiki-<版本>-linux-x86_64.tar.gz` |
| Linux | aarch64 / ARM64 | `alist-encrypt-txiki-<版本>-linux-aarch64.tar.gz` |
| Windows | x86_64 | `alist-encrypt-txiki-<版本>-windows-x86_64.zip` |

解压后只需改 `config.json`，然后 `./start.sh`（Linux）或双击 `start.bat`（Windows）。

- Linux 包的 `tjs` 是本项目自行构建的**含 WebDAV 补丁**版本，要求 **glibc ≥ 2.35**（Ubuntu 22.04+ / Debian 12+ /
  Raspberry Pi OS Bookworm+）；构建方式见 §3.2。
- Windows 包的 `tjs.exe` 是 txiki.js **官方原版**，**不含** WebDAV 补丁 → WebDAV 不可用（见 §3）。

以下 §1–§4 是想自己搭一套运行环境（或换架构、或要 Windows 的完整 WebDAV）时的完整做法。

## 1. 运行前提与目录布局

- txiki.js **v26.6.0**（与 guest 交付版本一致，不要混用其他版本）。
- 先构建应用产物（`dist/` 不入库）：

```sh
cd openwrt-tjs
npm ci
node build.mjs        # 产出 dist/server.mjs、dist/prga-worker.mjs、dist/public/、dist/convert.mjs
```

- 任一空目录作为运行目录（下称 `<run>`），内含：

```
<run>/
├── server.mjs          # 来自 openwrt-tjs/dist/
├── prga-worker.mjs     # 来自 openwrt-tjs/dist/（RC4/mix 加速 worker，必须与 server.mjs 同目录）
├── public/             # 管理页面静态资源，来自 openwrt-tjs/dist/public/
└── config.json         # 首次启动自动生成（建议预置，见 §2）
```

- 运行时还会生成 `data.sqlite`/`-shm`/`-wal`（用户数据库，WAL 模式）。

### 环境变量（平台适配层的正式契约，全部已实测）

| 变量 | 作用 | 缺省（OpenWrt 形态） |
|---|---|---|
| `ALIST_ENCRYPT_HOME` | config.json 与数据库所在目录（`process.cwd()` 语义） | `/etc/alist-encrypt` |
| `ALIST_ENCRYPT_PROGRAM_DIR` | server.mjs 所在目录（仅用于进程 argv 展示） | `/usr/lib/alist-encrypt` |
| `ALIST_ENCRYPT_ENTRY` | 覆盖入口路径 | `<PROGRAM_DIR>/server.mjs` |
| `ALIST_HOST` | 首次生成 config.json 时的 AList 地址（`host:port`） | `192.168.1.100:5244` |

### config.json 关键字段

- `alistServer.serverHost` / `serverPort`：AList 地址（可在管理页面 `/enc-api` 修改，热生效）。
- `port`：代理监听端口，默认 5344。桌面环境若与本机其他占用冲突，改为其他端口即可，**无需改代码**。
- 应用管理员：`admin` / `123456`（首次启动自动初始化，存于 SQLite）——**首次登录后请立即修改**。

## 2. 启动命令

### Windows（PowerShell / Git Bash）

```bash
cd <run>
ALIST_ENCRYPT_HOME="<run 的 Windows 绝对路径>" \
ALIST_ENCRYPT_PROGRAM_DIR="<run 的 Windows 绝对路径>" \
<txiki目录>\tjs.exe run server.mjs
```

实测样例（端口 5444，避让被占用的默认端口）：

```bash
cd /d/desktop-txiki/win-run
ALIST_ENCRYPT_HOME="C:/desktop-txiki/win-run" \
ALIST_ENCRYPT_PROGRAM_DIR="C:/desktop-txiki/win-run" \
../txiki-windows-x86_64/tjs.exe run server.mjs
# → [alist-encrypt] [INFO] 服务启动成功: 5444
```

### Linux

```bash
cd <run>
ALIST_ENCRYPT_HOME=<run> ALIST_ENCRYPT_PROGRAM_DIR=<run> \
  <txiki-build>/tjs run server.mjs
# → [alist-encrypt] [INFO] 服务启动成功: <port>
```

启动后验证：`curl http://127.0.0.1:<port>/ping`；浏览器打开 `http://127.0.0.1:<port>/public/index.html` 进管理页面。

## 3. WebDAV 方法支持（唯一的平台差异）

alist-encrypt 的 WebDAV 加密代理依赖 HTTP 方法 `PROPFIND/MKCOL/COPY/MOVE`，而 **libwebsockets 上游不支持这四个方法**
（项目补丁 C-21，见 [openwrt-tjs-compatibility.md](openwrt-tjs-compatibility.md)）。txiki 的 HTTP 层基于 LWS，因此：

| txiki 二进制 | 服务端接受 WebDAV 方法 | 客户端 `fetch` 发出 WebDAV 方法 |
|---|---|---|
| OpenWrt r3/r4（本项目补丁构建） | ✅ | ✅ |
| Linux 自编译 / 本项目 Linux 包（补丁树，§3.1/§3.2） | ✅ | ✅ |
| **Windows 官方 zip（未打补丁）** | ❌ 403 | ❌ **永久挂死** |
| macOS 官方 zip（未打补丁） | ❌ 403 | ❌ 永久挂死 |

> 症状与 OpenWrt prebuilt r1 完全同源：`fetch` PROPFIND 不报错也不返回（请求从未发出）；服务端收到 PROPFIND 直接回内建 403。
> A 组（管理 API）与 B 组（AList HTTP 代理上传/下载/改名/移动）不受影响。

**判定探针**（30 秒自检）：运行下方脚本，7 个方法全部回 `207` 即双侧可用；卡在 PROPFIND 即官方二进制形态：

```js
// webdav-method-probe.mjs —— tjs run webdav-method-probe.mjs
const server = tjs.serve({
  port: 18999, listenIp: '127.0.0.1',
  fetch: (req) => new Response('method=' + req.method, { status: 207 }),
})
await new Promise((r) => setTimeout(r, 300))
for (const m of ['GET', 'PUT', 'DELETE', 'PROPFIND', 'MKCOL', 'COPY', 'MOVE']) {
  try { console.log(m, (await fetch('http://127.0.0.1:18999/x', { method: m })).status) }
  catch (e) { console.log(m, 'ERROR', String(e).slice(0, 60)) }
}
server.close(); tjs.exit(0)
```

### 3.1 在本机发行版上原生编译（含 WebDAV 补丁）

前置：`sudo apt install build-essential cmake ninja-build libffi-dev`。

```bash
# 1) 取 txiki.js v26.6.0 源码
git clone https://github.com/saghul/txiki.js -b v26.6.0 --recurse-submodules
cd txiki.js

# 2) 施加 C-21 WebDAV 方法补丁（8 个 LWS 文件 + 重新生成 lextable；
#    补丁清单与理由见 docs/openwrt-tjs-compatibility.md 的 C-21 条目）

# 3) 原生编译
cmake -S . -B build-desktop -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_WITH_FFI=ON -DBUILD_WITH_SQLITE=ON -DBUILD_WITH_MIMALLOC=ON -DBUILD_WITH_WASM=ON
ninja -C build-desktop
./build-desktop/tjs --version   # 期望 v26.6.0
```

> **注意**：在较新的发行版（如 Ubuntu 24.04）上直接编译，产物会依赖 `GLIBC_2.38`（`__isoc23_*`），
> 拿到 Debian 12 / Raspberry Pi OS 等较老的系统上会报 `GLIBC_2.38 not found`。
> 需要更好的兼容性请用 §3.2。

### 3.2 在较老发行版容器内编译（推荐，得到 glibc 2.35 的产物）

在 `ubuntu:22.04`（GCC 12 / glibc 2.35）容器里构建，产物可覆盖 Ubuntu 22.04+ / Debian 12+ / Raspberry Pi OS Bookworm+：

```bash
docker run --rm --platform linux/amd64 \
  -v "$PWD/txiki.js":/src -v "$PWD/out":/out \
  ubuntu:22.04 bash -c '
    set -e
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq build-essential git ninja-build libffi-dev pkg-config python3-pip
    apt-get install -y -qq gcc-12 g++-12          # GCC 11 编不过 deps/ada
    pip3 install --quiet "cmake==3.28.3" ninja
    cmake -S /src -B /tmp/b -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_C_COMPILER=/usr/bin/gcc-12 -DCMAKE_CXX_COMPILER=/usr/bin/g++-12 \
      -DCMAKE_C_FLAGS="-Wno-error=unknown-pragmas" \
      -DCMAKE_CXX_FLAGS="-Wno-error=unknown-pragmas" \
      -DBUILD_WITH_FFI=ON -DBUILD_WITH_SQLITE=ON -DBUILD_WITH_MIMALLOC=ON -DBUILD_WITH_WASM=ON
    ninja -C /tmp/b
    cp /tmp/b/tjs /out/tjs
    objdump -T /out/tjs | grep -oE "GLIBC_[0-9.]+" | sort -V -u | tail -1   # 期望 GLIBC_2.35
  '
```

aarch64 同理，把 `--platform` 换成 `linux/arm64`（Docker 需已注册 binfmt）。

该配方里有三处**必须**成立，否则编译失败：

1. **GCC ≥ 12**：`deps/ada` 需要 `constexpr std::string`（P0980R1，libstdc++ 自 GCC 12 起提供）。
   GCC 11 会在 `ada.cpp` 报 `call to non-'constexpr' function`。而 22.04 默认就是 GCC 11，所以必须显式装 `gcc-12`。
2. **`-Wno-error=unknown-pragmas`**：上游 `CMakeLists.txt` 在 UNIX 上无条件加 `-Werror`，而 GCC 12 对
   `src/text-coding.c` 里的 MSVC 风格 `#pragma region` 会报 `-Wunknown-pragmas`（GCC 13 不报）。
   这里只降级这一条警告，其余警告仍按错误处理，**不改上游源码**。
3. **cmake 3.28.3**：22.04 自带的 3.22 低于 mimalloc 要求的 3.18 以上虽有富余，但版本与上游常用组合一致更稳；
   若容器自带过旧（如 20.04 的 3.16）则必须 pip 安装。

### 3.3 Windows 自编译（获得完整 WebDAV 能力的唯一途径）

本项目验证环境无 MSVC/clang 工具链，以下路径**未实测**，仅供方向参考：

1. 安装 Visual Studio Build Tools（含 C++ 桌面开发 workload）+ cmake + ninja；
2. 取 v26.6.0 源码并施加同一份 C-21 补丁（与 §3.1 相同的 8 文件 + lextable 重生成）；
3. `cmake -G "Visual Studio 17 2022" -A x64` 或 `cmake -G Ninja`（x64 Native Tools 命令行内）后编译；
4. 用 §3 探针自检后替换官方 `tjs.exe`。

在上游官方二进制支持 WebDAV 方法或完成自编译之前，Windows 官方二进制形态定位为：
**AList HTTP 代理 + 管理页面可用，WebDAV 代理不可用**。

## 4. 测试工具对桌面模式的支持

- 固定向量：`tjs run openwrt-vectors.mjs`（自包含，任意平台可跑）——期望 `ok: true`，且四种算法摘要为：

  | 算法 | `encryptedSha256`（前 16 位） |
  |---|---|
  | `aesctr` | `50d530bf9014f397` |
  | `rc4` | `71759b7429979c9d` |
  | `chacha20` | `c50cda6e15f59b15` |
  | `mix` | `37906b3b2b033ef8` |

  这四行与上游 Node 原版逐字节一致，是回归的主要判据。完整输出样例见
  [../openwrt-tjs/tests/live-openwrt-vectors.log](../openwrt-tjs/tests/live-openwrt-vectors.log)。
- 38 项 API 套件：`openwrt-tjs/tests/api-suite-run.mjs` 支持在 tjs 下直接运行；
  **运行时无 WebDAV 方法补丁时必须加 `API_SKIP_WEBDAV=1`**（否则 C01 的 fetch 会挂死整个套件）：

```bash
cd openwrt-tjs/tests        # tjs 对入口脚本的相对导入按 cwd 解析，必须在 tests 目录内执行
ALIST_ENCRYPT_HOME=<run> ALIST_PASSWORD=<alist密码> ALIST_USERNAME=admin \
APP_PASSWORD=123456 PROXY_ORIGIN=http://127.0.0.1:<port> ALIST_ORIGIN=http://<alist主机>:<端口> \
API_SKIP_WEBDAV=1 <tjs> run api-suite-run.mjs
```

- 其他注意：tjs 入口脚本的相对 import 按 cwd 解析（不是脚本所在目录）；Windows 下套件文件不要放在带空格的路径更稳妥。

## 5. 已知限制与注意

1. **官方二进制（Windows/macOS）无 WebDAV 方法支持**——不是适配缺陷，是 LWS 上游限制；补丁见 C-21。
2. Windows 下 worker 路径修复（C-23）要求 `prga-worker.mjs` 与 `server.mjs` 同目录且来自**同一份 dist**
   （旧版 server.mjs 在 Windows 上会静默退化为主线程 PRGA，功能正确但 RC4/mix 变慢）。
3. `tjs run` 的相对 import 按 cwd 解析：从别处运行套件/入口脚本时注意工作目录。
4. 多实例：同一 `<run>` 目录不可同时启动两个服务（SQLite/端口冲突）；不同目录可并行（不同端口）。
5. 桌面模式没有 procd 守护：进程退出即服务停止，长期运行建议注册为系统服务（Windows 服务/NSSM、Linux systemd unit）
   ——本项目未展开，属部署层。
