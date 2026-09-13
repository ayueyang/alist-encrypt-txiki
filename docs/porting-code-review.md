# 移植代码审查报告（2026-09-13，R-34）

> 审查对象：`alist-encrypt-txiki` 适配版（worktree `openwrt/alist-encrypt`，分支 `openwrt-tjs`）
> 上游基线：`upstream/alist-encrypt`，`main@3d5f19fc5a001dfcac110d4c7d3d12d12ab4e617`
> 审查结论、已实施修复与剩余项均以本文件为准；测试输出记录在 [`tests/run-2026-09-13.md`](../tests/run-2026-09-13.md) 的 R-34 段。

## 1. 判定标准

按维护者给定的四条标准评估，逐条给出可核对的量化结果：

| 编号 | 标准 | 判定方式 |
|---|---|---|
| S-1 | **只为移植**：能一样就一样 | 与上游逐字节 diff（忽略行尾）；列出差异文件清单 |
| S-2 | 不能一样时**逻辑必须一样** | 差异是否只落在运行时边界；业务语义是否有等价性证据 |
| S-3 | **可维护性**接近原版 | 上游同步成本、适配面是否收敛、是否引入并行实现 |
| S-4 | **可读性**接近原版 | 命名/结构/注释是否延续上游习惯，是否新增需要额外理解的机制 |

补充规则（维护者给定）：**上游问题只登记不改**；**移植侧没做好可以改**。

## 2. 方法

1. **源码对照**：对 `node-proxy/` 全部 29 个 `.js` 源文件执行 `diff --strip-trailing-cr`，逐个分类差异。
2. **越界判定**：凡差异落在业务逻辑（规则匹配、路径转换、缓存语义、AList API 语义）而非运行时边界，一律判为越界，要求证据或移除。
3. **登记核对**：对每处差异检索 `docs/` 与计划文件，区分「已登记替换项」与「未登记改动」。
4. **提交考古**：用 `git log -S` 定位每处改动的引入提交，判断是否有独立理由。
5. **行为验证**：向量一致性、HTTP 边界矩阵、38 项 API 套件（适配版与上游原版在**同一模拟环境**对照）、DAO 重启持久化、真实 tjs 运行时对真实 AList 的链路探测。

## 3. 结论摘要

**总体判定：符合移植标准，但存在 3 类偏离，已修复；另 2 项需登记/决策。**

- **S-1 达标**：`node-proxy/src/` **22 / 29 个源文件与上游逐字节相同**（修复前为 20/29）。`app.js` 与上游完全一致（CLI 分支只在打包期由 esbuild 改写，源文件不动）。
- **S-2 达标**：剩余 7 个差异文件**全部**是运行时边界替换（fs 异步、crypto、stream、http→fetch、worker_threads、DAODB、配置目录），加 1 处已登记的部署事实修复（`normalizeRawUrl`）与 1 处已登记的业务级分叉（U-01）。
- **S-3 / S-4 基本达标**：平台适配层以 Node 同名 API 承接，文件短小；上游文件改动面收敛到 7 个。唯一扣分项是 `fixed-length-fetch.js` 自建了第二套 HTTP/1.1 栈——已登记为 C-24 并标注为上游同步时的重点回归对象（不再计为「未编号」）。
- **修复前存在 3 类不应有的偏离**：① 「备份」提交引入的 118 行 AList API 兜底业务逻辑；② 业务无关的缓存查找语义改动；③ 多处删除上游日志调用点，与已登记的 C-10 契约直接冲突。

## 4. 逐文件结论

| 文件 | 修复前 | 修复后 | 差异性质 |
|---|---|---|---|
| `app.js` | 一致 | 一致 | — |
| `encDavHandle.js` | +156 / −38 | **一致** | 修复前含 118 行越界兜底逻辑（F-01） |
| `dao/fileDao.js` | +12 / −6 | **一致** | 修复前含缓存查找语义改动（F-02） |
| `config.js` | 差异 | 差异 | `fs` 异步、配置目录扁平化、U-01 归一化 |
| `router.js` | 差异 | 差异 | `fs` 异步、U-01 边界调用 |
| `encNameRouter.js` | 差异 | 差异 | `normalizeRawUrl()`（已登记部署事实） |
| `utils/convertFile.js` | 差异 | 差异 | 同步 `fs` → 异步 `fs` |
| `utils/httpClient.js` | 差异 | 差异 | Node `http/https` + Agent + pipe → Fetch/Web Streams |
| `utils/levelDB.js` | 差异 | 差异 | `nedb-promises` → `tjs:sqlite` |
| `utils/PRGAThread.js` | 差异 | 差异 | `worker_threads` → txiki Worker |
| 其余 20 个源文件 | 一致 | 一致 | — |

`build.mjs` 的 alias 表把 `koa / koa-router / koa-bodyparser / koa-static / http / https / crypto / stream / fs / path / log4js / dotenv / console` 在**构建期**映射到 `openwrt-tjs/src/platform/*`，使上游文件无需改写导入语句即可打包——这是「能一样就一样」得以实现的关键机制，予以肯定。

## 5. 发现清单

### F-01（已修复）`encDavHandle.js` 内的 118 行 AList API 兜底逻辑

- **内容**：新增 `apiFallbackStatus = {501, 502}`、`getBasicCredentials`、`getApiPath`、`requestAlistApi`、`waitForAlistPath`、`fallbackFileOperation`；当 COPY/MOVE 返回 501/502 时，用 Basic 凭据重新登录 AList，改走 `/api/fs/copy`、`/api/fs/move`、`/api/fs/rename` 并轮询确认。
- **判定：越界**。它在适配层内重新实现了一遍 AList 操作语义，属业务逻辑而非运行时边界，直接违反 S-2；且 `git log -S` 显示它由唯一的 `aa7c88d 备份` 提交引入，无独立提交说明。
- **收益为负的证据**：触发条件 501/502 在实测中的唯一来源是 **QEMU slirp 的 `502 Bad Gateway`**（`tests/run-2026-09-12.md:184`、`:311` 明确记录 guest 侧 C07/C08/C09 为 502/404），不是 AList 的业务响应；而该代码存在期间 C07/C08/C09 在三平台上始终失败。即：**它没有让任何用例转绿，却改变了 COPY/MOVE 的失败语义**（可能把传输失败伪装成业务成功）。
- **处置**：整段移除；`encDavHandle.js` 恢复与上游**逐字节一致**。若将来确需兜底，应作为独立需求立项并补 501/502 的来源证据，而不是留在适配层。

### F-02（已修复）`dao/fileDao.js` 的缓存查找回退

- **内容**：`getFileInfo()` 在精确键未命中时，再用「加/去尾斜杠」的替代键查一次。
- **判定：越界**。上游语义是「精确键命中或返回 `null`」；该改动放宽了命中条件，可能让同名文件与其目录的缓存条目互相误命中，属业务语义改动。
- **登记状态**：`docs/` 与计划文件中均无记录。
- **处置**：移除，恢复上游实现。移除后 38 项套件（含 B05–B09 的缓存/重定向链路）与上游对照结果不变（见 §6）。

### F-03（已修复）删除上游日志调用点，与已登记的 C-10 契约冲突

- **内容**：被删的上游日志调用点共 20 处：`config.js` 3、`router.js` 5、`encDavHandle.js` 4（另含 `import { log } from 'console'`）、`utils/httpClient.js` 7、`utils/levelDB.js` 1。
- **判定：违规**。C-10 在兼容性总表中明确写着「保持不变的内容：**原日志调用点和级别**」，而实现删除了这些调用点；`router.js` 中 `console.log(username, password)` 的删除尤其没有理由——平台层 `redact.js` 已对密码/token/授权头统一脱敏，该行会被打印成 `[REDACTED]`。
- **处置**：全部恢复（`httpClient.js` 中因 Fetch 模型没有远端 `close` 事件，`@远程响应关闭...` 映射到「本地响应已关闭、即将取消源流」的同一时刻，并加注释说明；`@本地响应关闭...` 因 C-19 已登记的「无入站关闭事件」无法映射，属登记内的限制）。

### F-04（已修复）`levelDB` 定时清理丢失上游调用点

- **内容**：上游的 30 秒清理循环是「遍历 → 逐条删除」，清理时打印 `@@expire`；适配版改成单条 SQL `DELETE`，`@@expire` 调用点消失。
- **处置**：改为与上游同形的遍历 + 逐条删除（新增 `expiredData()`/`removeByKey()` 两个方法，SQL 侧仍按 `expire` 过滤），保留同名同级别日志。测试入口 `dao-test-entry.js` 的对应调用同步更新。

### F-05（已修复）PRGA worker 数量公式不一致

- **内容**：上游为 `parseInt(os.cpus().length / 2 + 1)`（注释：留一个给后续 RC4 预加载），适配版为 `floor(hardwareConcurrency / 2)`，在 4 核机器上少一个 worker。
- **处置**：对齐为 `Math.max(1, Math.floor(hc / 2) + 1)`，四种核数下与上游取值一致（1→1、2→2、3→2、4→3）。

### F-06（已修复）U-01 归一化的冗余调用点

- **内容**：`normalizeAlistConfig()` 被调用 3 次：`config.js` 模块加载处、`router.js` 保存处、以及 `initAlistConfig()` 内部；后两者覆盖前者，`initAlistConfig()` 内那次在两条调用路径上都冗余。
- **处置**：移除 `initAlistConfig()` 内的冗余调用，分叉收敛为「读边界 + 保存边界」两处，与登记表对 U-01 的范围描述一致。移除后已实测：保存 `会员//ARM/.*` 仍落为 `会员/ARM/.*`（U-01 语义保持），配置可正常还原。

### F-07（已结案，2026-09-13 深夜补证）`httpClient.createHeaders()` 过滤 `origin` 请求头

- **内容**：出站 Fetch 时跳过 `host`（C-15 已登记）之外，还跳过 `origin`。
- **原疑点**：注释给的理由是「txiki.js 会给跨域 fetch 加上 Origin」，而该过滤表面上看只影响入站 Origin 是否被转发 —— 当时判断为「理由与实现不自洽」，且 `origin` 不在 C-15/C-16 登记范围内，因此挂为待决策。
- **补证（R-36，两路实测）**：
  1. **运行时侧**：用回显服务器 + 桌面 tjs 实测四个用例（显式 `Origin`、显式 `host`、无 `Origin`、混合）。结果是**运行时不接受调用方给的 Origin**：调用方传 `http://127.0.0.1:5344`，对端收到的是 `http://127.0.0.1`（端口被丢弃）；即使调用方完全不传，运行时也会自行补上 `Origin: <scheme>://<目标 host>`。⇒ **注释的结论正确**（运行时确实自行添加 Origin），过滤只是把「不可控的头」显式排除，与运行时既定行为一致。
  2. **CDN 侧**：对真实 302 目标（WebDAV GET → `yq01-cm01.baidupcs.com`）在六种变因下探测（curl UA / 浏览器 UA / +`Referer: pan.baidu.com` / +`Origin=代理自身` / +`Origin=第三方` / HEAD），响应**完全一致**：`403`、94 字节、`{"error_code":31362,"error_msg":"sign error"}`。⇒ `Origin` 不参与该 CDN 的鉴权/反盗链判定，过滤与否**在链路上没有可观察差异**。
- **结论与处置**：**无需改码**。这是运行时边界（调用方无法决定出站 Origin），不是业务语义改动；已登记为 **C-25**（替换与不支持项表），并把证据写入 `tests/run-2026-09-13.md` R-36 段。因不涉及源码变更，**不升包、不重编**（dist 仍为 `78beaa11…`、应用包仍为 r9）。
- **顺带记下的运行时事实（供后续参考）**：txiki 生成的 Origin 省略端口（`http://127.0.0.1` 而非 `http://127.0.0.1:5399`），与 Fetch 规范对非默认端口的写法不同；当前用途（服务端转发）无影响。

### F-08（未修改，已按建议登记为 C-24）`fixed-length-fetch.js` 是第二套 HTTP 栈

- **内容**：189 行自建 HTTP/1.1 客户端（socket 直连 + 手写请求行/头 + 手动解析状态行、`Content-Length`、chunked），用于「流式 body 且带已知长度」的上传。
- **判定**：属必要的运行时补丁（C-18 记录了 txiki Fetch 对流式 body 只能 chunked 的限制），但它是**与运行时 fetch 并行的第二套实现**，是本次审查中维护风险最高的模块。
- **登记状态**：**已登记为 C-24**（替换与不支持项表），已写明适用范围、失败模式（4 MiB 上限、仅 http/https、必须带合法 `Content-Length`）与测试入口，并列为后续上游同步时的重点回归对象。本轮**未修改其实现**。

### F-09（已修复）DAO 测试的时序竞态

- **内容**：`dao-test-entry.js` 的 `write` 阶段以 1 秒 TTL 写入 `restart-expire`，`read` 阶段（另一进程）立即断言其已过期；两者间隔取决于进程启动耗时，**可小于 1 秒**，导致断言偶发失败。
- **处置**：在 `read` 阶段显式等待 1.2 秒后再断言——**只消除竞态，未放宽任何断言**。复跑通过。

### F-10（已处理）源码变更导致产物口径失配

- **内容**：本次修改了 `node-proxy/src/`，`dist/server.mjs` 由 `f351646c…` 变为 `78beaa11…`，与已交付的 r8 包（`5e076136…`）不再匹配，违反「安装前必须核对 guest 内 `server.mjs` 与 dist 的 md5 一致」的项目规则。
- **处置**：`PKG_RELEASE` 升 **9**，用同一 SDK 重建 `alist-encrypt-tjs-0.3.0-r9.apk`（md5 `ae7189e7…`）；已核对 SDK 打包目录中 `/usr/lib/alist-encrypt/server.mjs` 的 md5 = `78beaa11…`，与当前 dist 一致。

## 6. 修复后的功能验证

| 项 | 结果 |
|---|---|
| 加密向量（Node 基线 vs 桌面 txiki） | 输出**逐字节相同**，`ok:true`；AES-CTR `50d530bf…`、RC4 `71759b74…`、ChaCha20 `c50cda6e…`、MIX `37906b3b…`，Range 11 个偏移全通过 |
| HTTP 边界矩阵（桌面 txiki） | 11 项 PASS，2 项为已登记限制（C-17 `Expect`、C-19 取消链路） |
| 38 项 API 套件（适配版 / 模拟 AList） | **36/38**，失败项 B06、B19 |
| 38 项 API 套件（**上游原版** / 同一模拟环境） | **36/38**，失败项 B06、B19 —— **完全相同** |
| DAO 重启持久化与过期语义 | 全通过（含并发 16 键、空值语义、TTL、重启恢复） |
| 真实 tjs 运行时 ↔ 真实 AList（`127.0.0.1:5244`） | `/ping`、登录、`getUserInfo`、`getAlistConfig`、`getWebdavonfig`、经代理访问 AList 公开接口均 200；未登录访问为 `401 user unlogin`（非 500） |
| U-01 归一化分叉 | 保存 `会员//ARM/.*` → 回读 `会员/ARM/.*`，PASS；配置已还原 |

> B06（模拟 AList 的 `raw_url` 直链 404）与 B19（8 MB 上传在本机 <300 ms 完成，300 ms 间隔的探测只采到 1 个样本）在**上游原版上同样失败**，属对照台自身限制，不是适配回归。

## 7. 剩余差异的登记状态

| 差异 | 类别 | 登记状态 |
|---|---|---|
| `fs` 同步 → 异步（`config.js`、`router.js`、`convertFile.js`） | 运行时边界 | C-07 |
| `crypto` → `tjs:hashing` + noble + WebCrypto | 运行时边界 | C-03、C-22 |
| `stream.Transform` → `TransformStream` | 运行时边界 | C-04 |
| `http/https` + Agent + pipe → Fetch/Web Streams | 运行时边界 | C-05、C-15～C-20 |
| `worker_threads` → txiki Worker | 运行时边界 | C-11 |
| `nedb-promises` → `tjs:sqlite` | 运行时边界 | C-09 |
| 配置目录由 `cwd/conf` 扁平化为 `cwd` | 部署约定 | 已在替换表与手册中说明 |
| `normalizeRawUrl()`（`encNameRouter.js`） | 环境事实修复 | 已登记（替换文档「不是替换，但必须记录的部署事实」） |
| `normalizeAlistConfig()`（U-01） | **业务级分叉** | 已登记为唯一分叉，范围未扩大 |
| 过滤 `origin` 请求头 | 运行时边界（不可复现上游形状） | **C-25，已登记（见 F-07 结案）** |
| `fixed-length-fetch.js` 第二套 HTTP 栈 | 运行时补丁 | **C-24**（F-08 建议已落地） |
| `redact.js` 日志脱敏层 | 运行时边界（属 C-10 的实现细节） | **归入 C-10**，不再作为独立未编号项：替换表 C-10 行与兼容总表 C-10 行均已注明其实现在 `openwrt-tjs/src/redact.js` |
| `@本地响应关闭...` 日志调用点无法映射 | 运行时边界 | C-19（无入站关闭事件） |

## 8. 可维护性与可读性评估

**做得好的部分**

1. 上游文件改动面收敛到 7/29，且集中在 `fs`/`crypto`/`stream`/`http`/`worker`/DAO 六个边界，符合「上游同步优先、适配面最小」的项目约定。
2. 平台层一律用 Node 同名 API 承接（`fs.exists/readFile/readdir`、`crypto.createHash/createCipheriv`、`Transform`、`path`、`process`），读者按 Node 习惯即可理解，`process.argv/cwd/env` 还与部署目录做了显式契约。
3. 平台层文件普遍带「为什么」注释（如 C-23 的 Windows 盘符前导斜杠、`stream.js` 的 64 KiB 合并缓冲、`prga-worker` 失败回退），而不是只写「做了什么」。

**扣分项**

1. `fixed-length-fetch.js` 与运行时 fetch 并行存在，读者需要额外判断「哪条路径会走哪套栈」；应登记并补单元级测试。
2. `redact.js` 是上游没有的能力（上游直接打印原始日志）。它作为安全措施合理，但属「新增机制」，必须由登记表承载，否则会与「逻辑一样」的直觉冲突。
3. `PRGAThread.js` 由 CommonJS + `worker_threads` 改写为 ESM + Web Worker，是本轮唯一「整体重写」的上游文件；虽已通过向量与 RC4 Range 验证，仍应视为上游同步的高风险点。

## 9. 上游问题（只记录，未修改）

本轮未新发现上游业务缺陷。已有登记项（U-01…U-06）保持原处置，见 [`docs/upstream-issues.md`](upstream-issues.md)。本轮唯一的业务级分叉仍是 U-01，且范围已收敛（见 F-06）。

## 10. 后续建议

1. ~~把 `fixed-length-fetch.js` 登记为 C-24，`redact.js` 归入 C-10 编号内，消除「未编号替换项」~~ → **已完成**：`fixed-length-fetch.js` 已登记为 **C-24**、`redact.js` 已归入 **C-10**（两处均见第 7 节表），登记表内**不再存在未编号替换项**。
2. ~~F-07（`origin` 头）在取得真实 CDN 侧证据后决定是否恢复转发~~ → **已结案（R-36）**：运行时侧与 CDN 侧两路取证均显示无行为差异，登记为 C-25，无需改码、不升包。
3. ~~r9 包尚未在 OpenWrt guest 内复跑 38 项套件~~ → **已完成（R-35，2026-09-13 晚）**：guest 内 `/usr/bin/tjs` 实测 `total=38 pass=30 fail=8`，8 项失败与 r8/r7 基线逐项同因同编号（B11-13 直链 `sign`、C04/C06 CDN 不可达、C07-09 AList COPY 级联），**无新增回归**；载荷时效绑定通过（guest 内 `server.mjs` md5 `78beaa11…` = dist）。原始日志 `openwrt-tjs/tests/suite-r9-guest-20260913.log`，记录见 `tests/run-2026-09-13.md` 第 6 节。
4. 每次改动 `node-proxy/src/` 后，按既定流程重跑 `build.mjs` 并升 `PKG_RELEASE`，同时更新本报告的表 4 与第 7 节。
