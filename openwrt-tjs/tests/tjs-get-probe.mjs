const env = tjs.env
const base = env.ALIST_ORIGIN || 'http://10.0.2.2:5244'
const proxy = env.PROXY_ORIGIN || 'http://127.0.0.1:5344'
const basic = 'Basic ' + btoa(`admin:${env.ALIST_PASSWORD || ''}`)

async function jf(url, options = {}) {
  const response = await fetch(url, options)
  const text = await response.text()
  let data = null
  try { data = JSON.parse(text) } catch {}
  return { response, text, data }
}

async function show(label, url, opts) {
  try {
    const r = await fetch(url, opts)
    const headers = {}
    for (const [k, v] of r.headers.entries()) headers[k] = v
    const buf = new Uint8Array(await r.arrayBuffer())
    console.log(label, '->', r.status, 'len=' + buf.byteLength, JSON.stringify(new TextDecoder().decode(buf.slice(0, 40))))
  } catch (e) {
    console.log(label, '-> THROW', String(e && e.message ? e.message : e))
  }
}

const login = await jf(`${proxy}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: env.ALIST_PASSWORD }) })
const token = login.data?.data?.token
console.log('alist-login', token ? 'ok' : JSON.stringify(login.text).slice(0, 120))

const payload = new TextEncoder().encode('tjs get probe 0123456789 ABCDEFGHIJ')
const put = await jf(`${base}/api/fs/put`, {
  method: 'PUT',
  headers: { authorization: token, 'content-type': 'application/octet-stream', 'content-length': String(payload.byteLength), 'file-path': encodeURIComponent('/会员/tjsget/sample.txt') },
  body: payload,
})
console.log('direct-put', put.response.status, put.text.slice(0, 80))

const davPath = `${base}/dav/%E4%BC%9A%E5%91%98/tjsget/sample.txt`
await show('GET plain          ', davPath, { headers: { authorization: basic } })
await show('GET redirect-manual', davPath, { headers: { authorization: basic }, redirect: 'manual' })
await show('GET range+manual   ', davPath, { headers: { authorization: basic, range: 'bytes=4-' }, redirect: 'manual' })
await show('HEAD plain         ', davPath, { method: 'HEAD', headers: { authorization: basic } })

try {
  await jf(`${base}/api/fs/remove`, { method: 'POST', headers: { authorization: token, 'content-type': 'application/json' }, body: JSON.stringify({ dir: '/会员', names: ['tjsget'] }) })
} catch {}
