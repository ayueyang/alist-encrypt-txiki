// Client-side LWS connection-pool stress: N sequential enc-api requests in
// ONE tjs process to reproduce the suite's A09 hang (dies at case #9 = ~N reqs).
const proxyOrigin = 'http://127.0.0.1:5344'

const login = await fetch(`${proxyOrigin}/enc-api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: '123456' }) })
const loginBody = await login.json()
const appToken = loginBody?.data?.jwtToken
const appHeaders = { authorizetoken: appToken, 'content-type': 'application/json' }
console.log('[stress] login ok')

const connClose = typeof tjs !== 'undefined' && tjs.env && tjs.env.STRESS_CONN_CLOSE === '1'

let line = ''
const t0 = Date.now()
for (let i = 1; i <= 40; i++) {
  const ts = Date.now()
  try {
    const headers = { ...appHeaders }
    if (connClose) headers['connection'] = 'close'
    const r = await fetch(`${proxyOrigin}/enc-api/getWebdavonfig`, { method: 'POST', headers })
    await r.text()
    line += `#${i}:${Date.now() - ts}ms `
    if (i % 8 === 0) {
      console.log(line)
      line = ''
    }
  } catch (err) {
    console.log(`${line}\n[stress] FAIL at request #${i} after ${Date.now() - ts}ms (total ${Math.round((Date.now() - t0) / 1000)}s): ${err?.name} ${JSON.stringify(String(err?.message))}`)
    if (typeof tjs !== "undefined" && tjs.exit) tjs.exit(1)
  }
}
console.log(`${line}\n[stress] all 40 done in ${Math.round((Date.now() - t0) / 1000)}s`)
