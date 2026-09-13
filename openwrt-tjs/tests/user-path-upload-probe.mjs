const env = typeof tjs === 'undefined' ? process.env : tjs.env
const proxyOrigin = (env.PROXY_ORIGIN || 'http://127.0.0.1:5344').replace(/\/$/, '')
const alistOrigin = (env.ALIST_ORIGIN || 'http://127.0.0.1:5244').replace(/\/$/, '')
const appPassword = env.APP_PASSWORD || '123456'
const alistPassword = env.ALIST_PASSWORD || ''
const encoder = new TextEncoder()

if (!alistPassword) {
  throw new Error('ALIST_PASSWORD is required')
}

async function responseJson(response) {
  const text = await response.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {}
  return { response, text, data }
}

async function request(origin, path, options = {}) {
  return await responseJson(await fetch(`${origin}${path}`, options))
}

async function post(origin, path, body, token) {
  return await request(origin, path, {
    method: 'POST',
    headers: { authorization: token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function apiCode(result) {
  return result.data?.code ?? null
}

function content(result) {
  return result.data?.data?.content || []
}

async function remove(origin, dir, names, token) {
  return await post(origin, '/api/fs/remove', { dir, names }, token)
}

async function sleep(time) {
  await new Promise((resolve) => setTimeout(resolve, time))
}

async function run() {
  const appLogin = await request(proxyOrigin, '/enc-api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: appPassword }),
  })
  const appToken = appLogin.data?.data?.jwtToken
  if (!appToken) throw new Error(`application login failed: HTTP ${appLogin.response.status}`)

  const currentConfigResult = await request(proxyOrigin, '/enc-api/getAlistConfig', {
    method: 'POST',
    headers: { authorizetoken: appToken },
  })
  const currentConfig = currentConfigResult.data?.data
  if (!currentConfig) throw new Error('application config is unavailable')

  const alistUrl = new URL(alistOrigin)

  const testConfig = JSON.parse(JSON.stringify(currentConfig))
  const rule = testConfig.passwdList[0]
  if (!rule) throw new Error('the application has no password rule')
  testConfig.serverHost = alistUrl.hostname
  testConfig.serverPort = alistUrl.port || (alistUrl.protocol === 'https:' ? '443' : '80')
  testConfig.https = alistUrl.protocol === 'https:'
  rule.encPath = [env.TEST_RULE_PATH || '/会员//ARM/.*']
  rule.encName = true
  rule.encFolder = env.TEST_ENC_FOLDER === 'true'

  const stamp = Date.now()
  const folder = `_codex_rule_probe_${stamp}`
  const file = `${folder}.txt`
  const folderPath = `/会员/ARM/${folder}`
  const filePath = `${folderPath}/${file}`
  const payload = encoder.encode('txiki correct rule probe 0123456789')
  let createdFolder = false
  let uploaded = false
  let alistToken = ''
  let cloudRootBefore = null
  const result = { rule: rule.encPath, encName: rule.encName, encFolder: rule.encFolder, folderPath, filePath }

  let runError = null
  try {
    const saved = await request(proxyOrigin, '/enc-api/saveAlistConfig', {
      method: 'POST',
      headers: { authorizetoken: appToken, 'content-type': 'application/json' },
      body: JSON.stringify(testConfig),
    })
    if (saved.response.status !== 200 || apiCode(saved) !== 200) throw new Error('temporary config save failed')
    const applied = await request(proxyOrigin, '/enc-api/getAlistConfig', {
      method: 'POST',
      headers: { authorizetoken: appToken },
    })
    console.log(JSON.stringify({ applied: applied.data?.data ? { serverHost: applied.data.data.serverHost, serverPort: applied.data.data.serverPort, encPath: applied.data.data.passwdList?.[0]?.encPath } : null }))

    const alistLogin = await request(proxyOrigin, '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: alistPassword }),
    })
    alistToken = alistLogin.data?.data?.token
    if (!alistToken) throw new Error(`AList login failed: HTTP ${alistLogin.response.status}`)

    cloudRootBefore = await post(alistOrigin, '/api/fs/list', { path: '/会员/ARM', page: 1, per_page: 100, refresh: true }, alistToken)

    const mkdir = await post(proxyOrigin, '/api/fs/mkdir', { path: folderPath }, alistToken)
    createdFolder = mkdir.response.status >= 200 && mkdir.response.status < 300 && apiCode(mkdir) === 200
    const upload = await request(proxyOrigin, '/api/fs/put', {
      method: 'PUT',
      headers: {
        authorization: alistToken,
        'content-type': 'application/octet-stream',
        'content-length': String(payload.byteLength),
        'file-path': encodeURIComponent(filePath),
      },
      body: payload,
    })
    uploaded = upload.response.status >= 200 && upload.response.status < 300 && apiCode(upload) === 200
    result.mkdir = { status: mkdir.response.status, code: apiCode(mkdir), message: mkdir.data?.message || mkdir.data?.msg }
    result.upload = { status: upload.response.status, code: apiCode(upload), message: upload.data?.message || upload.data?.msg }

    await sleep(1000)
    const proxyRoot = await post(proxyOrigin, '/api/fs/list', { path: '/会员/ARM', page: 1, per_page: 100, refresh: true }, alistToken)
    const proxyFolder = await post(proxyOrigin, '/api/fs/list', { path: folderPath, page: 1, per_page: 100, refresh: true }, alistToken)
    const cloudRoot = await post(alistOrigin, '/api/fs/list', { path: '/会员/ARM', page: 1, per_page: 100, refresh: true }, alistToken)
    const proxyFolderItem = content(proxyRoot).find((item) => item.name === folder)
    const previousCloudPaths = new Set(content(cloudRootBefore).map((item) => item.path))
    const cloudFolderItem = content(cloudRoot).find((item) => item.is_dir && !previousCloudPaths.has(item.path))
    let cloudFileItem = null
    let raw = null
    let cloudGet = null
    let cloudFolder = null
    if (cloudFolderItem) {
      const cloudFolderPaths = [cloudFolderItem.path, `/会员${cloudFolderItem.path}`, folderPath]
      for (const cloudFolderPath of cloudFolderPaths) {
        cloudFolder = await post(alistOrigin, '/api/fs/list', { path: cloudFolderPath, page: 1, per_page: 100, refresh: true }, alistToken)
        if (content(cloudFolder).length) break
      }
      cloudFileItem = content(cloudFolder).find((item) => !item.is_dir)
      if (cloudFileItem) {
        cloudGet = await post(alistOrigin, '/api/fs/get', { path: cloudFileItem.path }, alistToken)
        if (apiCode(cloudGet) !== 200) {
          cloudGet = await post(alistOrigin, '/api/fs/get', { path: `/会员/ARM/${cloudFolderItem.name}/${cloudFileItem.name}` }, alistToken)
        }
        const rawUrl = cloudGet.data?.data?.raw_url
        if (rawUrl) {
          const rawUrlInfo = new URL(rawUrl, alistOrigin)
          const alistUrlInfo = new URL(alistOrigin)
          if (rawUrlInfo.hostname === 'localhost' || rawUrlInfo.hostname === '127.0.0.1') {
            rawUrlInfo.hostname = alistUrlInfo.hostname
            rawUrlInfo.port = alistUrlInfo.port
          }
          const rawResponse = await fetch(`${alistOrigin}${rawUrlInfo.pathname}${rawUrlInfo.search}`)
          const bytes = new Uint8Array(await rawResponse.arrayBuffer())
          raw = { status: rawResponse.status, byteLength: bytes.byteLength, hex: Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('') }
        }
      }
    }
    const proxyFileItem = content(proxyFolder).find((item) => !item.is_dir)
    result.proxyFolderItem = proxyFolderItem ? { name: proxyFolderItem.name, path: proxyFolderItem.path, is_dir: proxyFolderItem.is_dir } : null
    result.proxyFileItem = proxyFileItem ? { name: proxyFileItem.name, path: proxyFileItem.path, size: proxyFileItem.size } : null
    result.cloudFolderItem = cloudFolderItem ? { name: cloudFolderItem.name, path: cloudFolderItem.path, is_dir: cloudFolderItem.is_dir } : null
    result.cloudFolderContent = (cloudFolder ? content(cloudFolder) : []).map((item) => ({ name: item.name, path: item.path, is_dir: item.is_dir, size: item.size }))
    result.cloudFileItem = cloudFileItem ? { name: cloudFileItem.name, path: cloudFileItem.path, size: cloudFileItem.size } : null
    result.cloudGet = cloudGet ? { status: cloudGet.response.status, code: apiCode(cloudGet), hasRawUrl: Boolean(cloudGet.data?.data?.raw_url) } : null
    result.raw = raw
    result.plainHex = Array.from(payload, (value) => value.toString(16).padStart(2, '0')).join('')
  } catch (error) {
    runError = error
  } finally {
    try {
      if (uploaded) {
        const proxyFolder = await post(proxyOrigin, '/api/fs/list', { path: folderPath, page: 1, per_page: 100, refresh: true }, alistToken)
        const proxyFileItem = content(proxyFolder).find((item) => !item.is_dir)
        if (proxyFileItem) await remove(proxyOrigin, folderPath, [proxyFileItem.name], alistToken)
      }
      if (createdFolder) await remove(proxyOrigin, '/会员/ARM', [folder], alistToken)
    } catch {}
    try {
      await request(proxyOrigin, '/enc-api/saveAlistConfig', {
        method: 'POST',
        headers: { authorizetoken: appToken, 'content-type': 'application/json' },
        body: JSON.stringify(currentConfig),
      })
    } catch {}
  }

  if (runError) result.error = String(runError && runError.stack ? runError.stack : runError)
  console.log(JSON.stringify({ ok: !runError, result, restored: true }))
}

await run()
