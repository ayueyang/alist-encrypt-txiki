import FlowEnc from '../../node-proxy/src/utils/flowEnc'
import { encodeName } from '../../node-proxy/src/utils/commonUtil'

const proxyOrigin = (tjs.env.PROXY_ORIGIN || 'http://127.0.0.1:5344').replace(/\/$/, '')
const alistOrigin = (tjs.env.ALIST_ORIGIN || 'http://10.0.2.100').replace(/\/$/, '')
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

async function request(origin, name, method, path, body, headers = {}) {
  console.log(`E2E_STEP ${name}`)
  const options = { method, headers: { ...headers } }
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json'
    options.body = JSON.stringify(body)
  }
  const response = await fetch(`${origin}${path}`, options)
  const text = await response.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {}
  return { name, status: response.status, data, text }
}

async function download(origin, path, headers = {}) {
  console.log(`E2E_STEP download ${path.split('?')[0]}`)
  const response = await fetch(`${origin}${path}`, { headers })
  return {
    status: response.status,
    headers: response.headers,
    bytes: new Uint8Array(await response.arrayBuffer()),
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function apiCode(result) {
  return result.data?.code ?? null
}

function apiData(result) {
  return result.data?.data ?? null
}

function getToken(result) {
  return result.data?.data?.token || result.data?.token || ''
}

function findContent(result, name) {
  return apiData(result)?.content?.find((item) => item.name === name)
}

async function assertRequest(results, origin, name, method, path, body, headers, expectedCode = 200) {
  const result = await request(origin, name, method, path, body, headers)
  const apiMessage = result.data?.message || result.data?.msg || null
  results.push({ name, status: result.status, apiCode: apiCode(result), apiMessage })
  if (result.status < 200 || result.status >= 300 || (result.data && apiCode(result) !== expectedCode)) {
    throw new Error(`${name} failed: HTTP ${result.status}, API ${apiCode(result)}, message ${apiMessage}`)
  }
  return result
}

const password = tjs.env.TEST_ENCRYPT_PASSWORD || 'openwrt-e2e-password'
const encType = 'aesctr'
const plainDir = `_codex_openwrt_e2e_${Date.now()}`
const destDir = `${plainDir}_dest`
const moveDir = `${plainDir}_move`
const plainFolder = '可见目录'
const plainFile = '中文 sample.txt'
const renamedFile = 'renamed 文件.txt'
const testDir = `${rootPath}/${plainDir}`
const destPath = `${rootPath}/${destDir}`
const movePath = `${rootPath}/${moveDir}`
const folderPath = `${testDir}/${plainFolder}`
const filePath = `${folderPath}/${plainFile}`
const payload = encoder.encode('alist-encrypt txiki.js real proxy payload 0123456789')
const results = []
let appToken = ''
let alistToken = ''
let originalConfig = null
let configured = false
let createdDir = false
let createdDestDir = false
let createdMoveDir = false
let createdFolder = false
let fileExists = false
let renamedExists = false
let movedExists = false

try {
  const appLogin = await request(proxyOrigin, 'application login', 'POST', '/enc-api/login', {
    username: 'admin',
    password: appPassword,
  })
  appToken = appLogin.data?.data?.jwtToken || ''
  results.push({ name: appLogin.name, status: appLogin.status, code: apiCode(appLogin), tokenReceived: Boolean(appToken) })
  if (!appToken) throw new Error(`application login failed: HTTP ${appLogin.status}`)

  const appHeaders = { authorizetoken: appToken }
  const configResult = await request(proxyOrigin, 'read application config', 'POST', '/enc-api/getAlistConfig', undefined, appHeaders)
  originalConfig = configResult.data?.data
  results.push({ name: configResult.name, status: configResult.status, code: apiCode(configResult), configReceived: Boolean(originalConfig) })
  if (!originalConfig) throw new Error(`read application config failed: HTTP ${configResult.status}`)

  const alistUrl = new URL(alistOrigin)
  const testConfig = {
    ...originalConfig,
    serverHost: alistUrl.hostname,
    serverPort: alistUrl.port || (alistUrl.protocol === 'https:' ? '443' : '80'),
    https: alistUrl.protocol === 'https:',
    passwdList: [{
      password,
      describe: 'OpenWrt e2e',
      encType,
      enable: true,
      encName: true,
      encFolder: true,
      encSuffix: '',
      encPath: [`${plainDir}/.*`, `${destDir}/.*`, `${moveDir}/.*`],
    }],
  }
  await assertRequest(results, proxyOrigin, 'save e2e application config', 'POST', '/enc-api/saveAlistConfig', testConfig, appHeaders)
  configured = true

  const alistLogin = await request(proxyOrigin, 'AList login through proxy', 'POST', '/api/auth/login', {
    username: alistUsername,
    password: alistPassword,
  })
  alistToken = getToken(alistLogin)
  results.push({ name: alistLogin.name, status: alistLogin.status, apiCode: apiCode(alistLogin), tokenReceived: Boolean(alistToken) })
  if (!alistToken) throw new Error(`AList login through proxy failed: HTTP ${alistLogin.status}`)
  const authHeaders = { authorization: alistToken }

  const rootList = await assertRequest(results, proxyOrigin, 'list encrypted root through proxy', 'POST', '/api/fs/list', {
    path: rootPath,
    password: '',
    page: 1,
    per_page: 100,
    refresh: true,
  }, authHeaders)
  if (!apiData(rootList)) throw new Error('encrypted root list has no data')

  await assertRequest(results, proxyOrigin, 'create isolated test directory through proxy', 'POST', '/api/fs/mkdir', { path: testDir }, authHeaders)
  createdDir = true
  await assertRequest(results, proxyOrigin, 'create copy destination through proxy', 'POST', '/api/fs/mkdir', { path: destPath }, authHeaders)
  createdDestDir = true
  await assertRequest(results, proxyOrigin, 'create move destination through proxy', 'POST', '/api/fs/mkdir', { path: movePath }, authHeaders)
  createdMoveDir = true

  await assertRequest(results, proxyOrigin, 'create encrypted child directory through proxy', 'POST', '/api/fs/mkdir', { path: folderPath }, authHeaders)
  createdFolder = true

  const emptyList = await assertRequest(results, proxyOrigin, 'list encrypted directory through proxy', 'POST', '/api/fs/list', {
    path: folderPath,
    password: '',
    page: 1,
    per_page: 100,
    refresh: true,
  }, authHeaders)
  if ((apiData(emptyList)?.content || []).length !== 0) throw new Error('new encrypted directory is not empty')

  const uploadResponse = await fetch(`${proxyOrigin}/api/fs/put`, {
    method: 'PUT',
    headers: {
    ...authHeaders,
    'content-type': 'application/octet-stream',
    'file-path': encodeURIComponent(filePath),
    },
    body: payload,
  })
  console.log('E2E_STEP encrypted upload response')
  const uploadText = await uploadResponse.text()
  let uploadData = null
  try {
    uploadData = JSON.parse(uploadText)
  } catch {}
  const uploadResult = { name: 'encrypted upload through proxy', status: uploadResponse.status, apiCode: uploadData?.code ?? null, byteLength: payload.byteLength, responsePreview: uploadText.slice(0, 160) }
  results.push(uploadResult)
  console.log(JSON.stringify(uploadResult))
  if (uploadResponse.status < 200 || uploadResponse.status >= 300 || uploadData?.code !== 200) {
    throw new Error(`encrypted upload failed: HTTP ${uploadResponse.status}, API ${uploadData?.code}, response ${uploadText.slice(0, 160)}`)
  }
  fileExists = true

  const encodedFolder = encodeName(password, encType, plainFolder)
  const encodedFile = `${encodeName(password, encType, plainFile)}.txt`
  const cloudDirList = await assertRequest(results, alistOrigin, 'list encrypted cloud directory', 'POST', '/api/fs/list', {
    path: testDir,
    password: '',
    page: 1,
    per_page: 100,
    refresh: true,
  }, authHeaders)
  if (!findContent(cloudDirList, encodedFolder)) throw new Error('cloud directory name is not encrypted as expected')

  const cloudFileList = await assertRequest(results, alistOrigin, 'list encrypted cloud file', 'POST', '/api/fs/list', {
    path: `${testDir}/${encodedFolder}`,
    password: '',
    page: 1,
    per_page: 100,
    refresh: true,
  }, authHeaders)
  results.push({
    name: 'inspect encrypted cloud names',
    expectedName: encodedFile,
    actualNames: (apiData(cloudFileList)?.content || []).map((item) => item.name),
  })
  const cloudFile = findContent(cloudFileList, encodedFile)
  if (!cloudFile) {
    throw new Error(`cloud file name is not encrypted as expected: expected ${encodedFile}, actual ${(apiData(cloudFileList)?.content || []).map((item) => item.name).join(',')}`)
  }

  const cloudGet = await assertRequest(results, alistOrigin, 'get encrypted cloud download', 'POST', '/api/fs/get', {
    path: `${testDir}/${encodedFolder}/${encodedFile}`,
  }, authHeaders)
  const cloudRawUrl = apiData(cloudGet)?.raw_url
  if (!cloudRawUrl) throw new Error('cloud raw_url is missing')
  const cloudUrl = new URL(cloudRawUrl)
  const rawDownload = await download(alistOrigin, cloudUrl.pathname + cloudUrl.search)
  const expectedCipher = await encryptedBytes(password, encType, payload)
  results.push({ name: 'cloud ciphertext byte comparison', status: rawDownload.status, byteLength: rawDownload.bytes.byteLength, matchesExpectedCipher: equalBytes(rawDownload.bytes, expectedCipher) })
  if (rawDownload.status < 200 || rawDownload.status >= 300 || !equalBytes(rawDownload.bytes, expectedCipher)) {
    throw new Error(`cloud ciphertext mismatch: HTTP ${rawDownload.status}, bytes ${rawDownload.bytes.byteLength}`)
  }

  const proxyList = await assertRequest(results, proxyOrigin, 'list decrypted file through proxy', 'POST', '/api/fs/list', {
    path: folderPath,
    password: '',
    page: 1,
    per_page: 100,
    refresh: true,
  }, authHeaders)
  if (!findContent(proxyList, plainFile)) throw new Error('proxy did not restore the original file name')

  const proxyGet = await assertRequest(results, proxyOrigin, 'get decrypted proxy download', 'POST', '/api/fs/get', { path: filePath }, authHeaders)
  const proxyRawUrl = apiData(proxyGet)?.raw_url
  if (!proxyRawUrl) throw new Error('proxy raw_url is missing')
  const proxyDownloadPath = proxyRawUrl.startsWith('http') ? new URL(proxyRawUrl).pathname + new URL(proxyRawUrl).search : proxyRawUrl
  const fullDownload = await download(proxyOrigin, proxyDownloadPath)
  results.push({
    name: 'complete decrypted proxy download',
    status: fullDownload.status,
    byteLength: fullDownload.bytes.byteLength,
    contentLength: fullDownload.headers.get('content-length'),
    contentRange: fullDownload.headers.get('content-range'),
    contentType: fullDownload.headers.get('content-type'),
    firstBytes: Array.from(fullDownload.bytes.slice(0, 16), (value) => value.toString(16).padStart(2, '0')).join(''),
    matchesPlaintext: equalBytes(fullDownload.bytes, payload),
  })
  if (fullDownload.status !== 200 || !equalBytes(fullDownload.bytes, payload)) {
    throw new Error(
      `complete decrypted proxy download mismatch: HTTP ${fullDownload.status}, bytes ${fullDownload.bytes.byteLength}, content-length ${fullDownload.headers.get('content-length')}, content-range ${fullDownload.headers.get('content-range')}, first-bytes ${Array.from(fullDownload.bytes.slice(0, 16), (value) => value.toString(16).padStart(2, '0')).join('')}`,
    )
  }

  const rangeStart = 7
  const rangeDownload = await download(proxyOrigin, proxyDownloadPath, { range: `bytes=${rangeStart}-` })
  results.push({ name: 'Range decrypted proxy download', status: rangeDownload.status, byteLength: rangeDownload.bytes.byteLength, contentRange: rangeDownload.headers.get('content-range'), matchesPlaintext: equalBytes(rangeDownload.bytes, payload.slice(rangeStart)) })
  if (rangeDownload.status !== 206 || !equalBytes(rangeDownload.bytes, payload.slice(rangeStart))) throw new Error('Range decrypted proxy download mismatch')

  await assertRequest(results, proxyOrigin, 'rename encrypted file through proxy', 'POST', '/api/fs/rename', { path: filePath, name: renamedFile }, authHeaders)
  fileExists = false
  renamedExists = true
  const renamedList = await assertRequest(results, proxyOrigin, 'list renamed encrypted file through proxy', 'POST', '/api/fs/list', {
    path: folderPath,
    password: '',
    page: 1,
    per_page: 100,
    refresh: true,
  }, authHeaders)
  if (!findContent(renamedList, renamedFile)) throw new Error('proxy rename did not restore the new file name')

  await assertRequest(results, proxyOrigin, 'copy encrypted file through proxy', 'POST', '/api/fs/copy', {
    src_dir: folderPath,
    dst_dir: destPath,
    names: [renamedFile],
  }, authHeaders)
  const copiedList = await assertRequest(results, proxyOrigin, 'list copied encrypted file through proxy', 'POST', '/api/fs/list', {
    path: destPath,
    password: '',
    page: 1,
    per_page: 100,
    refresh: true,
  }, authHeaders)
  if (!findContent(copiedList, renamedFile)) throw new Error('proxy copy did not preserve the displayed file name')

  await assertRequest(results, proxyOrigin, 'move encrypted file through proxy', 'POST', '/api/fs/move', {
    src_dir: destPath,
    dst_dir: movePath,
    names: [renamedFile],
  }, authHeaders)
  movedExists = true
  const movedList = await assertRequest(results, proxyOrigin, 'list moved encrypted file through proxy', 'POST', '/api/fs/list', {
    path: movePath,
    password: '',
    page: 1,
    per_page: 100,
    refresh: true,
  }, authHeaders)
  if (!findContent(movedList, renamedFile)) throw new Error('proxy move did not preserve the displayed file name')

  await assertRequest(results, proxyOrigin, 'remove moved encrypted file through proxy', 'POST', '/api/fs/remove', { dir: movePath, names: [renamedFile] }, authHeaders)
  movedExists = false
  await assertRequest(results, proxyOrigin, 'remove renamed encrypted file through proxy', 'POST', '/api/fs/remove', { dir: folderPath, names: [renamedFile] }, authHeaders)
  renamedExists = false
  await assertRequest(results, proxyOrigin, 'remove encrypted child directory through proxy', 'POST', '/api/fs/remove', { dir: testDir, names: [plainFolder] }, authHeaders)
  createdFolder = false
  await assertRequest(results, proxyOrigin, 'remove encrypted move destination through proxy', 'POST', '/api/fs/remove', { dir: rootPath, names: [moveDir] }, authHeaders)
  createdMoveDir = false
  await assertRequest(results, proxyOrigin, 'remove encrypted destination through proxy', 'POST', '/api/fs/remove', { dir: rootPath, names: [destDir] }, authHeaders)
  createdDestDir = false
  await assertRequest(results, proxyOrigin, 'remove encrypted directory through proxy', 'POST', '/api/fs/remove', { dir: rootPath, names: [plainDir] }, authHeaders)
  createdDir = false
} finally {
  if (alistToken) {
    const authHeaders = { authorization: alistToken }
    try {
      if (fileExists) await request(proxyOrigin, 'cleanup original file', 'POST', '/api/fs/remove', { dir: folderPath, names: [plainFile] }, authHeaders)
      if (renamedExists) await request(proxyOrigin, 'cleanup renamed file', 'POST', '/api/fs/remove', { dir: folderPath, names: [renamedFile] }, authHeaders)
      if (movedExists) await request(proxyOrigin, 'cleanup moved file', 'POST', '/api/fs/remove', { dir: movePath, names: [renamedFile] }, authHeaders)
      if (createdFolder) await request(proxyOrigin, 'cleanup encrypted child directory', 'POST', '/api/fs/remove', { dir: testDir, names: [plainFolder] }, authHeaders)
      if (createdMoveDir) await request(proxyOrigin, 'cleanup move directory', 'POST', '/api/fs/remove', { dir: rootPath, names: [moveDir] }, authHeaders)
      if (createdDestDir) await request(proxyOrigin, 'cleanup destination directory', 'POST', '/api/fs/remove', { dir: rootPath, names: [destDir] }, authHeaders)
      if (createdDir) await request(proxyOrigin, 'cleanup test directory', 'POST', '/api/fs/remove', { dir: rootPath, names: [plainDir] }, authHeaders)
    } catch {}
  }
  if (configured && appToken && originalConfig) {
    try {
      await request(proxyOrigin, 'restore application config', 'POST', '/enc-api/saveAlistConfig', originalConfig, { authorizetoken: appToken })
    } catch {}
  }
}

console.log(JSON.stringify({
  ok: true,
  proxyOrigin,
  alistOrigin,
  rootPath,
  testDir,
  tests: results,
}))
tjs.exit(0)
