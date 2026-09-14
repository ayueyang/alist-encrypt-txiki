// 目的：验证「dao 缓存逐级登记」假说——PROPFIND 子目录前必须先 PROPFIND
// 父目录（真实 WebDAV 客户端的浏览顺序）；以及服务端 COPY 之后，依
// 「PROPFIND 父目录 → PROPFIND 复制目录 → GET 复制件」的客户端顺序能否读到内容。
const env = typeof tjs === 'undefined' ? process.env : tjs.env
const proxyOrigin = (env.PROXY_ORIGIN || 'http://127.0.0.1:5344').replace(/\/$/, '')
const alistOrigin = (env.ALIST_ORIGIN || 'http://10.0.2.2:5244').replace(/\/$/, '')
const alistUser = env.ALIST_USERNAME || 'admin'
const alistPassword = env.ALIST_PASSWORD || ''
const appPassword = env.APP_PASSWORD || '123456'
if (!alistPassword) throw new Error('API_SETUP_ERROR ALIST_PASSWORD is required')
const ts = Date.now()
const topName = `_ch_${ts}`
const testDir = `/会员/${topName}`
const subName = '可见目录'
const copyDir = 'dav 复制目标'
const fileName = '原文样例.txt'
const payload = new TextEncoder().encode('chain probe payload')
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
async function step(label, method, path, headers = {}, body) {
  const r = await fetch(davUrl(path), { method, headers, body })
  const text = await r.text()
  console.log(`CH ${label.padEnd(34)} ${r.status} ${text.slice(0, 100).replace(/\s+/g, ' ')}`)
  return { status: r.status, text }
}

const appLogin = await jf(`${proxyOrigin}/enc-api/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: appPassword }),
})
const appToken = appLogin.data?.data?.jwtToken
if (!appToken) throw new Error(`app login failed: ${appLogin.text.slice(0, 160)}`)
const appHeaders = { authorizetoken: appToken, 'content-type': 'application/json' }
const current = await jf(`${proxyOrigin}/enc-api/getAlistConfig`, { method: 'POST', headers: { authorizetoken: appToken } })
const originalConfig = current.data?.data
const testConfig = JSON.parse(JSON.stringify(originalConfig))
const alistUrl = new URL(alistOrigin)
testConfig.serverHost = alistUrl.hostname
testConfig.serverPort = alistUrl.port || '80'
testConfig.https = alistUrl.protocol === 'https:'
testConfig.passwdList = [{ password: 'ch-password', describe: 'ch', encType: 'aesctr', enable: true, encName: true, encFolder: true, encSuffix: '', encPath: [`${topName}.*`] }]
await jf(`${proxyOrigin}/enc-api/saveAlistConfig`, { method: 'POST', headers: appHeaders, body: JSON.stringify(testConfig) })
const alistLogin = await jf(`${alistOrigin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: alistUser, password: alistPassword }) })
const alistHeaders = { authorization: alistLogin.data?.data?.token, 'content-type': 'application/json' }

try {
  await jf(`${proxyOrigin}/api/fs/mkdir`, { method: 'POST', headers: alistHeaders, body: JSON.stringify({ path: `${testDir}/${subName}` }) })
  await step('PUT 原文件', 'PUT', `/dav${testDir}/${subName}/${fileName}`, davAuth, payload)
  await step('MKCOL 复制目标', 'MKCOL', `/dav${testDir}/${subName}/${copyDir}`, davAuth)
  await step('COPY 跨目录同名', 'COPY', `/dav${testDir}/${subName}/${fileName}`, { ...davAuth, destination: davDest(`/dav${testDir}/${subName}/${copyDir}/${fileName}`), overwrite: 'T' })
  // 链 1：先 PROPFIND 父目录（登记复制目录），再 PROPFIND 复制目录（登记复制件）
  // 链 0（关键）：顶层目录在云端保持明文名，其 PROPFIND 不依赖缓存，
  // 而它的响应会把「可见目录」登记进 dao——这正是真实客户端自顶向下浏览的顺序
  await step('PROPFIND 顶层目录(链0)', 'PROPFIND', `/dav${testDir}`, { ...davAuth, depth: '1' })
  await step('PROPFIND 父目录(链1)', 'PROPFIND', `/dav${testDir}/${subName}`, { ...davAuth, depth: '1' })
  await step('PROPFIND 复制目录(链1)', 'PROPFIND', `/dav${testDir}/${subName}/${copyDir}`, { ...davAuth, depth: '1' })
  const got = await step('GET 复制件(链1)', 'GET', `/dav${testDir}/${subName}/${copyDir}/${fileName}`, davAuth)
  console.log(`CH 复制件内容 ${JSON.stringify(got.text.slice(0, 40))}`)
  // 链 2（对照）：直接 PROPFIND 复制目录（跳过父目录）
  await step('PROPFIND 复制目录(链2,对照)', 'PROPFIND', `/dav${testDir}/${subName}/${copyDir}`, { ...davAuth, depth: '1' })
} catch (error) {
  console.log(`CH_EXCEPTION ${String(error?.message || error)}`)
} finally {
  try {
    await jf(`${alistOrigin}/api/fs/remove`, { method: 'POST', headers: alistHeaders, body: JSON.stringify({ dir: '/会员', names: [topName] }) })
  } catch {}
  try {
    await jf(`${proxyOrigin}/enc-api/saveAlistConfig`, { method: 'POST', headers: appHeaders, body: JSON.stringify(originalConfig) })
  } catch {}
}
console.log('CH_DONE')
