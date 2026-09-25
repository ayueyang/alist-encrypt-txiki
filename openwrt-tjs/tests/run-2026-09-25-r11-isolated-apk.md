# 2026-09-25 下一版候选：独立 r11 APK 与目标运行时分层验收

> **仅为本地候选**：`0.3.0-r11` 未创建 GitHub Release、未覆盖现役 `r10`，也未在实体路由器或新版桌面发行包上验收。日期、版本号和下列哈希均指这一次隔离构建；包名中的 r11 不是已发布版本。

## 来源与边界

- 当前适配源码的独立构建位于根仓忽略目录 `work/r11-candidate-20260925/dist/`；临时派生构建脚本在成功后删除，未运行会删除正式 `openwrt-tjs/dist/` 的默认构建。`server.mjs` MD5：`064149adbf1f668067ca0d3889302139`，与此前已测源码候选相同；dist 顶层 18 项。
- ARM64 SDK 先完整复制到 WSL `/home/openclaw/alist-candidate-r11-sdk-20260925/`；将其两个绝对指向原 SDK 的 host/bin 软链重定向到**副本内**，只在副本中采用当前包源码 `ISC` 并暂改 `PKG_RELEASE:=11`。原 SDK package Makefile SHA256 `15fd03ec3d17cea42da7cfcb59df44e1d046038f5382f33765c9eebb77a3a248` 未变，适配仓正式 Makefile 仍为 r10。
- SDK 副本 `make package/alist-encrypt-tjs/clean` + `compile` RC0；构建日志保留于副本 `candidate-build.log`。产物复制到根仓 `work/r11-candidate-20260925/apk/alist-encrypt-tjs-0.3.0-r11.apk`，**SHA256 `95596c14763e1cddae04435fca3ba1dab228a01d63596e3b22fe96608b180079`**（MD5 `ca11ca645b11db1295b3ed0eccbb6ba9`）。同目录 `SHA256SUMS` 共 90 条，对候选 dist 和 APK 全部 `sha256sum -c` 通过。
- APK v3 元数据：`alist-encrypt-tjs`，`0.3.0-r11`，`noarch`，`ISC`，依赖 `libc txiki-js`；用 SDK `apk --allow-untrusted verify/extract` 完整性核验后，提取的 `server.mjs`/`convert.mjs`/`prga-worker.mjs`/`public/` 与隔离输入逐字节相同，三个服务/配置脚本与适配源码逐字节相同。**默认信任库对本次 r11 和此前 r10 均报 `UNTRUSTED signature`**；允许不受信任只用于本地检查及一次性 guest 安装，不能宣称已受信签名或适合直接在生产环境安装。

## 分层测试（不互相冒充）

| 层级 | 实际执行 | 结果 / 限制 |
|---|---|---|
| 宿主 Node fake-socket/Worker | adapter 回归和语法检查 | 5/5、RC0；mock 不替代目标运行时。 |
| Windows 原生 txiki v26.6.0 | 含空格路径旧源码候选固定向量、真实 Worker sentinel 和故意抛错 | 60 步/`ok:true`/RC0；sentinel 消息 RC0；throw 未触发 `PRGAThread.onerror`，靠既有 30,048ms timer 回退 RC0。**不是新版桌面包**。 |
| 原先现役 QEMU ARM64 guest 的源码候选 | 本地 Python 强制关闭 TCP fixture：Koa/raw 的 204、205、304；304 保留 CL12；带请求体 COPY、MOVE；另以真实 Worker 测 sentinel/throw | HTTP/WebDAV **8 PASS/0 FAIL/0 SKIP**，无真实网盘写入；Worker sentinel 443ms RC0、throw 无 `onerror` 但 30,428ms timer 回退 RC0。临时入口/日志/监听已清。**这些是源码载荷定点，不是新 APK 安装结果**。 |
| 历史真云（源码候选，独立 HOME） | 见 [同期真云分层报告](./run-2026-09-25-live-cloud.md) | 正式 r10 与**相同 MD5 的源码候选**各 50 PASS / 0 FAIL / 2 SKIP；不把它填进本次安装版 APK 的通过列。 |
| **本轮第二台独立 ARM64 QEMU initramfs guest：真正安装 r11 APK** | 从同一个只读 initramfs kernel 起独立无磁盘虚机；专用串口 `15556`、hostfwd `15223/5345`、9p `host11`，均不与现役 guest 共享；本地复制 ARM64 `txiki-js-26.6.0-r3` 与 `libatomic1/libstdcpp6` APK 后安装 | 首轮因 initramfs 禁止非仓库包而 RC99；补 `--force-non-repository`，在**一次性 guest** 用 `apk add --allow-untrusted --force-non-repository --no-network --repositories-file /dev/null` 安装 4/4 RC0。`apk list --installed` 明确显示 `alist-encrypt-tjs-0.3.0-r11` 与 `txiki-js-26.6.0-r3`。procd `running`，guest 安装载荷 MD5 `064149adbf1f668067ca0d3889302139`。 |
| **上述已安装版服务重启/只读后端冒烟** | 仅给第二台 guest 临时添加 QEMU NAT 地址 `10.0.2.15/24` 和路由；将 UCI `alist_host=10.0.2.2:5244` 指向 WSL 上可达的 AList，改用该 guest **全新 HOME** 首次初始化，再重启服务 | 第一次只看 HTTP 200 曾误以为成功：实体是 `success:false / code:500 / closed before established`，因为安装后先按默认 `192.168.1.100` 初始化的旧 HOME 保存了该地址，后改 env 不会覆盖。全新 HOME 的配置仅有 `10.0.2.2`（2 处）；此后代理 `GET /ping` **HTTP 200 且实体 `pong`**；`GET /api/public/settings` 直连 AList 与 r11 代理均 **HTTP 200、业务 code 200、1831 字节**。再次重启后 procd `running`、MD5 和新 HOME 配置均保持。**只读冒烟，未执行新 APK 的完整真云写入套件**。 |

## 清理、留存与闸门

- 测试结束只对二号 QEMU PID `3888` 核对独占命令行后发 SIGTERM；其 PID 文件自动消失，专用三个端口不再监听，二号 9p guestshare 已删除。正式 QEMU PID `171` 仍在运行；经**正式 guest 串口只读**复核，原版服务 `running`、`/usr/lib/alist-encrypt/server.mjs` MD5 `eab8830a36548ccb9e04fb768da31fdd`。Windows 正式 dist 同 MD5、正式 r10 APK MD5 `c03486423123cc72a2ef27287e809b25` 均不变。没有对既有网盘文件进行本轮写入。
- 本轮未修原版业务逻辑与固有问题：既有 30 秒 Worker 回退、D03/C-26 15 秒超时、D07 AList 自身 COPY 500、B19 样本不足等，仍按历史报告的层级/`SKIP` 保留。初期两次 `tjs.serve` fixture 不关闭连接以及 10 秒 Worker watchdog 都是测试装置的限制，已换正确夹具/预算并记录，不混入产品缺陷。
- 尚缺：实体路由器安装/长期运行、独立**新版桌面包**整套 HTTP/WebDAV 与安装验收、本次**已安装 r11 APK 的完整真云写入套件**、受信签名与用户批准的正式新版 Release。不得把这次 QEMU 的成功自动等同于生产验收，也不得用候选 APK 覆盖 r10。
