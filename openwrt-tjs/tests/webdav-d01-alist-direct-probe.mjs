// 目的：判别 D01 跨目录 MOVE 500 是「AList 侧对密文名的跨目录 MOVE 不支持」
// 还是「代理改写路径后 AList 才失败」。
// 方法：经代理 PUT 出密文文件 → 用 AList API 直接列出云端密文名 →
// 直连 AList WebDAV 做同目录 MOVE（对照）与跨目录 MOVE（实验），打印状态与响应体。
const env = typeof tjs === 'undefined' ? process.env : tjs.env
const proxyOrigin = (env.PROXY_ORIGIN || 'http://127.0.0.1:5344').replace(/\/$/, '')
const alistOrigin = (env.ALIST_ORIGIN || 'http://10.0.2.2:5244').replace(/\/$/, '')
const alistUser = env.ALIST_USERNAME || 'admin'
const alistPassword = env.ALIST_PASSWORD || ''
const appPassword = env.APP_PASSWORD || '123456'
if (!alistPassword) throw new Error('API_SETUP_ERROR ALIST_PASSWORD is required')
const ts = Date.now()
const topName = `_d01d_${ts}`
const testDir = `/会员/${topName}`
const subName = '可见目录'
const sub2Name = '第二目录'
const copyDir = 'dav 复制目标'
const fileName = 'dav 样例.txt'
const payload = new TextEncoder().encode('d01 direct discriminate payload')
const davAuth = { authorization: 'Basic ' + btoa(`${alistUser}:${alistPassword}`) }

async function jf(url, options = {}) {
  const response = await fetch(url, options)
  const text = await response.text()
  let data = null
  try { data = JSON.parse(text) } catch {}
  return { response, text, data }
}
function enc(path) {
  return path.split('/').map(encodeURIComponent).join('/')
}
async function davStep(label, origin, method, path, headers = {}, body) {
  const r = await fetch(`${origin}${enc(path)}`, { method, headers, body })
  const text = await r.text()
  console.log(`D01D ${label.padEnd(46)} ${r.status} ${text.slice(0, 160).replace(/\s+/g, ' ')}`)
  return { status: r.status, text }
}
async function alistList(path) {
  const r = await jf(`${alistOrigin}/api/fs/list`, {
    method: 'POST', headers: alistHeaders,
    body: JSON.stringify({ path, password: '', page: 1, per_page: 100, refresh: true }),
  })
  return (r.data?.data?.content || []).map((x) => x.name)
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
testConfig.passwdList = [{ password: 'd01d-password', describe: 'd01d', encType: 'aesctr', enable: true, encName: true, encFolder: true, encSuffix: '', encPath: [`${topName}.*`] }]
await jf(`${proxyOrigin}/enc-api/saveAlistConfig`, { method: 'POST', headers: appHeaders, body: JSON.stringify(testConfig) })
const alistLogin = await jf(`${alistOrigin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: alistUser, password: alistPassword }) })
const alistHeaders = { authorization: alistLogin.data?.data?.token, 'content-type': 'application/json' }

try {
  // 1) 经代理建目录、PUT 文件（产生密文实体）
  await jf(`${proxyOrigin}/api/fs/mkdir`, { method: 'POST', headers: alistHeaders, body: JSON.stringify({ path: `${testDir}/${subName}/${copyDir}` }) })
  await jf(`${proxyOrigin}/api/fs/mkdir`, { method: 'POST', headers: alistHeaders, body: JSON.stringify({ path: `${testDir}/${sub2Name}` }) })
  await davStep('代理 PUT 复制目录/f', proxyOrigin, 'PUT', `/dav${testDir}/${subName}/${copyDir}/${fileName}`, davAuth, payload)

  // 2) AList API 直列云端，拿密文名
  const topList = await alistList(testDir)
  console.log(`D01D 云端 ${topName} 下: ${JSON.stringify(topList)}`)
  const encSub = topList.find((n) => n !== sub2Name && !n.startsWith('orig_'))
  const encSub2 = topList.find((n) => n !== encSub)
  const subList = await alistList(`${testDir}/${encSub}`)
  console.log(`D01D 云端 可见目录(密文=${encSub}) 下: ${JSON.stringify(subList)}`)
  const encCopy = subList[0]
  const copyList = await alistList(`${testDir}/${encSub}/${encCopy}`)
  console.log(`D01D 云端 复制目录(密文=${encCopy}) 下: ${JSON.stringify(copyList)}`)
  const encF = copyList[0]
  if (!encSub || !encCopy || !encF) throw new Error('密文名枚举失败')

  // 3) 直连 AList WebDAV（不经过代理）：
  const src = `/dav${testDir}/${encSub}/${encCopy}/${encF}`
  // 3a 对照：同目录 MOVE（密文名）。Destination authority 必须无端口——txiki 发出的 Host 头不带端口，
  // AList 做字符串比较，带端口会被判跨服务器而 502（与 r10 destination-authority 修正同一机理）。
  const bareOrigin = `http://${alistUrl.hostname}`
  await davStep('直连AList MOVE 同目录(对照)', alistOrigin, 'MOVE', src, { ...davAuth, destination: `${bareOrigin}/dav${enc(`${testDir}/${encSub}/${encCopy}/same_${encF}`)}` })
  // 3b 实验：跨目录 MOVE（密文名，复制目录 → 第二目录）
  const mv = await davStep('直连AList MOVE 跨目录(实验)', alistOrigin, 'MOVE', src, { ...davAuth, destination: `${bareOrigin}/dav${enc(`${testDir}/${encSub2}/${encF}`)}` })
  console.log(`D01D 直连跨目录 MOVE 状态=${mv.status} body=${JSON.stringify(mv.text.slice(0, 300))}`)
  // 3c 对照：跨目录 COPY（密文名）——应先 PUT 一个新文件再 COPY
  await davStep('代理 PUT 复制目录/f2', proxyOrigin, 'PUT', `/dav${testDir}/${subName}/${copyDir}/f2.txt`, davAuth, payload)
  const copyList2 = await alistList(`${testDir}/${encSub}/${encCopy}`)
  const encF2 = copyList2.find((n) => n !== encF)
  const cp = await davStep('直连AList COPY 跨目录(对照)', alistOrigin, 'COPY', `/dav${testDir}/${encSub}/${encCopy}/${encF2}`, { ...davAuth, destination: `${bareOrigin}/dav${enc(`${testDir}/${encSub2}/${encF2}`)}`, overwrite: 'T' })
  console.log(`D01D 直连跨目录 COPY 状态=${cp.status} body=${JSON.stringify(cp.text.slice(0, 300))}`)
} catch (error) {
  console.log(`D01D_EXCEPTION ${String(error?.message || error)}`)
} finally {
  try {
    await jf(`${alistOrigin}/api/fs/remove`, { method: 'POST', headers: alistHeaders, body: JSON.stringify({ dir: '/会员', names: [topName] }) })
  } catch {}
  try {
    await jf(`${proxyOrigin}/enc-api/saveAlistConfig`, { method: 'POST', headers: appHeaders, body: JSON.stringify(originalConfig) })
  } catch {}
}
console.log('D01D_DONE')
