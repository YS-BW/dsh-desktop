'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { createLineReader, extractAuthenticatedUrl } = require('../output-lines')

test('reassembles a readiness line split at every byte', () => {
  const expected = 'dsh web: http://127.0.0.1:4321/?token=abc_DEF-123'
  const lines = []
  const reader = createLineReader((line) => lines.push(line))
  const bytes = Buffer.from(`${expected}\n`)
  for (const byte of bytes) reader.push(Buffer.from([byte]))
  assert.deepEqual(lines, [expected])
  assert.equal(extractAuthenticatedUrl(lines[0]), 'http://127.0.0.1:4321/?token=abc_DEF-123')
  assert.equal(reader.pending(), '')
})

test('does not emit an unterminated credential line', () => {
  const lines = []
  const reader = createLineReader((line) => lines.push(line))
  reader.push(Buffer.from('dsh web: http://127.0.0.1:4321/?token=partial'))
  assert.deepEqual(lines, [])
  assert.equal(extractAuthenticatedUrl('dsh web: http://127.0.0.1:4321/?token='), undefined)
})
