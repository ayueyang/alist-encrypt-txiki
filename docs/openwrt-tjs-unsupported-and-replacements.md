# OpenWrt txiki.js 不支持项与替换原因

## 目的

本文单独记录 `alist-encrypt` Node 原版在 OpenWrt txiki.js 中不能直接复用的运行时能力、实际证据、替换原因和保留的上游行为。这里的“替换”只允许发生在平台边界；加密算法、AList 路由、文件名协议和 WebDAV 业务逻辑仍以固定上游基线为准。

## 固定环境

- 上游：`upstream/alist-encrypt`，`main@3d5f19fc5a001dfcac110d4c7d3d12d12ab4e617`
- OpenWrt：`25.12.5 / armsr / armv8 / aarch64_generic`
- txiki.js：`v26.6.0-r3`，guest 执行器为 `/usr/bin/tjs`
- 应用包：`alist-encrypt-tjs-0.3.0-r10.apk`（md5 `c0348642…`，包内 `/usr/lib/alist-encrypt/server.mjs` = dist `eab8830a…`；本表于 r3 首次验收，r6–r10 复验未改变任何结论；历史包 r1–r9 并存，r9 及更早与 2026-09-15 的 WebDAV 跨目录 COPY/MOVE 修复不再匹配，仅供回溯）
- 验收日期：`2026-09-11`（首次）／`2026-09-12`–`09-13`（r6–r8 复验）／`2026-09-13`（r9 源码审查修复，见 `porting-code-review.md`；同日完成 r9 的 ARM64 guest 复跑 38 项 30/8，见 `tests/run-2026-09-13.md` R-35）／`2026-09-15`（r10 的 ARM64 guest 全量实测：套件扩为 48 项，`45/0/3`，见 `tests/run-2026-09-15.md` R-42；本轮登记 AList 侧「跨目录 MOVE 撞名」限制与运行时 **C-26**）

## 总表

| 编号 | 原版能力 | guest 中的实际问题 | 为什么必须替换 | 替换方式 | 保持不变的内容 | 状态 |
|---|---|---|---|---|---|---|
| C-01 | 全局 `Buffer` | txiki.js 不提供 Node `Buffer` 全局 | 上游大量模块直接使用 Buffer，删除会改变字节处理 | bundle 注入锁定的 `buffer@6.0.3` 表面 | 字节索引、编码、拷贝和整数读写 | 已通过固定向量 |
| C-02 | 全局 `process` | txiki.js 不提供 Node `process` | 配置、环境变量、退出和 CLI 参数必须继续可用 | 将 `argv/env/cwd/exit/pid` 映射到 txiki API | `ALIST_HOST`、`RUN_MODE`、端口和 CLI 语义 | 已通过服务验收 |
| C-03 | `crypto` / `node:crypto` | Node 模块名不能加载 | 加密字节必须与 Node 原版完全一致 | 使用 `tjs:hashing`、锁定的 noble 包和 Web Crypto | PBKDF2、摘要、AES-CTR、算法入口和密钥派生 | 已通过固定向量 |
| C-04 | Node `stream.Transform` | `stream` 模块不能加载 | `FlowEnc` 依赖 Transform 的逐块回调 | 用 Web `TransformStream` 承接原 `transform` 调用 | 四种算法、分块顺序和错误传播 | 已通过固定向量 |
| C-05 | Node `http` / `https` | txiki.js 使用 Fetch/Web Streams | 直接复制 Node request/response 会无法启动 | 保留 `httpClient` / `httpProxy` 签名，内部适配 Fetch | 方法、头、Range、重定向、文件名头和正常流 | 已通过 HTTP 与代理 E2E |
| C-06 | Koa 生态 | Koa、router、bodyparser、static 不能由裸 txiki 直接加载 | 原 Node HTTP server 对象不存在 | Hono 只作外层，小型适配层承接上游实际使用的 Koa 表面 | 路由注册顺序、接口名称和业务中间件 | 已通过服务与浏览器验收 |
| C-07 | Node `fs` 同步 API | txiki 文件 API 为异步，Node 模块不能加载 | 配置和文件转换不能依赖同步 Node I/O | 仅在平台边界改为 txiki 异步文件 API | 配置 JSON、路径、转换顺序和名称恢复 | 已通过持久化与转换测试 |
| C-08 | Node `path` | Node 模块名不能加载 | 文件名和目录路径处理不能删除或重写 | 直接映射官方 `tjs:path` | basename、dirname、extname、join、resolve 语义 | 已通过名称与 E2E |
| C-09 | `nedb-promises` | npm 依赖不能直接加载 | DAO 的覆盖、TTL 和 JSON 值语义仍必须保留 | 使用 `tjs:sqlite` 实现原 DAO 的最小表面 | `load/setValue/setExpire/getValue` 语义 | 已通过 DAO 与重启恢复 |
| C-10 | `log4js` | npm 模块和 Node 文件 appender 不适用 | OpenWrt 日志应交给 `logd`，不能引入另一套日志守护 | 保留 `debug/info/warn/error`，输出标准流并统一脱敏 | 原日志调用点和级别 | 脱敏用例通过，logd 作为运行时承接 |
| C-11 | `worker_threads` | Node 模块不能加载 | RC4 Range 定位需要异步计算，阻塞主线程会改变运行行为 | 使用 txiki Worker；失败时回退同一 PRGA 同步循环 | KSA、PRGA、定位和输出 | 已通过 Worker 与 RC4 Range |
| C-12 | `app.js` 顶层 `return` | txiki ESM 解析失败 | 运行时无法解析整个入口 | 仅 OpenWrt bundle 构建时移除 CLI 分支，转换命令使用独立入口 | 服务路由装配和 Node 原文件 | 已通过 bundle |
| C-13 | 无扩展名导入与 `@/` 别名 | 当前 txiki 加载方式不能解析 | 逐个改写会产生与上游持续分叉 | 用 esbuild 在构建期解析为单 bundle | 导入关系和模块职责 | 已通过 bundle |
| C-14 | 入站 `Request.signal` | 本次 txiki server 暴露为 `null` | 无条件调用会使所有请求返回 500 | 仅在 signal 存在时注册 abort 监听 | 正常请求、请求体和代理流 | 已通过服务；取消能力另列 C-19 |
| C-15 | 手工 `Host` 头 | txiki Fetch 已按 URL 生成 Host，重复设置会使 AList relay 返回 400 | 继续复制该头会破坏透明代理 | 出站 Fetch 过滤 `host`，路由计算仍读取入站头 | 目标 URL、其余请求头和路由 | 已通过透明代理 |
| C-16 | Node 逐跳响应头复制 | Fetch 响应再带 `connection/transfer-encoding` 会与新响应 framing 冲突 | 服务端 framing 必须由 txiki 重新生成 | 过滤逐跳头，保留业务端到端头 | 状态码、Range、Content-Disposition 和正文 | 已通过 HTTP 冒烟 |
| C-17 | `checkContinue` / `Expect: 100-continue` | txiki 没有 Node `checkContinue` 事件 | 伪造事件会给客户端错误的支持假象 | 过滤出站 `Expect`；严格等待 100 的客户端不支持 | 普通无 Expect 请求和 PUT/WebDAV 路由 | 已确认限制 |
| C-18 | Node 流请求 framing | ReadableStream 会自动使用 chunked，复制 `Content-Length` 会形成冲突 | 同时发送 CL 和 TE 会被运行时拒绝 | 流式 body 删除长度头，已知长度 body 保持原样 | 上传字节、FlowEnc 和业务头 | 已通过对照与上传 |
| C-19 | `response.on('close')` 取消链路 | 本次 txiki server 没有可用入站 signal/关闭事件 | 不能伪造 Node close 事件，否则会误报取消已支持 | 保留可用 signal 时的监听；否则依靠连接关闭清理 | 正常响应、加密流和字节协议 | 已确认限制 |
| C-20 | 单值 `Content-Length` | Fetch 可能暴露重复值 `"20,  20"` | 上游 `contentLength * 1` 会得到 `NaN` | 仅折叠完全相同的十进制重复值 | 上传路由、FlowEnc 和正文 | 已通过入站头与真实上传 |
| C-21 | WebDAV uncommon methods | r2 parser 在应用层之前拒绝 `PROPFIND/MKCOL/COPY/MOVE` | JavaScript 路由根本收不到请求，不能用 POST 伪装 | 在 txiki vendored libwebsockets 增加四个 method token、lexer/parser 表和 txiki 映射；保留 `LWS_WITH_HTTP_UNCOMMON_HEADERS=ON` | `encDavHandle`、XML、路径、AList 请求和加密逻辑 | r3 方法探针与 WebDAV E2E 已通过 |

| C-24 | 「流式 body + 已知长度」的请求 | txiki Fetch 对 `ReadableStream` body 固定使用 chunked，无法同时发送 `Content-Length`（见 C-18），而上游上传路径需要真实长度 | 改用运行时 socket 直连实现固定长度上传，避免与运行时 framing 冲突 | 在 `openwrt-tjs/src/platform/fixed-length-fetch.js` 内实现最小 HTTP/1.1 客户端（仅 http/https、必须带合法 `Content-Length`、响应上限 4 MiB） | 上传字节、方法、业务头；其余请求仍走运行时 fetch | 上传对照与真实 AList 上传通过；**本审查中维护风险最高的模块**，上游同步时列为重点回归对象（见 `porting-code-review.md` F-08） |
| C-25 | 出站 `Origin` 请求头 | txiki Fetch **不接受调用方给定的 Origin**：实测四个用例（显式 `Origin`、显式 `host`、无 `Origin`、混合）中，运行时一律改写成 `Origin: <scheme>://<目标 host>`（**端口被丢弃**），调用方传 `http://127.0.0.1:5344` 到达对端的是 `http://127.0.0.1` | 上游 Node 会把浏览器入站的 `Origin` 原样转发到 AList/存储 CDN；txiki 下该请求头形状**不可复现** | 平台层 `createHeaders()` 过滤掉入站 `origin`（与运行时既定行为一致，避免「以为转发了」的误解）；不需要额外实现 | 仅出站请求头形状；下载内容、状态码、Range 均不受影响 | 已取证 2026-09-13（R-36）：运行时行为用回显服务器实测；CDN 侧对同一真实 302 目标（`baidupcs.com`）在 UA/Referer/Origin/HEAD 六种变因下响应**完全一致**（`403 {"error_code":31362,"error_msg":"sign error"}`）⇒ `Origin` 不参与 CDN 鉴权判定 |

## C-21 的特殊说明

旧包 `txiki-js-26.6.0-r2` 的原始 TCP 探针结果为：

```text
PROPFIND/MKCOL/COPY/MOVE -> HTTP/1.0 403 Forbidden，应用未收到
PUT/GET/HEAD/DELETE      -> HTTP 200，应用收到且方法名正确
```

只打开 `-DLWS_WITH_HTTP_UNCOMMON_HEADERS=ON` 仍不足以增加 WebDAV method token。官方选项是构建前提，不是完整修复。因此本次 r3 只在 txiki.js 依赖层扩展现有 libwebsockets method 表和 Fetch method 映射，没有改写上游 WebDAV 逻辑。

r3 guest 探针输出：

```text
PROPFIND/MKCOL/COPY/MOVE/PUT/GET/HEAD/DELETE -> HTTP/1.1 200 OK
reportedMethod 与 sentMethod 逐项一致
```

## 不是“替换”，但必须记录的部署事实

### AList `raw_url` 端口

AList 在本次 QEMU user networking 场景返回的下载地址 host 可达，但可能省略 relay 端口。OpenWrt 分支增加了窄范围 `normalizeRawUrl()`：仅当 raw URL 的 host 等于配置的 AList host 且 URL 缺少端口时补上配置端口；不同 host、CDN 和默认端口不改写。该修复不改变文件名协议、加密字节或上游 AList API 结构。

### 出站 `origin` 请求头（已登记为 C-25）

适配层在出站 Fetch 时同时过滤 `host`（C-15）与 `origin`。R-36 已就该过滤的必要性完成两路取证（运行时侧用回显服务器 + 桌面 tjs；对端侧用真实存储 CDN 的 302 目标做六变因差分），结论是**运行时边界**：txiki Fetch 不接受调用方给定的 `Origin`，一律改写为目标 origin（端口被丢弃），且 CDN 不将 `Origin` 纳入判定，过滤与否无可观察差异。故保留现有实现并登记为 **C-25**，**不改码、不升包**。详见 `porting-code-review.md` F-07 与 `tests/run-2026-09-13.md` 第 7 节。

### 外部 CDN 资源

浏览器验收中配置页和 AList 代理页均可加载并完成登录。AList 页面引用的外部图片/CDN 请求在纯内网环境失败，例如 `cdn.jsdelivr.net` 和第三方图片地址。它们不是 `alist-encrypt` 代理主流程，也没有被伪装成成功；最终验收记录保留该浏览器请求失败限制。

### AList WebDAV 跨目录 MOVE 的同名限制（AList/驱动侧，非本适配层）

AList 的 `BaiduNetdisk` 驱动 `Move` 实现是：

```go
data := []base.Json{{"path": srcObj.GetPath(), "dest": dstDir.GetPath(), "newname": srcObj.GetName()}}
d.manage("move", data)   // POST /xpan/file?method=filemanager&opera=move，ondup="fail"，async="0"
```

即：**跨目录移动时不向驱动传目标名**（改用源文件名落实体），且重名策略为 `ondup=fail`。因此当目标目录已存在同名文件（加密规则下即**密文同名**）时，百度 API 返回 `errno 12`，AList 以 `500 Internal Server Error` 结束该 MOVE。改名本身由 AList 的 WebDAV 层在移动后补做，所以「目标无同名」的正常跨目录 MOVE 会得到正确的新文件名。

判定依据（均在真实 AList `xhofe/alist:v3.60.0` + 百度网盘存储上复现）：

| 形态 | 结果 |
|---|---|
| 跨目录 MOVE，目标目录**已有**同名文件 | `500`（AList 日志：`req: [https://pan.baidu.com/rest/2.0/xpan/file], errno: 12`） |
| 同一 MOVE，先删除目标同名文件 | `201`，且目标名正确 |
| 跨目录 MOVE，目标无同名（明文名、含 `~`/`+` 的密文风格名均测） | `201` |
| 直连 AList（绕开本代理）复现同一形态 | 与经代理一致（`500`） |

**结论**：这不是本适配层的缺陷，代理只是把客户端的 MOVE 原样改写后转发；同一形态直连 AList 同样失败。**不改代理代码**，在 `api-suite.mjs` 中固化为 D08 用例（含直连对照）以防回归误判。

## 明确不采用的方案

- 不把 `PROPFIND`、`MKCOL`、`COPY`、`MOVE` 改成 POST。
- 不复制一套新的加密算法、文件名协议或 WebDAV 业务实现。
- 不把全部 AList 请求缓存到内存来规避流式 API。
- 不把客户端取消伪装成已经支持 Node `response.on('close')`。
- 不修改 `upstream/alist-encrypt` 的 Node 原版目录。

## 证据入口

- 移植代码审查报告：[porting-code-review.md](porting-code-review.md)
- 逐项测试记录：[run-2026-09-11.md](../tests/run-2026-09-11.md)、[run-2026-09-12.md](../tests/run-2026-09-12.md)、[run-2026-09-13.md](../tests/run-2026-09-13.md)
- 兼容性总表：[openwrt-tjs-compatibility.md](openwrt-tjs-compatibility.md)
- OpenWrt 包构建脚本：[build-openwrt-package.sh](../openwrt-tjs/scripts/build-openwrt-package.sh)
