'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const zlib = require('node:zlib')
const { createTurnWatcher } = require('../notify')

function frame(event) {
  return zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`), {
    params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 }
  })
}

test('accepts complete frames and rejects every truncated checksum frame', () => {
  const decode = createTurnWatcher({ sessionsDir: '/unused', onTurnEnd() {} })._internal.decodeFrames
  const encoded = frame({ type: 'turn/end', data: { turn: 1 } })
  assert.equal(decode(encoded).consumed, encoded.length)
  for (let cut = 1; cut < encoded.length; cut += 1) {
    const result = decode(encoded.subarray(0, cut))
    assert.equal(result.consumed, 0, `accepted truncated frame at byte ${cut}`)
    assert.deepEqual(result.events, [])
  }
})

test('startup baseline begins at the last frame, including a torn frame', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notify-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'session.jsonl.zstd')
  const first = frame({ type: 'turn/end', data: { turn: 1 } })
  const second = frame({ type: 'turn/end', data: { turn: 2 } })
  const cut = second.length - 2
  fs.writeFileSync(file, Buffer.concat([first, second.subarray(0, cut)]))

  const watcher = createTurnWatcher({ sessionsDir: '/unused', onTurnEnd() {} })
  const state = watcher._internal.baseline(file)
  assert.equal(state.offset, first.length)

  fs.appendFileSync(file, second.subarray(cut))
  const completedTail = fs.readFileSync(file).subarray(state.offset)
  const decoded = watcher._internal.decodeFrames(completedTail)
  assert.equal(decoded.consumed, second.length)
  assert.equal(decoded.events[0].data.turn, 2)
})

