// api-suite 的独立执行入口：既可在 OpenWrt guest 内由 /usr/bin/tjs 直接运行（正式证据），
// 也可在 Node 对照台运行。用例主体在 api-suite.mjs，本文件只负责读环境变量、回显生效规则、汇报结果。
//
// 用法（guest）：
//   ALIST_PASSWORD='<secret>' ALIST_ORIGIN=http://10.0.2.100 PROXY_ORIGIN=http://127.0.0.1:5344 \
//     /usr/bin/tjs run <tests>/api-suite-run.mjs
//
// 用法（Node 对照台，需先有模拟 AList 与代理）：
//   ALIST_PASSWORD=... node api-suite-run.mjs
import { runApiSuite } from './api-suite.mjs'

const env = typeof tjs === 'undefined' ? process.env : tjs.env
const proxyOrigin = (env.PROXY_ORIGIN || 'http://127.0.0.1:5344').replace(/\/$/, '')
// 默认走 slirp 网关 10.0.2.2:5244（QEMU guestfwd 的 10.0.2.100:80 在长时间运行后
// 会出现 slirp 层转发失效，见 run-2026-09-12.md R-28；两者最终都指向宿主 AList）
const alistOrigin = (env.ALIST_ORIGIN || 'http://10.0.2.2:5244').replace(/\/$/, '')
const alistUsername = env.ALIST_USERNAME || 'admin'
const alistPassword = env.ALIST_PASSWORD || ''
const appPassword = env.APP_PASSWORD || '123456'
const rootPath = env.API_E2E_ROOT || '/会员'
const runtime = typeof tjs === 'undefined' ? `node ${process.version}` : 'openwrt tjs'

function exit(code) {
  if (typeof tjs !== 'undefined' && typeof tjs.exit === 'function') {
    tjs.exit(code)
    return
  }
  process.exit(code)
}

if (!alistPassword) {
  console.error('API_SETUP_ERROR ALIST_PASSWORD is required (pass it through the process environment only)')
  exit(2)
}

// 生效规则回显：只输出结构性字段，password 一律脱敏，避免凭据落到日志
async function dumpEffectiveRules(token) {
  try {
    const response = await fetch(`${proxyOrigin}/enc-api/getAlistConfig`, {
      method: 'POST',
      headers: { authorizetoken: token, 'content-type': 'application/json' },
    })
    const body = await response.json()
    const config = body?.data
    if (!config) return
    const rules = (config.passwdList || []).map((rule) => ({
      describe: rule.describe,
      enable: rule.enable,
      encType: rule.encType,
      encName: rule.encName,
      encFolder: rule.encFolder,
      encSuffix: rule.encSuffix,
      encPath: rule.encPath,
    }))
    console.log('API_RULES ' + JSON.stringify({ serverHost: config.serverHost, serverPort: config.serverPort, https: config.https, rules }))
  } catch (error) {
    console.log('API_RULES_UNAVAILABLE ' + String(error?.message || error))
  }
}

let exitCode = 0
try {
  const login = await fetch(`${proxyOrigin}/enc-api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: appPassword }),
  })
  const loginBody = await login.json()
  const appToken = loginBody?.data?.jwtToken
  if (!appToken) throw new Error(`application login failed: HTTP ${login.status} ${JSON.stringify(loginBody).slice(0, 200)}`)
  await dumpEffectiveRules(appToken)

  const { summary, results } = await runApiSuite({
    proxyOrigin,
    alistOrigin,
    rootPath,
    appPassword,
    alistUsername,
    alistPassword,
    runtime,
    skipWebdav: env.API_SKIP_WEBDAV === '1',
  })

  for (const item of results) {
    console.log(`API_CASE ${item.status} ${item.id} ${item.name} :: ${item.detail}`)
  }
  console.log('API_SUMMARY ' + JSON.stringify(summary))
  exitCode = summary.fail === 0 ? 0 : 1
} catch (error) {
  console.error('API_HARNESS_ERROR name=' + String(error?.name) + ' message=' + JSON.stringify(String(error?.message)))
  console.error('API_HARNESS_STACK ' + String(error?.stack || error))
  exitCode = 2
}

exit(exitCode)
