const env = typeof tjs === 'undefined' ? process.env : tjs.env
const proxyOrigin = env.PROXY_ORIGIN || 'http://127.0.0.1:5344'
const login = await fetch(`${proxyOrigin}/enc-api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: env.APP_PASSWORD || '123456' }) })
const loginBody = await login.json()
const token = loginBody.data?.jwtToken || loginBody.data?.data?.jwtToken
console.log('token-from:', loginBody.data?.jwtToken ? 'data.jwtToken' : 'data.data.jwtToken')
const r = await fetch(`${proxyOrigin}/enc-api/getWebdavonfig`, { method: 'POST', headers: { authorizetoken: token } })
const t = await r.text()
console.log('getWebdavonfig:', t.slice(0, 300).replace(/("password":")[^"]*/g, '$1[REDACTED]'))
