// 目的：精确复现套件 C07→C08→C09→D01 的完整顺序，定位 D01 MOVE 500 与
// cfx 简化重放（201）的差异在哪一步产生。
const env = typeof tjs === 'undefined' ? process.env : tjs.env
const proxyOrigin = (env.PROXY_ORIGIN || 'http://127.0.0.1:5344').replace(/\/$/, '')
const alistOrigin = (env.ALIST_ORIGIN || 'http://10.0.2.2:5244').replace(/\/$/, '')
const alistUser = env.ALIST_USERNAME || 'admin'
const alistPassword = env.ALIST_PASSWORD || ''
const appPassword = env.APP_PASSWORD || '123456'
if (!alistPassword) throw new Error('API_SETUP_ERROR ALIST_PASSWORD is required')
const ts = Date.now()
const topName = `_d01_${ts}`
const testDir = `/会员/${topName}`
const subName = '可见目录'
const copyDir = 'dav 复制目标'
const fileName = 'dav 样例.txt'
const renamed = 'renamed 样例.txt'
const moved = 'moved 样例.txt'
const payload = new TextEncoder().encode('d01 replay payload 0123456789')
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
  console.log(`D01R ${label.padEnd(40)} ${r.status} ${text.slice(0, 140).replace(/\s+/g, ' ')}`)
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
testConfig.passwdList = [{ password: 'd01-password', describe: 'd01', encType: 'aesctr', enable: true, encName: true, encFolder: true, encSuffix: '', encPath: [`${topName}.*`] }]
await jf(`${proxyOrigin}/enc-api/saveAlistConfig`, { method: 'POST', headers: appHeaders, body: JSON.stringify(testConfig) })
const alistLogin = await jf(`${alistOrigin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: alistUser, password: alistPassword }) })
const alistHeaders = { authorization: alistLogin.data?.data?.token, 'content-type': 'application/json' }

try {
  await jf(`${proxyOrigin}/api/fs/mkdir`, { method: 'POST', headers: alistHeaders, body: JSON.stringify({ path: `${testDir}/${subName}` }) })
  await step('PUT f (C02 形态)', 'PUT', `/dav${testDir}/${subName}/${fileName}`, davAuth, payload)
  await step('MKCOL 复制目标 (C07 前置)', 'MKCOL', `/dav${testDir}/${subName}/${copyDir}`, davAuth)
  await step('COPY f → 复制目标/f (C07)', 'COPY', `/dav${testDir}/${subName}/${fileName}`, { ...davAuth, destination: davDest(`/dav${testDir}/${subName}/${copyDir}/${fileName}`), overwrite: 'T' })
  await step('PROPFIND 父目录 (C07 后置)', 'PROPFIND', `/dav${testDir}/${subName}`, { ...davAuth, depth: '1' })
  await step('PROPFIND 复制目录 (C07 后置)', 'PROPFIND', `/dav${testDir}/${subName}/${copyDir}`, { ...davAuth, depth: '1' })
  await step('GET 复制件 (C07 后置)', 'GET', `/dav${testDir}/${subName}/${copyDir}/${fileName}`, davAuth)
  await step('MOVE 复制目录/f → renamed (C08)', 'MOVE', `/dav${testDir}/${subName}/${copyDir}/${fileName}`, { ...davAuth, destination: davDest(`/dav${testDir}/${subName}/${copyDir}/${renamed}`) })
  await step('PROPFIND 复制目录 (C08 后置)', 'PROPFIND', `/dav${testDir}/${subName}/${copyDir}`, { ...davAuth, depth: '1' })
  await step('DELETE 复制目录/renamed (C09)', 'DELETE', `/dav${testDir}/${subName}/${copyDir}/${renamed}`, davAuth)
  await step('PROPFIND 复制目录 (C09 后置)', 'PROPFIND', `/dav${testDir}/${subName}/${copyDir}`, { ...davAuth, depth: '1' })
  await step('MKCOL 复制目标 (D01 前置,405)', 'MKCOL', `/dav${testDir}/${subName}/${copyDir}`, davAuth)
  await step('PUT 复制目录/f (D01 前置)', 'PUT', `/dav${testDir}/${subName}/${copyDir}/${fileName}`, davAuth, payload)
  await step('PROPFIND 复制目录 (D01 前置,dao 预热)', 'PROPFIND', `/dav${testDir}/${subName}/${copyDir}`, { ...davAuth, depth: '1' })
  const mv = await step('MOVE 复制目录/f → 可见目录/moved (D01)', 'MOVE', `/dav${testDir}/${subName}/${copyDir}/${fileName}`, { ...davAuth, destination: davDest(`/dav${testDir}/${subName}/${moved}`) })
  console.log(`D01R 最终 MOVE 状态=${mv.status} body=${JSON.stringify(mv.text.slice(0, 300))}`)
  await step('PROPFIND 可见目录 (D01 后置)', 'PROPFIND', `/dav${testDir}/${subName}`, { ...davAuth, depth: '1' })
  await step('GET 可见目录/moved (D01 后置)', 'GET', `/dav${testDir}/${subName}/${moved}`, davAuth)
} catch (error) {
  console.log(`D01R_EXCEPTION ${String(error?.message || error)}`)
} finally {
  try {
    await jf(`${alistOrigin}/api/fs/remove`, { method: 'POST', headers: alistHeaders, body: JSON.stringify({ dir: '/会员', names: [topName] }) })
  } catch {}
  try {
    await jf(`${proxyOrigin}/enc-api/saveAlistConfig`, { method: 'POST', headers: appHeaders, body: JSON.stringify(originalConfig) })
  } catch {}
}
console.log('D01R_DONE')
