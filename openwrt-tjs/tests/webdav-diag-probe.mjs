const env = typeof tjs === 'undefined' ? process.env : tjs.env
const proxyOrigin = (env.PROXY_ORIGIN || 'http://127.0.0.1:5344').replace(/\/$/, '')
const alistOrigin = (env.ALIST_ORIGIN || 'http://127.0.0.1:5244').replace(/\/$/, '')
const appPassword = env.APP_PASSWORD || '123456'
const alistPassword = env.ALIST_PASSWORD || ''
if (!alistPassword) throw new Error('ALIST_PASSWORD is required')

const stamp = Date.now()
const topName = `_davdiag_${stamp}`
const testDir = `/会员/${topName}`
const subName = '可见目录'
const fileName = 'diag 样例.txt'
const payload = new TextEncoder().encode('diag webdav probe 0123456789 ABCDEF')
const davAuth = { authorization: 'Basic ' + btoa(`admin:${alistPassword}`) }
const DAV_ENCODE = env.DAV_ENCODE !== '0'
const davUrl = (path) => proxyOrigin + (DAV_ENCODE ? encodeURI(path) : path)

async function jf(url, options = {}) {
  const response = await fetch(url, options)
  const text = await response.text()
  let data = null
  try { data = JSON.parse(text) } catch {}
  return { response, text, data }
}
const code = (x) => x.data?.code ?? null

async function main() {
  const out = { topName, testDir, davPath: `/dav${testDir}/${subName}/${fileName}` }

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
  out.ruleApplied = { code: code(saved), encPath: rule.encPath }
  if (code(saved) !== 200) throw new Error(`rule save failed: ${saved.text.slice(0, 200)}`)

  const alistLogin = await jf(`${proxyOrigin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: alistPassword }),
  })
  const alistToken = alistLogin.data?.data?.token
  if (!alistToken) throw new Error(`alist login failed: ${alistLogin.text.slice(0, 160)}`)
  const authHeaders = { authorization: alistToken, 'content-type': 'application/json' }

  try {
    const mkdir = await jf(`${proxyOrigin}/api/fs/mkdir`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ path: `${testDir}/${subName}` }) })
    out.mkdir = { code: code(mkdir), msg: mkdir.data?.message }

    const put = await jf(davUrl(`/dav${testDir}/${subName}/${fileName}`), { method: 'PUT', headers: davAuth, body: payload })
    out.put = { status: put.response.status, text: put.text.slice(0, 120) }

    const propRoot = await jf(davUrl(`/dav${testDir}`), { method: 'PROPFIND', headers: { ...davAuth, depth: '1' } })
    out.propRoot = { status: propRoot.response.status, xml: propRoot.text.slice(0, 3000) }

    const propSub = await jf(davUrl(`/dav${testDir}/${subName}`), { method: 'PROPFIND', headers: { ...davAuth, depth: '1' } })
    out.propSub = { status: propSub.response.status, xml: propSub.text.slice(0, 3000) }

    const get = await fetch(davUrl(`/dav${testDir}/${subName}/${fileName}`), { method: 'GET', headers: davAuth })
    const getBytes = new Uint8Array(await get.arrayBuffer())
    out.get = {
      status: get.status,
      headers: Object.fromEntries([...get.headers.entries()]),
      byteLength: getBytes.byteLength,
      ascii: new TextDecoder().decode(getBytes.slice(0, 160)),
      hex: Array.from(getBytes.slice(0, 48), (v) => v.toString(16).padStart(2, '0')).join(''),
    }

    const getRange = await fetch(davUrl(`/dav${testDir}/${subName}/${fileName}`), { method: 'GET', headers: { ...davAuth, range: 'bytes=4-' } })
    const rangeBytes = new Uint8Array(await getRange.arrayBuffer())
    out.getRange = { status: getRange.status, byteLength: rangeBytes.byteLength, ascii: new TextDecoder().decode(rangeBytes.slice(0, 60)) }

    // 云端直查：加密子目录名 + 文件名 + 内容
    const cloudTop = await jf(`${alistOrigin}/api/fs/list`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ path: testDir, page: 1, per_page: 100, refresh: true }) })
    const cloudTopNames = (cloudTop.data?.data?.content || []).map((i) => i.name)
    out.cloudTopNames = cloudTopNames
    const cloudSubName = cloudTopNames[0]
    if (cloudSubName) {
      const cloudSub = await jf(`${alistOrigin}/api/fs/list`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ path: `${testDir}/${cloudSubName}`, page: 1, per_page: 100, refresh: true }) })
      const cloudFileNames = (cloudSub.data?.data?.content || []).map((i) => i.name)
      out.cloudFileNames = cloudFileNames
      const cloudFileName = cloudFileNames.find((n) => !n.endsWith('/'))
      if (cloudFileName) {
        const cloudGet = await jf(`${alistOrigin}/api/fs/get`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ path: `${testDir}/${cloudSubName}/${cloudFileName}` }) })
        const rawUrl = cloudGet.data?.data?.raw_url
        out.cloudGet = { code: code(cloudGet), rawUrl: rawUrl ? rawUrl.replace(rawUrl.split('?')[0], '<url>') : null }
        if (rawUrl) {
          const u = new URL(rawUrl, alistOrigin)
          const direct = await fetch(`${alistOrigin}${u.pathname}${u.search}`)
          const directBytes = new Uint8Array(await direct.arrayBuffer())
          out.cloudRaw = { status: direct.status, byteLength: directBytes.byteLength, hex: Array.from(directBytes.slice(0, 24), (v) => v.toString(16).padStart(2, '0')).join('') }
        }
      }
    }
    out.plainHex = Array.from(payload, (v) => v.toString(16).padStart(2, '0')).join('')
  } finally {
    try {
      await jf(`${proxyOrigin}/api/fs/remove`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ dir: testDir, names: [] }) })
      const top = await jf(`${alistOrigin}/api/fs/list`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ path: '/会员', page: 1, per_page: 200, refresh: true }) })
      const name = (top.data?.data?.content || []).find((i) => i.is_dir && i.name.includes('davdiag'))
      if (name) {
        // 加密目录只能按云端密文名直接经 AList 删除
        await jf(`${alistOrigin}/api/fs/remove`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ dir: '/会员', names: [name.name] }) })
      }
    } catch {}
    try {
      await jf(`${proxyOrigin}/enc-api/saveAlistConfig`, { method: 'POST', headers: appHeaders, body: JSON.stringify(currentConfig) })
    } catch {}
  }

  console.log(JSON.stringify(out, null, 1))
}

await main()
