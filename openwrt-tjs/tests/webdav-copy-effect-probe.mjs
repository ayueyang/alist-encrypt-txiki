// 目的：在 guest 内经代理完整重放套件 C07 的形态（MKCOL 目标目录 → PUT →
// 跨目录同名 COPY），并在每一步之后同时用【代理视角】和【AList 云端视角】
// 对照列表，判断「2xx 但目标为空」到底是复制没发生、还是落到别处、还是
// 代理侧列表翻译有问题。
//
// 用法（guest）：
//   ALIST_PASSWORD='…' PROXY_ORIGIN=http://127.0.0.1:5344 /usr/bin/tjs run /mnt/host/tests/webdav-copy-effect-probe.mjs
const env = typeof tjs === 'undefined' ? process.env : tjs.env
const proxyOrigin = (env.PROXY_ORIGIN || 'http://127.0.0.1:5344').replace(/\/$/, '')
const alistOrigin = (env.ALIST_ORIGIN || 'http://10.0.2.2:5244').replace(/\/$/, '')
const alistUser = env.ALIST_USERNAME || 'admin'
const alistPassword = env.ALIST_PASSWORD || ''
const appPassword = env.APP_PASSWORD || '123456'
if (!alistPassword) throw new Error('API_SETUP_ERROR ALIST_PASSWORD is required')

const ts = Date.now()
const topName = `_cfx_${ts}`
const testDir = `/会员/${topName}`
const subName = '可见目录'
const copyDirName = 'dav 复制目标'
const fileName = '原文样例.txt'
const payload = new TextEncoder().encode('copy effect probe payload')

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
async function apiList(origin, headers, path) {
  const r = await jf(`${origin}/api/fs/list`, { method: 'POST', headers, body: JSON.stringify({ path, page: 1, per_page: 100, refresh: true }) })
  return { code: r.data?.code, msg: r.data?.message, names: (r.data?.data?.content || []).map((i) => i.name) }
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
if (!originalConfig) throw new Error('alist config unavailable')
const testConfig = JSON.parse(JSON.stringify(originalConfig))
// 注意：套件跑完会把配置恢复为「历史持久化值」（可能指向不可达的历史内网地址），
// 所以这里必须显式下发 ALIST_ORIGIN 对应的端点，不能继承当前值。
const alistUrl = new URL(alistOrigin)
testConfig.serverHost = alistUrl.hostname
testConfig.serverPort = alistUrl.port || (alistUrl.protocol === 'https:' ? '443' : '80')
testConfig.https = alistUrl.protocol === 'https:'
testConfig.passwdList = [{ password: 'cfx-password', describe: 'cfx', encType: 'aesctr', enable: true, encName: true, encFolder: true, encSuffix: '', encPath: [`${topName}.*`] }]
await jf(`${proxyOrigin}/enc-api/saveAlistConfig`, { method: 'POST', headers: appHeaders, body: JSON.stringify(testConfig) })
console.log(`CFX_RULES ${JSON.stringify(testConfig.passwdList[0])}`)

const alistLogin = await jf(`${alistOrigin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: alistUser, password: alistPassword }) })
const alistHeaders = { authorization: alistLogin.data?.data?.token, 'content-type': 'application/json' }

async function dump(stage) {
  const top = await apiList(alistOrigin, alistHeaders, testDir)
  const cloudSub = top.names[0] ? await apiList(alistOrigin, alistHeaders, `${testDir}/${top.names[0]}`) : { names: [] }
  const proxySub = await apiList(proxyOrigin, alistHeaders, `${testDir}/${subName}`)
  const proxyCopy = await apiList(proxyOrigin, alistHeaders, `${testDir}/${subName}/${copyDirName}`)
  const cloudCopy = top.names[0] && cloudSub.names.length
    ? await apiList(alistOrigin, alistHeaders, `${testDir}/${top.names[0]}/${cloudSub.names.find((n) => n !== '') || ''}`)
    : { names: [] }
  console.log(`CFX_STATE ${stage} cloudTop=${JSON.stringify(top.names)} cloudSub=${JSON.stringify(cloudSub.names)} proxySub=${JSON.stringify(proxySub.names)} proxyCopy=${JSON.stringify(proxyCopy.names)} cloudFirstChild=${JSON.stringify(cloudCopy.names)}`)
}

try {
  await jf(`${proxyOrigin}/api/fs/mkdir`, { method: 'POST', headers: alistHeaders, body: JSON.stringify({ path: `${testDir}/${subName}` }) })
  await dump('after-mkdir')

  const mkcol = await fetch(davUrl(`/dav${testDir}/${subName}/${copyDirName}`), { method: 'MKCOL', headers: davAuth })
  const mkcolText = await mkcol.text()
  console.log(`CFX MKCOL ${mkcol.status} ${mkcolText.slice(0, 120)}`)
  await dump('after-mkcol')

  const put = await fetch(davUrl(`/dav${testDir}/${subName}/${fileName}`), { method: 'PUT', headers: davAuth, body: payload })
  console.log(`CFX PUT ${put.status} ${(await put.text()).slice(0, 80)}`)
  await dump('after-put')

  const copy = await fetch(davUrl(`/dav${testDir}/${subName}/${fileName}`), {
    method: 'COPY',
    headers: { ...davAuth, destination: davDest(`/dav${testDir}/${subName}/${copyDirName}/${fileName}`), overwrite: 'T' },
  })
  const copyText = await copy.text()
  console.log(`CFX COPY ${copy.status} ${JSON.stringify(Object.fromEntries([...copy.headers]))} body=${copyText.slice(0, 200)}`)
  await dump('after-copy')

  // 直接复核目标路径（不先 PROPFIND）
  const get1 = await fetch(davUrl(`/dav${testDir}/${subName}/${copyDirName}/${fileName}`), { headers: davAuth })
  console.log(`CFX GET 复制件(经代理,未先PROPFIND) ${get1.status}`)
  await get1.text()

  // 真实客户端的顺序：COPY 之后先 PROPFIND 目标目录，再 GET。
  // 代理的明文→密文翻译依赖自身 dao 缓存，PROPFIND 会把服务端副本登记进缓存。
  const pf = await fetch(davUrl(`/dav${testDir}/${subName}/${copyDirName}`), { method: 'PROPFIND', headers: { ...davAuth, depth: '1' } })
  const pfText = await pf.text()
  console.log(`CFX PROPFIND 复制目标 ${pf.status} body=${pfText.slice(0, 200)}`)
  const get2 = await fetch(davUrl(`/dav${testDir}/${subName}/${copyDirName}/${fileName}`), { headers: davAuth })
  const get2Text = await get2.text()
  console.log(`CFX GET 复制件(经代理,PROPFIND后) ${get2.status} body-head=${get2Text.slice(0, 40)}`)

  // 第二阶段：重放 D01（跨目录 + 改名 MOVE）
  const file2 = '第二样例.txt'
  const put2 = await fetch(davUrl(`/dav${testDir}/${subName}/${copyDirName}/${file2}`), { method: 'PUT', headers: davAuth, body: payload })
  console.log(`CFX PUT2 ${put2.status} ${(await put2.text()).slice(0, 60)}`)
  const mv = await fetch(davUrl(`/dav${testDir}/${subName}/${copyDirName}/${file2}`), {
    method: 'MOVE',
    headers: { ...davAuth, destination: davDest(`/dav${testDir}/${subName}/移动样例.txt`) },
  })
  console.log(`CFX MOVE 跨目录+改名 ${mv.status} ${(await mv.text()).slice(0, 160)}`)

  // 第三阶段：重放 C08（同目录改名 MOVE）
  const mv2 = await fetch(davUrl(`/dav${testDir}/${subName}/${fileName}`), {
    method: 'MOVE',
    headers: { ...davAuth, destination: davDest(`/dav${testDir}/${subName}/改名样例.txt`) },
  })
  console.log(`CFX MOVE 同目录改名 ${mv2.status} ${(await mv2.text()).slice(0, 160)}`)
  await dump('after-moves')
} catch (error) {
  console.log(`CFX_EXCEPTION ${String(error?.message || error)}`)
} finally {
  try {
    const rm = await jf(`${alistOrigin}/api/fs/remove`, { method: 'POST', headers: alistHeaders, body: JSON.stringify({ dir: '/会员', names: [topName] }) })
    console.log(`CFX_CLEANUP ${rm.data?.code}`)
  } catch {}
  try {
    await jf(`${proxyOrigin}/enc-api/saveAlistConfig`, { method: 'POST', headers: appHeaders, body: JSON.stringify(originalConfig) })
  } catch {}
}
console.log('CFX_DONE')
