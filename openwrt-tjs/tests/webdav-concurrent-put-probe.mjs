// 目的：判定「两路并发 PUT」在 txiki 运行时上是否可用。
// 套件 D03 用 200KB + 128KB 两路并发 PUT 时，其中一路抛出
// `Network request failed: Timed out waiting server reply`——需要分清是
//   (a) 并发本身的问题，(b) 大体积流式上传的问题，
//   (c) 只是这一次的环境抖动。
// 因此本探针按「串行小、并发小、串行大、并发大」四档对照，逐档打印耗时与异常。
//
// 用法（guest）：
//   ALIST_PASSWORD='…' PROXY_ORIGIN=http://127.0.0.1:5344 /usr/bin/tjs run /mnt/host/tests/webdav-concurrent-put-probe.mjs
const env = typeof tjs === 'undefined' ? process.env : tjs.env
const proxyOrigin = (env.PROXY_ORIGIN || 'http://127.0.0.1:5344').replace(/\/$/, '')
const alistOrigin = (env.ALIST_ORIGIN || 'http://10.0.2.2:5244').replace(/\/$/, '')
const alistUser = env.ALIST_USERNAME || 'admin'
const alistPassword = env.ALIST_PASSWORD || ''
const appPassword = env.APP_PASSWORD || '123456'
if (!alistPassword) throw new Error('API_SETUP_ERROR ALIST_PASSWORD is required')

const ts = Date.now()
const topName = `_conc_${ts}`
const testDir = `/会员/${topName}`
const davAuth = { authorization: 'Basic ' + btoa(`${alistUser}:${alistPassword}`) }
const davUrl = (p) => `${proxyOrigin}${encodeURI(p)}`

function makePayload(size, seed = 7) {
  const payload = new Uint8Array(size)
  for (let i = 0; i < size; i++) payload[i] = (i * 31 + seed) & 0xff
  return payload
}

async function jf(url, options = {}) {
  const response = await fetch(url, options)
  const text = await response.text()
  let data = null
  try { data = JSON.parse(text) } catch {}
  return { response, text, data }
}

async function timedPut(label, path, payload) {
  const t0 = Date.now()
  try {
    const response = await fetch(davUrl(path), { method: 'PUT', headers: davAuth, body: payload })
    const text = await response.text()
    return { label, ok: true, status: response.status, ms: Date.now() - t0, body: text.slice(0, 80) }
  } catch (error) {
    return { label, ok: false, status: null, ms: Date.now() - t0, error: String(error?.message || error) }
  }
}

async function timedGet(label, path) {
  const t0 = Date.now()
  try {
    const response = await fetch(davUrl(path), { headers: davAuth })
    const bytes = new Uint8Array(await response.arrayBuffer())
    return { label, ok: true, status: response.status, ms: Date.now() - t0, length: bytes.byteLength, bytes }
  } catch (error) {
    return { label, ok: false, status: null, ms: Date.now() - t0, error: String(error?.message || error) }
  }
}

const report = (r) => console.log(`CONC ${JSON.stringify(r)}`)

const login = await jf(`${proxyOrigin}/enc-api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: appPassword }),
})
const appToken = login.data?.data?.jwtToken
if (!appToken) throw new Error(`app login failed: ${login.text.slice(0, 160)}`)
const appHeaders = { authorizetoken: appToken, 'content-type': 'application/json' }

const current = await jf(`${proxyOrigin}/enc-api/getAlistConfig`, { method: 'POST', headers: { authorizetoken: appToken } })
const originalConfig = current.data?.data
if (!originalConfig) throw new Error('alist config unavailable')
const testConfig = JSON.parse(JSON.stringify(originalConfig))
testConfig.passwdList = [
  {
    password: 'conc-probe-password',
    describe: 'conc-probe',
    encType: 'aesctr',
    enable: true,
    encName: true,
    encFolder: true,
    encSuffix: '',
    encPath: [`${topName}.*`],
  },
]
const saved = await jf(`${proxyOrigin}/enc-api/saveAlistConfig`, { method: 'POST', headers: appHeaders, body: JSON.stringify(testConfig) })
console.log(`CONC_RULES ${JSON.stringify({ code: saved.data?.code, encPath: testConfig.passwdList[0].encPath })}`)

const alistLogin = await jf(`${alistOrigin}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: alistUser, password: alistPassword }),
})
const alistHeaders = { authorization: alistLogin.data?.data?.token, 'content-type': 'application/json' }

try {
  await jf(`${proxyOrigin}/api/fs/mkdir`, { method: 'POST', headers: alistHeaders, body: JSON.stringify({ path: `${testDir}/并发` }) })
  const dir = `/dav${testDir}/并发`

  // 1) 串行 1KB（对照：证明单路基本可用）
  report(await timedPut('serial-1k', `${dir}/s1.bin`, makePayload(1024, 1)))
  report(await timedPut('serial-1k-2', `${dir}/s2.bin`, makePayload(1024, 2)))

  // 2) 并发 2×1KB
  {
    const [a, b] = await Promise.all([
      timedPut('conc-1k-a', `${dir}/c1.bin`, makePayload(1024, 11)),
      timedPut('conc-1k-b', `${dir}/c2.bin`, makePayload(1024, 12)),
    ])
    report(a); report(b)
  }

  // 3) 串行 200KB（对照：证明大体积单路可用）
  report(await timedPut('serial-200k', `${dir}/s200.bin`, makePayload(204800, 21)))

  // 4) 并发 200KB + 128KB（复现 D03 的形态）
  {
    const [a, b] = await Promise.all([
      timedPut('conc-200k', `${dir}/c200.bin`, makePayload(204800, 31)),
      timedPut('conc-128k', `${dir}/c128.bin`, makePayload(131072, 32)),
    ])
    report(a); report(b)
  }

  // 5) 复核：并发写入的两个文件解密后是否与明文逐字节一致
  for (const [label, name, size, seed] of [['verify-200k', 'c200.bin', 204800, 31], ['verify-128k', 'c128.bin', 131072, 32]]) {
    const got = await timedGet(label, `${dir}/${name}`)
    const expected = makePayload(size, seed)
    let same = got.ok && got.length === size
    if (same) for (let i = 0; i < size; i++) if (got.bytes[i] !== expected[i]) { same = false; break }
    report({ label, ok: got.ok, status: got.status, ms: got.ms, length: got.length, bytesMatch: same })
  }
} catch (error) {
  console.log(`CONC_EXCEPTION ${String(error?.message || error)}`)
} finally {
  try {
    const top = await jf(`${alistOrigin}/api/fs/list`, { method: 'POST', headers: alistHeaders, body: JSON.stringify({ path: '/会员', page: 1, per_page: 200, refresh: true }) })
    const hit = (top.data?.data?.content || []).find((i) => i.is_dir && i.name.startsWith('_conc'))
    if (hit) {
      const rm = await jf(`${alistOrigin}/api/fs/remove`, { method: 'POST', headers: alistHeaders, body: JSON.stringify({ dir: '/会员', names: [hit.name] }) })
      console.log(`CONC_CLEANUP ${JSON.stringify({ name: hit.name, code: rm.data?.code })}`)
    }
  } catch (e) {
    console.log(`CONC_CLEANUP_ERROR ${String(e?.message || e)}`)
  }
  try {
    await jf(`${proxyOrigin}/enc-api/saveAlistConfig`, { method: 'POST', headers: appHeaders, body: JSON.stringify(originalConfig) })
  } catch {}
}
console.log('CONC_DONE')
