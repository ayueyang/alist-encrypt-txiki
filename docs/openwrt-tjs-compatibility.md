# OpenWrt txiki.js 不兼容项与替换说明

## 文档目的

本文只记录上游 `alist-encrypt` 在 OpenWrt txiki.js 中不能直接使用的能力，以及本移植为什么需要替换。它不把“API 名称不同”直接等同于“业务逻辑需要重写”。每个替换都必须有 guest 实测证据，并说明保持不变的上游行为和对应测试。

固定环境：

- 上游基线：`main@3d5f19fc5a001dfcac110d4c7d3d12d12ab4e617`
- txiki.js：`v26.6.0`
- OpenWrt：`25.12.5 / armsr / armv8 / aarch64_generic`
- 执行器：guest 内 `/usr/bin/tjs`

## 替换总表

| 编号 | 上游能力 | guest 实际不支持或不兼容 | 替换方式 | 不改变的内容 | 验证状态 |
|---|---|---|---|---|---|
| C-01 | Node `Buffer` 全局对象 | `typeof Buffer` 为 `undefined` | 打包 `buffer@6.0.3` 并仅在 OpenWrt bundle 注入全局 | 字节索引、编码、拷贝和整数读写调用 | Node 与 guest 固定向量通过 |
| C-02 | Node `process` 全局对象 | `typeof process` 为 `undefined` | 将 `argv/env/cwd/exit/pid` 映射到 `tjs.args/tjs.env/tjs.cwd/tjs.exit/tjs.pid` | `ALIST_HOST`、`RUN_MODE`、端口和 CLI 参数语义 | 服务、CLI 和配置验收通过 |
| C-03 | `crypto` / `node:crypto` | txiki 模块加载报告 `could not load` | `tjs:hashing` 承接摘要，`@noble/hashes` 承接同步 PBKDF2，`@noble/ciphers` 承接同步 AES-CTR，Web Crypto 提供 UUID | PBKDF2 salt/轮数/长度、MD5/SHA 字节、AES-CTR key/IV/counter 和算法类 | Node 与 guest 固定向量通过 |
| C-04 | Node `stream.Transform` | `stream` 模块不能加载 | 用 Web `TransformStream` 包装原 `transform(chunk, encoding, next)` 回调 | `FlowEnc`、四个算法类、每块输入输出顺序和错误传播 | 固定向量、真实上传下载和转换通过 |
| C-05 | Node `http` / `https` request/response | 模块不能加载，txiki 使用 Fetch/Web Streams | 保留 `httpClient`/`httpProxy` 函数签名，内部使用 `fetch`、`ReadableStream`、`Response` 和 `duplex: 'half'` | 方法、头、body、手动重定向、Range、文件名响应头和取消语义 | HTTP、AList 代理和 WebDAV 通过；取消限制见 C-19 |
| C-06 | Koa、koa-router、bodyparser、koa-static | npm 包不能由裸 txiki 直接加载，Koa 依赖 Node HTTP 模型 | Hono 作为 txiki server 外层；小型 Koa context/router/body/static 适配只实现上游实际使用表面 | 原 `app.js` 路由注册顺序、所有路由名和业务中间件 | 服务、API、UI 和代理页面通过 |
| C-07 | `fs` 同步 API | `fs` 模块不能加载，txiki 文件 API为异步 | 只在 OpenWrt 分支把配置和转换调用改为 `tjs` 异步文件 API | 配置 JSON 结构、路径、转换顺序和输出名称 | CLI/API 转换、配置持久化通过 |
| C-08 | Node `path` | `path` 模块不能加载 | 直接映射到官方 `tjs:path` | basename/dirname/extname/join/resolve 等路径语义 | 文件转换、文件名、AList 和 WebDAV 链路通过 |
| C-09 | `nedb-promises` | npm 模块不能加载 | 用 `tjs:sqlite` 实现相同的 `load/setValue/setExpire/getValue` 表面 | 覆盖写、永久值、TTL、JSON 值和过期返回 `null` | DAO 矩阵和进程重启恢复通过 |
| C-10 | `log4js` | npm 模块不能加载，OpenWrt 也不需要 Node 文件 appender | 保持 `debug/info/warn/error` 接口并输出标准流，由 procd/logd 接管；平台边界统一遮盖密码、token、授权头、Cookie 和签名 URL（实现在 `openwrt-tjs/src/redact.js`） | 原日志调用点和级别；请求数据本身不变（R-34 曾发现实现删除了 20 处上游日志调用点，已全部恢复，见 `porting-code-review.md` F-03） | 脱敏固定用例通过；日志由 procd/logd 承接 |
| C-11 | Node `worker_threads` | 模块不能加载；txiki 使用 Web Worker | RC4 Range 定位使用 txiki Worker，工作线程失败时回退相同 PRGA 同步循环 | KSA/PRGA 算法、1,000,000 字节分段点和定位结果 | guest 独立探针与完整 RC4 Range 向量通过 |
| C-12 | `app.js` 顶层 `return` | txiki ESM 解析报 `return not in a function` | esbuild 只在 OpenWrt 打包时移除五行 CLI 分支；转换命令使用独立入口 | `app.js` 的服务路由装配和 Node 上游文件 | bundle、服务和 CLI 转换通过 |
| C-13 | 无扩展名相对导入与 `@/` 别名 | txiki 直接加载不能解析 | esbuild 在构建期解析并打成单个 ESM bundle | 上游源码中的导入关系和模块职责 | bundle、服务和测试入口通过 |
| C-14 | 服务端 `Request.signal` | 本次 guest 的入站 Request 将 `signal` 暴露为 `null`，直接调用 `addEventListener` 导致所有 HTTP 请求返回 500 | 将入站 AbortSignal 视为可选；存在时才注册关闭监听并传给出站 `fetch` | 请求方法、请求体、代理流和正常响应路径 | 静态页、API、透明代理和 WebDAV 已通过 |
| C-15 | Node 客户端手工 `Host` 请求头 | txiki Fetch 在目标 URL 之外再传上游设置的 `Host` 时，AList relay 返回 HTTP 400；同一 URL 不传该头返回 200 | 出站 Fetch 过滤 `host`，由 Fetch 按 `urlAddr` 生成 | `preProxy` 的目标 URL、配置 host/port、其余请求头和业务路由 | guest 对照和完整透明代理均通过 |
| C-16 | Node HTTP 对逐跳响应头的处理 | Fetch 已解码远端响应，适配层又把 `connection`、`transfer-encoding` 原样交给 `Response`；guest 实际返回同时含长度和 chunked，客户端读取失败 | 请求与响应统一过滤标准 hop-by-hop 头，响应 framing 由 `tjs.serve()` 生成 | 状态码、端到端头、未修改流的 Content-Length 和响应体 | guest 透明代理返回 200/4320 字节，客户端完整读取通过 |
| C-17 | Node `server.on('checkContinue')` | txiki 的 `tjs.serve()` 返回 Fetch 风格服务对象，没有 Node `checkContinue` 事件表面；guest 未发送 `100 Continue`，严格请求经代理只到达上游而未收到最终响应 | 不复制 Node HTTP 事件模型；过滤出站 `Expect` 只避免远端继续等待；严格等待 100 的客户端列为不支持 | 上游注册代码和 PUT/WebDAV 路由保持不变；普通无 Expect 请求体、状态码和字节语义不变 | guest 原始 TCP 矩阵：`100=false`、上游收到 11 字节、代理最终响应 `false` |
| C-18 | Node 请求流与 `Content-Length` | txiki Fetch 把 `ReadableStream` 固定作为未知长度 chunked 上传；若同时复制入站 `Content-Length`，实际发出 CL 与 TE 两种 framing，guest 请求失败 | 仅对 `ReadableStream` 出站 body 删除 `Content-Length`，由 txiki 使用 chunked；已知长度字符串和字节 body 不变 | 上传字节、加密 Transform、请求方法和所有端到端业务头 | guest 对照、AList 上传和 WebDAV PUT 通过 |
| C-19 | 下游断开与 Node `response.on('close')` | 本次 txiki `tjs.serve()` 不向 Fetch `Request` 提供可用 `signal`，下游取消响应体也不会触发上游 Web Stream `cancel()`；应用层无法像 Node `response.on('close')` 那样及时取消远端请求 | 保留可用 signal 时的监听；没有 signal 时不伪造事件，记录为运行时限制并依靠连接关闭完成清理 | 正常请求、加密流、响应字节和路由行为 | guest 取消矩阵已复现；不可宣称上游取消已支持 |
| C-20 | Node 请求头对象中的单值 `Content-Length` | txiki `Request.headers` 在调用者显式设置长度且运行时也自动补长度时暴露为重复值，例如 `"20,  20"`；上游 `contentLength * 1` 会得到 `NaN` | 只在 OpenWrt Koa 适配层把多个完全相同且均为十进制数字的长度值折叠为一个；上游 `encNameRouter`、`FlowEnc` 和请求流不变 | 原作者上传路由、文件名编码、加密字节和真实长度 | 入站头探针、AList 上传和 WebDAV PUT 通过 |
| C-21 | WebDAV 的 `PROPFIND`、`MKCOL`、`COPY`、`MOVE` 等 HTTP 方法 | 现有 txiki OpenWrt 包编译的 libwebsockets 在 HTTP parser 阶段只接受常见方法，未知方法直接丢弃，应用层无法收到请求 | `LWS_WITH_HTTP_UNCOMMON_HEADERS=ON` 是必要前提但不足以增加方法；在 txiki vendored libwebsockets 中补充 method token、lexer/parser 表项和 txiki 方法映射，重建 txiki 依赖和应用包；不改 `encDavHandle` 方法逻辑 | WebDAV 方法顺序、XML 字段、路径转换、AList 请求和响应语义 | r3 方法探针、真实 WebDAV E2E 和清理均通过 |
| C-22 | `@noble/ciphers` 纯 JS AES-CTR | txiki（QuickJS 无 JIT）叠加 QEMU TCG 下吞吐仅 34–37 KB/s，与 chunk 大小无关；7.5 MB 经代理上传 307 秒并触发自旋挂死 | AES-CTR 改走 `crypto.subtle` 异步实现（`update()` 返回 Promise），保留 `@noble` 同步回退；平台 Transform 支持异步结果并加 64 KB 合并缓冲 | key/IV 派生、counter 128bit 进位、offset 前缀对齐与密文字节（`AesCTR`/`FlowEnc`/`setPositionAsync` 语义不变） | guest 与 Node 固定向量逐字节一致；7.5 MB 上传 307,155 ms → 9,463–11,128 ms；详见 C-22 段 |
| C-23 | `URL.pathname` 在 Windows 的盘符前导斜杠 | `new Worker(new URL('./prga-worker.mjs', import.meta.url).pathname)` 在 Windows 得到 `/C:/…`，txiki Worker 无法解析，PRGA worker 全部创建失败 | 剥掉盘符前的斜杠（POSIX 路径不匹配该模式，行为逐字节不变） | POSIX 路径与 worker 行为、RC4/MIX 算法结果均不变 | Windows 官方 tjs 重启后 stderr 无 worker 错误、向量 `ok:true`；Linux/OpenWrt 等价；详见 C-23 段 |
| C-24 | 「流式 body + 已知长度」的上传请求 | txiki Fetch 对 `ReadableStream` body 固定使用 chunked，无法同时发送 `Content-Length`（见 C-18） | `openwrt-tjs/src/platform/fixed-length-fetch.js` 自建最小 HTTP/1.1 客户端（仅 http/https、必须带合法 `Content-Length`、响应上限 4 MiB） | 上传字节、方法与业务头；其余请求仍走运行时 fetch | 上传对照与真实 AList 上传通过；**本审查中维护风险最高的模块**，上游同步时列为重点回归对象（见 `porting-code-review.md` F-08） |
| C-25 | 出站 `Origin` 请求头 | txiki Fetch **不接受调用方给定的 `Origin`**，一律改写为目标 origin（端口被丢弃），缺省时自行补上 | 平台层 `createHeaders()` 过滤入站 `origin`（与运行时既定行为一致，仅避免「以为已转发」的误解） | 下载内容、状态码、Range 与业务头均不受影响 | R-36 两路取证：运行时行为回显实测 + 真实 CDN 六变因响应逐字节一致（`403 sign error`）；详见 C-25 段 |
| C-26 | Fetch 等待响应头的 15 秒上限 | txiki vendored libwebsockets 的上下文超时默认 15 秒（`deps/libwebsockets/lib/core/context.c:1176` `context->timeout_secs = 15;`，仅可由 context 创建参数覆盖）；请求体发出后在 `PENDING_TIMEOUT_AWAITING_SERVER_RESPONSE` 状态下按该值计时（`…/roles/http/client/client-http.c:340`），txiki 自身从不设置该值 | **无代码改动**：属运行时内部常量，调用方无法设置。后端（如百度 dlink 冷启动）响应头慢于 15s 时，`fetch` 以 `Network request failed: Timed out waiting server reply` 失败；并发请求排队会先撞上该上限 | 仅影响等待时长上限；已收到的内容字节、状态码、Range 与业务头语义不变 | guest 实测：并发 GET/PUT 在百度 dlink 冷启动时复现；暖场单路 GET 正常（D03/D03b 记 SKIP）；详见 `tests/run-2026-09-15.md` |

## C-11 Worker 失败记录

首次 OpenWrt 向量命令：

```sh
/usr/bin/tjs run /mnt/host/openwrt/alist-encrypt/openwrt-tjs/dist/openwrt-vectors.mjs
```

首次实现使用 `data:text/javascript,...` 创建 Worker，guest 实际返回：

```text
ReferenceError: could not load 'data:text/javascript,...'
```

原因：txiki.js `v26.6.0` 的 Worker 构造器在本次 OpenWrt guest 中要求可加载的模块文件，不能把该 `data:` URL 当成 Worker 模块入口。替换为随应用安装的 `prga-worker.mjs`。

第二次实现把 `new URL('./prga-worker.mjs', import.meta.url)` 对象直接传入 Worker，guest 返回：

```text
ReferenceError: could not load 'file:///mnt/host/openwrt/alist-encrypt/openwrt-tjs/dist/prga-worker.mjs' - ENOENT
```

同一时刻 guest 的 `ls -l` 已证明文件存在。txiki.js 官方 Worker 测试使用文件系统路径；因此主模块最终传入 `new URL('./prga-worker.mjs', import.meta.url).pathname`。独立探针使用 `/usr/bin/tjs` 完成 Worker 创建、消息发送、PRGA 结果返回和 `terminate()`，输出中的实际路径为：

```text
/mnt/host/openwrt/alist-encrypt/openwrt-tjs/dist/prga-worker.mjs
```

该改动只改变工作线程的装载参数，Worker 内的 PRGA 循环逐行保持与上游一致。

## C-14 入站 AbortSignal 记录

完整服务首次请求 `/public/index.html` 返回 HTTP 500，guest 日志指向 Koa 适配的：

```text
request.signal.addEventListener('abort', ...)
```

txiki.js 自身支持 `AbortController`，但本次 `tjs.serve()` 交付给应用的服务端 Request 没有可用 signal。替换只取消对该可选属性的强制假设；如果后续请求对象提供 signal，原关闭监听仍会注册。客户端断开时上游 fetch 和流能否及时取消，必须由独立取消测试判定，不能由本修复推断。

## C-15 Host 请求头记录

guest 内对同一地址执行直接对照：

```text
fetch('http://10.0.2.2:15244/')                                  -> 200
fetch('http://10.0.2.2:15244/', { headers: { host: '...' } })    -> 400
```

上游 Node `http.request` 通过可变 headers 设置目标 Host；Fetch 已从 `urlAddr` 生成正确 Host，重复手工设置会触发本次后端拒绝。过滤只发生在构造 Fetch Headers 时，`request.headers.host` 仍保留给上游路由计算 `urlAddr`，没有改变 AList/WebDAV 配置语义。

## C-16 Hop-by-hop 响应头记录

过滤 Host 后，服务已经成功取回并修改 AList 首页，但客户端读取代理响应失败。guest 看到代理响应同时包含：

```text
content-length: 4320
transfer-encoding: chunked
connection: close
```

`connection`、`transfer-encoding`、`keep-alive`、`te`、`trailer`、`upgrade` 和代理认证相关头只对单次连接有效，不能从远端 Fetch 响应复制到新的服务端 Response。适配层只过滤这些 framing 头，业务使用的 Content-Type、Range、Content-Disposition、Location 等端到端头继续保留。

修复后再次在 guest 内执行完整 HTTP 冒烟，静态 UI、`/index`、登录、鉴权 API 和透明代理全部通过。透明代理实际返回 HTTP 200、4320 字节，客户端能够完整读取响应体，不再出现长度与 chunked 冲突。

## C-17 Expect 事件记录

txiki.js `v26.6.0` 的官方测试使用 `tjs.serve({ fetch })` 和 Fetch `Request`/`Response` 模型。运行时没有 Node `http.Server` 的 `checkContinue` 事件接口；guest 原始 TCP 测试发送 `Expect: 100-continue` 后未收到 `100 Continue`。通过代理继续发送 11 字节 body 后，fixture 确实收到 body，但客户端没有收到代理最终 HTTP 200。适配层过滤出站 `Expect`，避免把未处理的继续请求转发给上游服务器；这仍不能支持严格等待 100 的客户端，因此该场景明确不支持。

## C-18 流式请求 framing 记录

guest 内对同一 txiki fixture 的四组 Fetch 对照结果为：

```text
Uint8Array + Content-Length      -> 200
ReadableStream，无长度          -> 200
ReadableStream + Content-Length -> TypeError: Network request failed
ReadableStream + 浏览器头和长度 -> TypeError: Network request failed
```

txiki.js `httpclient.c` 对 streaming body 无条件添加 `Transfer-Encoding: chunked`，而自定义请求头仍会保留调用者复制的 `Content-Length`。两者同时存在会形成歧义 framing；txiki 自身服务端的官方测试也明确拒绝同时带 CL 与 TE 的请求。替换只在 body 确认为 `ReadableStream` 时过滤长度头，不把文件缓冲进内存，也不改变 `FlowEnc` 产生的任何字节。

## C-19 下游取消记录

guest HTTP 矩阵向代理请求一个持续输出的上游响应，读取第一块后调用下游 `ReadableStream.cancel()`。测试实际输出为：

```text
HTTP_MATRIX_LIMITATION client-cancel upstream-cancelled=false
```

txiki.js 固定版本的 `tjs.serve()` 在本次交付 ABI 中没有把 HTTP 连接关闭映射成 `Request.signal`，其 HTTP server JS 层也没有每请求关闭回调；因此 `httpProxy` 不能可靠调用远端 Fetch 的 `AbortController`。这不是 AList 或 `FlowEnc` 逻辑缺陷，不能通过复制 Node `response.on('close')` 名称来伪造支持。该限制会增加客户端异常断开时的远端流存活时间，正常完成、服务重启和网络层关闭仍由运行时处理；最终交付文档必须把它列为已知 OpenWrt txiki 限制。

## C-20 Content-Length 重复值记录

OpenWrt guest 内的最小探针使用相同的 20 字节 PUT，分别验证 Fetch 客户端和原始 TCP 客户端：

```text
Fetch 入站 content-length: "20,  20"
原始 TCP 入站 content-length: "20"
Fetch 入站 bodyLength: 20
原始 TCP 入站 bodyLength: 20
```

因此，txiki 仍然能正确接收正文，问题只出在兼容层把 Fetch 暴露的重复字符串直接交给上游 Node 风格代码。`encNameRouter` 的原实现按单值头执行 `contentLength * 1`；对 `"20,  20"` 的 JavaScript 转换结果是 `NaN`，会使 `FlowEnc` 无法得到文件大小。

替换范围限定在 `src/platform/koa.js` 的请求头映射：只有每个值都相同、且每个值都是十进制数字时才折叠；普通单值和原始 TCP 请求保持原样。这样修复的是 txiki 与 Node 请求头表面的差异，不是重写上传业务。若出现不同的重复长度值，适配层不会替它选择一个值，仍交由请求处理失败，避免把不一致 framing 当成合法长度。

## C-21 WebDAV uncommon HTTP methods 记录

### 现象

首次 WebDAV 测试在第一个 `MKCOL` 停止。请求没有进入 `alist-encrypt` 的 `/dav/...` 路由，guest 内应用层没有机会读取 `ctx.method`。在已安装的 `txiki-js-26.6.0-r2` 上，原始 TCP 方法探针实际得到：

```text
PROPFIND -> HTTP/1.0 403 Forbidden，应用未收到
MKCOL    -> HTTP/1.0 403 Forbidden，应用未收到
COPY     -> HTTP/1.0 403 Forbidden，应用未收到
MOVE     -> HTTP/1.0 403 Forbidden，应用未收到
PUT/GET/HEAD/DELETE -> HTTP 200，方法名正确
```

随后单独验证 `-DLWS_WITH_HTTP_UNCOMMON_HEADERS=ON`：该选项能够作为 uncommon header 能力的构建前提，但不能凭空增加 HTTP method token。仅靠该 CMake 选项时，上述四个方法仍会在 HTTP 解析阶段被拒绝。因此不能把“打开 uncommon headers”写成完整修复。

### 为什么必须替换

这是 HTTP 运行时构建能力缺失，不是 `encDavHandle` 的业务逻辑缺失。WebDAV 客户端必须把这些方法送到服务端，应用层才能按上游原作者已经实现的分支处理。把请求伪装成 POST、在 JavaScript 路由层补发，或重写 WebDAV 方法都会改变上游协议和代码逻辑，因此不采用。

### 替换内容

只在 txiki.js/OpenWrt 构建边界保留官方 libwebsockets 选项，并补齐 vendored parser 的最小方法表：

```text
-DLWS_WITH_HTTP_UNCOMMON_HEADERS=ON
```

本次 r3 的底层补丁只涉及 txiki vendored libwebsockets 和 txiki HTTP 映射：

- `lws-http.h` 增加四个方法 token；
- `lextable-strings.h`、`minilex.c`、生成的 `lextable.h` 和 `parsers.c` 增加词法/解析表项；
- `server.c`、`ops-h1.c`、`connect2.c`、`http2.c` 维护服务端和客户端方法映射；
- `src/httpserver.c` 将底层 token 映射为 Fetch `Request.method`。

该选项同时写入 txiki.js CMake 和 OpenWrt 包配方，确保 OpenWrt SDK 的独立构建不会依赖默认值或历史 CMake 缓存。txiki 包 release 号递增至 r3，以便 guest 明确安装新二进制。`alist-encrypt` 的 `encDavHandle`、`webdavClient`、AList 路由、XML 和加密逻辑不重写。

### 证据要求

必须在安装新包后由 guest 内 `/usr/bin/tjs` 完成：

- 方法探针：`PROPFIND`、`MKCOL`、`COPY`、`MOVE`、`PUT`、`GET`、`HEAD`、`DELETE`；
- 应用 WebDAV 端到端：目录、文件、加密内容、名称转换、复制、移动和清理；
- 运行证明：新包版本、`readlink /proc/<pid>/exe` 和实际监听服务。

### r3 方法探针结果

安装 `txiki-js-26.6.0-r3` 后，在 OpenWrt guest 内由 `/usr/bin/tjs` 执行：

```sh
/usr/bin/tjs run /mnt/host/openwrt/alist-encrypt/openwrt-tjs/tests/webdav-method-probe.mjs
```

实际输出摘要：

```text
ok=true
PROPFIND  HTTP/1.1 200 OK  reportedMethod=PROPFIND
MKCOL     HTTP/1.1 200 OK  reportedMethod=MKCOL
COPY      HTTP/1.1 200 OK  reportedMethod=COPY
MOVE      HTTP/1.1 200 OK  reportedMethod=MOVE
PUT/GET/HEAD/DELETE 全部 HTTP/1.1 200 OK，reportedMethod 与发送方法一致
```

这证明四种方法已经穿过 HTTP parser 并到达 txiki 应用层；在真实 WebDAV E2E 通过前，C-21 不能单独代表完整 WebDAV 可用。

## 固定向量结果

2026-08-31 在 guest 内执行：

```sh
/usr/bin/tjs run /mnt/host/openwrt/alist-encrypt/openwrt-tjs/dist/openwrt-vectors.mjs
```

实际结论为 `ok=true`，并与干净上游 Node 基线一致：

| 项目 | SHA-256 或结果 |
|---|---|
| AES-CTR 密文 | `50d530bf9014f3974461b4b44ef529acae8827bcc7ca3b92c3846a17b0ec9261` |
| RC4 密文 | `71759b7429979c9dfd2f6a8035a7f45cd8e61c9288dda705b7fd90c8e9665e48` |
| ChaCha20 密文 | `c50cda6e15f59b155343b9f1248329463bb82759f29302f928ed9fdde18f72ff` |
| MIX 密文 | `37906b3b2b033ef8a1daeda69879eceb6cf430f648b8ab3f00a0167dc53451e1` |
| PBKDF2 | `a1db58f5a583ed980a6aed137929eda5` |
| MD5 | `f39178e2ed2cac109e614582af2316ff` |
| SHA-256 | `3fd9cca535eb1226579c46d722dc9c9edd9864617fc1ac294bb9b64afd2b1b88` |

数据长度为 1,000,065 字节，分块边界和 12 个 Range 偏移全部通过。该测试证明字节协议一致，不代表 HTTP、WebDAV、持久化和浏览器链路已经完成。

## 不属于替换的内容

以下内容即使后续出现缺陷，也必须先按上游行为修复，不能以“txiki 不兼容”为由重新设计：

- `encNameRouter` 的 AList 路由和文件名处理规则；
- `encDavHandle` 的 WebDAV 方法顺序、XML 字段和路径转换；
- `FlowEnc` 的算法选择、密码派生入口和 `setPosition()` 语义；
- AES-CTR、RC4、ChaCha20、MIX 的密文字节协议；
- AList `/api/fs/*` 请求字段、`raw_url` 和代理重定向规则；
- 配置页面现有静态资源和 `/enc-api` 接口结构。

## 上游问题与业务级分叉（只记录）

适配过程中发现的**上游业务逻辑问题**（规则匹配、路径转换、`orig_` 回退、重定向解密语义、AList 侧外部行为）统一登记在 [upstream-issues.md](upstream-issues.md)（U-01…U-06），本表不逐条展开。处置原则：**只修运行时边界，上游问题只记录，不改业务逻辑**。

唯一已实施的业务级分叉是 **U-01**：配置保存边界折叠连续斜杠（`normalizeAlistConfig()`，r4 起随产物发布）。理由是该失败模式会让「用户设了规则却静默不加密」，属安全语义问题；分叉范围不再扩大。除此以外，`pathFindPasswd()`、`convertRealPath()`、`convertShowName()`、`encNameRouter`、`encDavHandle` 与四种加密算法均与上游逐字节一致。

## 更新规则

1. 只有 guest 内 `/usr/bin/tjs` 的复现结果才能新增“不支持”结论。
2. 每项必须记录原命令、实际错误、替换原因和测试编号。
3. 替换完成不等于验收通过；总表中的验证状态必须随测试更新。
4. 如果后续发现 txiki 原生能力可以直接满足要求，应删除多余适配并在本文记录原因。

## C-22 AES-CTR 适配层切换到 WebCrypto（2026-09-12，R-25 修复）

### 现象（R-25）

用户实测：经代理上传 7.5MB 文件时整个代理 307 秒无响应（72/72 次 `/ping` 全部超时），直连 AList 同尺寸仅 2.5s；且一次上传重试风暴后服务陷入**永久自旋挂死**（无请求时 tjs 仍满核运行，重启前无法恢复）。

guest 内基准定位根因：`@noble/ciphers` 纯 JS AES-CTR 在 txiki（QuickJS 解释执行，无 JIT）+ QEMU TCG 模拟下吞吐仅 **34–37 KB/s**，与 chunk 大小无关（1KB–256KB 全部相同），即纯算力瓶颈；上传事件循环被加密独占，客户端超时重试叠加后触发挂死。

### 替换内容

- `src/platform/crypto.js`：`createCipheriv('aes-128-ctr')` 改为基于 `crypto.subtle` 的异步实现（`update()` 返回 `Promise<Buffer>`），保留 `@noble` 同步回退（无 WebCrypto 的运行时）；CryptoKey 按 key 字节缓存。
- `src/platform/stream.js`：Transform 适配器支持异步 transform 结果（`Promise.resolve(data)` 后入队），并新增 64KB 合并缓冲（`flush` 保证尾部不丢）；FlowEnc 各算法分块不变性已由向量套件证明，合并不改变密文字节。
- `tests/vector-suite.js`：`transformByChunks` 改为 await 兼容（对同步算法无副作用）。
- `src/platform/koa.js` / `node-proxy/src/utils/httpClient.js`：防御性取消——response close / 已关闭时对 `ReadableStream` body 执行 `cancel()`，避免向已死连接继续泵流。httpClient.js 属已记录替换文件（见 C-01 系列 fixed-length-fetch 引入处）。

### 客观依据

- guest 基准（`/usr/bin/tjs run /mnt/host/dist/tjs-crypto-bench.mjs` 等）：noble shim 34–37 KB/s（chunk 无关）；`crypto.subtle` 15.4–15.75 MiB/s（1MiB 块），固定调用开销 ~1.4ms（1KB 块 0.69 MiB/s）。
- 密文等价：切换后 guest `openwrt-vectors.mjs` 与 Node 基线 `node-vectors.cjs` 全部通过，aesctr `encryptedSha256 = 50d530bf9014f397…` 双侧一致（逐字节相同）。
- 端到端（guest r6 服务体 + 新 dist）：7.5MB 经代理上传 307,155ms → 9,463–11,128ms（PUT 200 success）；上传期间 tjs 大部分时间 S 状态 0% CPU（此前 R 状态 ~45%），并发 `/ping` 仅首连 1 次超时；100MB 中途 abort 后代理保持 0.1–0.3s 响应，无自旋复发，AList 侧无残留文件。
- 剩余瓶颈归因：上传期间 guest CPU 空闲，时间消耗在 QEMU slirp/TCG 网络转发；真实 ARM 硬件上不存在该层。
- ChaCha20/RC4/MIX 仍为上游自带纯 JS 实现，在 guest 内依旧缓慢（向量套件 chacha20 段约 20 分钟）；用户当前配置使用 `aesctr`，其余算法未做替换，如需提速另行登记。

### 上游语义保持

密文字节协议（key/IV 派生、counter 128bit 进位、offset 前缀对齐）不变，`AesCTR`、`FlowEnc`、`setPositionAsync` 语义不变；`cipher.update()` 的调用方中仅流式路径可感知 Promise 化，`setPositionAsync` 的丢弃结果调用不受影响（shim 内 position 同步推进）。

## 2026-09-11 交付复核

- `/usr/bin/tjs run .../tests/http-smoke.mjs`：静态 UI、302、登录、鉴权 API、透明代理和 HEAD 检查退出码均为 0。
- `/usr/bin/tjs run .../tests/webdav-method-probe.mjs`：八种方法均为 `HTTP/1.1 200 OK`，应用报告的方法名与发送方法一致。
- `/usr/bin/tjs run .../dist/openwrt-vectors.mjs`：`ok=true`，四种算法、分块、解密、12 个 Range 偏移、名称编码和目录派生密码均通过。
- 浏览器访问 `http://<代理主机>:5344/`：配置页和 AList 代理页主流程通过；AList 页面外部 CDN 图片请求失败，见独立限制记录。
- 运行证明：最终重启后的 OpenWrt `25.12.5 / armsr / armv8 / aarch64_generic` 中 PID `26026` 的 exe 为 `/usr/bin/tjs`，命令行为 `/usr/bin/tjs run /usr/lib/alist-encrypt/server.mjs`；guest 未安装 `ss`，由 `netstat -lntp` 确认监听 `0.0.0.0:5344`。
- Node 对照：`upstream/alist-encrypt/node-proxy` 的 `npm run webpack` 成功，原版 `npm run serve` 在临时 5345 端口启动并返回 `/index` 的 `302 /public/index.html`；临时运行数据清理后上游目录保持干净。

逐项测试、清理和限制见 [run-2026-09-11.md](../tests/run-2026-09-11.md)、[run-2026-09-12.md](../tests/run-2026-09-12.md)、[run-2026-09-13.md](../tests/run-2026-09-13.md)；不支持项和替换原因见 [openwrt-tjs-unsupported-and-replacements.md](openwrt-tjs-unsupported-and-replacements.md)。

## C-23 PRGA worker 路径的 Windows 兼容（2026-09-13，R-33）

### 背景

桌面运行验证（`docs/desktop-txiki-runbook.md`，R-33）中发现：Windows 官方 txiki 二进制下 `dist/server.mjs` 启动后 stderr 反复出现
`could not load '/C:/.../prga-worker.mjs'`，RC4/mix 的 PRGA worker 全部创建失败（功能由主线程兜底保持正确，但失去多核加速）。

### 根因

`node-proxy/src/utils/PRGAThread.js`（txiki 适配版）用
`new Worker(new URL('./prga-worker.mjs', import.meta.url).pathname)` 取 worker 脚本路径。
`URL.pathname` 按 URL 规范保留前导斜杠：POSIX 下得到 `/path/to/prga-worker.mjs`（正确），Windows 下得到 `/C:/path/...`（盘符前多一个 `/`），txiki Worker 无法解析。

### 修复

```js
const workerPath = new URL('./prga-worker.mjs', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:\/)/, '')
worker = new Worker(workerPath)
```

POSIX 路径不匹配该模式、行为逐字节不变；Windows 下剥掉盘符前的斜杠得到 `C:/...` 原生可解析路径。
该文件本就是 txiki 适配改写文件（上游为 worker_threads，见 C-01 系列），修复属适配层边界。

### 验证

- Windows 官方 tjs（v26.6.0）：重启后 stderr 无 worker 错误；向量套件 `ok:true`（四算法逐字节一致）；38 项套件 A/B 组 26/3（`API_SKIP_WEBDAV=1`，3 失败为 B11-13 环境归因）；8MB 大文件上传（B19）正常。
- Linux 自编 tjs（v26.6.0，POSIX 路径不受影响）：向量 `ok:true`；38 项套件 32/6，与其他平台失败特征一致。
- OpenWrt guest：POSIX 行为等价；R-33 时应用包随 dist 重建升 **r8**（md5 `5e076136…`），安装后 `/usr/lib/alist-encrypt/server.mjs` 与 dist `server.mjs` md5 `f351646c…` 绑定一致，38 项回归见 R-33。
- 2026-09-13 代码审查（R-34）后源码再次变更，`dist/server.mjs` md5 为 `78beaa11…`，应用包升 **r9**（md5 `ae7189e7…`），包内载荷已核对与 dist 一致；**r9 已由 OpenWrt ARM64 guest 复跑确认无回归（38 项 30/8，与 r8 逐项一致，R-35）**，审查结论与差异清单见 `porting-code-review.md`。

## C-25 Origin 请求头记录

F-07 审查疑点（`httpClient.createHeaders()` 过滤入站 `origin`）于 2026-09-13 完成两路取证，结论为**运行时边界**，不改码。

**运行时侧**（回显服务器 + 桌面 tjs v26.6.0，四个用例）：

```text
调用方传 Origin=http://127.0.0.1:5344  ->  对端收到 Origin=http://127.0.0.1   （端口丢失，调用方的值被忽略）
调用方传 host=evil.example             ->  对端收到 Host=127.0.0.1 + host=127.0.0.1
调用方不传 Origin                      ->  对端收到 Origin=http://127.0.0.1   （运行时自行补上）
四个用例均无抛错
```

即 txiki 的 fetch **不接受调用方给定的 `Origin`**，一律改写为目标 origin，缺省时自行添加。上游 Node 版「把入站 `Origin` 原样转发」的形状在 txiki 上不可复现；适配层的过滤与运行时既定行为一致，仅避免「以为转发了」的误解。

**对端侧**（同一真实 302 目标 `yq01-cm01.baidupcs.com`，Range 0-1023）：

```text
curl UA / 浏览器 UA / +Referer=pan.baidu.com / +Origin=代理自身 / +Origin=第三方 / HEAD
  -> 全部 403、94 字节、{"error_code":31362,"error_msg":"sign error"}
```

六种变因响应逐字节一致 ⇒ `Origin` 不参与该 CDN 的鉴权/反盗链判定，过滤与否在链路上无可观察差异。

**处置**：登记为 C-25（见 `openwrt-tjs-unsupported-and-replacements.md`）；`PKG_RELEASE` 仍为 9、`dist/server.mjs` 仍为 `78beaa11…`、应用包仍为 r9，无需重编。取证记录见 `tests/run-2026-09-13.md` 第 7 节 R-36。

## C-26 Fetch 等待响应头的 15 秒上限（2026-09-15，R-42）

**现象**：guest 内并发两路 GET / PUT 经代理访问真实 AList（百度网盘存储）时，客户端出现
`Network request failed: Timed out waiting server reply`，而单路（含首字节较慢的冷启动）在暖场后正常。

**根因（源码定位，运行时侧）**：

```c
/* deps/libwebsockets/lib/core/context.c:1176 —— 上下文超时默认值 */
context->timeout_secs = 15;

/* deps/libwebsockets/lib/roles/http/client/client-http.c:340 —— 请求体发出后开始计时 */
lws_set_timeout(wsi, PENDING_TIMEOUT_AWAITING_SERVER_RESPONSE,
        (int)wsi->a.context->timeout_secs);
```

txiki.js 自身（`src/`）从不设置 `timeout_secs`，也没有暴露给 JS 调用方的接口 ⇒ **15 秒是硬上限**，
且只在「等待响应头」阶段计时（响应体流式传输不受该值约束）。

**影响面**：后端（本次为百度 dlink 冷启动/限速）响应头慢于 15 秒时，该请求必然失败；并发请求会排队，
先超限的一路先失败。这解释了 D03（并发 GET）与 D03b（并发 PUT）在两个套件轮次中的间歇失败。

**处置**：**不改码、不升包**（运行时内部常量，调用方无法设置）。套件把该形态按已归因受限形态记 `SKIP`
（`SKIP::` 机制），但状态码/内容不符仍判 `FAIL`；并补 D03c（并发两路 PROPFIND，不触达 CDN）
独立证明代理的并发处理能力。逐次结果见 `tests/run-2026-09-15.md`。
