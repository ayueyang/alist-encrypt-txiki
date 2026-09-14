# API 端到端测试指南（api-suite）

本文件说明如何在**不依赖浏览器**的前提下，用纯 HTTP API 反复验证 alist-encrypt 的服务端行为。
适用范围：OpenWrt txiki.js 适配版（`openwrt-tjs`）与上游 Node 原版，二者共用同一份用例。

> 本文件是**使用说明**。单次执行的真实输出记录在 `tests/run-<date>.md`，两者不要混写。

## 1. 组成

| 文件 | 角色 |
| --- | --- |
| `openwrt-tjs/tests/api-suite.mjs` | 用例库。导出 `runApiSuite(options)`，返回 `{ summary, results }`。只有用例，不含运行环境假设。 |
| `openwrt-tjs/tests/api-suite-run.mjs` | 执行入口。读环境变量 → 回显生效加密规则 → 执行用例 → 打印结果与汇总 → 以退出码表示成败。 |

`api-suite.mjs` 刻意只使用标准 Web API（`fetch` / `ReadableStream` / `Headers` / `TextEncoder`），
并自带 `toBase64`（不依赖 `btoa`），因此同一份代码在 guest 的 `/usr/bin/tjs` 与 Node 下都能直接跑。

## 2. 前置条件

1. 被验证的代理服务已在目标环境启动：
   - guest：`/etc/init.d/alist-encrypt start`（procd 托管，监听 `port`，默认 5344）。
   - Node 对照台：由 `work/api-harness/run-api.mjs` 拉起。
2. AList 服务可达，且测试账号具备 `/会员` 下建目录、上传、下载、删除的权限。
3. 凭据只经**进程环境变量**传入，不得写入脚本、配置文件、日志或 shell history。
4. 用例只操作 `<rootPath>/_api_e2e_<时间戳>`（默认 `/会员/_api_e2e_*`）与 `<rootPath>/_api_plain_<时间戳>`，
   结束时会删除这两个目录并恢复被改动的应用配置。**不要把它指向业务目录。**

## 3. 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ALIST_PASSWORD` | 无（必填） | AList 账号密码。缺失时入口直接以退出码 2 终止。 |
| `ALIST_USERNAME` | `admin` | AList 账号名。 |
| `ALIST_ORIGIN` | `http://10.0.2.100` | AList 起点（guest 内可用 QEMU 网关地址；对照台用模拟 AList 地址）。 |
| `PROXY_ORIGIN` | `http://127.0.0.1:5344` | 被验证代理的起点。 |
| `APP_PASSWORD` | `123456` | 代理自身 `/enc-api/login` 的密码（初始化默认值）。 |
| `API_E2E_ROOT` | `/会员` | 隔离目录的父目录。 |
| `API_SKIP_WEBDAV=1` | 未设置 | 跳过 C 组全部 9 项（记 SKIP）。**运行时 LWS 无 WebDAV 方法补丁时必须设置**（官方 Windows/macOS tjs 二进制下 C01 的 fetch PROPFIND 会永久挂死整个套件），见 `docs/desktop-txiki-runbook.md` §4。 |

## 4. 运行方式

### 4.1 OpenWrt guest（正式证据）

guest 测试目录的挂载点随环境代数不同（详见根目录 `docs/openwrt-guest-runbook.md` 第 4、5.3 节）：

- **第二代（2026-09-11 实测环境）**：`/mnt/host/tests/`（扁平暂存目录共享，guest 实测日志证实）；
- 第一代（2026-08-30/31）：`/mnt/host/openwrt/alist-encrypt/openwrt-tjs/`（整个工作区根共享）。

```sh
ALIST_PASSWORD='<secret>' \
ALIST_ORIGIN=http://10.0.2.100 \
PROXY_ORIGIN=http://127.0.0.1:5344 \
  /usr/bin/tjs run /mnt/host/tests/api-suite-run.mjs
```

只有 guest 内 `/usr/bin/tjs` 的输出才算 OpenWrt 证据。

### 4.2 Node 对照台（适配版）

```sh
node work/api-harness/build-run.mjs   # 用最新 dist/server.mjs 重新生成对照可运行版
node work/api-harness/run-api.mjs     # 拉起模拟 AList + 适配版，调用同一个入口，写 last-report.json
```

### 4.3 Node 对照台（上游原版）

```sh
node work/api-harness/run-upstream.mjs   # 拉起模拟 AList + 未修改的上游 node-proxy，写 last-report-upstream.json
```

原版以项目原本方式加载（ts-node + tsconfig-paths），只把工作目录换到 `work/api-harness/upstream-run/`，
保证 `upstream/` 工作区不被写入。注意上游配置文件在 `cwd/conf/config.json`，适配版在 `cwd/config.json`。

三者的执行路径完全一致：都通过 `api-suite-run.mjs` 这个入口，避免"对照台与 guest 走不同分支"导致的假结论。

### 4.4 真实 AList（不用模拟）

```sh
# 免凭据自检：只验证「代理 ↔ 真实 AList」链路
PROBE_ONLY=1 node work/api-harness/run-real.mjs

# 真实上传与校验（需要 AList 凭据）
ALIST_PASSWORD='<secret>' node work/api-harness/run-real.mjs
PROXY_KIND=upstream ALIST_PASSWORD='<secret>' node work/api-harness/run-real.mjs
```

要点：

- 不启动模拟 AList；把代理指向 `REAL_ALIST_ORIGIN`（默认 `http://127.0.0.1:5244`）。
- 用例 B05/B06 经**代理**上传，再**绕开代理直接查原版 AList**，读出落盘文件名与内容字节头部，
  因此能直接回答"云端存的是明文还是密文"。
- 用例 A06 会临时改写代理配置并指向真实 AList，结束时用 `originalConfig` 恢复；
  不要在有生产流量的实例上运行。
- `PROXY_KIND=adapted`（默认）验证适配版，`upstream` 用未经修改的上游 Node 原版做参照。

## 5. 用例清单（48 项）

### A 组：应用自身 API（9 项）

| 编号 | 覆盖点 |
| --- | --- |
| A01 | 应用登录 `/enc-api/login`，取得 token |
| A02 | 错误密码被拒绝 |
| A03 | 缺少 token 的请求被拦截（要求 `401 user unlogin`，不得是 500） |
| A04 | 读取用户信息 `/enc-api/getUserInfo` |
| A05 | 读取 AList 代理配置 `/enc-api/getAlistConfig` |
| A06 | 写入测试加密规则 `/enc-api/saveAlistConfig` |
| A07 | 目录派生密码编解码往返 `/enc-api/encodeFoldName` → `/decodeFoldName` |
| A08 | 读取 WebDAV 代理配置 `/enc-api/getWebdavonfig` |
| A09 | WebDAV 配置增删改往返 |

### B 组：AList HTTP 代理（20 项）

| 编号 | 覆盖点 |
| --- | --- |
| B00 | AList 登录（经代理） |
| B01–B02 | 代理列目录 `/api/fs/list`、`/api/fs/dirs` |
| B03 | 顶部隔离目录保持明文（负向：不被误加密） |
| B04 | 子目录名加密落盘 |
| B05–B06 | `/api/fs/put` 上传后，云端文件名与**内容**均为密文 |
| B07 | 代理列目录把密文名还原成明文显示 |
| B08 | `/api/fs/get` 返回的 `raw_url` 被改写为 `/redirect/<key>` |
| B09–B10 | 重定向通道完整下载与 Range 下载，内容与明文逐字节一致 |
| B11–B13 | 直链通道 `/d`、`/p` 的完整下载与 Range 下载 |
| B14 | 重命名 `/api/fs/rename`：显示明文、云端密文 |
| B15–B16 | 复制 `/api/fs/copy`、移动 `/api/fs/move` |
| B17 | 落在加密规则之外的路径透传（负向验证） |
| B18 | 删除 `/api/fs/remove` |
| B19 | 大文件并发上传（8MB，R-25 回归守护）：上传成功 + 云端密文尺寸吻合 + 期间 `/ping` 不被事件循环阻塞 |

### C 组：WebDAV 代理（9 项）

| 编号 | 覆盖点 |
| --- | --- |
| C01 | 根目录 PROPFIND |
| C02 | WebDAV PUT 上传同样加密文件名与内容 |
| C03 | 目录 PROPFIND 把目录名与文件名解密为明文显示 |
| C04 | WebDAV GET 完整解密下载 |
| C05 | WebDAV HEAD 返回明文长度 |
| C06 | WebDAV Range 解密下载 |
| C07 | WebDAV COPY（跨目录，含密文名与内容解密复核） |
| C08 | WebDAV MOVE（同目录重命名） |
| C09 | WebDAV DELETE |

### D 组：补充覆盖与受限形态归因（10 项）

这一组补 A/B/C 三组没走到的形态，并把已归因的 AList 侧受限形态固化成用例，防止回归时被误判成本适配层缺陷。

| 编号 | 覆盖点 |
| --- | --- |
| D01 | WebDAV MOVE（跨目录）：源清空 + 目标为明文新名 + 内容逐字节一致（源名不得与目标目录已有文件重名，见 D08） |
| D02 | 覆盖上传（同路径 PUT 两次）：云端只留一份密文，GET 得到第二版 |
| D03 | 并发两路 GET：内容/状态码不符判 FAIL；若后端慢到连暖场单路都撞上 C-26 的 15s 响应头上限，则记 SKIP（无法测量） |
| D03c | 并发两路 PROPFIND：不触达 CDN，独立证明代理能并行处理多请求（比对解码后的明文名集合，不比响应体字节） |
| D03b | 并发两路 PUT（204800 / 131072 B）：两路密文名与内容互不串扰；超 C-26 上限时记 SKIP |
| D04 | PROPFIND depth:0（客户端 exists 探测）返回明文名 |
| D05 | API 目录级 mkdir / rename / move / remove，目录明文名仅在代理侧可见 |
| D06 | 文本内容加解密往返（CRLF + LF + 中文），逐字节一致 |
| D07 | 受限形态登记：同目录换名 COPY 在 AList 侧 500（直连 AList 同样 500）→ SKIP |
| D08 | 受限形态归因：跨目录 MOVE 撞名。AList 的 `BaiduNetdisk` 驱动 Move 为 `newname=源文件名 + ondup=fail`，目标目录已有同名（密文同名）时百度返回 `errno 12` → 500；本用例同时验证「经代理」与「直连 AList」均 500，并在移除目标同名文件后确认同一 MOVE 恢复 2xx |

## 6. 判读方式

输出三类行：

```
API_RULES {"serverHost":"...","serverPort":5344,"rules":[{"enable":true,"encType":"aesctr","encName":true,"encFolder":true,"encPath":["..."]}]}
API_CASE PASS B05 加密上传 /api/fs/put :: HTTP 200
API_SUMMARY {"runtime":"openwrt tjs","total":37,"pass":37,"fail":0,"skip":0}
```

- `API_RULES` 是**生效规则回显**（`password` 一律脱敏）。排查"加密不生效"时先看这一行：
  `encName`/`encFolder` 是否为 `true`、`encPath` 是否与请求路径形状匹配。
- 退出码：`0` 全部通过；`1` 有用例失败；`2` 前置失败（登录失败、缺凭据等）。
- 断言一律通过 `assert()` 抛出。用例失败时 `detail` 直接给出实际值，不用"把失败描述当字符串返回"的写法。
- **`SKIP` 的两种来源**：① `API_SKIP_WEBDAV=1`（运行时无 WebDAV 方法时跳过 C 组）；
  ② 断言抛出的错误消息以 `SKIP::` 开头——表示"已归因的受限形态，非本适配层缺陷"，例如
  C-26（txiki fetch 等待响应头 15s 上限，后端慢时并发请求排队超限）、D07（AList 侧同目录 COPY 限制）。
  SKIP 只对**已归因的形态**生效：一旦状态码/内容变了（例如 500 变成 502 或内容不一致），仍会落到 `FAIL`。

### WebDAV 的判读注意

WebDAV 的 `href` 是 URI，必须是百分号编码形式。断言前要解码再比对，
例如 `dav%20%E6%A0%B7%E4%BE%8B.txt` 解码后才是明文 `dav 样例.txt`。

### Guest（txiki）环境的注意

- **URL 必须显式百分号编码**：txiki 的 `fetch` 不会像 Node 一样对 URL 中的空格与非 ASCII 自动编码，
  裸空格会让请求行在服务端按空格截断（文件名丢后缀、PROPFIND href 截断）。套件统一用
  `davUrl() = proxyOrigin + encodeURI(path)`；真实 WebDAV 客户端（rclone 等）本就发送编码路径。
- **不要依赖 fetch 自动跟随重定向**：txiki 自动跟随 302 会抛 `Network request failed: closed before established`；
  需要重定向时用 `redirect: 'manual'` 自行循环。代理内部即为 `manual` + 自实现跳转。
- **A09 断言语义**：环境可能带预置 WebDAV 条目（如出厂配置 `other-webdav`），
  断言口径是「自建条目删净 + 总数复原」，不是「列表清空」。
- **真实 AList 直链与外网**：网盘挂载的 `/d`、`/p` 直链要求 `sign`；AList WebDAV GET 会 302 到
  网盘 CDN（如 `baidupcs.com`）。guest 内通常不可达外网 CDN，B11/B12/B13/C04/C06 在 guest 失败属环境限制，
  与宿主 Node 侧（可上网）结果对照后再下结论。

## 7. 新增用例的写法

用例统一通过 `step(id, name, purpose, action, verify)` 注册：

```js
await step(
  'B19', '用例名', '这一项要证明什么',
  async () => ({ /* action：只做请求与取数，不做断言 */ }),
  (value) => {
    assert(value.status === 200, `HTTP ${value.status}`)
    return '给出一句话结论与关键实测值'
  },
)
```

约定：

- `action` 内**不做断言**；断言全部放 `verify`，失败即抛出。
- 新用例必须自带清理：在 `finally` 中回收自己创建的目录/文件，并恢复被改动的配置。
- 涉及路径的用例要同时覆盖"命中规则"与"不命中规则"两个方向。
- 新增加密相关用例时，至少要覆盖算法 `aesctr`，并且断言必须落在**内容字节**或**云端实际文件名**上，
  不要只断言 HTTP 状态码。

## 8. 规则形状矩阵（rule-matrix）

当要回答「上传为什么是明文」时，用这个矩阵而不是 37 项用例集：它专门逐个测试 `encPath` 的写法。

- 脚本：`work/api-harness/rule-matrix.mjs`（不在 git 仓库内，属对照台工具）。
- 运行方式：借 `run-real.mjs` 的 `ENTRY_SCRIPT` 挂载，代理指向真实 AList。

```bash
cd work/api-harness
ENTRY_SCRIPT=$(pwd)/rule-matrix.mjs PROXY_KIND=adapted ALIST_PASSWORD='<secret>' node run-real.mjs > rule-matrix-adapted.log 2>&1
ENTRY_SCRIPT=$(pwd)/rule-matrix.mjs PROXY_KIND=upstream ALIST_PASSWORD='<secret>' node run-real.mjs > rule-matrix-upstream.log 2>&1
grep -E '^RULE_CASE|^RULE_MATRIX_SUMMARY' rule-matrix-*.log
```

- 每个用例：设置规则 → **真实上传** → **绕开代理直查原版 AList**，逐级核对目录名、文件名与内容。
- 判定口径：输出 `RULE_CASE <label> <verdict>`；`verdict` 取值 `ENCRYPTED` / `ENCRYPTED_NAMES_ONLY` /
  `PLAINTEXT` / `MIXED` / `BROKEN`（请求被 `convertRealPath` 改坏，典型 `storage not found`）/ `ERROR`（工具问题）。
- 必备的负向对照：规则不匹配、规则 `enable:false`。缺了这两个，`ENCRYPTED` 结果不可信。
- 逐级核对遇到「同一逻辑目录出现明文与密文两份」时会置 `levelAmbiguity`，这是规则语义导致的真实歧义，
  脚本不会替你在两份之间择一认定。
- 安全：只在 `API_E2E_ROOT` 下用唯一前缀 `_rm_<stamp>` 的隔离目录，结束必删；
  还原用户原配置的动作放在删除隔离目录**之前**，保证删除路径不经过加密变换。

## 9. 限制

- 本用例集走 HTTP/WebDAV 协议面，不覆盖浏览器渲染。前端页面验收在
  `openwrt-tjs/tests/browser-acceptance.py`。
- 本地 Node 与 Windows 侧的结果只能作为对照，不能写成 OpenWrt 结论。
- 跨 WSL / guest 的命令一律用字面路径：宿主命令行的 `$VAR`/`$?`/`$( )` 会在到达 guest 前被外层展开。
  一键部署脚本 `openwrt-tjs/tests/guest-deploy.sh` 把挂载、装包、修 slirp、起服务与 md5 回显固化在 guest 内执行。
  环境拓扑、重建步骤与故障速查见工作区根的 `docs/openwrt-guest-runbook.md`。
- 用 `curl` 探测本地端口时必须加 `--noproxy '*'`：本机 `http_proxy` 指向 `127.0.0.1:9851`，
  不加会得到误导性的 `502 upstream connect failed` 而不是「连接被拒」。
- 真实 AList 若为网盘类挂载，`/d`、`/p` 直链要求 `sign` 参数、WebDAV `COPY` 由 AList 返回 500，
  相关用例会稳定失败；这属被测环境行为，判读时须与上游原版对照后再下结论。
