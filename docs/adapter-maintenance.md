# txiki 适配版的长期复审流程

> 2026-09-25 建立。本页是**人工触发的维护清单**，不是后台定时任务，也不授权自动拉取、合并或公开推送。
> 每次运行先冻结上游/适配版的具体 SHA，再区分「源码已修」「新产物已建」「ARM64 guest 已验收」「Release 已发布」四种状态。

## 0. 当前边界（下次运行先重新核对）

- 原版：独立 checkout `upstream/alist-encrypt`，`main@3d5f19fc5a001dfcac110d4c7d3d12d12ab4e617`；不得在此目录修改文件。
- 适配版：`openwrt/alist-encrypt` worktree，起点 `openwrt-tjs@e3f4d97`；2026-09-25 规范 CRLF 后 `node-proxy/src/` 的 **29 个 `.js`，21 同、8 异**。请以脚本实际输出代替将此数字当作永久常量。
- **已发布**应用 r10：R-42 的 ARM64 guest 48 项为 **45 PASS / 0 FAIL / 3 SKIP**（D03、D03b、D07）；R-43 桌面包和 Release 已同步 r10。见 [r10 测试记录](../tests/run-2026-09-15.md)。
- **源码候选补丁，未入 r10**：`platform/koa.js`、`platform/fixed-length-fetch.js`、`node-proxy/src/utils/PRGAThread.js` 的异常路径与 `PKG_LICENSE` 元数据已修；Node 隔离测试 5/5，临时 staging bundle 构建通过并清理。此后正式 r10 与**独立候选**分别在 ARM64 guest + 真实网盘跑 52 项，各 **50 PASS / 0 FAIL / 2 SKIP**（D03/C-26 与 D07/AList 500）；候选另通过固定向量、DAO 12 项和本地 HTTP 11 项。正式 `dist/`、APK 和 Release 均未改；切勿把候选的验收写成已发布 r10 包的新功能。隔离阶段见 [R-44](../tests/run-2026-09-25.md)，后续实测见 [分层真云报告](../openwrt-tjs/tests/run-2026-09-25-live-cloud.md)。

## 1. 触发与基线

收到维护请求、发现上游新提交、txiki/OpenWrt 运行时变化或适配回归时执行；没有设定自动巡查频率。以下在 **PowerShell** 中，从适配 worktree 根目录运行：

```powershell
$adapt = (Get-Location).Path
$upstream = (Resolve-Path '..\..\upstream\alist-encrypt').Path
$env:GIT_OPTIONAL_LOCKS = '0'
git -C $upstream rev-parse HEAD
git -C $adapt rev-parse HEAD
git -C $upstream status --short
git -C $adapt status --short
```

若是**独立发布仓库**，不一定存在 `..\..\upstream`；先另行提供未改动的上游 checkout 路径，不得拿已适配的 `node-proxy/` 冒充原版。检查上游 GitHub `main` 当前 SHA 可用只读 GitHub API（`https://api.github.com/repos/traceless/alist-encrypt/commits/main`），记录检查时间；若本地 SHA 不同，**先报告差异并征求同步授权**，不得擅自 `fetch/merge/rebase`。`git ls-remote` 曾在 Windows 宿主无响应，不要将超时误判为「上游没更新」。

## 2. 复审原版差异与风格

在 `openwrt-tjs/` 目录，依赖安装完毕时运行（不会 fetch、merge 或改源码）：

```powershell
npm run audit:upstream
# 独立检出且上游不在默认位置：
# npm run audit:upstream -- --upstream='D:\other-checkout\alist-encrypt'
```

脚本逐个读取两侧 Git 跟踪的 `node-proxy/src/*.js`，统一 CRLF 后输出相同/差异清单与两侧 HEAD；上游非干净状态会停止。**还须检查整个上游仓库**（`node-proxy/app.js`、UI、依赖、构建脚本、文档），29 文件数字不覆盖这些目录。

逐个阅读 `git -C $adapt diff --ignore-space-at-eol main..openwrt-tjs -- node-proxy/src`（以及本地未提交的 `git -C $adapt diff -- node-proxy/src`）。每个差异登记：原版行为、适配必要性、运行时限制、实测证据、是否改变加密/路径/权限语义、回退方案。未经双环境对照，不能将源代码推断正式登记为「上游缺陷」；已有 U-01～U-06 见 [上游问题清单](upstream-issues.md)，旧 R-34 审查与本轮增量见 [审查报告](porting-code-review.md)。

**风格原则**：在原作者文件中尽可能只做必需的适配，优先把 HTTP、文件 I/O、数据库和 Worker 的差别放进 `openwrt-tjs/src/platform/`；保留原文件的两空格缩进、单引号、不加分号、既有命名和中文注释习惯。不要批量格式化整树，不要把上游固有业务问题顺手修成新分叉；有安全例外须注明原因与对照结果。

## 3. 验证与发布闸门

```powershell
Set-Location openwrt-tjs
npm run test:adapter   # Node 隔离回归：204/205/304、定长 COPY/MOVE、PRGA 失败回退
npm run test:syntax
Set-Location ..
git diff --check
```

隔离测试只能验证适配模块分支，**不能替代 txiki 真机、AList 或 ARM64 guest**。完整发布前应按 [API 指南](api-test-guide.md) 在目标平台用真实 AList 重跑 48 项并检查 `FAIL` 与 `SKIP` 分别的原因；退出码 0 仅表示无 FAIL。重点回归 C-24 的定长上传/空响应、WebDAV COPY/MOVE 的 Host/Destination、RC4 Range/worker 回退、配置/DAO 持久化与转换命令。用平台补丁版 `/usr/bin/tjs` 跑 guest WebDAV；未补丁的 Windows 官方二进制须设置 `API_SKIP_WEBDAV=1` 并单独标明覆盖边界。guest 部署指引见工作区根 `docs/openwrt-guest-runbook.md`。

**新版本需单独构建并验证**：重建 dist 后核对 server 与 APK 内载荷哈希一致，升 `PKG_RELEASE`（不要覆盖已发布的 r10），再做 guest 和桌面包验收；核对仓库 `LICENSE`/`NOTICE`、`openwrt-tjs/package.json` 与 Makefile 的 `PKG_LICENSE`，保存日志到有日期的 `tests/run-YYYY-MM-DD.md`。未经授权不得推送公开仓库、覆盖 Release、重启用户现有服务或无差别升级镜像；不得把实际 AList 口令/令牌写进日志与 Markdown。

## 4. 下次优先复查的未闭环点

1. **目标环境尚未全部闭环**：候选已在 QEMU ARM64 guest + 真实 AList 完成 52 项（50/0/2），并通过固定向量、DAO/本地 HTTP；这不是生产路由器现场或 Windows 原生 txiki/新版桌面包验收。204/205/304、带 body 的 WebDAV COPY/MOVE、Worker 故障注入与 Windows 含空格路径等特殊分支须单独核对目标运行时覆盖，不得把完整云端套件的通过误称为这些分支都被触发。
2. **配置更新并发（待验证）**：`router.js` 的同步写文件被换成 `await fs.writeFile()`；两个管理员同时提交时，文件与 `alistServer._snapshot` 的先后顺序可能不同于原版。先做隔离复现与 Node 对照，再决定是否序列化；不要凭推断修改上游逻辑。
3. **传输形态（待验证）**：txiki `fetch` 与 Node `http.request` 在自签名 HTTPS、响应压缩 `Content-Encoding/Length`、中途断连时可能不同。扩大 C-24/C-19 矩阵，明确证据后才改码。
4. **数据库迁移边界**：NeDB → SQLite 没有自动导入旧 `nedb/datafile` 的流程；升级旧 Node 安装前须单独处理账号/缓存数据，不能直接宣称无损迁移。

每次维护把基线 SHA、29 文件列表、修复/未修风险、测试结果与产物哈希写入远端计划 `C:\...\alist-encrypt-arm\.planning\2026-09-25-adaptation-maintenance\progress.md`（或后续同类计划），并更新本页的当前边界。**保留历史测试原文，添加新日期的增量记录。**
