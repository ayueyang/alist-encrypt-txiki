// Minimal repro for the suite's API_HARNESS_ERROR: step through the suite's
// pre-case requests one at a time and print status or full error details.
//
// AList credentials come from the process environment only:
//   ALIST_PASSWORD='<secret>' [ALIST_USERNAME=admin] node tjs-suite-step-probe.mjs
// The proxy's own /enc-api password defaults to the upstream factory value (123456).
const env = typeof process !== 'undefined' ? process.env : (typeof tjs !== 'undefined' ? tjs.env : {})
const proxyOrigin = 'http://127.0.0.1:5344'
const appPassword = env.APP_PASSWORD || '123456'
const alistUsername = env.ALIST_USERNAME || 'admin'
const alistPassword = env.ALIST_PASSWORD || ''

if (!alistPassword) {
  console.error('PROBE_SETUP_ERROR ALIST_PASSWORD is required (pass it through the process environment only)')
  if (typeof tjs !== 'undefined' && typeof tjs.exit === 'function') tjs.exit(2)
  process.exit(2)
}

async function step(label, fn) {
  try {
    const r = await fn()
    const text = await r.text()
    console.log(`[step] ${label} -> ${r.status} ${text.slice(0, 140)}`)
    return text
  } catch (err) {
    console.log(`[step] ${label} THROW name=${err?.name} message=${JSON.stringify(err?.message)} stack=${String(err?.stack).slice(0, 300)}`)
    throw err
  }
}

try {
  await step('A01 enc-api/login', () =>
    fetch(`${proxyOrigin}/enc-api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: appPassword }) })
  )
  await step('alist auth/login via proxy', () =>
    fetch(`${proxyOrigin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: alistUsername, password: alistPassword }) })
  )
  await step('fs/list via proxy', () =>
    fetch(`${proxyOrigin}/api/fs/list`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'x' }, body: JSON.stringify({ path: '/会员', password: '', page: 1, per_page: 10, refresh: false }) })
  )
  console.log('[probe] all steps ok')
} catch (err) {
  console.log(`[probe] failed at some step: name=${err?.name} message=${JSON.stringify(err?.message)}`)
}
