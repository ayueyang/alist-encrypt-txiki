// 运行时边界适配：Destination 的 authority 必须与「本运行时实际发出的 Host 头」完全一致。
//
// 背景（均为实测，见 tests/run-2026-09-15.md）：
//   1. AList 的 WebDAV COPY/MOVE 会把 Destination 的 authority 与请求的 Host 头做字符串比较，
//      不一致就返回 502 Bad Gateway。实测矩阵：
//        Host 127.0.0.1:5244 + Dest http://127.0.0.1:5244/… → 201
//        Host 10.0.2.2:5244  + Dest http://10.0.2.2:5244/…  → 201（该地址根本不可达，证明只比字符串）
//        Host 127.0.0.1      + Dest http://127.0.0.1:5244/… → 502（只是少了端口）
//   2. txiki 的 fetch 生成 Host 头时**一律不带端口**：目标 URL 写成 http://h:15267/… 时，
//      线上字节仍是 `Host: h`；调用方显式传入的 host 头同样会被忽略（与 C-25 的 origin 同源行为）。
//   3. node-proxy 在 app.js 里把 request.headers.host 置为 `${serverHost}:${serverPort}`，
//      并按它拼 Destination，于是经 txiki 转发时两者必然不一致 → COPY/MOVE 恒 502。
//      上游 Node 版不会遇到：undici 的 Host 头取自 URL authority，本身含端口。
//
// 因此按「运行时实际会发出的 Host」来构造 Destination authority：txiki 下去掉端口，
// 其余运行时（含 Node 对照基线，本模块只被 txiki 构建引用）保持原样。
export function destinationAuthority(hostWithPort) {
  if (typeof hostWithPort !== 'string' || hostWithPort === '') {
    return hostWithPort
  }
  // txiki 的 Host 头不带端口
  if (typeof tjs !== 'undefined') {
    try {
      return new URL(`http://${hostWithPort}`).hostname
    } catch {
      return hostWithPort
    }
  }
  return hostWithPort
}
