// Replicates suite A01 -> A06(saveAlistConfig) -> A09(webdav CRUD) with
// per-request timing to find which server request hangs.
const proxyOrigin = 'http://127.0.0.1:5344'
const appPassword = '123456'
const encType = 'aesctr'
const alistUrl = new URL('http://10.0.2.100')

async function timed(label, fn) {
  const t0 = Date.now()
  try {
    const r = await fn()
    const text = await r.text()
    console.log(`[t] ${label} ${r.status} ${Date.now() - t0}ms ${text.slice(0, 110)}`)
    return text
  } catch (err) {
    console.log(`[t] ${label} THROW after ${Date.now() - t0}ms name=${err?.name} message=${JSON.stringify(String(err?.message))}`)
    throw err
  }
}

async function jf(label, path, body, headers) {
  return timed(label, () =>
    fetch(`${proxyOrigin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  )
}

try {
  const loginText = await jf('A01 login', '/enc-api/login', { username: 'admin', password: appPassword })
  const appToken = JSON.parse(loginText)?.data?.jwtToken
  const appHeaders = { authorizetoken: appToken }

  const cfgText = await jf('A05 getAlistConfig', '/enc-api/getAlistConfig', undefined, appHeaders)
  const originalConfig = JSON.parse(cfgText)?.data

  await jf('A06 saveAlistConfig', '/enc-api/saveAlistConfig', {
    ...originalConfig,
    serverHost: alistUrl.hostname,
    serverPort: alistUrl.port || '80',
    https: false,
    passwdList: [{ password: 'api-e2e-password', describe: 'api-e2e', encType, enable: true, encName: true, encFolder: true, encSuffix: '', encPath: ['/_api_e2e_probe.*'] }],
  }, appHeaders)
  await jf('A06 readBack', '/enc-api/getAlistConfig', undefined, appHeaders)
  await jf('A07 encodeFoldName', '/enc-api/encodeFoldName', { password: 'api-e2e-password', encType, folderPasswd: 'inner-password', folderEncType: 'rc4' }, appHeaders)
  await jf('A07 decodeFoldName', '/enc-api/decodeFoldName', { password: 'api-e2e-password', encType, folderNameEnc: 'x_test' }, appHeaders)
  await jf('A08 getWebdavonfig', '/enc-api/getWebdavonfig', undefined, appHeaders)

  const entry = {
    name: 'api-e2e-webdav',
    describe: 'api-e2e',
    path: '^/api_e2e_dav/*',
    enable: false,
    serverHost: alistUrl.hostname,
    serverPort: alistUrl.port || '80',
    https: false,
    passwdList: [{ password: 'x', encType, enable: false, encName: false, encPath: ['api_e2e_dav/*'] }],
  }
  await jf('A09 saveWebdavConfig', '/enc-api/saveWebdavConfig', entry, appHeaders)
  const listText = await jf('A09 list-after-save', '/enc-api/getWebdavonfig', undefined, appHeaders)
  const created = (JSON.parse(listText)?.data || []).find((item) => item.name === 'api-e2e-webdav')
  if (created) {
    await jf('A09 updateWebdavConfig', '/enc-api/updateWebdavConfig', { ...created, describe: 'api-e2e-updated' }, appHeaders)
    await jf('A09 delWebdavConfig', '/enc-api/delWebdavConfig', { id: created.id }, appHeaders)
  }
  // restore config
  await jf('restore saveAlistConfig', '/enc-api/saveAlistConfig', originalConfig, appHeaders)
  console.log('[probe] ALL OK')
} catch (err) {
  console.log(`[probe] FAILED: ${err?.name} ${JSON.stringify(String(err?.message))}`)
}
