const decoder = new TextDecoder()
const encoder = new TextEncoder()

async function readSecret() {
  const reader = tjs.stdin.getReader()
  let secret = ''
  tjs.stdin.setRawMode(true)
  console.log('REDIRECT_PROBE_CREDENTIAL_READY')
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

async function readResponse(response) {
  const bytes = new Uint8Array(await response.arrayBuffer())
  return {
    status: response.status,
    contentLength: response.headers.get('content-length'),
    contentRange: response.headers.get('content-range'),
    contentType: response.headers.get('content-type'),
    location: Boolean(response.headers.get('location')),
    byteLength: bytes.byteLength,
    firstBytes: Array.from(bytes.slice(0, 16), (value) => value.toString(16).padStart(2, '0')).join(''),
  }
}

const password = await readSecret()
if (!password) throw new Error('AList password was not provided')

const origin = (tjs.env.ALIST_ORIGIN || 'http://10.0.2.2:15244').replace(/\/$/, '')
const rootPath = tjs.env.ALIST_TEST_ROOT || '/会员'
const testName = `_codex_redirect_probe_${Date.now()}`
const davPath = `/dav${rootPath}/${testName}/probe.bin`
const payload = encoder.encode('redirect fetch probe')
const auth = `Basic ${btoa(`admin:${password}`)}`
const results = []
let rootCreated = false
let fileCreated = false

async function dav(method, path, options = {}) {
  return await fetch(`${origin}${path}`, {
    method,
    headers: { authorization: auth, ...options.headers },
    body: options.body,
    redirect: 'manual',
  })
}

try {
  const mkcol = await dav('MKCOL', `/dav${rootPath}/${testName}`)
  if (mkcol.status !== 201) throw new Error(`MKCOL failed: HTTP ${mkcol.status}`)
  rootCreated = true

  const put = await dav('PUT', davPath, {
    headers: { 'content-type': 'application/octet-stream' },
    body: payload,
  })
  if (put.status !== 201 && put.status !== 204) throw new Error(`PUT failed: HTTP ${put.status}`)
  fileCreated = true

  const redirect = await dav('GET', davPath)
  const location = redirect.headers.get('location')
  if (redirect.status < 300 || redirect.status >= 400 || !location) {
    throw new Error(`AList redirect failed: HTTP ${redirect.status}`)
  }

  const rawUrl = new URL(location, origin).href
  const variants = [
    ['default', {}],
    ['baidu-user-agent', { 'User-Agent': 'pan.baidu.com' }],
    ['baidu-user-agent-gzip', { 'User-Agent': 'pan.baidu.com', 'Accept-Encoding': 'gzip, deflate' }],
    ['baidu-user-agent-identity', { 'User-Agent': 'pan.baidu.com', 'Accept-Encoding': 'identity' }],
    ['origin-only', { 'User-Agent': 'pan.baidu.com', 'Accept-Encoding': 'gzip, deflate', Origin: 'http://127.0.0.1' }],
    ['pragma-only', { 'User-Agent': 'pan.baidu.com', 'Accept-Encoding': 'gzip, deflate', Pragma: 'no-cache' }],
    ['cache-control-only', { 'User-Agent': 'pan.baidu.com', 'Accept-Encoding': 'gzip, deflate', 'Cache-Control': 'no-cache' }],
    ['original-incoming', {
      'User-Agent': 'pan.baidu.com',
      Origin: 'http://127.0.0.1',
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
      'Accept-Encoding': 'gzip, deflate',
    }],
    ['range', { 'User-Agent': 'pan.baidu.com', Range: 'bytes=0-' }],
  ]
  for (const [name, headers] of variants) {
    const response = await fetch(rawUrl, { headers, redirect: 'manual' })
    const result = await readResponse(response)
    results.push({ name, ...result })
    console.log(`REDIRECT_PROBE_RESULT ${name} ${JSON.stringify(result)}`)
  }
} finally {
  if (fileCreated) {
    try { await dav('DELETE', davPath) } catch {}
  }
  if (rootCreated) {
    try { await dav('DELETE', `/dav${rootPath}/${testName}`) } catch {}
  }
}

console.log(JSON.stringify({ ok: true, origin, tests: results }))
tjs.exit(0)
