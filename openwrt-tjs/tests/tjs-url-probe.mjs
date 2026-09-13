const env = tjs.env
const base = env.ALIST_ORIGIN || 'http://10.0.2.2:5244'
const auth = { authorization: 'Basic ' + btoa(`admin:${env.ALIST_PASSWORD || ''}`) }

async function show(label, url, opts) {
  try {
    const r = await fetch(url, opts)
    const t = await r.text()
    console.log(label, '->', r.status, JSON.stringify(t.slice(0, 60)))
  } catch (e) {
    console.log(label, '-> THROW', String(e && e.message ? e.message : e))
  }
}

await show('ping            ', `${base}/ping`)
await show('dav-encoded     ', `${base}/dav/%E4%BC%9A%E5%91%98/`, { method: 'PROPFIND', headers: { ...auth, depth: '1' } })
await show('dav-raw-chinese ', `${base}/dav/会员/`, { method: 'PROPFIND', headers: { ...auth, depth: '1' } })
await show('api-raw-chinese ', `${base}/api/fs/list`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ path: '/会员', page: 1, per_page: 5, refresh: false }) })
