// 目的：对照「MKCOL 之后立即 PROPFIND 新目录」在带/不带尾斜杠时的行为，
// 判定 cfx-probe 里的 PROPFIND 404 是不是只因缺少尾斜杠。
const env = typeof tjs === 'undefined' ? process.env : tjs.env
const proxyOrigin = (env.PROXY_ORIGIN || 'http://127.0.0.1:5344').replace(/\/$/, '')
const alistOrigin = (env.ALIST_ORIGIN || 'http://10.0.2.2:5244').replace(/\/$/, '')
const alistUser = env.ALIST_USERNAME || 'admin'
const alistPassword = env.ALIST_PASSWORD || ''
const appPassword = env.APP_PASSWORD || '123456'
if (!alistPassword) throw new Error('API_SETUP_ERROR ALIST_PASSWORD is required')
const ts = Date.now()
const topName = `_pfs_${ts}`
const testDir = `/会员/${topName}`
const subName = '可见目录'
const davAuth = { authorization: 'Basic ' + btoa(`${alistUser}:${alistPassword}`) }
const davUrl = (p) => `${proxyOrigin}${encodeURI(p)}`

async function jf(url, options = {}) {
  const response = await fetch(url, options)
  const text = await response.text()
  let data = null
  try { data = JSON.parse(text) } catch {}
  return { response, text, data }
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
testConfig.passwdList = [{ password: 'pfs-password', describe: 'pfs', encType: 'aesctr', enable: true, encName: true, encFolder: true, encSuffix: '', encPath: [`${topName}.*`] }]
await jf(`${proxyOrigin}/enc-api/saveAlistConfig`, { method: 'POST', headers: appHeaders, body: JSON.stringify(testConfig) })
const alistLogin = await jf(`${alistOrigin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: alistUser, password: alistPassword }) })
const alistHeaders = { authorization: alistLogin.data?.data?.token, 'content-type': 'application/json' }

try {
  await jf(`${proxyOrigin}/api/fs/mkdir`, { method: 'POST', headers: alistHeaders, body: JSON.stringify({ path: `${testDir}/${subName}` }) })
  const newDir = `dav 复制目标`
  const mkcol = await fetch(davUrl(`/dav${testDir}/${subName}/${newDir}`), { method: 'MKCOL', headers: davAuth })
  console.log(`MKCOL ${mkcol.status}`)
  await mkcol.text()

  for (const [tag, p] of [['无尾斜杠', `/dav${testDir}/${subName}/${newDir}`], ['带尾斜杠', `/dav${testDir}/${subName}/${newDir}/`]]) {
    const r = await fetch(davUrl(p), { method: 'PROPFIND', headers: { ...davAuth, depth: '1' } })
    const text = await r.text()
    console.log(`PROPFIND ${tag} ${r.status} body=${text.slice(0, 160).replace(/\s+/g, ' ')}`)
  }
  // 对照：API 建目录后的 PROPFIND
  for (const [tag, p] of [['可见目录(无尾斜杠)', `/dav${testDir}/${subName}`], ['可见目录(带尾斜杠)', `/dav${testDir}/${subName}/`]]) {
    const r = await fetch(davUrl(p), { method: 'PROPFIND', headers: { ...davAuth, depth: '1' } })
    const text = await r.text()
    console.log(`PROPFIND ${tag} ${r.status} body=${text.slice(0, 120).replace(/\s+/g, ' ')}`)
  }
} catch (error) {
  console.log(`PFS_EXCEPTION ${String(error?.message || error)}`)
} finally {
  try {
    await jf(`${alistOrigin}/api/fs/remove`, { method: 'POST', headers: alistHeaders, body: JSON.stringify({ dir: '/会员', names: [topName] }) })
  } catch {}
  try {
    await jf(`${proxyOrigin}/enc-api/saveAlistConfig`, { method: 'POST', headers: appHeaders, body: JSON.stringify(originalConfig) })
  } catch {}
}
console.log('PFS_DONE')
