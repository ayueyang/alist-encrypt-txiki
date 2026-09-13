// Test: after A06-style config save (serverHost=10.0.2.100:80 guestfwd path),
// does the first proxied /api/auth/login hang? Then restore and retest.
//
// AList credentials come from the process environment only:
//   ALIST_PASSWORD='<secret>' [ALIST_USERNAME=admin] node tjs-guestfwd-probe.mjs
const env = typeof process !== 'undefined' ? process.env : (typeof tjs !== 'undefined' ? tjs.env : {})
const proxyOrigin = 'http://127.0.0.1:5344'
const alistUsername = env.ALIST_USERNAME || 'admin'
const alistPassword = env.ALIST_PASSWORD || ''
const appPassword = env.APP_PASSWORD || '123456'

if (!alistPassword) {
  console.error('PROBE_SETUP_ERROR ALIST_PASSWORD is required (pass it through the process environment only)')
  if (typeof tjs !== 'undefined' && typeof tjs.exit === 'function') tjs.exit(2)
  process.exit(2)
}

async function req(label, path, body, headers, timeoutMs = 30000) {
  const ts = Date.now()
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    const r = await fetch(`${proxyOrigin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal })
    clearTimeout(timer)
    const text = await r.text()
    console.log(`[${label}] ${r.status} ${Date.now() - ts}ms ${text.slice(0, 90)}`)
    return text
  } catch (err) {
    console.log(`[${label}] FAIL after ${Date.now() - ts}ms: ${err?.name} ${JSON.stringify(String(err?.message))}`)
    throw err
  }
}

try {
  const t1 = await req('login', '/enc-api/login', { username: 'admin', password: '123456' })
  const appHeaders = { authorizetoken: JSON.parse(t1)?.data?.jwtToken }
  const t5 = await req('getConfig', '/enc-api/getAlistConfig', undefined, appHeaders)
  const originalConfig = JSON.parse(t5)?.data
  console.log('[cfg] factory serverHost =', originalConfig.serverHost, ':', originalConfig.serverPort)

  // switch to guestfwd path exactly like suite A06
  await req('A06 save(guestfwd)', '/enc-api/saveAlistConfig', { ...originalConfig, serverHost: '10.0.2.100', serverPort: '80', https: false }, appHeaders)
  await req('B00 login via proxy (guestfwd cfg)', '/api/auth/login', { username: alistUsername, password: alistPassword })
  await req('B00b fs/list via proxy', '/api/fs/list', { path: '/会员', password: '', page: 1, per_page: 5, refresh: false }, { authorization: JSON.parse(await req('B00-login', '/api/auth/login', { username: alistUsername, password: alistPassword }))?.data?.token })

  // restore factory config and retest
  await req('restore', '/enc-api/saveAlistConfig', originalConfig, appHeaders)
  await req('B00 login via proxy (factory cfg)', '/api/auth/login', { username: alistUsername, password: alistPassword })
  console.log('[probe] done')
} catch (err) {
  console.log('[probe] aborted:', err?.name)
}
