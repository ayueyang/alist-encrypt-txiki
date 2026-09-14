// WebDAV COPY/MOVE 经代理的响应取证（guest 内由 /usr/bin/tjs 执行）。
// 目的：AList 直连时 COPY=500 / MOVE=201（已由宿主侧直连探针证实），
// 而套件经代理得到 502 —— 本探针打印经代理时的状态行、响应头与响应体，定位 502 的产生者。
//
// 用法（guest）：
//   ALIST_PASSWORD='…' PROXY_ORIGIN=http://127.0.0.1:5344 /usr/bin/tjs run /mnt/host/tests/webdav-copy-move-probe.mjs
const env = typeof tjs === 'undefined' ? process.env : tjs.env
const proxyOrigin = (env.PROXY_ORIGIN || 'http://127.0.0.1:5344').replace(/\/$/, '')
const alistOrigin = (env.ALIST_ORIGIN || 'http://10.0.2.2:5244').replace(/\/$/, '')
const alistUser = env.ALIST_USERNAME || 'admin'
const alistPassword = env.ALIST_PASSWORD || ''
const appPassword = env.APP_PASSWORD || '123456'
if (!alistPassword) throw new Error('API_SETUP_ERROR ALIST_PASSWORD is required')

const ts = Date.now()
const topName = `_davcm_${ts}`
const testDir = `/会员/${topName}`
const subName = '可见目录'
const fileName = '原文样例.txt'
const copyName = '副本.txt'
const moveName = '移动后.txt'
const payload = new TextEncoder().encode('dav copy/move probe payload 0123456789')

const davAuth = { authorization: 'Basic ' + btoa(`${alistUser}:${alistPassword}`) }
const davUrl = (p) => `${proxyOrigin}${encodeURI(p)}`
const davDest = (p) => `${proxyOrigin}${p.split('/').map(encodeURIComponent).join('/')}`

async function jf(url, options = {}) {
  const response = await fetch(url, options)
  const text = await response.text()
  let data = null
  try { data = JSON.parse(text) } catch {}
  return { response, text, data }
}

async function show(label, method, url, headers, body) {
  const res = await fetch(url, { method, headers, body })
  const text = await res.text().catch(() => '')
  const h = {}
  for (const k of ['server', 'content-type', 'content-length', 'x-powered-by', 'location', 'allow', 'dav', 'www-authenticate']) {
    const v = res.headers.get(k)
    if (v) h[k] = v
  }
  const record = { label, method, status: res.status, statusText: res.statusText, headers: h, body: text.slice(0, 300) }
  console.log(`PROBE ${JSON.stringify(record)}`)
  return record
}

const out = { topName, testDir }
try {
  const appLogin = await jf(`${proxyOrigin}/enc-api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: appPassword }),
  })
  const appToken = appLogin.data?.data?.jwtToken
  if (!appToken) throw new Error(`app login failed: ${appLogin.text.slice(0, 160)}`)
  const appHeaders = { authorizetoken: appToken, 'content-type': 'application/json' }

  const current = await jf(`${proxyOrigin}/enc-api/getAlistConfig`, { method: 'POST', headers: { authorizetoken: appToken } })
  const currentConfig = current.data?.data
  if (!currentConfig) throw new Error('alist config unavailable')
  const testConfig = JSON.parse(JSON.stringify(currentConfig))
  const rule = testConfig.passwdList[0]
  rule.encPath = [`${topName}.*`]
  rule.encName = true
  rule.encFolder = true
  const saved = await jf(`${proxyOrigin}/enc-api/saveAlistConfig`, { method: 'POST', headers: appHeaders, body: JSON.stringify(testConfig) })
  out.ruleApplied = { code: saved.data?.code, encPath: rule.encPath }
  console.log(`PROBE_RULES ${JSON.stringify(out.ruleApplied)}`)

  const alistLogin = await jf(`${alistOrigin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: alistUser, password: alistPassword }),
  })
  const alistToken = alistLogin.data?.data?.token
  if (!alistToken) throw new Error(`alist login failed: ${alistLogin.text.slice(0, 160)}`)
  const alistHeaders = { authorization: alistToken, 'content-type': 'application/json' }

  try {
    const mkdir = await jf(`${proxyOrigin}/api/fs/mkdir`, { method: 'POST', headers: alistHeaders, body: JSON.stringify({ path: `${testDir}/${subName}` }) })
    console.log(`PROBE_MKDIR ${JSON.stringify({ code: mkdir.data?.code, msg: mkdir.data?.message })}`)

    await show('proxy PUT', 'PUT', davUrl(`/dav${testDir}/${subName}/${fileName}`), davAuth, payload)
    await show('proxy PROPFIND 目录', 'PROPFIND', davUrl(`/dav${testDir}/${subName}`), { ...davAuth, depth: '1' })
    await show('proxy HEAD', 'HEAD', davUrl(`/dav${testDir}/${subName}/${fileName}`), davAuth)
    await show('proxy COPY', 'COPY', davUrl(`/dav${testDir}/${subName}/${fileName}`), { ...davAuth, destination: davDest(`/dav${testDir}/${subName}/${copyName}`) })
    await show('proxy COPY(已存在目标,overwrite)', 'COPY', davUrl(`/dav${testDir}/${subName}/${fileName}`), { ...davAuth, destination: davDest(`/dav${testDir}/${subName}/${copyName}`), overwrite: 'T' })
    await show('proxy MOVE', 'MOVE', davUrl(`/dav${testDir}/${subName}/${fileName}`), { ...davAuth, destination: davDest(`/dav${testDir}/${subName}/${moveName}`) })
    await show('proxy PROPFIND 复核', 'PROPFIND', davUrl(`/dav${testDir}/${subName}`), { ...davAuth, depth: '1' })
    await show('proxy DELETE 副本', 'DELETE', davUrl(`/dav${testDir}/${subName}/${copyName}`), davAuth)
    await show('proxy DELETE 移动后', 'DELETE', davUrl(`/dav${testDir}/${subName}/${moveName}`), davAuth)
    await show('proxy DELETE 源(应已不存在)', 'DELETE', davUrl(`/dav${testDir}/${subName}/${fileName}`), davAuth)
  } finally {
    try {
      const top = await jf(`${alistOrigin}/api/fs/list`, { method: 'POST', headers: alistHeaders, body: JSON.stringify({ path: '/会员', page: 1, per_page: 200, refresh: true }) })
      const name = (top.data?.data?.content || []).find((i) => i.is_dir && i.name.startsWith('_davcm') )
      const nameRaw = (top.data?.data?.content || []).find((i) => i.is_dir && i.name !== name?.name && i.name.length > 0 && !i.name.startsWith('_api_e2e'))
      if (name) {
        await jf(`${alistOrigin}/api/fs/remove`, { method: 'POST', headers: alistHeaders, body: JSON.stringify({ dir: '/会员', names: [name.name] }) })
        out.cleanup = name.name
      }
    } catch (e) { out.cleanupError = String(e?.message || e) }
    try {
      await jf(`${proxyOrigin}/enc-api/saveAlistConfig`, { method: 'POST', headers: appHeaders, body: JSON.stringify(currentConfig) })
    } catch {}
  }
} catch (error) {
  console.log(`PROBE_EXCEPTION ${String(error?.message || error)}`)
}
console.log(`PROBE_DONE ${JSON.stringify(out)}`)
