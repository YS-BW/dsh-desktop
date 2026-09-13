'use strict'

/**
 * 轮次通知：从会话 JSONL 事件流里读出「轮次结束」，交给外壳弹原生通知。
 *
 * 为什么读 JSONL 而不是读投影缓存
 * ──────────────────────────────
 * `dsh-session-persistence` 的官方文档写明：
 *
 *   · "`SESSION_FORMAT_VERSION` remains v0 and this build provides **no format-migration
 *     path**" —— 这是会话数据的持久化契约，版本冻结、没有迁移路径。因为它是**用户数据**，
 *     dsh 不能随便改（改了用户历史就读不出来）。
 *   · "An event type unknown to this build refuses **unless its envelope marks it
 *     `ignorable`**" —— 新事件类型可以「可忽略」地加进来，这是**为跨版本稳定设计的**。
 *
 * 而投影缓存（`storages/session_projcache/`）官方明确称之为 cache：每个投影单元带
 * `stateVersion`，*"bumps whenever the state fields or fold semantics change"*，而且
 * *"a restart rebuilds by folding the log"* —— 它是**从 JSONL 派生出来的**。
 * 读缓存是读派生物，读 JSONL 是读源头。
 *
 * 顺带：`turn/end` 事件直接带着结论，不用像缓存那样从 `openStep` 清空去推断：
 *
 *   {"type":"turn/end","seq":...,"time":...,"data":{"turn":50,"reason":{"kind":"completed"}}}
 *
 * 存储细节
 * ────────
 * 这个文件是**分帧追加**的 zstd（每批一个独立帧），整体解压会在第 2 帧失败
 * （报 `Unknown frame descriptor`）。所以要按帧魔数切分、逐帧解压。实测一个 5.5MB /
 * 12930 帧的会话：全部帧解码成功，0 失败。
 *
 * 零耦合：只读文件，不改 dsh 一个字节，不加 dsh 插件，不加 npm 依赖
 * （只用 node:fs / node:zlib，随 App 自带的 node 一起来）。
 */

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

/** zstd 帧魔数 0xFD2FB528 的小端字节序。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 会话日志的文件名。 */
const LOG_FILENAME = 'session.jsonl.zstd'

/** 文件事件的防抖：fs.watch 一次追加会连发好几个事件。 */
const DEBOUNCE_MS = 150

/** 兜底轮询间隔。fs.watch 在少数情况下会漏事件，定期 stat 一下更稳。 */
const POLL_MS = 3000

/** Read enough of one Zstandard frame to locate its exact physical end. */
function zstdFrameEnd(buffer, start) {
  let offset = start
  if (buffer.length - offset < 4) return undefined
  if (!buffer.subarray(offset, offset + 4).equals(ZSTD_MAGIC)) {
    throw new Error(`invalid zstd frame magic at byte ${offset}`)
  }
  offset += 4
  if (offset === buffer.length) return undefined

  const descriptor = buffer.readUInt8(offset)
  offset += 1
  if ((descriptor & 0x18) !== 0) throw new Error('reserved zstd frame-header bit')
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const checksum = (descriptor & 0x04) !== 0
  const dictionaryFlag = descriptor & 0x03
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
  if (buffer.length - offset < remainingHeaderBytes) return undefined
  offset += remainingHeaderBytes

  for (;;) {
    if (buffer.length - offset < 3) return undefined
    const blockHeader = buffer.readUIntLE(offset, 3)
    offset += 3
    const lastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 3
    const blockSize = blockHeader >>> 3
    if (blockType === 3) throw new Error('reserved zstd block type')
    const payloadBytes = blockType === 1 ? 1 : blockSize
    if (buffer.length - offset < payloadBytes) return undefined
    offset += payloadBytes
    if (lastBlock) break
  }

  if (checksum) {
    if (buffer.length - offset < 4) return undefined
    offset += 4
  }
  return offset
}

/**
 * Find the final frame start without loading a potentially huge session file.
 * Re-reading that one frame establishes a safe baseline even when startup
 * happens while DSH is halfway through appending it.
 */
function findLastFrameStart(filePath, size) {
  if (size <= 0) return 0
  const handle = fs.openSync(filePath, 'r')
  const chunkSize = 64 * 1024
  let end = size
  let nextPrefix = Buffer.alloc(0)
  try {
    while (end > 0) {
      const start = Math.max(0, end - chunkSize)
      const chunk = Buffer.allocUnsafe(end - start)
      fs.readSync(handle, chunk, 0, chunk.length, start)
      const searchable = nextPrefix.length > 0 ? Buffer.concat([chunk, nextPrefix]) : chunk
      const index = searchable.lastIndexOf(ZSTD_MAGIC)
      if (index !== -1 && index < chunk.length) return start + index
      nextPrefix = Buffer.from(chunk.subarray(0, Math.min(3, chunk.length)))
      end = start
    }
  } finally {
    fs.closeSync(handle)
  }
  return size
}

/**
 * @param options.sessionsDir  DSH_HOME/sessions
 * @param options.onTurnEnd    轮次结束时回调 { sessionId, turn, reason, durationMs }
 * @param options.log
 */
function createTurnWatcher(options) {
  const { sessionsDir, onTurnEnd, log = () => {} } = options

  /** filePath -> { offset }：已消费到的字节偏移。 */
  const files = new Map()
  /** sessionId -> 该会话当前轮次的开始时间，用来算用时。 */
  const openTurns = new Map()
  /**
   * sessionId -> 本轮助手最后一段文字。
   *
   * 用来做通知正文：用户要的是「谁 + 说了什么」，而不是「任务完成」这种空洞文案。
   * 只在 assistant/message 里取 type==='text' 的块 —— reasoning 是思考过程，不该外泄到通知。
   */
  const lastAssistantText = new Map()

  /** watcher 启动时刻。用来挡掉「文件被延迟发现、从头读」时回放出来的历史轮次。 */
  const startedAt = Date.now()

  let watcher
  let pollTimer
  const pending = new Map()
  let stopped = false

  // ── 帧解码 ──────────────────────────────────────────────────────────

  /**
   * 解出 buf 开头所有**完整**的帧，返回事件与已消费的字节数。
   *
   * 两个关键点，都是实测出来的：
   *
   * 1. **先解析 zstd 帧结构，再解压精确的一帧**。不能用解压器的 `bytesWritten`
   *    猜边界：带 checksum 的帧少最后 1～3 字节时，Node 仍可能返回完整明文，
   *    这会把半帧误认成完整帧并永久推进 offset。
   *
   * 2. **换行只作为明文的第二道完整性检查**。`zstdDecompressSync` 对部分截断帧
   *    不抛错，所以完整性首先由帧头、block 长度和 checksum 长度共同判定。
   *    真实文件里 13318 个帧**全部**以换行结尾（0 例外），因为 dsh 写的是
   *    newline-delimited 的 JSON 行。
   *
   * 半截帧一律不消费，留在文件里等下次变化再读 —— 连同 `consume()` 保留的 pending
   * 尾巴，能正确处理「完整帧 + 尾部半帧」这种最容易出错的写入时序。
   */
  function decodeFrames(buf) {
    const events = []
    let consumed = 0

    while (consumed < buf.length) {
      let frameEnd
      try {
        frameEnd = zstdFrameEnd(buf, consumed)
      } catch {
        // If a prior run began in the middle of a frame, resynchronize at the
        // next physical frame so future notifications are not lost forever.
        const next = buf.indexOf(ZSTD_MAGIC, consumed + 1)
        if (next === -1) break
        consumed = next
        continue
      }
      if (frameEnd === undefined) break

      let text
      try {
        text = zlib.zstdDecompressSync(buf.subarray(consumed, frameEnd)).toString('utf8')
      } catch {
        // A structurally complete frame with a bad checksum is corruption.
        // Preserve it instead of silently advancing the durable offset.
        break
      }

      if (!text.endsWith('\n')) break

      consumed = frameEnd
      for (const line of text.split('\n')) {
        if (line.length === 0) continue
        try {
          events.push(JSON.parse(line))
        } catch {
          // 单行解析失败不影响其它行
        }
      }
    }

    return { events, consumed }
  }

  // ── 增量读取 ────────────────────────────────────────────────────────

  /**
   * 读某个会话日志自 offset 起的新内容，解帧并派发事件。
   *
   * 用文件句柄只读增量部分，不把整个文件读进内存（活跃会话可能几十 MB）。
   */
  async function consume(filePath, state) {
    let handle
    try {
      handle = await fs.promises.open(filePath, 'r')
      const { size } = await handle.stat()

      // state.offset 是「已成功消费到的文件偏移」，state.pending 是「从该偏移起读进来、
      // 但还没能解成完整帧的字节」。所以新数据要从 offset + pending.length 开始读 ——
      // 否则会把 pending 那一段重复读一遍、拼出损坏的帧。
      const readFrom = state.offset + state.pending.length
      if (size <= readFrom) return

      const length = size - readFrom
      const fresh = Buffer.allocUnsafe(length)
      await handle.read(fresh, 0, length, readFrom)
      await handle.close()
      handle = undefined

      // 把上次没解动的尾巴接上来一起解 —— 这样「完整帧 + 尾部半帧」里的半帧
      // 下一轮还能被解出来，不会因为偏移推过头而永久丢失。
      const buffer = state.pending.length > 0 ? Buffer.concat([state.pending, fresh]) : fresh

      const { events, consumed } = decodeFrames(buffer)
      if (consumed > 0) state.offset += consumed
      state.pending = consumed < buffer.length ? Buffer.from(buffer.subarray(consumed)) : Buffer.alloc(0)
      if (events.length === 0) return

      const sessionId = path.basename(path.dirname(filePath))
      for (const event of events) handleEvent(sessionId, event)
    } catch (error) {
      // 只记日志：通知坏了绝不能影响 App 的运行
      if (error?.code !== 'ENOENT') {
        log('读取会话日志失败:', filePath, String(error.message || error))
      }
    } finally {
      if (handle !== undefined) {
        try {
          await handle.close()
        } catch {}
      }
    }
  }

  /** 从 assistant/message 里取出文本块（跳过 reasoning / tool-call）。 */
  function assistantTextOf(event) {
    const content = event?.data?.message?.content
    if (!Array.isArray(content)) return undefined
    const parts = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
    const joined = parts.join('\n').trim()
    return joined === '' ? undefined : joined
  }

  function handleEvent(sessionId, event) {
    const type = event?.type
    if (type === 'assistant/message') {
      const text = assistantTextOf(event)
      if (text !== undefined) lastAssistantText.set(sessionId, text)
      return
    }
    if (type === 'turn/start') {
      openTurns.set(sessionId, Number(event.time) || Date.now())
      lastAssistantText.delete(sessionId) // 新一轮，清掉上一轮的摘要
      return
    }
    if (type !== 'turn/end') return

    const endedAt = Number(event.time) || Date.now()

    // 只处理 watcher 启动之后发生的轮次。
    // 有它兜底，即使某个会话日志被延迟发现、从字节 0 开始读，也不会把历史轮次
    // 当成新完成的任务弹一堆通知。
    if (endedAt < startedAt) return

    const turnStartedAt = openTurns.get(sessionId)
    openTurns.delete(sessionId)
    const summary = lastAssistantText.get(sessionId)
    lastAssistantText.delete(sessionId)

    try {
      onTurnEnd({
        sessionId,
        turn: event.data?.turn,
        reason: event.data?.reason?.kind ?? 'unknown',
        summary,
        durationMs:
          turnStartedAt === undefined ? undefined : Math.max(0, endedAt - turnStartedAt)
      })
    } catch (error) {
      log('通知回调出错:', String(error?.message || error))
    }
  }

  /** 从最后一帧起建立基线，既不回放旧轮次，也不会从半帧中间开始。 */
  function baseline(filePath) {
    try {
      const size = fs.statSync(filePath).size
      return { offset: findLastFrameStart(filePath, size), pending: Buffer.alloc(0) }
    } catch {
      return { offset: 0, pending: Buffer.alloc(0) }
    }
  }

  function schedule(filePath) {
    if (stopped) return
    const existing = pending.get(filePath)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      pending.delete(filePath)
      const state = files.get(filePath)
      if (state) void consume(filePath, state)
    }, DEBOUNCE_MS)
    timer.unref?.()
    pending.set(filePath, timer)
  }

  /** 扫一遍所有会话日志：发现新文件、检查已有文件有没有增长。 */
  async function sweep({ initial = false } = {}) {
    let buckets
    try {
      buckets = await fs.promises.readdir(sessionsDir, { withFileTypes: true })
    } catch {
      return
    }

    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue
      const bucketDir = path.join(sessionsDir, bucket.name)
      let sessions
      try {
        sessions = await fs.promises.readdir(bucketDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const session of sessions) {
        if (!session.isDirectory()) continue
        const filePath = path.join(bucketDir, session.name, LOG_FILENAME)

        if (!files.has(filePath)) {
          // 启动时就存在的文件：只记当前位置，不回溯历史（否则一开机就狂弹旧通知）。
          // 启动之后才出现的文件：从 0 开始读，这样它第一个轮次结束也能通知到。
          files.set(filePath, initial ? baseline(filePath) : { offset: 0, pending: Buffer.alloc(0) })
        }
        // 这里**不能** continue。新文件注册完也要立刻安排一次消费，否则只能等
        // 下一轮轮询（POLL_MS = 3s）—— 表现就是「新会话的第一轮通知平白迟到几秒」。
        if (!initial) schedule(filePath)
      }
    }
  }

  // ── 生命周期 ────────────────────────────────────────────────────────

  async function start() {
    // 先建立基线（跳过历史），再开始监听
    await sweep({ initial: true })

    try {
      watcher = fs.watch(sessionsDir, { recursive: true, persistent: false }, (_event, filename) => {
        if (filename === null || filename === undefined) {
          // 拿不到文件名时，稳妥起见整棵扫一遍
          void sweep()
          return
        }
        const name = String(filename)
        if (!name.endsWith(LOG_FILENAME)) return
        const filePath = path.resolve(sessionsDir, name)
        if (!files.has(filePath)) {
          void sweep()
          return
        }
        schedule(filePath)
      })
      watcher.on('error', (error) => log('会话监听出错:', String(error?.message || error)))
    } catch (error) {
      log('无法监听会话目录（将只靠轮询）:', String(error?.message || error))
    }

    pollTimer = setInterval(() => void sweep(), POLL_MS)
    pollTimer.unref?.()
  }

  function stop() {
    stopped = true
    try {
      watcher?.close()
    } catch {}
    if (pollTimer) clearInterval(pollTimer)
    for (const timer of pending.values()) clearTimeout(timer)
    pending.clear()
  }

  return { start, stop, _internal: { decodeFrames, baseline } }
}

/**
 * 把助手的回复压成一行能塞进通知的摘要。
 *
 * Markdown 的记号在这里只会是噪音（通知不渲染格式），所以剥掉；换行压成空格，
 * 免得通知只显示第一行的几个字。
 */
function summarize(text, maxLength = 40) {
  if (typeof text !== 'string') return undefined
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')        // 代码块整体丢掉
    .replace(/`([^`]*)`/g, '$1')             // 行内代码留内容
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接/图片留文字
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')      // 标题
    .replace(/^\s{0,3}[-*+]\s+/gm, '')       // 列表符号
    .replace(/\*\*([^*]*)\*\*/g, '$1')      // 粗体
    .replace(/\*([^*]*)\*/g, '$1')           // 斜体
    .replace(/\s+/g, ' ')
    .trim()
  if (flat === '') return undefined
  return flat.length <= maxLength ? flat : `${flat.slice(0, maxLength)}…`
}

/** 把毫秒转成「3 分 12 秒」这种可读文案。 */
function formatDuration(ms) {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return undefined
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

module.exports = {
  createTurnWatcher,
  formatDuration,
  summarize,
  LOG_FILENAME,
  ZSTD_MAGIC,
  _internal: { zstdFrameEnd, findLastFrameStart }
}
