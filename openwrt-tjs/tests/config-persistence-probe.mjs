const origin = 'http://127.0.0.1:5344'
const mode = tjs.env.PERSISTENCE_MODE || ''
const marker = tjs.env.PERSISTENCE_MARKER || ''

async function request(path, options = {}) {
  const response = await fetch(`${origin}${path}`, options)
  const text = await response.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {}
  return { response, data, text }
}

const login = await request('/enc-api/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: '123456' }),
})
const token = login.data?.data?.jwtToken
if (login.response.status !== 200 || login.data?.code !== 200 || !token) {
  throw new Error(`application login failed: HTTP ${login.response.status}, API ${login.data?.code}`)
}

const headers = { authorizetoken: token }
const configResult = await request('/enc-api/getAlistConfig', { method: 'POST', headers })
const config = configResult.data?.data
if (configResult.response.status !== 200 || configResult.data?.code !== 200 || !config) {
  throw new Error(`read application config failed: HTTP ${configResult.response.status}, API ${configResult.data?.code}`)
}

if (mode === 'save') {
  if (!marker) throw new Error('PERSISTENCE_MARKER is required')
  config.describe = marker
  const save = await request('/enc-api/saveAlistConfig', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(config),
  })
  if (save.response.status !== 200 || save.data?.code !== 200) {
    throw new Error(`save application config failed: HTTP ${save.response.status}, API ${save.data?.code}`)
  }
  console.log(JSON.stringify({ ok: true, mode, marker }))
} else if (mode === 'check') {
  const actual = config.describe || ''
  if (actual !== marker) throw new Error(`configuration marker mismatch: expected ${marker}, actual ${actual}`)
  console.log(JSON.stringify({ ok: true, mode, marker: actual }))
} else if (mode === 'restore') {
  delete config.describe
  const save = await request('/enc-api/saveAlistConfig', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(config),
  })
  if (save.response.status !== 200 || save.data?.code !== 200) {
    throw new Error(`restore application config failed: HTTP ${save.response.status}, API ${save.data?.code}`)
  }
  console.log(JSON.stringify({ ok: true, mode }))
} else {
  throw new Error(`unknown PERSISTENCE_MODE: ${mode}`)
}

tjs.exit(0)
