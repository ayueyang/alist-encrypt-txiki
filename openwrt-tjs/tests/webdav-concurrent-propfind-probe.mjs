// 目的：快速验证 D03c 的断言逻辑（并发两路 PROPFIND → 比对解码后的明文名集合）。
// 在 guest 内用 /usr/bin/tjs 运行；自建隔离目录并在结束时删除。
const env = typeof tjs === 'undefined' ? process.env : tjs.env
const proxyOrigin = (env.PROXY_ORIGIN || 'http://127.0.0.1:5344').replace(/\/$/, '')
const alistOrigin = (env.ALIST_ORIGIN || 'http://10.0.2.2:5244').replace(/\/$/, '')
const alistUser = env.ALIST_USERNAME || 'admin'
const alistPassword = env.ALIST_PASSWORD || ''
const appPassword = env.APP_PASSWORD || '123456'
if (!alistPassword) throw new Error('API_SETUP_ERROR ALIST_PASSWORD is required')
const ts = Date.now()
const topName = `_d03c_${ts}`
const testDir = `/会员/${topName}`
const sub = '可见目录'
const fileName = 'dav 样例.txt'
const payload = new TextEncoder().encode('d03c probe payload')
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
const appHeaders = { authorizetoken: appToken, 'content-type': 'application/json' }
const current = await jf(`${proxyOrigin}/enc-api/getAlistConfig`, { method: 'POST', headers: { authorizetoken: appToken } })
const originalConfig = current.data?.data
const testConfig = JSON.parse(JSON.stringify(originalConfig))
const alistUrl = new URL(alistOrigin)
testConfig.serverHost = alistUrl.hostname
testConfig.serverPort = alistUrl.port || '80'
testConfig.https = alistUrl.protocol === 'https:'
testConfig.passwdList = [{ password: 'd03c', describe: 'd03c', encType: 'aesctr', enable: true, encName: true, encFolder: true, encSuffix: '', encPath: [`${topName}.*`] }]
await jf(`${proxyOrigin}/enc-api/saveAlistConfig`, { method: 'POST', headers: appHeaders, body: JSON.stringify(testConfig) })
const alistLogin = await jf(`${alistOrigin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: alistUser, password: alistPassword }) })
const alistHeaders = { authorization: alistLogin.data?.data?.token, 'content-type': 'application/json' }

const davFolder = `/dav${testDir}/${sub}`
const namesOf = (body, exclude) =>
  (body.match(/<D:href>([^<]*)<\/D:href>/g) || [])
    .map((item) => item.replace(/<\/?D:href>/g, ''))
    .map((href) => { try { return decodeURIComponent(href).replace(/\/$/, '').split('/').pop() } catch { return href } })
    .filter((name) => name && name !== exclude)
    .sort()

try {
  await jf(`${proxyOrigin}/api/fs/mkdir`, { method: 'POST', headers: alistHeaders, body: JSON.stringify({ path: `${testDir}/${sub}` }) })
  const put = await fetch(davUrl(`${davFolder}/${fileName}`), { method: 'PUT', headers: davAuth, body: payload })
  console.log(`D03C PUT ${put.status}`)
  // dao 缓存链：必须从上层逐级浏览下来，否则单层 PROPFIND 直接 404（已由 webdav-propfind-mkcol-probe 证实）
  for (const prime of ['/dav/会员', `/dav${testDir}`, davFolder]) {
    const r = await fetch(davUrl(prime), { method: 'PROPFIND', headers: { ...davAuth, depth: '1' } })
    await r.text()
    console.log(`D03C 预热 PROPFIND ${prime} → ${r.status}`)
  }
  const [ra, rb] = await Promise.all([
    fetch(davUrl(davFolder), { method: 'PROPFIND', headers: { ...davAuth, depth: '1' } }),
    fetch(davUrl(davFolder), { method: 'PROPFIND', headers: { ...davAuth, depth: '1' } }),
  ])
  const [ta, tb] = await Promise.all([ra.text(), rb.text()])
  const na = namesOf(ta, sub)
  const nb = namesOf(tb, sub)
  console.log(`D03C 状态 ${ra.status}/${rb.status} 字节 ${ta.length}/${tb.length}`)
  console.log(`D03C 集合A ${JSON.stringify(na)}`)
  console.log(`D03C 集合B ${JSON.stringify(nb)}`)
  console.log(`D03C 集合一致=${na.join('|') === nb.join('|')} 含明文名=${na.includes(fileName)}`)
  console.log(`D03C 原始是否逐字节相同=${ta === tb}`)
} catch (error) {
  console.log(`D03C_EXCEPTION ${String(error?.message || error)}`)
} finally {
  try {
    await jf(`${alistOrigin}/api/fs/remove`, { method: 'POST', headers: alistHeaders, body: JSON.stringify({ dir: '/会员', names: [topName] }) })
  } catch {}
  try {
    await jf(`${proxyOrigin}/enc-api/saveAlistConfig`, { method: 'POST', headers: appHeaders, body: JSON.stringify(originalConfig) })
  } catch {}
}
console.log('D03C_DONE')
