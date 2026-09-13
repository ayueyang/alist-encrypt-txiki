// alist-encrypt（OpenWrt txiki.js 适配版）API 端到端用例集。
//
// 设计目标：
//   1. 全流程只用 HTTP API 驱动，不依赖浏览器，便于反复执行。
//   2. 同一份用例既能在 OpenWrt guest 内由 /usr/bin/tjs 执行（正式证据），
//      也能在 Node 侧对模拟 AList 执行（对照）。
//   3. 用例自带清理，断言失败也会回收隔离目录并恢复应用配置。
//   4. 断言一律通过 assert() 抛出，禁止「把失败描述当字符串返回」的写法。
//
// 加密参数约定：encType=aesctr、encName=true、encFolder=true。
// 隔离目录：<rootPath>/_api_e2e_<时间戳>，顶层保持明文，内部子目录与文件参与加解密。

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function equalBytes(left, right) {
  if (!left || !right || left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function toHex(bytes, limit = 16) {
  return Array.from(bytes.slice(0, limit), (value) => value.toString(16).padStart(2, '0')).join('')
}

// 失败时给出可读正文：真实 AList 常以 JSON 错误体回应短响应，只打十六进制看不出原因
function preview(bytes, limit = 120) {
  const slice = bytes.slice(0, limit)
  let text = ''
  for (const byte of slice) {
    text += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.'
  }
  return `${toHex(bytes)} | ascii="${text}"`
}

function looksEncrypted(bytes, plain) {
  if (bytes.byteLength !== plain.byteLength) return true
  return !equalBytes(bytes, plain)
}

function makePayload(size) {
  const payload = new Uint8Array(size)
  for (let index = 0; index < size; index++) {
    payload[index] = (index * 31 + 7) & 0xff
  }
  payload.set(new TextEncoder().encode('alist-encrypt-api-e2e'), 0)
  return payload
}

const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// 不依赖 btoa/atob，保证在 tjs 与 Node 下行为一致
function toBase64(text) {
  const bytes = new TextEncoder().encode(text)
  let output = ''
  for (let index = 0; index < bytes.byteLength; index += 3) {
    const first = bytes[index]
    const second = index + 1 < bytes.byteLength ? bytes[index + 1] : 0
    const third = index + 2 < bytes.byteLength ? bytes[index + 2] : 0
    output += base64Alphabet[first >> 2]
    output += base64Alphabet[((first & 0x03) << 4) | (second >> 4)]
    output += index + 1 < bytes.byteLength ? base64Alphabet[((second & 0x0f) << 2) | (third >> 6)] : '='
    output += index + 2 < bytes.byteLength ? base64Alphabet[third & 0x3f] : '='
  }
  return output
}

export async function runApiSuite(options) {
  const {
    proxyOrigin,
    alistOrigin,
    rootPath = '/会员',
    appPassword = '123456',
    alistUsername,
    alistPassword,
    runtime = 'unknown',
    skipWebdav = false,
  } = options

  assert(alistUsername && alistPassword, 'ALIST_USERNAME and ALIST_PASSWORD are required')

  const alistUrl = new URL(alistOrigin)

  // ---------------------------------------------------------------- 用例数据
  const stamp = Date.now()
  const plainDir = `_api_e2e_${stamp}`
  const plainFolder = '可见目录'
  const plainFile = '中文 sample.txt'
  const renamedFile = 'renamed 文件.txt'
  const plainFileName = 'plain sample.txt'
  const copyFolder = '复制目标'
  const moveFolder = '移动目标'
  const encryptPassword = 'api-e2e-password'
  const encType = 'aesctr'

  const testDir = `${rootPath}/${plainDir}`
  const folderPath = `${testDir}/${plainFolder}`
  const filePath = `${folderPath}/${plainFile}`
  const copyPath = `${folderPath}/${copyFolder}`
  const movedPath = `${folderPath}/${moveFolder}`
  // 明文对照区：命名刻意不落在加密规则内
  const plainAreaName = `_api_plain_${stamp}`
  const plainAreaPath = `${rootPath}/${plainAreaName}`
  const plainFilePath = `${plainAreaPath}/${plainFileName}`

  const payload = makePayload(65536)
  const rangeStart = 12345

  const davFileName = 'dav 样例.txt'
  const davPayload = makePayload(32768)
  const davBase = `/dav${testDir}`
  const davFolder = `${davBase}/${plainFolder}`
  const davFile = `${davFolder}/${davFileName}`
  const davHeaders = { authorization: `Basic ${toBase64(`${alistUsername}:${alistPassword}`)}` }
  // txiki 的 fetch 不会像 Node 一样对 URL 中的空格与非 ASCII 自动百分号编码，
  // 裸空格会让请求行在服务端按空格截断；真实 WebDAV 客户端（rclone 等）本就发送编码路径，因此统一显式编码。
  const davUrl = (davPath) => `${proxyOrigin}${encodeURI(davPath)}`

  const results = []
  let appToken = ''
  let alistToken = ''
  let appHeaders = {}
  let authHeaders = {}
  let originalConfig = null
  let configured = false
  let createdRoot = false
  let createdFolder = false
  let createdPlainArea = false

  function pass(id, name, purpose, detail) {
    results.push({ id, name, purpose, status: 'PASS', detail })
  }

  function record(id, name, purpose, status, detail) {
    results.push({ id, name, purpose, status, detail })
  }

  // 统一执行：action 抛错即失败；verify 抛错即断言失败
  async function step(id, name, purpose, action, verify) {
    // API_SKIP_WEBDAV=1：跳过 C 组（运行时 LWS 无 WebDAV 方法补丁时，
    // 客户端 fetch PROPFIND 会永久挂死——例如官方 Windows/macOS tjs 二进制）
    if (skipWebdav && id.startsWith('C')) {
      console.log(`API_CASE_START ${id} ${name}`)
      record(id, name, purpose, 'SKIP', 'API_SKIP_WEBDAV=1')
      return null
    }
    console.log(`API_CASE_START ${id} ${name}`)
    try {
      const value = await action()
      const detail = verify ? await verify(value) : ''
      pass(id, name, purpose, detail || 'ok')
      return value
    } catch (error) {
      record(id, name, purpose, 'FAIL', String(error?.message || error))
      return null
    }
  }

  // ---------------------------------------------------------------- HTTP 基础

  async function requestJson(origin, method, apiPath, body, headers = {}) {
    const init = { method, headers: { ...headers } }
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const reqStart = Date.now()
    console.log(`API_REQ ${method} ${apiPath}`)
    const response = await fetch(`${origin}${apiPath}`, init)
    const text = await response.text()
    console.log(`API_REQ_DONE ${method} ${apiPath} ${response.status} ${Date.now() - reqStart}ms`)
    let data = null
    try {
      data = JSON.parse(text)
    } catch {}
    return { status: response.status, data, text }
  }

  function apiBody(result) {
    return result?.data?.data ?? null
  }

  function apiCode(result) {
    return result?.data?.code ?? null
  }

  async function listNames(origin, headers, listPath) {
    const result = await requestJson(origin, 'POST', '/api/fs/list', { path: listPath, password: '', page: 1, per_page: 200, refresh: true }, headers)
    return { result, names: (apiBody(result)?.content || []).map((item) => item.name) }
  }

  async function download(origin, downloadPath, headers = {}) {
    const response = await fetch(`${origin}${encodeURI(downloadPath)}`, { headers })
    const bytes = new Uint8Array(await response.arrayBuffer())
    return { status: response.status, headers: response.headers, bytes }
  }

  try {
    // ============================================================ A. 应用自身 API
    await step(
      'A01',
      '应用登录 /enc-api/login',
      '确认适配版服务可由 HTTP API 登录并取得 jwtToken',
      () => requestJson(proxyOrigin, 'POST', '/enc-api/login', { username: 'admin', password: appPassword }),
      (value) => {
        appToken = value.data?.data?.jwtToken || ''
        assert(appToken, `未返回 jwtToken：HTTP ${value.status} ${value.text.slice(0, 160)}`)
        appHeaders = { authorizetoken: appToken }
        return `HTTP ${value.status} token=${appToken.slice(0, 8)}…`
      },
    )
    assert(appToken, 'A01 登录失败，后续用例无法继续')

    await step(
      'A02',
      '错误密码登录被拒绝',
      '确认登录鉴权逻辑未被适配层破坏',
      () => requestJson(proxyOrigin, 'POST', '/enc-api/login', { username: 'admin', password: `${appPassword}-wrong` }),
      (value) => {
        assert(value.data?.code === 500, `预期 code=500，实际 ${JSON.stringify(value.data).slice(0, 160)}`)
        return `code=500 msg=${value.data.msg}`
      },
    )

    await step(
      'A03',
      '缺少 token 的请求被拦截',
      '确认 /enc-api/* 的登录拦截仍按上游语义返回 401',
      () => requestJson(proxyOrigin, 'POST', '/enc-api/getUserInfo'),
      (value) => {
        assert(value.data?.code === 401, `预期 code=401 msg=user unlogin，实际 ${JSON.stringify(value.data).slice(0, 200)}`)
        return `code=401 msg=${value.data.msg}`
      },
    )

    await step(
      'A04',
      '读取当前用户信息',
      '确认 token 缓存与用户信息接口正常',
      () => requestJson(proxyOrigin, 'POST', '/enc-api/getUserInfo', undefined, appHeaders),
      (value) => {
        const info = apiBody(value)
        assert(info?.userInfo?.username, `未返回 userInfo：${value.text.slice(0, 160)}`)
        return `username=${info.userInfo.username} version=${info.version}`
      },
    )

    await step(
      'A05',
      '读取 AList 代理配置',
      '取得当前 passwdList 快照，供后续用例与最终恢复使用',
      () => requestJson(proxyOrigin, 'POST', '/enc-api/getAlistConfig', undefined, appHeaders),
      (value) => {
        originalConfig = apiBody(value)
        assert(originalConfig, `未返回配置：${value.text.slice(0, 160)}`)
        return `passwdList=${(originalConfig.passwdList || []).length} serverHost=${originalConfig.serverHost}:${originalConfig.serverPort}`
      },
    )
    assert(originalConfig, 'A05 无法读取应用配置，后续用例无法继续')

    await step(
      'A06',
      '写入测试加密规则',
      '把隔离目录纳入加密路径，后续所有加密用例依赖该规则',
      () =>
        requestJson(
          proxyOrigin,
          'POST',
          '/enc-api/saveAlistConfig',
          {
            ...originalConfig,
            serverHost: alistUrl.hostname,
            serverPort: alistUrl.port || (alistUrl.protocol === 'https:' ? '443' : '80'),
            https: alistUrl.protocol === 'https:',
            passwdList: [
              {
                password: encryptPassword,
                describe: 'api-e2e',
                encType,
                enable: true,
                encName: true,
                encFolder: true,
                encSuffix: '',
                encPath: [`${plainDir}.*`],
              },
            ],
          },
          appHeaders,
        ),
      async (value) => {
        assert(apiCode(value) === 200, `保存失败 code=${apiCode(value)} msg=${value.data?.msg}`)
        configured = true
        await delay(200)
        const readBack = await requestJson(proxyOrigin, 'POST', '/enc-api/getAlistConfig', undefined, appHeaders)
        const rule = apiBody(readBack)?.passwdList?.[0]
        assert(rule?.encName && rule?.encFolder, `回读配置未包含 encName/encFolder：${readBack.text.slice(0, 160)}`)
        return `encType=${rule.encType} encPath=${JSON.stringify(rule.encPath)}`
      },
    )

    await step(
      'A07',
      '目录派生密码编解码往返',
      '确认 encodeFoldName / decodeFoldName 在适配运行时与上游语义一致',
      async () => {
        const encoded = await requestJson(
          proxyOrigin,
          'POST',
          '/enc-api/encodeFoldName',
          { password: encryptPassword, encType, folderPasswd: 'inner-password', folderEncType: 'rc4' },
          appHeaders,
        )
        const folderNameEnc = apiBody(encoded)?.folderNameEnc
        assert(folderNameEnc, `encode 失败：${encoded.text.slice(0, 160)}`)
        // 目录名约定为「显示名_<编码片段>」，decodeFoldName 取最后一段解码
        const folderName = `前缀_${folderNameEnc}`
        const decoded = await requestJson(proxyOrigin, 'POST', '/enc-api/decodeFoldName', { password: encryptPassword, encType, folderNameEnc: folderName }, appHeaders)
        return { folderName, decoded: apiBody(decoded), raw: decoded.text }
      },
      (value) => {
        const { decoded } = value
        assert(decoded, `decode 未返回数据：${String(value.raw).slice(0, 160)}`)
        assert(decoded.folderPasswd === 'inner-password', `派生密码往返不一致：${JSON.stringify(decoded)}`)
        assert(decoded.folderEncType === 'rc4', `派生算法往返不一致：${JSON.stringify(decoded)}`)
        return `${value.folderName.slice(0, 14)}… → ${decoded.folderEncType}/${decoded.folderPasswd}`
      },
    )

    await step(
      'A08',
      '读取 WebDAV 代理配置',
      '确认 getWebdavonfig 可用',
      () => requestJson(proxyOrigin, 'POST', '/enc-api/getWebdavonfig', undefined, appHeaders),
      (value) => {
        assert(Array.isArray(apiBody(value)), `未返回数组：${value.text.slice(0, 160)}`)
        return `webdavServer=${apiBody(value).length}`
      },
    )

    await step(
      'A09',
      'WebDAV 配置增删改往返',
      '确认 saveWebdavConfig / updateWebdavConfig / delWebdavConfig 接口闭环',
      async () => {
        const listWebdav = async () => apiBody(await requestJson(proxyOrigin, 'POST', '/enc-api/getWebdavonfig', undefined, appHeaders)) || []
        // 环境可能带预置条目（例如出厂配置的 other-webdav），断言以「自建条目被删净」与「总数复原」为准
        const countBefore = (await listWebdav()).length
        const entry = {
          name: 'api-e2e-webdav',
          describe: 'api-e2e',
          path: '^/api_e2e_dav/*',
          enable: false,
          serverHost: alistUrl.hostname,
          serverPort: alistUrl.port || '80',
          https: false,
          passwdList: [{ password: 'x', encType, enable: false, encName: false, encPath: ['api_e2e_dav/*'] }],
        }
        const saved = await requestJson(proxyOrigin, 'POST', '/enc-api/saveWebdavConfig', entry, appHeaders)
        const created = (await listWebdav()).find((item) => item.name === 'api-e2e-webdav')
        assert(created, `保存后未找到新条目：${saved.text.slice(0, 160)}`)
        const updated = await requestJson(proxyOrigin, 'POST', '/enc-api/updateWebdavConfig', { ...created, describe: 'api-e2e-updated' }, appHeaders)
        const updatedList = apiBody(updated) || (await listWebdav())
        await requestJson(proxyOrigin, 'POST', '/enc-api/delWebdavConfig', { id: created.id }, appHeaders)
        const afterList = await listWebdav()
        return {
          updatedDescribe: updatedList.find((item) => item.id === created.id)?.describe,
          deleteLeft: afterList.filter((item) => item.id === created.id).length,
          countBefore,
          countAfter: afterList.length,
        }
      },
      (value) => {
        assert(value.updatedDescribe === 'api-e2e-updated', `更新未生效：${value.updatedDescribe}`)
        assert(value.deleteLeft === 0, `删除后仍剩 ${value.deleteLeft} 条`)
        assert(value.countAfter === value.countBefore, `条目数未复原：${value.countBefore} -> ${value.countAfter}`)
        return '新增 / 更新 / 删除均生效'
      },
    )

    // ============================================================ B. AList 代理链路
    const alistLogin = await requestJson(proxyOrigin, 'POST', '/api/auth/login', { username: alistUsername, password: alistPassword })
    alistToken = alistLogin.data?.data?.token || alistLogin.data?.token || ''
    if (!alistToken) {
      record('B00', 'AList 登录（经代理）', '后续全部 AList 用例的前置条件', 'FAIL', `HTTP ${alistLogin.status}: ${alistLogin.text.slice(0, 200)}`)
      throw new Error('AList login through proxy failed')
    }
    authHeaders = { authorization: alistToken }
    pass('B00', 'AList 登录（经代理）', '后续全部 AList 用例的前置条件', `HTTP ${alistLogin.status}`)

    await step(
      'B01',
      '代理列目录 /api/fs/list',
      '确认 /api/fs/list 被适配版接管并返回 AList 数据结构',
      () => requestJson(proxyOrigin, 'POST', '/api/fs/list', { path: rootPath, password: '', page: 1, per_page: 50, refresh: true }, authHeaders),
      (value) => {
        assert(apiCode(value) === 200, `code=${apiCode(value)} msg=${value.data?.message}`)
        assert(Array.isArray(apiBody(value)?.content), '返回结构缺少 data.content')
        return `content=${apiBody(value).content.length}`
      },
    )

    await step(
      'B02',
      '代理列子目录 /api/fs/dirs',
      '确认 /api/fs/dirs 可用',
      () => requestJson(proxyOrigin, 'POST', '/api/fs/dirs', { path: rootPath }, authHeaders),
      (value) => {
        assert(apiCode(value) === 200, `code=${apiCode(value)} msg=${value.data?.message}`)
        assert(Array.isArray(apiBody(value)), '返回结构不是数组')
        return `dirs=${apiBody(value).length}`
      },
    )

    await step(
      'B03',
      '创建明文顶层隔离目录',
      '建立隔离空间，并确认未命中 encPath 的路径保持明文（文件夹名加密的负向基准）',
      () => requestJson(proxyOrigin, 'POST', '/api/fs/mkdir', { path: testDir }, authHeaders),
      async (value) => {
        assert(apiCode(value) === 200, `code=${apiCode(value)} msg=${value.data?.message}`)
        createdRoot = true
        const { names } = await listNames(alistOrigin, authHeaders, rootPath)
        assert(names.includes(plainDir), `云端未出现明文目录 ${plainDir}，实际 ${names.join(',') || '(空)'}`)
        return `云端目录名保持明文：${plainDir}`
      },
    )

    await step(
      'B04',
      '创建加密子目录',
      '确认 encFolder=true 时子目录名在云端被加密',
      () => requestJson(proxyOrigin, 'POST', '/api/fs/mkdir', { path: folderPath }, authHeaders),
      async (value) => {
        assert(apiCode(value) === 200, `code=${apiCode(value)} msg=${value.data?.message}`)
        createdFolder = true
        const { names } = await listNames(alistOrigin, authHeaders, testDir)
        assert(!names.includes(plainFolder), `云端目录名仍是明文 ${plainFolder}（文件夹名加密失效）`)
        assert(names.length === 1, `云端目录项数量异常：${names.join(',') || '(空)'}`)
        return `云端目录名为密文：${names[0].slice(0, 16)}…`
      },
    )
    const cloudFolder = (await listNames(alistOrigin, authHeaders, testDir)).names[0] || ''

    await step(
      'B05',
      '加密上传 /api/fs/put',
      '确认 PUT 上传通道被适配版接管',
      async () => {
        const response = await fetch(`${proxyOrigin}/api/fs/put`, {
          method: 'PUT',
          headers: { ...authHeaders, 'content-type': 'application/octet-stream', 'file-path': encodeURIComponent(filePath) },
          body: payload,
        })
        const text = await response.text()
        let code = null
        try {
          code = JSON.parse(text).code
        } catch {}
        return { status: response.status, code, text: text.slice(0, 160) }
      },
      (value) => {
        assert(value.status >= 200 && value.status < 300, `HTTP ${value.status} ${value.text}`)
        assert(value.code === 200, `code=${value.code} ${value.text}`)
        return `HTTP ${value.status}`
      },
    )

    await step(
      'B06',
      '云端校验：文件名密文 + 内容密文',
      '直接向 AList 取原始数据，确认落盘的是密文而非明文',
      async () => {
        const { names } = await listNames(alistOrigin, authHeaders, `${testDir}/${cloudFolder}`)
        assert(names.length > 0, '云端加密目录为空，上传未落盘')
        const cloudName = names[0]
        const getResult = await requestJson(alistOrigin, 'POST', '/api/fs/get', { path: `${testDir}/${cloudFolder}/${cloudName}` }, authHeaders)
        const rawUrl = apiBody(getResult)?.raw_url
        assert(rawUrl, `云端未返回 raw_url：${getResult.text.slice(0, 160)}`)
        const raw = await download(alistOrigin, new URL(rawUrl).pathname + new URL(rawUrl).search)
        return { cloudName, status: raw.status, byteLength: raw.bytes.byteLength, encrypted: looksEncrypted(raw.bytes, payload), head: toHex(raw.bytes) }
      },
      (value) => {
        assert(value.cloudName !== plainFile, `云端文件名仍是明文 ${plainFile}（文件名加密失效）`)
        assert(value.status === 200, `云端直链下载失败 HTTP ${value.status}`)
        assert(value.byteLength === payload.byteLength, `云端密文长度 ${value.byteLength} 与明文 ${payload.byteLength} 不一致`)
        assert(value.encrypted, '云端内容与明文逐字节相同（内容加密失效）')
        return `云端名=${value.cloudName.slice(0, 16)}… 长度=${value.byteLength} 头部=${value.head}`
      },
    )

    await step(
      'B07',
      '代理列目录显示明文名',
      '确认文件名解密在 /api/fs/list 生效',
      async () => {
        const { result, names } = await listNames(proxyOrigin, authHeaders, folderPath)
        return { code: apiCode(result), names }
      },
      (value) => {
        assert(value.code === 200, `code=${value.code}`)
        assert(value.names.includes(plainFile), `未显示明文名 ${plainFile}，实际 ${value.names.join(',') || '(空)'}`)
        return `显示明文名：${plainFile}`
      },
    )

    let redirectPath = null
    await step(
      'B08',
      '获取文件详情 /api/fs/get',
      '确认 raw_url 被改写为 /redirect/<key>，且名称恢复为明文',
      async () => {
        const result = await requestJson(proxyOrigin, 'POST', '/api/fs/get', { path: filePath }, authHeaders)
        const data = apiBody(result)
        if (data?.raw_url) {
          redirectPath = data.raw_url.startsWith('http') ? new URL(data.raw_url).pathname + new URL(data.raw_url).search : data.raw_url
        }
        return { code: apiCode(result), data }
      },
      (value) => {
        assert(value.code === 200, `code=${value.code}`)
        const { raw_url: rawUrl, name } = value.data || {}
        assert(rawUrl, '未返回 raw_url')
        assert(rawUrl.includes('/redirect/'), `raw_url 未被改写：${String(rawUrl).slice(0, 80)}`)
        assert(name === plainFile, `显示名未恢复：${name}`)
        return `raw_url → ${String(rawUrl).split('?')[0]}`
      },
    )

    if (redirectPath) {
      await step(
        'B09',
        '重定向通道完整解密下载',
        '确认 /redirect/<key> 能完整还原明文（在线播放同链路）',
        () => download(proxyOrigin, redirectPath),
        (value) => {
          assert(value.status === 200, `HTTP ${value.status}`)
          assert(equalBytes(value.bytes, payload), `内容与明文不一致，长度 ${value.bytes.byteLength}，头部 ${toHex(value.bytes)}`)
          return `length=${value.bytes.byteLength} 与明文逐字节一致`
        },
      )

      await step(
        'B10',
        '重定向通道 Range 解密下载',
        '确认偏移定位正确（拖动进度条场景）',
        () => download(proxyOrigin, redirectPath, { range: `bytes=${rangeStart}-` }),
        (value) => {
          assert(value.status === 206, `HTTP ${value.status}（预期 206）`)
          assert(equalBytes(value.bytes, payload.slice(rangeStart)), `Range 内容不一致，长度 ${value.bytes.byteLength}，头部 ${toHex(value.bytes)}`)
          return `206 length=${value.bytes.byteLength} ${value.headers.get('content-range')}`
        },
      )
    } else {
      record('B09', '重定向通道完整解密下载', '依赖 B08 的 raw_url', 'SKIP', 'B08 未取得 raw_url')
      record('B10', '重定向通道 Range 解密下载', '依赖 B08 的 raw_url', 'SKIP', 'B08 未取得 raw_url')
    }

    await step(
      'B11',
      '直链通道 /d 完整解密下载',
      '确认 handleDownload 对 /d 路径完成密文名定位与内容解密',
      () => download(proxyOrigin, `/d${filePath}`),
      (value) => {
        assert(value.status === 200, `HTTP ${value.status}`)
        assert(equalBytes(value.bytes, payload), `内容与明文不一致，长度 ${value.bytes.byteLength}，${preview(value.bytes)}`)
        return `HTTP 200 length=${value.bytes.byteLength}`
      },
    )

    await step(
      'B12',
      '直链通道 /d Range 解密下载',
      '确认 handleDownload 的 Range 偏移定位',
      () => download(proxyOrigin, `/d${filePath}`, { range: `bytes=${rangeStart}-` }),
      (value) => {
        assert(value.status === 206, `HTTP ${value.status}（预期 206）`)
        assert(equalBytes(value.bytes, payload.slice(rangeStart)), `Range 内容不一致，长度 ${value.bytes.byteLength}，头部 ${toHex(value.bytes)}`)
        return `206 length=${value.bytes.byteLength}`
      },
    )

    await step(
      'B13',
      '直链通道 /p 解密下载',
      '确认 /p 前缀同样按磁盘路径解密',
      () => download(proxyOrigin, `/p${filePath}`),
      (value) => {
        assert(value.status === 200, `HTTP ${value.status}`)
        assert(equalBytes(value.bytes, payload), `内容与明文不一致，长度 ${value.bytes.byteLength}，${preview(value.bytes)}`)
        return `HTTP 200 length=${value.bytes.byteLength}`
      },
    )

    await step(
      'B14',
      '重命名 /api/fs/rename',
      '确认新名字以密文落盘，且代理列表恢复明文名',
      async () => {
        const renamed = await requestJson(proxyOrigin, 'POST', '/api/fs/rename', { path: filePath, name: renamedFile }, authHeaders)
        const proxyList = await listNames(proxyOrigin, authHeaders, folderPath)
        const cloudList = await listNames(alistOrigin, authHeaders, `${testDir}/${cloudFolder}`)
        return { code: apiCode(renamed), proxyNames: proxyList.names, cloudNames: cloudList.names, raw: renamed.text.slice(0, 160) }
      },
      (value) => {
        assert(value.code === 200, `code=${value.code} ${value.raw}`)
        assert(value.proxyNames.includes(renamedFile), `代理列表未显示新明文名，实际 ${value.proxyNames.join(',') || '(空)'}`)
        assert(!value.cloudNames.includes(renamedFile), '云端仍是明文新名字（重命名未加密）')
        assert(value.cloudNames.some((name) => name.endsWith('.txt')), `云端新名字缺少扩展名：${value.cloudNames.join(',')}`)
        return `代理显示=${renamedFile} 云端=${value.cloudNames[0].slice(0, 16)}…`
      },
    )

    await step(
      'B15',
      '复制 /api/fs/copy',
      '确认复制后目标目录显示明文名',
      async () => {
        const mkdir = await requestJson(proxyOrigin, 'POST', '/api/fs/mkdir', { path: copyPath }, authHeaders)
        assert(apiCode(mkdir) === 200, `创建复制目标失败 code=${apiCode(mkdir)} msg=${mkdir.data?.message}`)
        const copied = await requestJson(proxyOrigin, 'POST', '/api/fs/copy', { src_dir: folderPath, dst_dir: copyPath, names: [renamedFile] }, authHeaders)
        const after = await listNames(proxyOrigin, authHeaders, copyPath)
        return { code: apiCode(copied), names: after.names, raw: copied.text.slice(0, 160) }
      },
      (value) => {
        assert(value.code === 200, `code=${value.code} ${value.raw}`)
        assert(value.names.includes(renamedFile), `复制目标未显示明文名，实际 ${value.names.join(',') || '(空)'}`)
        return `目标目录显示：${renamedFile}`
      },
    )

    await step(
      'B16',
      '移动 /api/fs/move',
      '确认移动后目标目录显示明文名，原目录清空',
      async () => {
        const mkdir = await requestJson(proxyOrigin, 'POST', '/api/fs/mkdir', { path: movedPath }, authHeaders)
        assert(apiCode(mkdir) === 200, `创建移动目标失败 code=${apiCode(mkdir)} msg=${mkdir.data?.message}`)
        const moved = await requestJson(proxyOrigin, 'POST', '/api/fs/move', { src_dir: copyPath, dst_dir: movedPath, names: [renamedFile] }, authHeaders)
        const after = await listNames(proxyOrigin, authHeaders, movedPath)
        const source = await listNames(proxyOrigin, authHeaders, copyPath)
        return { code: apiCode(moved), names: after.names, sourceNames: source.names, raw: moved.text.slice(0, 160) }
      },
      (value) => {
        assert(value.code === 200, `code=${value.code} ${value.raw}`)
        assert(value.names.includes(renamedFile), `移动目标未显示明文名，实际 ${value.names.join(',') || '(空)'}`)
        assert(value.sourceNames.length === 0, `源目录未清空：${value.sourceNames.join(',')}`)
        return `移动后目标显示：${renamedFile}`
      },
    )

    await step(
      'B17',
      '明文路径透传（负向验证）',
      '确认未命中 encPath 的目录不会被误加密',
      async () => {
        const mkdir = await requestJson(proxyOrigin, 'POST', '/api/fs/mkdir', { path: plainAreaPath }, authHeaders)
        assert(apiCode(mkdir) === 200, `创建明文目录失败 code=${apiCode(mkdir)} msg=${mkdir.data?.message}`)
        createdPlainArea = true
        const response = await fetch(`${proxyOrigin}/api/fs/put`, {
          method: 'PUT',
          headers: { ...authHeaders, 'content-type': 'application/octet-stream', 'file-path': encodeURIComponent(plainFilePath) },
          body: payload,
        })
        await response.text()
        const cloudArea = await listNames(alistOrigin, authHeaders, plainAreaPath)
        const cloudContent = await listNames(alistOrigin, authHeaders, plainFilePath.slice(0, plainFilePath.lastIndexOf('/')))
        return { status: response.status, areaNames: cloudArea.names, contentNames: cloudContent.names }
      },
      (value) => {
        assert(value.status >= 200 && value.status < 300, `上传失败 HTTP ${value.status}`)
        assert(value.contentNames.includes(plainFileName), `明文目录下的文件名被改写：${value.contentNames.join(',') || '(空)'}`)
        return `云端保持明文名：${plainFileName}`
      },
    )

    await step(
      'B18',
      '删除文件 /api/fs/remove',
      '确认删除通道可用（密文名转换正确）',
      async () => {
        const removed = await requestJson(proxyOrigin, 'POST', '/api/fs/remove', { dir: movedPath, names: [renamedFile] }, authHeaders)
        const after = await listNames(proxyOrigin, authHeaders, movedPath)
        return { code: apiCode(removed), names: after.names, raw: removed.text.slice(0, 160) }
      },
      (value) => {
        assert(value.code === 200, `code=${value.code} ${value.raw}`)
        assert(value.names.length === 0, `删除后目录仍有：${value.names.join(',')}`)
        return '删除后目录为空'
      },
    )

    await step(
      'B19',
      '大文件并发上传（R-25 回归守护）',
      '确认 8MB 经代理上传成功且期间 /ping 不被事件循环阻塞（R-25：修复前 7.5MB 上传导致整个代理 307s 无响应）',
      async () => {
        const largePath = `${folderPath}/large-r25.bin`
        const largeSize = 8 * 1024 * 1024
        const largePayload = makePayload(largeSize)
        // 并发 /ping 探测：300ms 间隔，单次 4s 超时
        const pings = []
        let probing = true
        const prober = (async () => {
          while (probing) {
            const t0 = Date.now()
            try {
              const ctl = new AbortController()
              const timer = setTimeout(() => ctl.abort(), 4000)
              const r = await fetch(`${proxyOrigin}/ping`, { signal: ctl.signal })
              clearTimeout(timer)
              await r.text()
              pings.push({ ok: true, ms: Date.now() - t0 })
            } catch {
              pings.push({ ok: false, ms: Date.now() - t0 })
            }
            await delay(300)
          }
        })()
        const uploadStart = Date.now()
        const upload = await fetch(`${proxyOrigin}/api/fs/put`, {
          method: 'PUT',
          headers: { ...authHeaders, 'content-type': 'application/octet-stream', 'content-length': String(largeSize), 'file-path': encodeURIComponent(largePath) },
          body: largePayload,
        })
        const uploadText = await upload.text()
        const uploadMs = Date.now() - uploadStart
        probing = false
        await prober
        const pingFails = pings.filter((item) => !item.ok).length
        // 云端为密文名，用尺寸定位（AList 报真实大小）
        const listed = await requestJson(alistOrigin, 'POST', '/api/fs/list', { path: `${testDir}/${cloudFolder}`, password: '', page: 1, per_page: 200, refresh: false }, authHeaders)
        const sizeMatch = (apiBody(listed)?.content || []).find((item) => Number(item.size) === largeSize) || null
        return { status: upload.status, uploadMs, pings: pings.length, pingFails, sizeMatchFound: !!sizeMatch, raw: uploadText.slice(0, 120), largeSize }
      },
      (value) => {
        assert(value.status >= 200 && value.status < 300, `上传失败 HTTP ${value.status} ${value.raw}`)
        assert(value.sizeMatchFound, `云端未找到尺寸为 ${value.largeSize} 的上传文件`)
        assert(value.pings >= 5, `并发探测样本过少：${value.pings}`)
        assert(value.pingFails <= Math.floor(value.pings / 4), `上传期间 /ping 失败过多：${value.pingFails}/${value.pings}（事件循环被阻塞）`)
        return `PUT ${value.uploadMs}ms，ping ${value.pings - value.pingFails}/${value.pings} 正常，云端密文尺寸吻合`
      },
    )

    // ============================================================ C. WebDAV 代理
    await step(
      'C01',
      'WebDAV PROPFIND 根目录',
      '确认 /dav 代理可用并返回 multistatus',
      async () => {
        const response = await fetch(davUrl(davBase), { method: 'PROPFIND', headers: { ...davHeaders, depth: '1' } })
        const text = await response.text()
        return { status: response.status, text }
      },
      (value) => {
        assert(value.status === 207, `HTTP ${value.status} ${value.text.slice(0, 160)}`)
        assert(value.text.includes('multistatus'), `响应不是 WebDAV multistatus：${value.text.slice(0, 160)}`)
        return 'HTTP 207 multistatus'
      },
    )

    await step(
      'C02',
      'WebDAV PUT 加密上传',
      '确认 WebDAV 上传同样执行内容与文件名加密',
      async () => {
        const before = await listNames(alistOrigin, authHeaders, `${testDir}/${cloudFolder}`)
        const response = await fetch(davUrl(davFile), { method: 'PUT', headers: davHeaders, body: davPayload })
        const text = await response.text()
        const after = await listNames(alistOrigin, authHeaders, `${testDir}/${cloudFolder}`)
        return { status: response.status, text: text.slice(0, 160), before: before.names, cloudNames: after.names }
      },
      (value) => {
        assert(value.status >= 200 && value.status < 300, `HTTP ${value.status} ${value.text}`)
        assert(!value.cloudNames.includes(davFileName), '云端仍是明文文件名（WebDAV 未加密名字）')
        assert(value.cloudNames.length > value.before.length, `云端未出现新增文件：${value.cloudNames.join(',') || '(空)'}`)
        return `HTTP ${value.status} 云端新增 ${value.cloudNames.length - value.before.length} 个密文文件`
      },
    )

    await step(
      'C03',
      'WebDAV PROPFIND 显示明文名',
      '确认 WebDAV 目录读取会解密目录名与文件名',
      async () => {
        const response = await fetch(davUrl(davFolder), { method: 'PROPFIND', headers: { ...davHeaders, depth: '1' } })
        return { status: response.status, text: await response.text() }
      },
      (value) => {
        assert(value.status === 207, `HTTP ${value.status} ${value.text.slice(0, 240)}`)
        // WebDAV 的 href 是 URI，必须是百分号编码形式，断言前先按规范解码
        const hrefs = (value.text.match(/<D:href>([^<]*)<\/D:href>/g) || []).map((item) => item.replace(/<\/?D:href>/g, ''))
        const names = hrefs.map((href) => {
          try {
            return decodeURIComponent(href).replace(/\/$/, '').split('/').pop()
          } catch {
            return href
          }
        })
        const shown = names.join(' | ')
        assert(names.includes(davFileName), `PROPFIND 未返回明文文件名 ${davFileName}；实际展示名=${shown}`)
        assert(names.includes(plainFolder), `PROPFIND 未返回明文目录名 ${plainFolder}；实际展示名=${shown}`)
        return `PROPFIND 明文名：${shown}`
      },
    )

    await step(
      'C04',
      'WebDAV GET 完整解密下载',
      '确认 WebDAV 下载通道能还原明文',
      () => download(proxyOrigin, davFile, davHeaders),
      (value) => {
        assert(value.status === 200, `HTTP ${value.status}`)
        assert(equalBytes(value.bytes, davPayload), `内容与明文不一致，长度 ${value.bytes.byteLength}，头部 ${toHex(value.bytes)}`)
        return `length=${value.bytes.byteLength} 与明文逐字节一致`
      },
    )

    await step(
      'C05',
      'WebDAV HEAD 返回明文长度',
      '确认 HEAD 的 content-length 与明文长度一致',
      async () => {
        const response = await fetch(davUrl(davFile), { method: 'HEAD', headers: davHeaders })
        return { status: response.status, contentLength: response.headers.get('content-length') }
      },
      (value) => {
        assert(value.status === 200, `HTTP ${value.status}`)
        assert(Number(value.contentLength) === davPayload.byteLength, `content-length=${value.contentLength}，预期 ${davPayload.byteLength}`)
        return `content-length=${value.contentLength}`
      },
    )

    await step(
      'C06',
      'WebDAV Range 解密下载',
      '确认 WebDAV 通道的偏移定位正确',
      () => download(proxyOrigin, davFile, { ...davHeaders, range: 'bytes=1024-' }),
      (value) => {
        assert(value.status === 206, `HTTP ${value.status}（预期 206）`)
        assert(equalBytes(value.bytes, davPayload.slice(1024)), `Range 内容不一致，长度 ${value.bytes.byteLength}`)
        return `206 length=${value.bytes.byteLength}`
      },
    )

    const davCopyName = 'copy 样例.txt'
    const davMoveName = 'moved 样例.txt'
    // destination 头是 ByteString，非 ASCII 路径必须整体百分号编码
    const davDestination = (name) => `${proxyOrigin}${davFolder.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(name)}`

    await step(
      'C07',
      'WebDAV COPY',
      '确认 WebDAV 复制通道可用并保持加密语义',
      async () => {
        const response = await fetch(davUrl(davFile), { method: 'COPY', headers: { ...davHeaders, destination: davDestination(davCopyName) } })
        const text = await response.text()
        const cloudList = await listNames(alistOrigin, authHeaders, `${testDir}/${cloudFolder}`)
        return { status: response.status, text: text.slice(0, 200), cloudNames: cloudList.names }
      },
      (value) => {
        assert(value.status >= 200 && value.status < 300, `HTTP ${value.status} ${value.text}`)
        assert(!value.cloudNames.includes(davCopyName), '复制目标在云端是明文名（未加密）')
        return `HTTP ${value.status} 云端未出现明文新名`
      },
    )

    await step(
      'C08',
      'WebDAV MOVE',
      '确认 WebDAV 移动通道可用并保持加密语义',
      async () => {
        const response = await fetch(davUrl(`${davFolder}/${davCopyName}`), {
          method: 'MOVE',
          headers: { ...davHeaders, destination: davDestination(davMoveName) },
        })
        const text = await response.text()
        const cloudList = await listNames(alistOrigin, authHeaders, `${testDir}/${cloudFolder}`)
        return { status: response.status, text: text.slice(0, 200), cloudNames: cloudList.names }
      },
      (value) => {
        assert(value.status >= 200 && value.status < 300, `HTTP ${value.status} ${value.text}`)
        assert(!value.cloudNames.includes(davMoveName), '移动目标在云端是明文名（未加密）')
        return `HTTP ${value.status} 云端未出现明文新名`
      },
    )

    await step(
      'C09',
      'WebDAV DELETE',
      '确认 WebDAV 删除通道可用',
      async () => {
        const response = await fetch(davUrl(`${davFolder}/${davMoveName}`), { method: 'DELETE', headers: davHeaders })
        const text = await response.text()
        return { status: response.status, text: text.slice(0, 200) }
      },
      (value) => {
        assert(value.status >= 200 && value.status < 300, `HTTP ${value.status} ${value.text}`)
        return `HTTP ${value.status}`
      },
    )
  } finally {
    // ---------------------------------------------------------- 清理与恢复
    if (alistToken) {
      for (const [flag, name] of [
        [createdRoot, plainDir],
        [createdPlainArea, plainAreaName],
      ]) {
        if (!flag) continue
        try {
          await requestJson(proxyOrigin, 'POST', '/api/fs/remove', { dir: rootPath, names: [name] }, { authorization: alistToken })
        } catch {}
      }
    }
    if (configured && appToken && originalConfig) {
      try {
        await requestJson(proxyOrigin, 'POST', '/enc-api/saveAlistConfig', originalConfig, { authorizetoken: appToken })
      } catch {}
    }
  }

  const summary = {
    runtime,
    proxyOrigin,
    alistOrigin,
    rootPath,
    testDir,
    total: results.length,
    pass: results.filter((item) => item.status === 'PASS').length,
    fail: results.filter((item) => item.status === 'FAIL').length,
    skip: results.filter((item) => item.status === 'SKIP').length,
  }
  return { summary, results }
}
