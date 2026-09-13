const origin = 'http://127.0.0.1:5344'
const serverHost = tjs.env.ALIST_SERVER_HOST || '10.0.2.2'
const serverPort = tjs.env.ALIST_SERVER_PORT || '5244'

async function request(path, options = {}) {
  const response = await fetch(`${origin}${path}`, options)
  const text = await response.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {}
  return { response, data }
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
const current = await request('/enc-api/getAlistConfig', { method: 'POST', headers })
const config = current.data?.data
if (current.response.status !== 200 || current.data?.code !== 200 || !config) {
  throw new Error(`read application config failed: HTTP ${current.response.status}, API ${current.data?.code}`)
}

config.serverHost = serverHost
config.serverPort = serverPort
config.https = false
const saved = await request('/enc-api/saveAlistConfig', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(config),
})
if (saved.response.status !== 200 || saved.data?.code !== 200) {
  throw new Error(`save application config failed: HTTP ${saved.response.status}, API ${saved.data?.code}`)
}

console.log(JSON.stringify({ ok: true, serverHost, serverPort, https: false }))
tjs.exit(0)
