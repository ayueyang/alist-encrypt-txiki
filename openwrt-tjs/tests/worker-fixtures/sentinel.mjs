// Distinct result proves the actual txiki Worker handled this message.
self.onmessage = ({ data: { msgId, data } }) => {
  self.postMessage({ msgId, resData: { sbox: data.sbox, i: 71, j: 72 } })
}
