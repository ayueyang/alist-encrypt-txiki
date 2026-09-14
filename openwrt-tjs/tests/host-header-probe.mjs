// txiki fetch 的 Host 头行为探针（guest 内 /usr/bin/tjs 执行）。
// 背景：AList 的 WebDAV COPY/MOVE 要求「请求 Host」与「Destination authority」字符串一致；
// 经适配层转发时 Host 丢掉了端口，导致 502。本探针判定 txiki 的 fetch 是否忽略调用方给定的 host。
//
// 用法：/usr/bin/tjs run /mnt/host/tests/host-header-probe.mjs
// 需要一个记录请求头的接收端（宿主 work/header-spy.mjs）。
const env = typeof tjs === 'undefined' ? process.env : tjs.env
const TARGET = env.TARGET || 'http://192.168.1.6:15267'

const cases = [
  ['裸 fetch（目标 URL 带端口）', {}],
  ['显式 headers.host = 自造 authority', { host: 'example.test:9999' }],
  ['显式 headers.host 与目标 authority 相同', { host: '192.168.1.6:15267' }],
]

for (const [label, extra] of cases) {
  try {
    const res = await fetch(`${TARGET}/host-probe/${encodeURIComponent(label)}`, { headers: { ...extra } })
    console.log(`PROBE ${JSON.stringify({ label, status: res.status })}`)
  } catch (e) {
    console.log(`PROBE ${JSON.stringify({ label, error: String(e?.message || e) })}`)
  }
}
console.log('HOST_PROBE_DONE')
if (typeof tjs !== 'undefined') tjs.exit(0)
