// 目的：把「两路并发请求失败」定位到 代理 / AList / 网络 三者中的哪一个。
// 做法：同一形态（两路并发）分别打到
//   A. 代理自身的 /ping（不经 AList）
//   B. AList 的读接口（不经代理）
//   C. AList 的 WebDAV PUT（不经代理）
//   D. 代理的 WebDAV PUT（经代理）
// 若 C 与 D 同命运，则与代理无关；若 C 通过而 D 失败，才需要查代理。
//
// 用法（guest）：
//   ALIST_PASSWORD='…' PROXY_ORIGIN=http://127.0.0.1:5344 ALIST_ORIGIN=http://10.0.2.2:5244 \
//     /usr/bin/tjs run /mnt/host/tests/concurrency-discriminate-probe.mjs
const env = typeof tjs === 'undefined' ? process.env : tjs.env
const proxyOrigin = (env.PROXY_ORIGIN || 'http://127.0.0.1:5344').replace(/\/$/, '')
const alistOrigin = (env.ALIST_ORIGIN || 'http://10.0.2.2:5244').replace(/\/$/, '')
const alistUser = env.ALIST_USERNAME || 'admin'
const alistPassword = env.ALIST_PASSWORD || ''
const appPassword = env.APP_PASSWORD || '123456'
if (!alistPassword) throw new Error('API_SETUP_ERROR ALIST_PASSWORD is required')

const ts = Date.now()
const top = `_conc2_${ts}`
const davAuth = { authorization: 'Basic ' + btoa(`${alistUser}:${alistPassword}`) }
const enc = (p) => p.split('/').map(encodeURIComponent).join('/')
const payload = new Uint8Array(1024).fill(0x41)

async function timed(label, fn) {
  const t0 = Date.now()
  try {
    const value = await fn()
    return { label, ok: true, ms: Date.now() - t0, ...value }
  } catch (error) {
    return { label, ok: false, ms: Date.now() - t0, error: String(error?.message || error) }
  }
}
const report = (r) => console.log(`DISC ${JSON.stringify(r)}`)

async function parallel(label, factories) {
  const results = await Promise.all(factories.map((fn, index) => timed(`${label}#${index + 1}`, fn)))
  for (const r of results) report(r)
  return results
}

const login = await (async () => {
  const response = await fetch(`${proxyOrigin}/enc-api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: appPassword }),
  })
  return (await response.json())?.data?.jwtToken
})()

const alistToken = await (async () => {
  const response = await fetch(`${alistOrigin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: alistUser, password: alistPassword }),
  })
  return (await response.json())?.data?.token
})()
const alistHeaders = { authorization: alistToken, 'content-type': 'application/json' }
console.log(`DISC_SETUP ${JSON.stringify({ appToken: !!login, alistToken: !!alistToken, top })}`)

// A. 代理本地 /ping ×2
await parallel('proxy-ping', [
  () => fetch(`${proxyOrigin}/ping`).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 20) })),
  () => fetch(`${proxyOrigin}/ping`).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 20) })),
])

// B. AList 读接口 ×2（直连，不经代理）
await parallel('alist-list', [
  () => fetch(`${alistOrigin}/api/fs/list`, { method: 'POST', headers: alistHeaders, body: JSON.stringify({ path: '/会员', page: 1, per_page: 50 }) }).then(async (r) => ({ status: r.status, len: (await r.text()).length })),
  () => fetch(`${alistOrigin}/api/fs/list`, { method: 'POST', headers: alistHeaders, body: JSON.stringify({ path: '/会员', page: 1, per_page: 50 }) }).then(async (r) => ({ status: r.status, len: (await r.text()).length })),
])

// 准备目录（先建好，避免把建目录的延迟混进 PUT）
for (const [label, origin] of [['alist', alistOrigin], ['proxy', proxyOrigin]]) {
  const r = await fetch(`${origin}/api/fs/mkdir`, { method: 'POST', headers: alistHeaders, body: JSON.stringify({ path: `/会员/${top}_${label}` }) })
  console.log(`DISC_MKDIR ${label} ${r.status} ${(await r.text()).slice(0, 60)}`)
}

// C. AList WebDAV PUT ×2（直连）
await parallel('alist-dav-put', [
  () => fetch(`${alistOrigin}/dav${enc(`/会员/${top}_alist/a.bin`)}`, { method: 'PUT', headers: davAuth, body: payload }).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 40) })),
  () => fetch(`${alistOrigin}/dav${enc(`/会员/${top}_alist/b.bin`)}`, { method: 'PUT', headers: davAuth, body: payload }).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 40) })),
])

// D. 代理 WebDAV PUT ×2（经代理）
await parallel('proxy-dav-put', [
  () => fetch(`${proxyOrigin}/dav${enc(`/会员/${top}_proxy/a.bin`)}`, { method: 'PUT', headers: davAuth, body: payload }).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 40) })),
  () => fetch(`${proxyOrigin}/dav${enc(`/会员/${top}_proxy/b.bin`)}`, { method: 'PUT', headers: davAuth, body: payload }).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 40) })),
])

// E. 串行对照：同样的 PUT 逐个来一遍（用于对比并发与串行的耗时量级）
await timed('serial-alist-dav-put', () => fetch(`${alistOrigin}/dav${enc(`/会员/${top}_alist/c.bin`)}`, { method: 'PUT', headers: davAuth, body: payload }).then(async (r) => ({ status: r.status }))).then(report)
await timed('serial-proxy-dav-put', () => fetch(`${proxyOrigin}/dav${enc(`/会员/${top}_proxy/c.bin`)}`, { method: 'PUT', headers: davAuth, body: payload }).then(async (r) => ({ status: r.status }))).then(report)

// 清理
for (const name of [`${top}_alist`, `${top}_proxy`]) {
  const r = await fetch(`${alistOrigin}/api/fs/remove`, { method: 'POST', headers: alistHeaders, body: JSON.stringify({ dir: '/会员', names: [name] }) })
  console.log(`DISC_CLEANUP ${name} code=${(await r.json())?.code}`)
}
console.log('DISC_DONE')
