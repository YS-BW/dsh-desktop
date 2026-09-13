'use strict'

const { StringDecoder } = require('node:string_decoder')

/**
 * Turn arbitrarily chunked process output into complete lines.
 * Child-process `data` events do not preserve line boundaries, so callers must
 * not parse credentials or readiness markers directly from individual chunks.
 */
function createLineReader(onLine, { maxPending = 64 * 1024 } = {}) {
  const decoder = new StringDecoder('utf8')
  let pending = ''

  function emitCompleteLines() {
    let newline
    while ((newline = pending.indexOf('\n')) !== -1) {
      let line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      onLine(line)
    }

    // A backend should never print a credential-bearing readiness line this
    // large. Bound malformed/no-newline output so startup cannot grow forever.
    if (pending.length > maxPending) pending = pending.slice(-maxPending)
  }

  return {
    push(chunk) {
      pending += decoder.write(chunk)
      emitCompleteLines()
    },
    end() {
      pending += decoder.end()
      if (pending !== '') onLine(pending.endsWith('\r') ? pending.slice(0, -1) : pending)
      pending = ''
    },
    pending() {
      return pending
    }
  }
}

function extractAuthenticatedUrl(line) {
  const match = String(line).match(
    /dsh web:\s*(http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)(?:\s|$)/
  )
  return match ? match[1] : undefined
}

module.exports = { createLineReader, extractAuthenticatedUrl }
