import { Buffer as BufferImpl } from 'buffer'
import processImpl from './platform/process.js'
import { installRedactedConsole } from './redact.js'

installRedactedConsole()

if (!globalThis.Buffer) {
  globalThis.Buffer = BufferImpl
}

if (!globalThis.process) {
  globalThis.process = processImpl
}

export { BufferImpl as Buffer, processImpl as process }
