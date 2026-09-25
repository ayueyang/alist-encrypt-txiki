// Deliberate isolated Worker crash after onerror has been installed.
self.onmessage = () => {
  throw new Error('intentional PRGA Worker failure fixture')
}
