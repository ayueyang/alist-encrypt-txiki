import FlowEnc from '../../node-proxy/src/utils/flowEnc'
import { encodeName } from '../../node-proxy/src/utils/commonUtil'

const proxyOrigin = (tjs.env.PROXY_ORIGIN || 'http://127.0.0.1:5344').replace(/\/$/, '')
const alistOrigin = (tjs.env.ALIST_ORIGIN || 'http://10.0.2.2:15244').replace(/\/$/, '')
const appPassword = tjs.env.APP_PASSWORD || '123456'
const alistUsername = tjs.env.ALIST_USERNAME || ''
const alistPassword = tjs.env.ALIST_PASSWORD || ''
const rootPath = tjs.env.ALIST_TEST_ROOT || '/会员'
const encoder = new TextEncoder()

if (!alistUsername || !alistPassword) {
  throw new Error('ALIST_USERNAME and ALIST_PASSWORD are required')
}

function equalBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false
  for (let i = 0; i < left.byteLength; i++) {
    if (left[i] !== right[i]) return false
  }
  return true
}

async function apiRequest(origin, name, path, body, headers = {}) {
  console.log(`WEBDAV_STEP ${name}`)
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {}
  return { status: response.status, data, text }
}

async function davRequest(name, method, path, headers = {}, body) {
  console.log(`WEBDAV_STEP ${name}`)
  let response = await fetch(`${proxyOrigin}${encodeURI(path)}`, {
    method,
    headers,
    body,
    redirect: 'manual',
  })
  if (method === 'GET' && response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')
    console.log(`WEBDAV_REDIRECT status=${response.status} location=${location}`)
    response = await fetch(`${proxyOrigin}${location}`, { method: 'GET', headers, redirect: 'manual' })
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  return { status: response.status, headers: response.headers, bytes, text: new TextDecoder().decode(bytes) }
}

async function collect(stream) {
  const reader = stream.getReader()
  const chunks = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    length += value.byteLength
  }
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

async function encryptedBytes(password, encType, payload) {
  const flowEnc = new FlowEnc(password, encType, payload.byteLength)
  const input = new ReadableStream({
    start(controller) {
      controller.enqueue(payload)
      controller.close()
    },
  })
  return await collect(input.pipeThrough(flowEnc.encryptTransform().stream))
}

function assertDav(name, result, statuses) {
  if (!statuses.includes(result.status)) {
    throw new Error(`${name} failed: HTTP ${result.status}, response ${result.text.slice(0, 200)}`)
  }
}

const password = tjs.env.TEST_ENCRYPT_PASSWORD || 'openwrt-webdav-password'
const encType = 'aesctr'
const testName = `_codex_openwrt_webdav_${Date.now()}`
const sourceFolder = '源目录'
const copyFolder = '复制目录'
const moveFolder = '移动目录'
const plainFile = 'webdav 中文.txt'
const copiedFile = 'copied 中文.txt'
const testPath = `${rootPath}/${testName}`
const davBase = `/dav${testPath}`
const sourceDav = `${davBase}/${sourceFolder}`
const copyDav = `${davBase}/${copyFolder}`
const moveDav = `${davBase}/${moveFolder}`
const sourceFileDav = `${sourceDav}/${plainFile}`
const copyFileDav = `${copyDav}/${copiedFile}`
const moveFileDav = `${moveDav}/${copiedFile}`
const payload = encoder.encode('alist-encrypt txiki.js WebDAV payload 0123456789')
const basicAuthorization = `Basic ${btoa(`${alistUsername}:${alistPassword}`)}`
const davHeaders = { authorization: basicAuthorization }
const propfindBody = '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>'
const results = []
let appToken = ''
let alistToken = ''
let originalConfig = null
let configured = false
let rootCreated = false

try {
  const appLogin = await apiRequest(proxyOrigin, 'application login', '/enc-api/login', { username: 'admin', password: appPassword })
  appToken = appLogin.data?.data?.jwtToken || ''
  if (!appToken) throw new Error(`application login failed: HTTP ${appLogin.status}`)
  const appHeaders = { authorizetoken: appToken }

  const configResult = await apiRequest(proxyOrigin, 'read application config', '/enc-api/getAlistConfig', undefined, appHeaders)
  originalConfig = configResult.data?.data
  if (!originalConfig) throw new Error('application config is missing')

  const alistUrl = new URL(alistOrigin)
  const testConfig = {
    ...originalConfig,
    serverHost: alistUrl.hostname,
    serverPort: alistUrl.port || (alistUrl.protocol === 'https:' ? '443' : '80'),
    https: alistUrl.protocol === 'https:',
    passwdList: [{
      id: 'openwrt-webdav-e2e',
      password,
      describe: 'OpenWrt WebDAV e2e',
      encType,
      enable: true,
      encName: true,
      encFolder: true,
      encSuffix: '',
      encPath: [`${testName}/.*`],
    }],
  }
  const saveConfig = await apiRequest(proxyOrigin, 'save WebDAV e2e config', '/enc-api/saveAlistConfig', testConfig, appHeaders)
  if (saveConfig.data?.code !== 200) throw new Error(`save config failed: ${saveConfig.text}`)
  configured = true

  const alistLogin = await apiRequest(proxyOrigin, 'AList login through proxy', '/api/auth/login', {
    username: alistUsername,
    password: alistPassword,
  })
  console.log(JSON.stringify({
    name: 'AList login response shape',
    status: alistLogin.status,
    topLevelKeys: alistLogin.data ? Object.keys(alistLogin.data) : [],
    dataKeys: alistLogin.data?.data ? Object.keys(alistLogin.data.data) : [],
    apiCode: alistLogin.data?.code ?? null,
    apiMessage: alistLogin.data?.message || alistLogin.data?.msg || null,
    responseLength: alistLogin.text.length,
  }))
  alistToken = alistLogin.data?.data?.token || ''
  if (!alistToken) throw new Error('AList token is missing')
  const alistHeaders = { authorization: alistToken }

  const rootMkcol = await davRequest('MKCOL test root', 'MKCOL', davBase, davHeaders)
  assertDav('MKCOL test root', rootMkcol, [201])
  rootCreated = true
  results.push({ method: 'MKCOL', path: davBase, status: rootMkcol.status })

  for (const [name, path] of [['source', sourceDav], ['copy', copyDav], ['move', moveDav]]) {
    const result = await davRequest(`MKCOL ${name} folder`, 'MKCOL', path, davHeaders)
    assertDav(`MKCOL ${name} folder`, result, [201])
    results.push({ method: 'MKCOL', path, status: result.status })
  }

  const put = await davRequest('PUT encrypted file', 'PUT', sourceFileDav, {
    ...davHeaders,
    'content-type': 'application/octet-stream',
  }, payload)
  assertDav('PUT encrypted file', put, [201, 204])
  results.push({ method: 'PUT', status: put.status, byteLength: payload.byteLength })

  const propfind = await davRequest('PROPFIND source folder', 'PROPFIND', `${sourceDav}/`, {
    ...davHeaders,
    depth: '1',
    'content-type': 'application/xml',
  }, propfindBody)
  assertDav('PROPFIND source folder', propfind, [207])
  const decodedPropfind = decodeURIComponent(propfind.text.replace(/\+/g, '%20'))
  if (!decodedPropfind.includes(plainFile)) throw new Error('PROPFIND did not expose the plaintext file name')
  results.push({ method: 'PROPFIND', status: propfind.status, plaintextName: true })

  const get = await davRequest('GET decrypted file', 'GET', sourceFileDav, davHeaders)
  assertDav('GET decrypted file', get, [200])
  if (!equalBytes(get.bytes, payload)) throw new Error('WebDAV GET plaintext mismatch')
  results.push({ method: 'GET', status: get.status, matchesPlaintext: true })

  const head = await fetch(`${proxyOrigin}${encodeURI(sourceFileDav)}`, { method: 'HEAD', headers: davHeaders })
  console.log(JSON.stringify({
    name: 'WebDAV HEAD response',
    status: head.status,
    headers: Object.fromEntries(head.headers),
  }))
  if (head.status !== 200 || (await head.text()) !== '') throw new Error(`WebDAV HEAD failed: HTTP ${head.status}`)
  results.push({ method: 'HEAD', status: head.status, contentLength: head.headers.get('content-length') })

  const encodedSourceFolder = encodeName(password, encType, sourceFolder)
  const encodedFile = `${encodeName(password, encType, plainFile)}.txt`
  const cloudList = await apiRequest(alistOrigin, 'inspect encrypted cloud file', '/api/fs/list', {
    path: `${testPath}/${encodedSourceFolder}`,
    password: '',
    page: 1,
    per_page: 100,
    refresh: true,
  }, alistHeaders)
  const cloudFile = cloudList.data?.data?.content?.find((item) => item.name === encodedFile)
  if (!cloudFile) throw new Error('WebDAV cloud file name is not encrypted')

  const cloudGet = await apiRequest(alistOrigin, 'get encrypted cloud download', '/api/fs/get', {
    path: `${testPath}/${encodedSourceFolder}/${encodedFile}`,
  }, alistHeaders)
  const rawUrl = cloudGet.data?.data?.raw_url
  if (!rawUrl) throw new Error('WebDAV cloud raw_url is missing')
  const rawPath = new URL(rawUrl).pathname + new URL(rawUrl).search
  const rawResponse = await fetch(`${alistOrigin}${rawPath}`)
  const rawBytes = new Uint8Array(await rawResponse.arrayBuffer())
  const expectedCipher = await encryptedBytes(password, encType, payload)
  if (!equalBytes(rawBytes, expectedCipher)) throw new Error('WebDAV cloud ciphertext mismatch')
  results.push({ check: 'cloud ciphertext', status: rawResponse.status, matchesExpectedCipher: true })

  const copy = await davRequest('COPY encrypted file', 'COPY', sourceFileDav, {
    ...davHeaders,
    destination: encodeURI(`${proxyOrigin}${copyFileDav}`),
    overwrite: 'T',
  })
  assertDav('COPY encrypted file', copy, [201, 204])
  results.push({ method: 'COPY', status: copy.status })

  const move = await davRequest('MOVE encrypted file', 'MOVE', copyFileDav, {
    ...davHeaders,
    destination: encodeURI(`${proxyOrigin}${moveFileDav}`),
    overwrite: 'T',
  })
  assertDav('MOVE encrypted file', move, [201, 204])
  results.push({ method: 'MOVE', status: move.status })

  const movedGet = await davRequest('GET moved decrypted file', 'GET', moveFileDav, davHeaders)
  assertDav('GET moved decrypted file', movedGet, [200])
  if (!equalBytes(movedGet.bytes, payload)) throw new Error('WebDAV moved file plaintext mismatch')

  for (const [name, path] of [
    ['moved file', moveFileDav],
    ['source file', sourceFileDav],
    ['source folder', sourceDav],
    ['copy folder', copyDav],
    ['move folder', moveDav],
    ['test root', davBase],
  ]) {
    const result = await davRequest(`DELETE ${name}`, 'DELETE', path, davHeaders)
    assertDav(`DELETE ${name}`, result, [200, 204])
    results.push({ method: 'DELETE', path, status: result.status })
  }
  rootCreated = false
} finally {
  if (rootCreated && alistToken) {
    try {
      await apiRequest(alistOrigin, 'cleanup WebDAV test root', '/api/fs/remove', {
        dir: rootPath,
        names: [testName],
      }, { authorization: alistToken })
    } catch {}
  }
  if (configured && appToken && originalConfig) {
    try {
      await apiRequest(proxyOrigin, 'restore application config', '/enc-api/saveAlistConfig', originalConfig, { authorizetoken: appToken })
    } catch {}
  }
}

console.log(JSON.stringify({ ok: true, proxyOrigin, alistOrigin, testPath, tests: results }))
tjs.exit(0)
