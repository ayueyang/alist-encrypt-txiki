export default async function PRGAExcuteThread(data) {
  let { sbox: S, i, j, position } = data
  for (let k = 0; k < position; k++) {
    i = (i + 1) % 256
    j = (j + S[i]) % 256
    const temp = S[i]
    S[i] = S[j]
    S[j] = temp
  }
  return { sbox: S, i, j }
}
