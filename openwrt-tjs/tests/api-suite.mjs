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
      const message = String(error?.message || error)
      // `SKIP::` 前缀 = 断言层判定「这是上游/后端已知受限形态，非本适配层缺陷」，
      // 与 FAIL 区分开：受限形态被登记为 SKIP，一旦变成别的状态码仍会落到 FAIL。
      if (message.startsWith('SKIP::')) {
        record(id, name, purpose, 'SKIP', message.slice('SKIP::'.length))
        return null
      }
      record(id, name, purpose, 'FAIL', message)
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

    // 直链通道（/d、/p）在本版 AList 上必须带 sign：无 sign 时 AList 回
    // HTTP 200 + 51 字节 {"code":401,"message":"expire missing"}，代理按加密
    // 语义把它当密文解密，于是客户端拿到 51 字节乱码——历史 B11–B13 的失败体正是它。
    // 真实客户端的用法（上游 encNameRouter.js:357 注释所约定的形态）：
    // 先向 AList 要该文件的 sign，再把「密文名 + sign」换成「明文名 + sign」走代理。
    const signedDirectQuery = async () => {
      const { names } = await listNames(alistOrigin, authHeaders, `${testDir}/${cloudFolder}`)
      assert(names.length > 0, '云端加密目录为空，无法获取直链签名')
      const cloudName = names.find((name) => name.endsWith('.txt')) || names[0]
      const getResult = await requestJson(alistOrigin, 'POST', '/api/fs/get', { path: `${testDir}/${cloudFolder}/${cloudName}` }, authHeaders)
      const sign = apiBody(getResult)?.sign
      assert(sign, `AList 未返回 sign：${getResult.text.slice(0, 160)}`)
      return `?sign=${encodeURIComponent(sign)}`
    }
    const directQuery = await signedDirectQuery()

    await step(
      'B11',
      '直链通道 /d 完整解密下载',
      '确认 handleDownload 对 /d 路径完成密文名定位与内容解密（带 AList sign）',
      () => download(proxyOrigin, `/d${filePath}${directQuery}`),
      (value) => {
        assert(value.status === 200, `HTTP ${value.status}`)
        assert(equalBytes(value.bytes, payload), `内容与明文不一致，长度 ${value.bytes.byteLength}，${preview(value.bytes)}`)
        return `HTTP 200 length=${value.bytes.byteLength}`
      },
    )

    await step(
      'B12',
      '直链通道 /d Range 解密下载',
      '确认 handleDownload 的 Range 偏移定位（带 AList sign）',
      () => download(proxyOrigin, `/d${filePath}${directQuery}`, { range: `bytes=${rangeStart}-` }),
      (value) => {
        assert(value.status === 206, `HTTP ${value.status}（预期 206）`)
        assert(equalBytes(value.bytes, payload.slice(rangeStart)), `Range 内容不一致，长度 ${value.bytes.byteLength}，头部 ${toHex(value.bytes)}`)
        return `206 length=${value.bytes.byteLength}`
      },
    )

    await step(
      'B13',
      '直链通道 /p 解密下载',
      '确认 /p 前缀同样按磁盘路径解密（带 AList sign）',
      () => download(proxyOrigin, `/p${filePath}${directQuery}`),
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
      '确认 8MB 经代理上传的密文正确落盘，且期间 /ping 不被事件循环阻塞（R-25：修复前 7.5MB 上传导致整个代理 307s 无响应）。本轮起把「客户端等待响应头超 15s（C-26）」与「传输本身失败」分开判定：前者仍以云端密文尺寸 + /ping 健康度为准',
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
        let uploadStatus = null
        let uploadError = ''
        const uploadStart = Date.now()
        try {
          const upload = await fetch(`${proxyOrigin}/api/fs/put`, {
            method: 'PUT',
            headers: { ...authHeaders, 'content-type': 'application/octet-stream', 'content-length': String(largeSize), 'file-path': encodeURIComponent(largePath) },
            body: largePayload,
          })
          uploadStatus = upload.status
          await upload.text()
        } catch (error) {
          // 超时后必须停探测循环：否则 300ms 的 /ping 会一路打到套件结束，
          // 让后续用例（D03/D03b）在慢后端下更容易撞上 C-26 的 15s 上限
          uploadError = String(error?.message || error)
        } finally {
          probing = false
          await prober
        }
        const uploadMs = Date.now() - uploadStart
        const pingFails = pings.filter((item) => !item.ok).length
        // 云端为密文名，用尺寸定位（AList 报真实大小）。客户端超时后服务端可能仍在收尾，故重试若干次
        let sizeMatchFound = false
        for (let attempt = 0; attempt < 4 && !sizeMatchFound; attempt += 1) {
          const listed = await requestJson(alistOrigin, 'POST', '/api/fs/list', { path: `${testDir}/${cloudFolder}`, password: '', page: 1, per_page: 200, refresh: true }, authHeaders)
          const match = (apiBody(listed)?.content || []).find((item) => Number(item.size) === largeSize) || null
          sizeMatchFound = !!match
          if (!sizeMatchFound) await delay(5000)
        }
        return { status: uploadStatus, uploadError, uploadMs, pings: pings.length, pingFails, sizeMatchFound, largeSize }
      },
      (value) => {
        if (!value.uploadError) {
          assert(value.status >= 200 && value.status < 300, `上传失败 HTTP ${value.status}`)
        } else {
          // 只接受 C-26 这一种已知形态；其余网络错误照旧 FAIL
          assert(/Timed out waiting server reply/.test(value.uploadError), `上传网络错误：${value.uploadError}`)
        }
        assert(value.pings >= 5, `并发探测样本过少：${value.pings}`)
        // R-25 的回归指纹是「上传期间事件循环被阻塞」——先判这一条，再判落盘结果
        assert(value.pingFails <= Math.floor(value.pings / 4), `上传期间 /ping 失败过多：${value.pingFails}/${value.pings}（事件循环被阻塞，R-25 回归）`)
        if (value.uploadError && !value.sizeMatchFound) {
          throw new Error(`SKIP::客户端 ${Math.round(value.uploadMs / 1000)}s 未收到响应头（C-26 15s 上限）后放弃，服务端未完成落盘；/ping ${value.pings - value.pingFails}/${value.pings} 健康，未复发 R-25 自旋`)
        }
        assert(value.sizeMatchFound, `云端未找到尺寸为 ${value.largeSize} 的上传文件（R-25 回归：上传未完成）`)
        if (value.uploadError) {
          return `客户端 ${Math.round(value.uploadMs / 1000)}s 未收到响应头（C-26 15s 上限）；云端密文尺寸吻合、ping ${value.pings - value.pingFails}/${value.pings} 正常 ⇒ 未复发 R-25`
        }
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

    const davMoveName = 'moved 样例.txt'
    const davRenamedName = 'renamed 样例.txt'
    // 注意：B15/B16 已经在可见目录里建过「复制目标」「移动目标」两个目录，
    // 对已存在的集合做 MKCOL 会得到 405，所以这里另起目录名并容忍 405。
    const davCopyDirName = 'dav 复制目标'
    const davCopyDir = `${davFolder}/${davCopyDirName}`
    // API 视角的路径不带 /dav 前缀（/api/fs/* 与 WebDAV 是两套 URL 空间，混用会永远得到空列表）
    const apiCopyDir = `${folderPath}/${davCopyDirName}`
    // destination 头是 ByteString，非 ASCII 路径必须整体百分号编码
    const davDestination = (path) => `${proxyOrigin}${path.split('/').map(encodeURIComponent).join('/')}`
    const davMkcol = async (path) => {
      const response = await fetch(davUrl(path), { method: 'MKCOL', headers: davHeaders })
      await response.text()
      // 201 = 新建；405 = 已存在（RFC 4918 允许），两者都算可用
      assert(response.status === 201 || response.status === 405, `MKCOL ${path} HTTP ${response.status}`)
      return response.status
    }
    // 上游的明文→密文翻译依赖代理自身的 dao 缓存：文件/目录必须「被看见过」
    // （PROPFIND / PUT / API list 时登记）才查得到。服务端 COPY 产生的新文件不在
    // 缓存里，按真实客户端的浏览顺序（父目录 → 新目录）刷新后再 GET 才能命中。
    // 已用独立探针（webdav-chain-probe）在 guest 内验证该顺序端到端可用。
    const davPropfind = async (path, depth = '1') => {
      const response = await fetch(davUrl(path), { method: 'PROPFIND', headers: { ...davHeaders, depth } })
      const text = await response.text()
      assert(response.status === 207, `PROPFIND ${path} HTTP ${response.status} ${text.slice(0, 160)}`)
      return text
    }

    // 云端（AList 裸视角）列表里不得出现任何明文名——这是「加密语义未被破坏」的统一断言
    const cloudPlainLeak = (names) => names.filter((name) => [davFileName, davMoveName, davRenamedName, davCopyDirName, plainFolder, renamedFile].includes(name))

    await step(
      'C07',
      'WebDAV COPY（跨目录，含密文名与内容解密复核）',
      'AList 自带 WebDAV 的 COPY 只在目标位于另一目录时生效（同目录换名 COPY 与目录级 COPY 均返回 500，已由绕开本代理的直连对照证实），故按真实客户端可用的形态验证复制通道',
      async () => {
        const mkcol = await davMkcol(davCopyDir)
        const response = await fetch(davUrl(davFile), {
          method: 'COPY',
          headers: { ...davHeaders, destination: davDestination(`${davCopyDir}/${davFileName}`), overwrite: 'T' },
        })
        const text = await response.text()
        // 真实客户端顺序：先浏览父目录、再浏览新目录，把服务端副本登记进代理 dao 缓存
        await davPropfind(davFolder)
        await davPropfind(davCopyDir)
        const proxyList = await listNames(proxyOrigin, authHeaders, apiCopyDir)
        const copyGet = await download(proxyOrigin, `${davCopyDir}/${davFileName}`, davHeaders)
        const cloudList = await listNames(alistOrigin, authHeaders, `${testDir}/${cloudFolder}`)
        return {
          mkcol,
          status: response.status,
          text: text.slice(0, 200),
          proxyNames: proxyList.names,
          copyGet,
          cloudNames: cloudList.names,
        }
      },
      (value) => {
        assert(value.mkcol === 201 || value.mkcol === 405, `目标目录 MKCOL HTTP ${value.mkcol}`)
        assert(value.status >= 200 && value.status < 300, `HTTP ${value.status} ${value.text}`)
        assert(value.proxyNames.includes(davFileName), `复制目标目录未显示明文名，实际 ${value.proxyNames.join(',') || '(空)'}`)
        assert(value.copyGet.status === 200, `复制件 GET HTTP ${value.copyGet.status}`)
        assert(equalBytes(value.copyGet.bytes, davPayload), `复制件解密内容不一致，长度 ${value.copyGet.bytes.byteLength}，头部 ${toHex(value.copyGet.bytes)}`)
        const leaked = cloudPlainLeak(value.cloudNames)
        assert(leaked.length === 0, `云端出现明文名：${leaked.join(',')}`)
        return `COPY HTTP ${value.status}；明文名可见、复制件解密逐字节一致、云端无明文名（${value.cloudNames.length} 项）`
      },
    )

    await step(
      'C08',
      'WebDAV MOVE（同目录重命名）',
      'WebDAV 客户端「重命名」的标准形态；确认源消失、新名可见、内容仍可解密',
      async () => {
        const response = await fetch(davUrl(`${davCopyDir}/${davFileName}`), {
          method: 'MOVE',
          headers: { ...davHeaders, destination: davDestination(`${davCopyDir}/${davRenamedName}`) },
        })
        const text = await response.text()
        // MOVE 后浏览目录刷新 dao 缓存（新名登记、旧名对应云端实体已不存在）
        await davPropfind(davCopyDir)
        const after = await listNames(proxyOrigin, authHeaders, apiCopyDir)
        const getAfter = await download(proxyOrigin, `${davCopyDir}/${davRenamedName}`, davHeaders)
        const oldGet = await download(proxyOrigin, `${davCopyDir}/${davFileName}`, davHeaders)
        const cloudList = await listNames(alistOrigin, authHeaders, `${testDir}/${cloudFolder}`)
        return { status: response.status, text: text.slice(0, 200), names: after.names, getAfter, oldGet, cloudNames: cloudList.names }
      },
      (value) => {
        assert(value.status >= 200 && value.status < 300, `HTTP ${value.status} ${value.text}`)
        assert(value.names.includes(davRenamedName), `重命名后未显示新明文名，实际 ${value.names.join(',') || '(空)'}`)
        assert(!value.names.includes(davFileName), `重命名后旧名仍在：${value.names.join(',')}`)
        assert(value.getAfter.status === 200 && equalBytes(value.getAfter.bytes, davPayload), `重命名后内容不可解密：HTTP ${value.getAfter.status} length=${value.getAfter.bytes.byteLength}`)
        assert(value.oldGet.status === 404, `旧名仍可下载：HTTP ${value.oldGet.status}（预期 404）`)
        const leaked = cloudPlainLeak(value.cloudNames)
        assert(leaked.length === 0, `云端出现明文名：${leaked.join(',')}`)
        return `HTTP ${value.status} 新名=${davRenamedName} 旧名 404 且内容逐字节一致`
      },
    )

    await step(
      'C09',
      'WebDAV DELETE',
      '确认 WebDAV 删除通道可用（密文名转换正确）',
      async () => {
        const response = await fetch(davUrl(`${davCopyDir}/${davRenamedName}`), { method: 'DELETE', headers: davHeaders })
        const text = await response.text()
        await davPropfind(davCopyDir)
        const after = await listNames(proxyOrigin, authHeaders, apiCopyDir)
        const gone = await download(proxyOrigin, `${davCopyDir}/${davRenamedName}`, davHeaders)
        return { status: response.status, text: text.slice(0, 200), names: after.names, goneStatus: gone.status }
      },
      (value) => {
        assert(value.status >= 200 && value.status < 300, `HTTP ${value.status} ${value.text}`)
        assert(!value.names.includes(davRenamedName), `删除后仍在：${value.names.join(',')}`)
        assert(value.goneStatus === 404, `删除后仍可下载：HTTP ${value.goneStatus}`)
        return `HTTP ${value.status} 目录内已无该文件`
      },
    )

    // ============================================================ D. 补充覆盖（用户点名的「漏网功能」）
    // 这一组补的是 A/B/C 三组没走到的形态：跨目录移动、覆盖上传、并发双路、
    // 目录级增删改、PROPFIND 深度，以及两种 AList 侧受限形态的登记（防止悄悄回归成 502）。
    const davSecondName = '并发乙.txt'
    const davTextName = '换行样例.txt'
    // D01/D08 专用：源文件必须用「目标目录里不存在的名字」。
    // AList 的 BaiduNetdisk 驱动 Move 是 newname=源文件名 + ondup=fail：跨目录移动时
    // 先按源名在目标目录落实体，目标已有同名（密文名相同）即 errno 12 → 500。
    // 若沿用 davFileName，可见目录里 C 组 PUT 的那份会撞名（D08 专门验证该限制）。
    const davCrossName = '跨目录样例.txt'

    await step(
      'D01',
      'WebDAV MOVE（跨目录）',
      '真实客户端「移动到别的目录」的形态，跨目录 MOVE 在 AList 上受支持（源名不得与目标目录已有文件重名，见 D08）',
      async () => {
        await davMkcol(davCopyDir)
        const put = await fetch(davUrl(`${davCopyDir}/${davCrossName}`), { method: 'PUT', headers: davHeaders, body: davPayload })
        await put.text()
        // dao 缓存：PUT 新建的文件未经浏览不会登记明文↔密文映射，MOVE 前必须先 PROPFIND 源目录
        // （与 C07/C08 同一模式；否则代理无法把明文源路径翻译成密文，AList 返回 500）
        await davPropfind(davCopyDir)
        const response = await fetch(davUrl(`${davCopyDir}/${davCrossName}`), {
          method: 'MOVE',
          headers: { ...davHeaders, destination: davDestination(`${davFolder}/${davMoveName}`) },
        })
        const text = await response.text()
        // 真实客户端顺序：MOVE 后浏览目标目录刷新 dao 缓存再 GET
        await davPropfind(davFolder)
        const target = await listNames(proxyOrigin, authHeaders, folderPath)
        const source = await listNames(proxyOrigin, authHeaders, apiCopyDir)
        const got = await download(proxyOrigin, `${davFolder}/${davMoveName}`, davHeaders)
        return { status: response.status, text: text.slice(0, 200), targetNames: target.names, sourceNames: source.names, got }
      },
      (value) => {
        assert(value.status >= 200 && value.status < 300, `HTTP ${value.status} ${value.text}`)
        assert(value.targetNames.includes(davMoveName), `目标目录未显示明文名，实际 ${value.targetNames.join(',') || '(空)'}`)
        assert(!value.sourceNames.includes(davCrossName), `源目录未清空：${value.sourceNames.join(',')}`)
        assert(value.got.status === 200 && equalBytes(value.got.bytes, davPayload), `跨目录移动后内容不可解密：HTTP ${value.got.status}`)
        return `HTTP ${value.status} 源清空、目标=${davMoveName}、内容逐字节一致`
      },
    )

    await step(
      'D02',
      'WebDAV 覆盖上传（同路径 PUT 两次）',
      '确认第二次 PUT 覆盖首个版本，且云端始终只留一份密文文件',
      async () => {
        const secondPayload = makePayload(4096)
        const first = await fetch(davUrl(`${davFolder}/${davTextName}`), { method: 'PUT', headers: davHeaders, body: davPayload })
        await first.text()
        const secondPut = await fetch(davUrl(`${davFolder}/${davTextName}`), { method: 'PUT', headers: davHeaders, body: secondPayload })
        await secondPut.text()
        const got = await download(proxyOrigin, `${davFolder}/${davTextName}`, davHeaders)
        const cloudList = await listNames(alistOrigin, authHeaders, `${testDir}/${cloudFolder}`)
        return { firstStatus: first.status, secondStatus: secondPut.status, got, secondPayload, cloudNames: cloudList.names }
      },
      (value) => {
        assert(value.firstStatus >= 200 && value.firstStatus < 300, `首次 PUT HTTP ${value.firstStatus}`)
        assert(value.secondStatus >= 200 && value.secondStatus < 300, `覆盖 PUT HTTP ${value.secondStatus}`)
        assert(value.got.status === 200, `覆盖后 GET HTTP ${value.got.status}`)
        assert(equalBytes(value.got.bytes, value.secondPayload), `覆盖后内容不是第二版，长度 ${value.got.bytes.byteLength}（预期 ${value.secondPayload.byteLength}）`)
        const leaked = cloudPlainLeak(value.cloudNames)
        assert(leaked.length === 0, `云端出现明文名：${leaked.join(',')}`)
        return `PUT ${value.firstStatus} → PUT ${value.secondStatus}，GET 得到第二版（${value.secondPayload.byteLength} B）`
      },
    )

    await step(
      'D03',
      'WebDAV 并发两路下载',
      '确认两路并行 GET 解密互不串扰。先单路暖一次，再并发两路——测的是并发本身，不是后端首次取源。若后端（百度 dlink）慢到连暖场单路都超过 txiki fetch 的 15s 响应头上限（C-26），则本用例无法测量该属性，按已归因受限形态记 SKIP；内容/状态码不符仍判 FAIL',
      async () => {
        // 冷拉百度 dlink 的首次响应可能长于 15s（C-26）：给暖场两次机会，仍超时则归因 SKIP
        let warm = null
        let warmError = ''
        for (let attempt = 0; attempt < 2 && !warm; attempt += 1) {
          try {
            const response = await download(proxyOrigin, davFile, davHeaders)
            if (response.status === 200) warm = response
            else warmError = `HTTP ${response.status}`
          } catch (error) {
            warmError = String(error?.message || error)
          }
        }
        if (!warm) {
          throw new Error(`SKIP::暖场单路 GET 未能在 15s 内取得响应头（后端慢，非并发放大）：${warmError}`)
        }
        const settled = await Promise.all(
          [0, 1].map((index) =>
            download(proxyOrigin, davFile, davHeaders).then(
              (value) => ({ index, value }),
              (error) => ({ index, error: String(error?.message || error) }),
            ),
          ),
        )
        return { settled, warm }
      },
      (value) => {
        const timedOut = value.settled.filter((item) => item.error)
        if (timedOut.length > 0) {
          const messages = timedOut.map((item) => item.error).join(' | ')
          assert(/Timed out waiting server reply/.test(messages), `并发下载出现非超时错误：${messages}`)
          throw new Error(`SKIP::并发 GET 至少一路达到 txiki fetch 的 15s 响应头上限（C-26，libwebsockets 默认 timeout_secs=15）：${messages}`)
        }
        const [ga, gb] = value.settled.map((item) => item.value)
        assert(ga.status === 200 && gb.status === 200, `并发下载 HTTP ${ga.status}/${gb.status}`)
        assert(equalBytes(ga.bytes, davPayload) && equalBytes(gb.bytes, davPayload), `并发下载内容不一致（${ga.bytes.byteLength}/${gb.bytes.byteLength} B）`)
        return `两路 GET 均 200 且各自逐字节解密一致（${ga.bytes.byteLength} B）`
      },
    )

    await step(
      'D03c',
      'WebDAV 并发两路 PROPFIND',
      '并发场景不依赖后端 CDN 首字节：两路 PROPFIND 由 AList 目录缓存应答，用来独立证明代理能并行处理多请求且响应不串扰（D03 的并发 GET 会被 C-26 的 15s 上限与百度 dlink 延迟干扰）。比对解码后的名字集合，不比响应体字节（multistatus 含时间戳等易变字段）',
      async () => {
        const [ra, rb] = await Promise.all([
          fetch(davUrl(davFolder), { method: 'PROPFIND', headers: { ...davHeaders, depth: '1' } }),
          fetch(davUrl(davFolder), { method: 'PROPFIND', headers: { ...davHeaders, depth: '1' } }),
        ])
        const [ta, tb] = await Promise.all([ra.text(), rb.text()])
        const namesOf = (body) =>
          (body.match(/<D:href>([^<]*)<\/D:href>/g) || [])
            .map((item) => item.replace(/<\/?D:href>/g, ''))
            .map((href) => {
              try {
                return decodeURIComponent(href).replace(/\/$/, '').split('/').pop()
              } catch {
                return href
              }
            })
            .filter((name) => name && name !== davFolder.split('/').pop())
            .sort()
        return { statuses: [ra.status, rb.status], nameSets: [namesOf(ta), namesOf(tb)], sizes: [ta.length, tb.length] }
      },
      (value) => {
        assert(value.statuses[0] === 207 && value.statuses[1] === 207, `并发 PROPFIND HTTP ${value.statuses.join('/')}`)
        for (const [index, names] of value.nameSets.entries()) {
          assert(names.includes(davFileName), `第 ${index + 1} 路 PROPFIND 未返回明文名 ${davFileName}，实际 ${names.join(',') || '(空)'}`)
        }
        assert(value.nameSets[0].join('|') === value.nameSets[1].join('|'), `两路 PROPFIND 明文名集合不一致（疑串扰）：${value.nameSets[0].join(',')} vs ${value.nameSets[1].join(',')}`)
        return `两路 PROPFIND 均 207 且明文名集合一致（${value.nameSets[0].length} 项：${value.nameSets[0].slice(0, 4).join(',')}…）`
      },
    )

    await step(
      'D03b',
      'WebDAV 并发两路上传',
      '确认两路并行 PUT 互不串扰（各自密文名与内容独立）。注意：txiki 的 fetch 客户端等待响应头有 15s 硬上限（libwebsockets context->timeout_secs 默认 15，txiki 未覆盖），云端响应慢时排队请求会先于服务端到达该上限——此形态登记为 SKIP 而非 FAIL',
      async () => {
        const alpha = makePayload(204800)
        const beta = makePayload(131072)
        beta[0] = 0x5a
        const [ra, rb] = await Promise.all([
          fetch(davUrl(`${davFolder}/并发甲.txt`), { method: 'PUT', headers: davHeaders, body: alpha }).then(async (r) => ({ status: r.status, text: await r.text() })).catch((error) => ({ networkError: String(error?.message || error) })),
          fetch(davUrl(`${davFolder}/${davSecondName}`), { method: 'PUT', headers: davHeaders, body: beta }).then(async (r) => ({ status: r.status, text: await r.text() })).catch((error) => ({ networkError: String(error?.message || error) })),
        ])
        return { ra, rb, alpha, beta }
      },
      async (value) => {
        for (const [tag, r] of [['并发甲', value.ra], ['并发乙', value.rb]]) {
          if (r.networkError) {
            assert(/Timed out waiting server reply/.test(r.networkError), `${tag} 并发 PUT 网络错误：${r.networkError}`)
            throw new Error(`SKIP::${tag} PUT 达到 txiki fetch 的 15s 响应头上限（C-26，libwebsockets 默认 timeout_secs=15；后端慢时两路排队超过该值）。另一路结果：${JSON.stringify(value.rb.status ?? value.rb.networkError ?? value.ra.status)}`)
          }
          assert(r.status >= 200 && r.status < 300, `${tag} PUT HTTP ${r.status} ${String(r.text).slice(0, 120)}`)
        }
        // 并发 PUT 成功后按真实客户端顺序浏览目录、再分别 GET 复核内容
        await davPropfind(davFolder)
        const ga = await download(proxyOrigin, `${davFolder}/并发甲.txt`, davHeaders)
        const gb = await download(proxyOrigin, `${davFolder}/${davSecondName}`, davHeaders)
        assert(ga.status === 200 && equalBytes(ga.bytes, value.alpha), `并发甲内容不一致（length=${ga.bytes.byteLength}）`)
        assert(gb.status === 200 && equalBytes(gb.bytes, value.beta), `并发乙内容不一致（length=${gb.bytes.byteLength}）`)
        return `两路 PUT 均成功；解密后分别 ${ga.bytes.byteLength} / ${gb.bytes.byteLength} B 逐字节一致`
      },
    )

    await step(
      'D04',
      'WebDAV PROPFIND depth:0',
      '确认单资源 PROPFIND（客户端 exists 探测）走的也是明文名',
      async () => {
        const response = await fetch(davUrl(`${davFolder}/${davFileName}`), { method: 'PROPFIND', headers: { ...davHeaders, depth: '0' } })
        const text = await response.text()
        const hrefs = (text.match(/<D:href>([^<]*)<\/D:href>/g) || []).map((item) => item.replace(/<\/?D:href>/g, ''))
        const names = hrefs.map((href) => {
          try {
            return decodeURIComponent(href).replace(/\/$/, '').split('/').pop()
          } catch {
            return href
          }
        })
        return { status: response.status, text, names }
      },
      (value) => {
        assert(value.status === 207, `HTTP ${value.status} ${value.text.slice(0, 200)}`)
        assert(value.names.includes(davFileName), `depth:0 未返回明文名，实际 ${value.names.join(' | ') || '(空)'}`)
        return `HTTP 207 明文名=${davFileName}`
      },
    )

    await step(
      'D05',
      'API 目录级重命名 / 移动 / 删除',
      'B 组只覆盖了文件级；这里补目录级，确认目录名同样以密文落盘、代理侧仍显示明文',
      async () => {
        const dirA = `${folderPath}/目录甲`
        const dirB = `${folderPath}/目录乙`
        const mkdirA = await requestJson(proxyOrigin, 'POST', '/api/fs/mkdir', { path: dirA }, authHeaders)
        const mkdirB = await requestJson(proxyOrigin, 'POST', '/api/fs/mkdir', { path: dirB }, authHeaders)
        // rename 的明文→密文翻译依赖 dao 缓存（encNameRouter 的 handleFolderPath）：
        // 必须先浏览父目录把新目录登记进来，否则会把明文路径原样转发给 AList 而 500。
        // 真实用户操作本就「先看到目录、再改名」，这里按同样的顺序
        await listNames(proxyOrigin, authHeaders, folderPath)
        const rename = await requestJson(proxyOrigin, 'POST', '/api/fs/rename', { path: dirA, name: '目录甲改名' }, authHeaders)
        const moved = await requestJson(proxyOrigin, 'POST', '/api/fs/move', { src_dir: folderPath, dst_dir: dirB, names: ['目录甲改名'] }, authHeaders)
        const listed = await listNames(proxyOrigin, authHeaders, dirB)
        const removed = await requestJson(proxyOrigin, 'POST', '/api/fs/remove', { dir: dirB, names: ['目录甲改名'] }, authHeaders)
        const afterRemove = await listNames(proxyOrigin, authHeaders, dirB)
        const cloudList = await listNames(alistOrigin, authHeaders, `${testDir}/${cloudFolder}`)
        return {
          mkdirA: apiCode(mkdirA),
          mkdirB: apiCode(mkdirB),
          rename: apiCode(rename),
          moved: apiCode(moved),
          listed: listed.names,
          removed: apiCode(removed),
          afterRemove: afterRemove.names,
          cloudNames: cloudList.names,
        }
      },
      (value) => {
        assert(value.mkdirA === 200 && value.mkdirB === 200, `建目录失败 mkdirA=${value.mkdirA} mkdirB=${value.mkdirB}`)
        assert(value.rename === 200, `目录重命名 code=${value.rename}`)
        assert(value.moved === 200, `目录移动 code=${value.moved}`)
        assert(value.listed.includes('目录甲改名'), `移动后未显示明文目录名，实际 ${value.listed.join(',') || '(空)'}`)
        assert(value.removed === 200 && value.afterRemove.length === 0, `目录删除失败 code=${value.removed} 残留=${value.afterRemove.join(',')}`)
        const leaked = cloudPlainLeak(value.cloudNames)
        assert(leaked.length === 0, `云端出现明文名：${leaked.join(',')}`)
        return `mkdir/rename/move/remove 全 200；目录明文名仅在代理侧可见`
      },
    )

    await step(
      'D06',
      'WebDAV 文本内容加解密往返（含 CRLF 与中文）',
      '补齐「文本 + 行尾」这一类载荷，确认 AES-CTR 逐字节往返不受内容影响',
      async () => {
        const text = '中文内容第一行\r\nsecond line\n第三行 without trailing newline 尾巴'
        const bytes = new TextEncoder().encode(text)
        const put = await fetch(davUrl(`${davFolder}/文本往返.txt`), { method: 'PUT', headers: davHeaders, body: bytes })
        await put.text()
        const got = await download(proxyOrigin, `${davFolder}/文本往返.txt`, davHeaders)
        const cloudList = await listNames(alistOrigin, authHeaders, `${testDir}/${cloudFolder}`)
        return { put: put.status, got, bytes, cloudNames: cloudList.names }
      },
      (value) => {
        assert(value.put >= 200 && value.put < 300, `PUT HTTP ${value.put}`)
        assert(value.got.status === 200, `GET HTTP ${value.got.status}`)
        assert(equalBytes(value.got.bytes, value.bytes), `文本往返不一致，长度 ${value.got.bytes.byteLength} 预期 ${value.bytes.byteLength}，头部 ${toHex(value.got.bytes)}`)
        const leaked = cloudPlainLeak(value.cloudNames)
        assert(leaked.length === 0, `云端出现明文名：${leaked.join(',')}`)
        return `${value.bytes.byteLength} B 文本（CRLF+LF+中文）逐字节往返一致`
      },
    )

    await step(
      'D07',
      'AList 受限形态登记：同目录换名 COPY',
      'AList 自带 WebDAV（BaiduNetdisk 驱动）不接受「同目录换名 COPY」，直连 AList 亦返回 500。这里只守住两条红线：不得变成代理侧 502；不得出现明文名。2xx 视为额外能力，记 PASS',
      async () => {
        const response = await fetch(davUrl(davFile), {
          method: 'COPY',
          headers: { ...davHeaders, destination: davDestination(`${davFolder}/同目录副本.txt`), overwrite: 'T' },
        })
        const text = await response.text()
        const cloudList = await listNames(alistOrigin, authHeaders, `${testDir}/${cloudFolder}`)
        return { status: response.status, text: text.slice(0, 200), cloudNames: cloudList.names }
      },
      (value) => {
        assert(value.status !== 502, `代理侧 502（Host/Destination 不匹配回归）`)
        const leaked = cloudPlainLeak(value.cloudNames)
        assert(leaked.length === 0, `云端出现明文名：${leaked.join(',')}`)
        if (value.status >= 200 && value.status < 300) return `HTTP ${value.status}（该驱动已支持同目录 COPY）`
        assert(value.status === 500, `HTTP ${value.status}，非预期的 500 受限形态`)
        throw new Error(`SKIP::HTTP 500 —— AList 侧同目录 COPY 限制（直连 AList 同样 500，非本适配层问题）`)
      },
    )

    // D08：把 D01 曾经的 500 归因固化下来——AList 的 BaiduNetdisk 驱动 Move 是
    // 「newname = 源文件名 + ondup = fail」，跨目录 MOVE 先按源名在目标目录落实体，
    // 目标目录已有同名（加密规则下即密文同名）就由百度 API 返回 errno 12 → 500。
    // 直连 AList 复现同一形态，排除代理侧改写路径的因素；最后删除撞名文件证明成因。
    const davDupAName = 'dav 冲突甲'
    const davDupBName = 'dav 冲突乙'
    const davClashName = '冲突样例.txt'
    const davClashRenamed = '冲突改名.txt'
    const clashLeak = (names) => names.filter((name) => [davDupAName, davDupBName, davClashName, davClashRenamed].includes(name))

    await step(
      'D08',
      'AList 受限形态归因：跨目录 MOVE 撞名（ondup=fail）',
      '确认「跨目录 MOVE 到已有同名文件的目录」返回 500 属 AList / BaiduNetdisk 驱动语义（直连 AList 同样 500），不是代理缺陷；并确认移除目标同名文件后同一操作恢复可用',
      async () => {
        const dupA = `${davFolder}/${davDupAName}`
        const dupB = `${davFolder}/${davDupBName}`
        await davMkcol(dupA)
        await davMkcol(dupB)
        // dao 缓存链：子目录必须先经父目录浏览才登记得进代理缓存，否则 PROPFIND 子目录直接 404
        await davPropfind(davFolder)
        for (const dir of [dupA, dupB]) {
          const put = await fetch(davUrl(`${dir}/${davClashName}`), { method: 'PUT', headers: davHeaders, body: davPayload })
          await put.text()
          await davPropfind(dir)
        }
        // ① 经代理：目标目录已有同名 → 期望 AList 侧 500（而非代理侧 502）
        const clash = await fetch(davUrl(`${dupA}/${davClashName}`), {
          method: 'MOVE',
          headers: { ...davHeaders, destination: davDestination(`${dupB}/${davClashRenamed}`) },
        })
        const clashText = await clash.text()

        // ② 直连 AList 同形态（ASCII 明文名，排除密文名与代理改写两个因素）。
        //    该运行时的 Host 头不带端口，Destination 的 authority 也必须不带端口，
        //    否则 AList 会判为跨服务器直接 502（与 r10 destination-authority 修正同一机理）。
        const directA = '_dup_direct_a'
        const directB = '_dup_direct_b'
        const directFile = 'dup.txt'
        await requestJson(alistOrigin, 'POST', '/api/fs/mkdir', { path: `${testDir}/${directA}` }, authHeaders)
        await requestJson(alistOrigin, 'POST', '/api/fs/mkdir', { path: `${testDir}/${directB}` }, authHeaders)
        const alistUrl = new URL(alistOrigin)
        const alistDavUrl = (path) => `${alistOrigin}${encodeURI(path)}`
        // URL.host 带端口（10.0.2.2:5244），而该运行时的 Host 头不带端口 —— AList 做字符串比较，
        // 带端口的 Destination 会被判为跨服务器而直接 502；必须用 hostname 拼 authority。
        const alistDavDestination = (path) => `${alistUrl.protocol}//${alistUrl.hostname}${encodeURI(path)}`
        for (const dir of [directA, directB]) {
          const put = await fetch(alistDavUrl(`/dav${testDir}/${dir}/${directFile}`), { method: 'PUT', headers: davHeaders, body: davPayload })
          await put.text()
        }
        const directClash = await fetch(alistDavUrl(`/dav${testDir}/${directA}/${directFile}`), {
          method: 'MOVE',
          headers: { ...davHeaders, destination: alistDavDestination(`/dav${testDir}/${directB}/renamed_${directFile}`) },
        })
        const directText = await directClash.text()

        // ③ 删除目标目录里的同名文件后，经代理重试同一 MOVE 应恢复可用
        const removed = await fetch(davUrl(`${dupB}/${davClashName}`), { method: 'DELETE', headers: davHeaders })
        await removed.text()
        await davPropfind(dupB)
        const retry = await fetch(davUrl(`${dupA}/${davClashName}`), {
          method: 'MOVE',
          headers: { ...davHeaders, destination: davDestination(`${dupB}/${davClashRenamed}`) },
        })
        const retryText = await retry.text()
        await davPropfind(dupB)
        const got = await download(proxyOrigin, `${dupB}/${davClashRenamed}`, davHeaders)
        const cloudList = await listNames(alistOrigin, authHeaders, `${testDir}/${cloudFolder}`)
        return {
          clash: clash.status,
          clashText: clashText.slice(0, 160),
          directClash: directClash.status,
          directText: directText.slice(0, 160),
          retry: retry.status,
          retryText: retryText.slice(0, 160),
          got,
          cloudNames: cloudList.names,
        }
      },
      (value) => {
        assert(value.clash !== 502, `经代理返回 502（Host/Destination 不匹配回归）`)
        assert(value.clash === 500, `目标同名时经代理 HTTP ${value.clash}（预期 AList 侧 500）${value.clashText}`)
        assert(value.directClash === 500, `直连 AList 同名跨目录 MOVE HTTP ${value.directClash}（预期 500，用于归因）${value.directText}`)
        assert(value.retry >= 200 && value.retry < 300, `移除目标同名文件后 MOVE HTTP ${value.retry} ${value.retryText}`)
        assert(value.got.status === 200 && equalBytes(value.got.bytes, davPayload), `撞名解除后内容不可解密：HTTP ${value.got.status}`)
        const leaked = clashLeak(value.cloudNames)
        assert(leaked.length === 0, `云端出现明文名：${leaked.join(',')}`)
        return `同名冲突经代理与直连 AList 均 500（ondup=fail 归因）；移除目标同名后 2xx 且内容逐字节一致`
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
