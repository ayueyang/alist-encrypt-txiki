// Full A-section replication (A01-A09 exactly like api-suite) x2 rounds,
// to find which case poisons the connection state before A09's hang.
const proxyOrigin = 'http://127.0.0.1:5344'
const appPassword = '123456'
const encType = 'aesctr'
const alistUrl = new URL('http://10.0.2.100')

async function req(label, path, body, headers) {
  const ts = Date.now()
  const r = await fetch(`${proxyOrigin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text()
  console.log(`[${label}] ${r.status} ${Date.now() - ts}ms ${text.slice(0, 80)}`)
  return text
}

for (let round = 1; round <= 2; round++) {
  console.log(`=== ROUND ${round} ===`)
  try {
    const t1 = await req('A01', '/enc-api/login', { username: 'admin', password: appPassword })
    const appToken = JSON.parse(t1)?.data?.jwtToken
    const appHeaders = { authorizetoken: appToken }
    await req('A02', '/enc-api/login', { username: 'admin', password: `${appPassword}-wrong` })
    await req('A03', '/enc-api/getUserInfo')
    await req('A04', '/enc-api/getUserInfo', undefined, appHeaders)
    const t5 = await req('A05', '/enc-api/getAlistConfig', undefined, appHeaders)
    const originalConfig = JSON.parse(t5)?.data
    await req('A06 save', '/enc-api/saveAlistConfig', {
      ...originalConfig,
      serverHost: alistUrl.hostname,
      serverPort: '80',
      https: false,
      passwdList: [{ password: 'api-e2e-password', describe: 'api-e2e', encType, enable: true, encName: true, encFolder: true, encSuffix: '', encPath: [`_api_e2e_round${round}.*`] }],
    }, appHeaders)
    await req('A06 readBack', '/enc-api/getAlistConfig', undefined, appHeaders)
    const t7a = await req('A07 encode', '/enc-api/encodeFoldName', { password: 'api-e2e-password', encType, folderPasswd: 'inner-password', folderEncType: 'rc4' }, appHeaders)
    const folderNameEnc = JSON.parse(t7a)?.data?.folderNameEnc
    await req('A07 decode', '/enc-api/decodeFoldName', { password: 'api-e2e-password', encType, folderNameEnc: `前缀_${folderNameEnc}` }, appHeaders)
    await req('A08', '/enc-api/getWebdavonfig', undefined, appHeaders)
    const t9 = await req('A09 save', '/enc-api/saveWebdavConfig', {
      name: 'api-e2e-webdav',
      describe: 'api-e2e',
      path: '^/api_e2e_dav/*',
      enable: false,
      serverHost: alistUrl.hostname,
      serverPort: '80',
      https: false,
      passwdList: [{ password: 'x', encType, enable: false, encName: false, encPath: ['api_e2e_dav/*'] }],
    }, appHeaders)
    const created = (JSON.parse(t9)?.data || []).find((item) => item.name === 'api-e2e-webdav')
    if (created) {
      await req('A09 update', '/enc-api/updateWebdavConfig', { ...created, describe: 'api-e2e-updated' }, appHeaders)
      await req('A09 del', '/enc-api/delWebdavConfig', { id: created.id }, appHeaders)
    }
    await req(`restore r${round}`, '/enc-api/saveAlistConfig', originalConfig, appHeaders)
  } catch (err) {
    console.log(`=== ROUND ${round} FAILED: ${err?.name} ${JSON.stringify(String(err?.message))}`)
    break
  }
}
console.log('[arepl] done')
