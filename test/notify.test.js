'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const zlib = require('node:zlib')
const { createTurnWatcher, LOG_FILENAMES } = require('../notify')

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

test('tails the v3 log and dispatches completion, user choice, and approval events once', async (t) => {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notify-v3-test-'))
  t.after(() => fs.rmSync(sessionsDir, { recursive: true, force: true }))
  assert.equal(LOG_FILENAMES[0], 'session.v3.jsonl.zstd', '新版日志必须优先于旧日志')

  const seen = { ended: [], questions: [], approvals: [] }
  const watcher = createTurnWatcher({
    sessionsDir,
    onTurnEnd: (event) => seen.ended.push(event),
    onUserQuestion: (event) => seen.questions.push(event),
    onApprovalAsked: (event) => seen.approvals.push(event)
  })
  t.after(() => watcher.stop())
  await watcher.start()

  const sessionDir = path.join(sessionsDir, 'workspace', 'session-v3')
  fs.mkdirSync(sessionDir, { recursive: true })
  const now = Date.now()
  fs.writeFileSync(
    path.join(sessionDir, 'session.v3.jsonl.zstd'),
    Buffer.concat([
      frame({ type: 'turn/start', time: now, data: { turn: 7 } }),
      frame({
        type: 'tool/call',
        time: now + 1,
        data: {
          turn: 7,
          callId: 'choice-1',
          name: 'ask_user_question',
          arguments: JSON.stringify({ questions: [{ header: '选择模式', question: '请选择执行方式' }] })
        }
      }),
      frame({
        type: 'approval/asked',
        time: now + 2,
        data: { id: 'approval-1', toolName: 'bash', reason: '需要写入工作区外目录' }
      }),
      frame({ type: 'turn/end', time: now + 3, data: { turn: 7, reason: { kind: 'completed' } } })
    ])
  )

  // 不依赖操作系统是否把新建嵌套目录送进 fs.watch；主动扫描也正是生产环境的兜底路径。
  await watcher._internal.sweep()
  await new Promise((resolve) => setTimeout(resolve, 300))

  assert.deepEqual(seen.ended.map((event) => event.reason), ['completed'])
  assert.deepEqual(seen.questions, [
    { sessionId: 'session-v3', callId: 'choice-1', header: '选择模式', question: '请选择执行方式' }
  ])
  assert.deepEqual(seen.approvals, [
    {
      sessionId: 'session-v3',
      id: 'approval-1',
      toolName: 'bash',
      reason: '需要写入工作区外目录'
    }
  ])
})
