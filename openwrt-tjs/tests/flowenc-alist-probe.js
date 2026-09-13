import FlowEnc from '../../node-proxy/src/utils/flowEnc'
import { encodeName } from '../../node-proxy/src/utils/commonUtil'
import { fetchWithKnownLength } from '../src/platform/fixed-length-fetch.js'

const decoder = new TextDecoder()
const encoder = new TextEncoder()

async function readSecret() {
  const reader = tjs.stdin.getReader()
  let secret = ''
  tjs.stdin.setRawMode(true)
  console.log('FLOWENC_WEBDAV_CREDENTIAL_READY')
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      secret += decoder.decode(value, { stream: true })
      const lineEnd = secret.search(/[\r\n]/)
      if (lineEnd !== -1) return secret.slice(0, lineEnd)
    }
  } finally {
    tjs.stdin.setRawMode(false)
    reader.releaseLock()
  }
  return secret
}

const alistPassword = await readSecret()
if (!alistPassword) throw new Error('AList password was not provided')

const origin = (tjs.env.ALIST_ORIGIN || 'http://10.0.2.2:15244').replace(/\/$/, '')
const rootPath = tjs.env.ALIST_TEST_ROOT || '/会员'
const password = 'openwrt-webdav-password'
const encType = 'aesctr'
const testName = `_codex_flowenc_webdav_${Date.now()}`
const sourceFolder = '源目录'
const plainFile = 'webdav 中文.txt'
const davRoot = `/dav${rootPath}/${testName}`
const encodedFolder = encodeName(password, encType, sourceFolder)
const encodedFile = `${encodeName(password, encType, plainFile)}.txt`
const folderPath = `${davRoot}/${encodedFolder}`
const filePath = `${folderPath}/${encodedFile}`
const payload = encoder.encode('alist-encrypt txiki.js WebDAV payload 0123456789')
const auth = `Basic ${btoa(`admin:${alistPassword}`)}`
const results = []
let rootCreated = false

async function request(name, method, path) {
  console.log(`FLOWENC_WEBDAV_STEP ${name}`)
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { authorization: auth },
    redirect: 'manual',
  })
  const bytes = new Uint8Array(await response.arrayBuffer())
  return { name, method, status: response.status, byteLength: bytes.byteLength }
}

async function encryptedBody() {
  const flowEnc = new FlowEnc(password, encType, payload.byteLength)
  const input = new ReadableStream({
    start(controller) {
      controller.enqueue(payload)
      controller.close()
    },
  })
  return input.pipeThrough(flowEnc.encryptTransform().stream)
}

async function upload() {
  console.log('FLOWENC_WEBDAV_STEP PUT FlowEnc stream')
  const response = await fetchWithKnownLength(`${origin}${filePath}`, {
    method: 'PUT',
    headers: {
      authorization: auth,
      'content-type': 'application/octet-stream',
      'content-length': String(payload.byteLength),
      origin: 'http://127.0.0.1',
      pragma: 'no-cache',
      'cache-control': 'no-cache',
      'accept-encoding': 'gzip, deflate',
      'user-agent': 'txiki.js/26.6.0',
    },
    body: await encryptedBody(),
  })
  const bytes = new Uint8Array(await response.arrayBuffer())
  return { name: 'PUT FlowEnc stream', method: 'PUT', status: response.status, byteLength: bytes.byteLength }
}

try {
  const root = await request('MKCOL root', 'MKCOL', davRoot)
  results.push(root)
  rootCreated = root.status === 201 || root.status === 204

  results.push(await request('MKCOL encoded folder', 'MKCOL', folderPath))
  results.push(await upload())
  results.push(await request('DELETE file', 'DELETE', filePath))
  results.push(await request('DELETE encoded folder', 'DELETE', folderPath))
  results.push(await request('DELETE root', 'DELETE', davRoot))
  rootCreated = false
} finally {
  if (rootCreated) {
    try {
      await request('cleanup root', 'DELETE', davRoot)
    } catch {}
  }
}

console.log(JSON.stringify({ ok: true, origin, davRoot, folderPath, filePath, results }))
tjs.exit(0)
