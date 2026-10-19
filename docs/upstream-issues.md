# 上游 alist-encrypt 问题登记

本文件登记**在适配过程中发现、但根因位于上游 `alist-encrypt` 业务逻辑（而非 txiki.js 运行时边界）**的问题。

处置原则：**只记录，不改上游业务逻辑；移植少动**。

- 这些问题在上游 Node 原版下同样复现，不是适配引入的缺陷。判定方式见下。
- 本项目不因为「顺手」而修改规则匹配、路径转换、命名回退或重定向语义；提出上游修复与否由维护者决定，本文件只提供可复现证据。
- 已实施的业务级分叉共两批：**U-01**（配置保存边界折叠连续斜杠）与 **U-07/U-08/U-09**（WebDAV 路径还原与缓存键一致性），理由与范围见各自条目；除此之外**不扩大分叉范围**。

## 判定口径

一条问题只有同时满足以下三条才登记为本文件条目：

1. 在真实 AList 环境端到端复现（不是纯函数推断）；
2. 在**上游未修改源码**上对照复现（`PROXY_KIND=upstream`，对照台 `work/api-harness/`，不在本仓库内）；
3. 能在上游源码中指出具体位置与成因。

适配版与上游行为存在差异的，必须显式写明差异与理由（如 U-01）。

## U-01 `encPath` 含连续斜杠时规则永不匹配，内容落明文

**现象**：规则写为 `/会员//ARM/.*`（多打一个斜杠）时，保存成功、上传返回 200，但云端与代理侧**均为明文文件名 + 明文内容**；用户视角是「明明设了加密规则却没加密」。

**根因**：`node-proxy/src/utils/commonUtil.js` 的 `pathExec()`（第 78–86 行）用 `pathToRegexp(new RegExp(filePath)).exec(url)` 匹配请求 URL。`//` 在正则中不匹配 URL 中的单个 `/`，规则永远匹配不到，`pathFindPasswd()`（第 154 行起）因此返回空 `passwdInfo`，整条链路按明文透传。

**本项目处置（业务级分叉，已实施）**：在**配置保存边界**折叠连续斜杠（`normalizeAlistConfig()`，r4 起随交付产物发布），不触碰 `pathFindPasswd()`、`convertRealPath()`、`encNameRouter`、`encDavHandle` 与加密算法。理由是数据安全语义：静默不加密的失败模式比规则被规范化更危险。

**对照证据**：规则形状矩阵 13 项中适配版与上游 **12/13 完全一致**，唯一差异即本项（上游落明文、适配版落密文），见 `tests/run-2026-09-12.md` 的 R-20/R-21 与 guest 侧 R-23。

**若决定完全对齐上游**：需要同时接受「多打一个斜杠即静默不加密」，属产品决策，当前不作为计划。

## U-02 绝对规则含存储挂载名时挂载名被加密，返回 `storage not found`

**现象**：`/会员/<dir>/*`、`/会员/<dir>`，或 `/会员/<dir>/.*`（目录层数 ≥ 2）等写法下，请求返回 HTTP 500，AList 报 `failed get storage: storage not found`。

**根因**：`convertRealPath()`（`commonUtil.js` 第 50–75 行）取正则命中的文本 `pathInfo[0]`，按 `/` 切分后 `shift()` 掉首段，**其余每一段都经 `convertRealPathName()` 加密**。规则命中范围包含存储挂载名时，挂载名一并被加密，AList 无法解析。

**本项目处置**：不修改。文档给出可用形状（相对父目录写法 `会员/.*`）；该形状同时是 `orig_` 导航可用的唯一形状（见 U-04）。

## U-03 规则点名的目录本身不加密

**现象**：`encFolder=true` 时，规则点名的目录保持明文，其下的子目录与文件才使用加密名。

**根因**：目录名校验路径不带尾斜杠，与规则命中结果不一致。

**本项目处置**：不修改，记录为语义边界；需要「明文锚点层 + 之下全密文」时应使用叶子目录规则（见 `optional-plaintext-anchor-layer.md`）。

## U-04 `orig_` 明文回退标记在非父目录规则下不可导航（404）

**现象**：云上先有明文内容时，UI 显示 `orig_ARM`，点入报 `object not found`。

**根因**：`convertShowName()`（`commonUtil.js` 第 41–47 行）在解不出名字时返回 `orig_` + 原名作为明文回退标记。点开该条目要求**规则能匹配含 `orig_` 的路径**；`/会员/ARM/*` 这类写法匹配不到 `/会员/orig_ARM`，路径被字面透传，AList 返回 404。

**本项目处置**：不修改。使用指引：规则改用相对父目录形状 `会员/.*`（唯一能同时支持 `orig_` 导航的形状）。

**对照证据**：上游代码纯函数探针与端到端对照 7/7，见 `tests/run-2026-09-12.md` R-30。

## U-05 规则命中路径上的存量明文文件经代理下载会被损坏

**现象**：启用规则前已存在的明文文件，经代理下载后内容损坏。

**根因**：代理的 `/redirect?decode=1` 通道**无条件解密**，源码中没有「内容是否已加密」的判断。上游从不回溯加密存量内容。

**本项目处置**：不修改（上游语义）。**本项目不要求做存量数据迁移**——云上内容均为测试数据（用户 2026-09-14 明确）。此条作为上游行为记录保留，仅供将来在真实数据场景下参考：若确有存量明文需长期保留，做法是经代理重传（重传即加密）后删除云上原件。

## U-06 外部依赖：AList 侧的直链与 WebDAV 行为（非 alist-encrypt 缺陷）

以下属 AList 服务本身的行为，登记在此以免与适配缺陷混淆：

- `/d`、`/p` 直链要求 `sign` 参数，缺失返回 `{"code":401,"message":"expire missing"}`；
- AList 自身 WebDAV `COPY` 返回 500（`MOVE` 正常），并级联影响依赖它的用例；
- 网盘挂载（`/会员`）的 WebDAV `GET` 会 302 到外部 CDN，无外网出口的网络环境不可达。

**证据**：`api-suite` 中稳定失败的 6–8 项即来源于此，逐项归因见 `tests/run-2026-09-12.md`（R-19、R-24、R-29）与 `tests/run-2026-09-13.md`（R-33，Windows 需 `API_SKIP_WEBDAV=1`）。

## U-07 MKCOL 不带尾斜杠时目录建好却查不到（PROPFIND 404）

**现象**：`MKCOL /dav/会员/x`（不带尾斜杠）返回 201，随后 `PROPFIND /dav/会员/x/` 一律 404；代理侧 `/api/fs/list` 能看到该目录，说明目录确实建出来了。带尾斜杠的 MKCOL 则正常（207）。

**根因**：`dao/fileDao.js` 的 `cacheFileInfo()` 以 `fileInfoTable_<path>` 为键写入，MKCOL 分支写入的 `path` 不带尾斜杠；`encDavHandle` 的 PROPFIND 分支用 `getFileInfo(decodeURI(realPathUrl) + ends)` 查询，请求带尾斜杠时键多一个 `/`，两边对不上，`isDir` 判为 false，后续按文件处理，最终 404。

**本项目处置（业务级分叉，已实施）**：`fileDao.js` 新增 `normalizePathKey()`，缓存键统一去掉末尾斜杠，读写两侧一致。

**对照证据**：2026-10-19 真机（Nokia XG-040G-MF / PonWrt 25.12.5 / aarch64_cortex-a53）。修复前 MKCOL(无斜杠)=201、PROPFIND=404；修复后 201/207。上游原版（`traceless/alist-encrypt` `3d5f19fc`，ts-node 跑在 15444）表现完全相同（404/207），确认根因在上游。

## U-08 PROPFIND 返回的 href 父目录停留在密文

**现象**：加密目录下列表能出，但子项 href 形如 `/dav/会员/sSZKwaKN8VHHP/f.txt`（父目录是密文），客户端照 href 取文件 404；`displayname` 却是对的。含中文的加密路径必现。

**根因**：`encDavHandle` 用 `respBody.replace(ctx.req.url, url)` 还原路径。`ctx.req.url` 是 `convertRealPath()` 生成的**解码后**中文路径，而 AList 返回的 XML 里中文是百分号编码，字符串匹配不上；随后只替换了 ASCII 文件名（`/${hrefName}</D:href>`），于是 `displayname` 对、`href` 错。

**本项目处置（业务级分叉，已实施）**：新增 `replacePathInBody()`，先按原样、再按 `encodeURI(from)` 两种形式各试一次；目标侧直接使用已有的编码形式，避免二次编码（`%` → `%25`）。

**对照证据**：修复前 href=`/dav/%E4%BC%9A%E5%91%98/sSZKwaKN8VHHP/f.txt`，GET 该 href=404；修复后 href=`/dav/%E4%BC%9A%E5%91%98/_fix_b/f.txt`，GET=200。rclone（`ls`/`copyto`）与 Windows 资源管理器（映射 Z:）读取均恢复正常。上游同版本同样出现密文父目录。

## U-09 COPY/MOVE 之后立刻 GET 目标返回 404

**现象**：COPY 返回 201、数据确实落到云端，但紧接着 GET 目标文件 404；先做一次 PROPFIND 再 GET 才正常。

**根因**：GET 分支依赖 `fileInfoTable_` 缓存把明文名映射到密文名；COPY/MOVE 不写缓存，`getFileInfo` 未命中后只拿**明文** URL 去 `getWebdavFileInfo()` 探测，云端存的是密文名，探测失败 → `fileSize=0` → 按不加密明文透传 → 404。

**本项目处置（业务级分叉，已实施）**：缓存未命中时，按 `convertRealName()` 算出的加密名先探测；命中后把 `request.url` / `request.urlAddr` 一并切到加密路径再代理；探测失败才回退明文（兼容 `orig_` 存量文件）。

**对照证据**：修复前 COPY=201、GET=404；修复后 COPY=201、GET=200 且内容一致（`COPYFIX01`）。上游同版本同样 404。

## U-10 Windows 资源管理器（WebClient）在加密目录内无法写入

**现象**：资源管理器里新建文件夹成功，往里写文件报"权限不足"；该目录随后也列不出来。同一目录用 rclone 上传、用 curl `PUT` 都正常。

**根因（已定位到现象层，未完全归因）**：WebClient 写入前会对目标文件做 PROPFIND 探测（含 `.exe`、`.lnk` 变体），代理对尚不存在的文件返回 404，WebClient 直接判定为无权限。服务端日志显示 `PUT` 实际到达并已转换成密文名（`@@webdav_put_info`），是客户端先放弃了。

**本项目处置**：未修改。上游同版本行为一致，需进一步定位 WebClient 对 404 的判定条件（可能与响应头或 `displayname` 有关），留作后续。

## 相关文档

- 运行时替换与平台差异：`openwrt-tjs-compatibility.md`（C-01…C-23）
- 不支持项与替换原因：`openwrt-tjs-unsupported-and-replacements.md`
- 逐项测试记录：`tests/run-2026-09-11.md`、`tests/run-2026-09-12.md`、`tests/run-2026-09-13.md`
- 可选功能（明文锚点层）方案：`optional-plaintext-anchor-layer.md`
