const decoder = new TextDecoder()
import { fetchWithKnownLength } from '../src/platform/fixed-length-fetch.js'

async function readSecret() {
  const reader = tjs.stdin.getReader()
  let secret = ''
  tjs.stdin.setRawMode(true)
  console.log('DIRECT_WEBDAV_CREDENTIAL_READY')
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

const password = await readSecret()
if (!password) throw new Error('AList password was not provided')

const origin = (tjs.env.ALIST_ORIGIN || 'http://10.0.2.2:15244').replace(/\/$/, '')
const rootPath = tjs.env.ALIST_TEST_ROOT || '/会员'
const testName = `_codex_direct_webdav_${Date.now()}`
const davRoot = `/dav${rootPath}/${testName}`
const filePath = `${davRoot}/direct-put.txt`
const copyFilePath = `${davRoot}/direct-copy.txt`
const moveFilePath = `${davRoot}/direct-move.txt`
const encodedFolderPath = `${davRoot}/EkB5EE22E8bnk`
const encodedFilePath = `${encodedFolderPath}/gbndTFjbGVfNkW4~-ME9WA5J-.txt`
const auth = `Basic ${btoa(`admin:${password}`)}`
const payload = new TextEncoder().encode('direct AList WebDAV PUT probe')
const results = []
let rootCreated = false

async function request(name, method, path, body, extraHeaders = {}) {
  console.log(`DIRECT_WEBDAV_STEP ${name}`)
  const headers = { authorization: auth, ...extraHeaders }
  if (body !== undefined) headers['content-type'] = 'application/octet-stream'
  const response = await fetch(`${origin}${path}`, {
    method,
    headers,
    body,
    redirect: 'manual',
  })
  const bytes = new Uint8Array(await response.arrayBuffer())
  return {
    name,
    method,
    status: response.status,
    contentLength: response.headers.get('content-length'),
    allow: response.headers.get('allow'),
    bodyPreview: new TextDecoder().decode(bytes).slice(0, 160),
    byteLength: bytes.byteLength,
  }
}

async function fixedLengthPut(name, path, body) {
  console.log(`DIRECT_WEBDAV_STEP ${name}`)
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(body)
      controller.close()
    },
  })
  const response = await fetchWithKnownLength(`${origin}${path}`, {
    method: 'PUT',
    headers: {
      authorization: auth,
      'content-type': 'application/octet-stream',
      'content-length': String(body.byteLength),
      origin: 'http://127.0.0.1',
      pragma: 'no-cache',
      'cache-control': 'no-cache',
      'accept-encoding': 'gzip, deflate',
      'user-agent': 'txiki.js/26.6.0',
    },
    body: stream,
  })
  const bytes = new Uint8Array(await response.arrayBuffer())
  return {
    name,
    method: 'PUT',
    status: response.status,
    contentLength: response.headers.get('content-length'),
    allow: response.headers.get('allow'),
    bodyPreview: new TextDecoder().decode(bytes).slice(0, 160),
    byteLength: bytes.byteLength,
  }
}

try {
  const mkcol = await request('MKCOL direct root', 'MKCOL', davRoot)
  results.push(mkcol)
  rootCreated = mkcol.status === 201 || mkcol.status === 204

  const encodedMkcol = await request('MKCOL encoded folder shape', 'MKCOL', encodedFolderPath)
  results.push(encodedMkcol)

  const put = await request('PUT direct fixed body', 'PUT', filePath, payload)
  results.push(put)

  const encodedPut = await fixedLengthPut('PUT encoded file shape', encodedFilePath, payload)
  results.push(encodedPut)

  console.log('DIRECT_WEBDAV_STEP PROPFIND encoded folder')
  const propfindResponse = await fetch(`${origin}${encodedFolderPath}`, {
    method: 'PROPFIND',
    headers: {
      authorization: auth,
      depth: '1',
      'content-type': 'application/xml',
    },
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
  })
  const propfindBytes = new Uint8Array(await propfindResponse.arrayBuffer())
  results.push({
    name: 'PROPFIND encoded folder',
    method: 'PROPFIND',
    status: propfindResponse.status,
    byteLength: propfindBytes.byteLength,
    bodyPreview: new TextDecoder().decode(propfindBytes).slice(0, 160),
  })

  console.log('DIRECT_WEBDAV_STEP PROPFIND streaming XML')
  const propfindStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>'))
      controller.close()
    },
  })
  const streamingPropfindResponse = await fetch(`${origin}${encodedFolderPath}`, {
    method: 'PROPFIND',
    headers: {
      authorization: auth,
      depth: '1',
      'content-type': 'application/xml',
    },
    body: propfindStream,
    duplex: 'half',
  })
  const streamingPropfindBytes = new Uint8Array(await streamingPropfindResponse.arrayBuffer())
  results.push({
    name: 'PROPFIND streaming XML',
    method: 'PROPFIND',
    status: streamingPropfindResponse.status,
    byteLength: streamingPropfindBytes.byteLength,
    bodyPreview: new TextDecoder().decode(streamingPropfindBytes).slice(0, 160),
  })

  const fixedFilePath = `${davRoot}/fixed-length-put.txt`
  const fixedPut = await fixedLengthPut('PUT direct ReadableStream fixed length', fixedFilePath, payload)
  results.push(fixedPut)

  const get = await request('GET direct file', 'GET', filePath)
  results.push(get)

  const head = await request('HEAD direct file', 'HEAD', filePath)
  results.push(head)

  const copy = await request('COPY direct file', 'COPY', filePath, undefined, {
    destination: `${origin}${copyFilePath}`,
    overwrite: 'T',
  })
  results.push(copy)

  const move = await request('MOVE direct file', 'MOVE', copyFilePath, undefined, {
    destination: `${origin}${moveFilePath}`,
    overwrite: 'T',
  })
  results.push(move)

  const movedGet = await request('GET direct moved file', 'GET', moveFilePath)
  results.push(movedGet)

  const del = await request('DELETE direct file', 'DELETE', filePath)
  results.push(del)
  const movedDel = await request('DELETE direct moved file', 'DELETE', moveFilePath)
  results.push(movedDel)
  const fixedDel = await request('DELETE direct fixed-length file', 'DELETE', fixedFilePath)
  results.push(fixedDel)
  const encodedDel = await request('DELETE encoded file shape', 'DELETE', encodedFilePath)
  results.push(encodedDel)
  const encodedFolderDel = await request('DELETE encoded folder shape', 'DELETE', encodedFolderPath)
  results.push(encodedFolderDel)
  const rootDel = await request('DELETE direct root', 'DELETE', davRoot)
  results.push(rootDel)
  rootCreated = false
} finally {
  if (rootCreated) {
    try {
      await request('cleanup direct root', 'DELETE', davRoot)
    } catch {}
  }
}

console.log(JSON.stringify({ ok: true, origin, davRoot, results }))
tjs.exit(0)
