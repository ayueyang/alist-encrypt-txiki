# 2026-09-25 测试项目审查与真实网盘验收（运行记录）

> 本轮已完成：模拟台、宿主 Node + 真实 AList、ARM64 QEMU guest 上发布 r10 与独立候选、只读浏览器分别验收。`SKIP` 不等于 PASS；QEMU guest 不等于用户生产路由器现场。口令与下载 `sign` 不记入本文。测试指南见 `../../docs/api-test-guide.md`。
> 文中“未公开推送”仅描述测试**执行当时**的边界；后来获得用户授权同步本人仓库，不表示 r10 发布包、正式 `dist` 或 Release 已更新。

## 1. 固定边界与审查

- 基线：根仓 `213f673`；OpenWrt 适配 worktree `3f3dd52`；未经修改的上游原版 `3d5f19f`。未公开推送；上游目录检查干净。
- 正式发布 **r10**：APK MD5 `c03486423123cc72a2ef27287e809b25`，安装后 guest 载荷 MD5 `eab8830a36548ccb9e04fb768da31fdd`。新源码的独立候选产物 `server.mjs` MD5 `064149adbf1f668067ca0d3889302139`；未覆盖 r10 APK/dist。
- 逐项审查 A–D 组 48 项 + Z01–Z04 清理回读 4 项（总 52），并巡查固定加密向量、DAO/HTTP、WebDAV、浏览器/上传探针。真实云端仅使用 `/会员/_api_e2e_<时间戳>_<随机后缀>`、`/会员/_api_plain_<时间戳>_<随机后缀>`；创建前断言不存在，不运行写死 `/会员/ARM` 的老探针。A09 的临时 WebDAV 条目亦随机化，测试后逐项恢复配置、删除临时条目、**直接回读 AList 核实**。
- `SKIP` 不是通过：B19 模拟后端 8MB 上传过快，没有足够的 `/ping` 样本时只证明落盘；已归因 AList 同目录换名 COPY（D07）代理与直连同为 500 时登记 SKIP。对于慢上传仍采不到样本、意外状态/字节差异照常 FAIL。另测 `API_SKIP_WEBDAV=1` 时应跳过 C9 + WebDAV 依赖的 D9，但不跳过纯 API 的 D05。

## 2. 分层证据（最终）

表中 `logs/` 是工作区根 `work/api-harness/logs/`（被忽略的实验日志）；guest 原始脱敏控制台保存在 WSL 共享目录 `/home/openclaw/alist-encrypt-guestshare-20260925/logs/`，本文汇总须随仓库长期保存。

| 层级 | 执行/证据 | PASS / FAIL / SKIP | 结论 |
| --- | --- | --- | --- |
| 仅代码／源码 | 适配回归、固定向量、脚本语法、日志脱敏 | 适配 **5/0/0**；脱敏 **5/0/0**；脚本语法 **51/51**；Node 原版固定向量 ok | 仅宿主代码证据；适配/原版差异审计 21/29 相同，其余为已记录替换，不改业务语义。 |
| 模拟 AList + 候选 Node 测试替身 | `node work/api-harness/run-api.mjs`；`work/api-harness/logs/mock-candidate-final-20260925.log` | **51 / 0 / 1**（52） | B19 模拟 8MB 上传约 320ms，只有 1 个 `/ping`，测不到并发属性；Z01–Z04 PASS。非真实网盘证据。 |
| 模拟 AList + 原版 Node | `node work/api-harness/run-upstream.mjs`；`logs/mock-upstream-original-20260925.log` | **51 / 0 / 1**（52） | 同样仅 B19 快上传 SKIP；原版源码未改动。 |
| 模拟环境、禁 WebDAV 分支 | `API_SKIP_WEBDAV=1` 下跑候选；`logs/mock-no-webdav-20260925.log` | **33 / 0 / 19**（52） | 18 项 WebDAV 依赖 SKIP + B19 快上传 SKIP，D05 照常执行，Z01–Z04 PASS。 |
| 真实 AList 直连（非代理） | 实际 BaiduNetdisk `/会员`：认证、目录列表；套件直查密文名与内容头/尺寸，末次独立直查残留 | 根目录 **46 项**；测试前缀残留 **0** | `/ping`、登录、列表、读取/写入/回读/删除都用了真实服务。勿将云端隔离测试数据当用户原有文件修改。 |
| 宿主 Node 测试替身 + **真实 AList/网盘** | `node work/api-harness/run-real.mjs`；`logs/real-candidate-authority-fixed-20260925.log` | **51 / 0 / 1**（52） | B05/B06 实测云端文件名和内容为密文，代理读取明文与 Range 对照；WebDAV COPY/MOVE 与 API 操作已实测。仅 D07 为直连 AList 同样 500 的已归因限制。Z01–Z04 PASS；独立直查目录仍为 46 项、隔离前缀残留 0。**不等于 OpenWrt guest 通过。** |
| ARM64 OpenWrt guest：已发布 r10 + **真实网盘** | OpenWrt 25.12.5/aarch64、`txiki-js` v26.6.0，正式 APK/dist MD5 未变；`/usr/bin/tjs` 实跑与候选一致的完整 52 项；原始脱敏记录 `logs/guest-r10-cloud-20260925.log` | **50 / 0 / 2**（52）；B19 的 8MB PUT 12070ms、健康 ping 11/13 且密文尺寸吻合 | D03 因真实 txiki 并发 GET 撞上 C-26 15s 响应头上限 SKIP、D07 为 AList 自身 500 SKIP；C07/C08/D08 等通过；Z01–Z04 PASS，直连根仍 46 项、测试目录残留 0。 |
| ARM64 OpenWrt guest：源码候选（仅代码层） | 候选向量 guest 内 MD5 `064149adbf1f668067ca0d3889302139`；`/usr/bin/tjs run /mnt/host/candidate/openwrt-vectors.mjs`、独立 `/tmp` 数据目录的 DAO、仅本地 fixture 的 HTTP 矩阵；再由宿主 Node 跑同一候选固定向量 | guest 向量 **ok、4 算法 × 12 Range 全 True**；DAO **12 PASS（跨进程读写）**；HTTP **11 PASS**；3 个入口 RC=0；Node 与 guest JSON 的 `size/chunks/offsets/vectors/name/results` **逐项完全一致** | 代码层跨运行时比对完成，不代替下行候选真云。 |
| ARM64 OpenWrt guest：源码候选 + **真实网盘** | 独立 `ALIST_ENCRYPT_HOME=/tmp/alist-encrypt-candidate-20260925`，只从 9p 载入候选、不覆盖 r10；PID 8472 监听 5344，`/ping` 经代理到真 AList 为 200 pong；用同一套件全量跑，脱敏记录 `logs/guest-candidate-cloud-20260925.log` | **50 / 0 / 2**（52） | D03 因 C-26 15s 上限 SKIP，D07 AList 侧 500 SKIP；B19 客户端等头约 17s 超时，但云端 8MB 密文尺寸**最终吻合**、ping 9/12 正常，按原有 C-26 条件 PASS（**不是**客户端成功收到响应）；C07/C08/D08 等通过。Z01–Z04 PASS、独立云端根仍 46 项、隔离残留 0。 |
| Windows Playwright + guest 候选只读浏览器 | `python openwrt/alist-encrypt/openwrt-tjs/tests/browser-acceptance.py`；截图仅在忽略的 `work/api-harness/browser-candidate-20260925/`，未公开 | **脚本退出 0**；配置 UI 登录、AList 浏览器登录与首页渲染成功；3 张截图 | console/page 错误 0，但导航/资源切换时有 3 项 `net::ERR_ABORTED` request failures；这是**UI 冒烟**，不能代替上面的云端字节测试或断言全部网络请求成功。 |

## 3. 初轮失败与窄修复

首次真实网盘候选 Node 替身为 **46 PASS / 6 FAIL / 0 SKIP**：C07/C08/D01/D07/D08 的 COPY/MOVE 为 HTTP 502，C09 因前置 MOVE 失败而 404；**当时不能写成通过**。探针证实 Node `fetch` 强制发送带端口 `Host`，而真实 txiki 的 WebDAV 兼容路径发送不带端口 `Host`，测试台未忠实模拟；AList 按 `Host`/`Destination` authority 判定跨服务器并拒绝。只修*被忽略的 Node 测试替身* `work/api-harness/shims/tjs-install.mjs`（COPY/MOVE 包括空 `ReadableStream` 使用 `http.request` 模拟 txiki），并在 mock 增加 authority 断言；D08 直连基线按 Node/txiki 的 Host 差异生成 `Destination`。严格 mock 和真云完整复测后为上表数据。生产适配逻辑与原版业务代码**未修改**。B19 快上传采样的 1.5s 易假 FAIL，测试断言按 `/ping` 单次 4s 超时窗口改为 <4s 记“样本不足”SKIP；长上传样本不足仍 FAIL。

另有一个仅影响**隔离测试初始化**的上游既有形态：上游 `config.js` 对 `ALIST_HOST` 使用 `serverAddr.indexOf(':') > 6`，因此 `http://10.0.2.2:5244` 的首个冒号在索引 4 会被忽略，新候选初启 `/ping` 超时；已停止该进程并恢复 r10 后，仅把 guest **测试启动脚本**改为原版可解析的 `10.0.2.2:5244`，重新用空的独立 HOME 启动候选，`/ping` 现 HTTP 200 pong。此处不修、不掩饰原版解析行为，不改生产代码。

## 4. 凭据、清理、未决

- 宿主 Node 真云日志中本轮测试口令出现 **0** 次；`sign=` 命中 56 处，全部显示 `[REDACTED]`，未脱敏签名 **0**。r10/候选两次 guest 串口捕获均在无回显握手后输入凭据，原始串口输出的口令命中 **0**；串口脱敏日志中 `sign=` 命中 0。候选服务的临时 guest 日志中 29 行含 `sign=`，未发现缺少 `[REDACTED]` 的行，检查后已删除该临时日志。浏览器日志口令命中 0，截图只放在忽略的私有目录。
- 完整套件 Z01/Z02 两处隔离目录消失、Z03 临时 WebDAV 配置条目消失、Z04 原配置快照恢复均 PASS。末次独立直连 `/会员` 返回 46 项，`_api_e2e_*`/`_api_plain_*` 残留为 0；不运行非隔离的旧上传脚本。
- r10 与独立候选均在 guest + 真网盘完整验收 **50/0/2**；各次 Z01–Z04 PASS，候选结束、浏览器验收与恢复 r10 **之后**又独立直连查 `/会员`：仍 46 项，隔离前缀残留 0。候选独立 HOME 已清理，正式 r10 procd 再次 `running`、PID 10373 监听 5344，guest 正式载荷 MD5 `eab8830a36548ccb9e04fb768da31fdd`，宿主正式 dist MD5 同值。仅目标路由器现场运行、本轮浏览器深度操作与已知 C-26/D07 限制未由本测试消除；宿主 Node 的 51/0/1 不可替代 guest 的 50/0/2。

## 5. 可复跑的入口与边界

- PowerShell 宿主（凭据由安全执行环境注入子进程环境，**命令中不写明文**）：`node work/api-harness/run-api.mjs`（模拟候选）、`node work/api-harness/run-upstream.mjs`（模拟原版）、`node work/api-harness/run-real.mjs`（真实 AList）；三者共享 `api-suite-run.mjs`。Windows 使用 PowerShell 的 `$env:VAR`；需要 Git sh 时用 `& "C:\Program Files\Git\bin\sh.exe"`，宿主 PATH 没有裸 `sh`。
- guest：`sh /mnt/host/tests/guest-deploy.sh` 装 r10；`/usr/bin/tjs run /mnt/host/candidate/openwrt-vectors.mjs` 跑候选固定向量；DAO 和 HTTP 通过共享目录的独立 `/tmp` 包装脚本运行。云端全套通过 `E2E_TARGET=api-suite` 的 `secure-e2e-runner.mjs` 接口在原生 `/usr/bin/tjs` 内运行，凭据仅在 `E2E_CREDENTIAL_READY` 后经无回显串口传入。候选以独立 HOME 和 9p 载荷临时运行，完成后停止并恢复 r10 procd，**不替换发布版**。
- 浏览器只读冒烟在 Windows Playwright 访问 guest 候选，另设 `BROWSER_OUTPUT_DIR` 防止覆盖旧截图；截图可能包含已有网盘文件名，保留在忽略目录，不纳入公开报告。含已知跳过的 52 项结果必须连同 SKIP 原因、直连残留复核一起读，不能只看退出码 0。未运行写固定业务目录的旧探针，也未推送远端。