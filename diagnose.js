'use strict'

/**
 * 诊断脚本：把真实的 DOM 层级、关键元素坐标、以及各点位的 app-region 计算值
 * 写成一个 JSON 文件。用来回答「窗口能不能拖动」「东西有没有被挡住」这类问题。
 *
 * 用法：
 *   ./node_modules/.bin/electron diagnose.js
 * 输出：
 *   diagnose-report.json
 */

const { app, BrowserWindow } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPORT = path.join(__dirname, 'diagnose-report.json')
const DSH_HOME = process.env.DSH_MIN_HOME || path.join(os.homedir(), '.dsh')
const WORKSPACE = process.env.DSH_MIN_WORKSPACE || '/Users/lixinlv/Documents/DSH'

const CSS = require('node:fs')
  .readFileSync(path.join(__dirname, 'main.js'), 'utf8')
  .match(/const TRAFFIC_LIGHT_CSS = `([\s\S]*?)`\n/)[1]
  .replace('${TRAFFIC_LIGHT_PAD_TOP}', process.env.DSH_MIN_TOP_PAD || '30')

function write(data) {
  fs.writeFileSync(REPORT, JSON.stringify(data, null, 2), 'utf8')
  console.log('[diagnose] 已写入', REPORT)
}

function installDragRegion(target) {
  if (process.platform !== 'darwin') return
  target.webContents
    .executeJavaScript(
      `(() => {
        const ID = 'dsh-min-drag-region'
        const place = () => {
          let el = document.getElementById(ID)
          if (!el) {
            el = document.createElement('div')
            el.id = ID
            el.setAttribute('aria-hidden', 'true')
            Object.assign(el.style, {
              position: 'fixed',
              top: '0',
              height: '24px',
              background: 'transparent',
              pointerEvents: 'auto',
              userSelect: 'none'
            })
            el.style.setProperty('-webkit-app-region', 'drag')
            document.body.appendChild(el)
          }
          // 右侧至少留出 120px 给头部按钮；窗口太窄就整体不启用。
          const reserved = 120
          const left = 80
          const width = window.innerWidth - left - reserved
          el.style.left = left + 'px'
          el.style.right = 'auto'
          el.style.width = Math.max(0, width) + 'px'
          el.style.display = width > 40 ? 'block' : 'none'
        }
        place()
        window.addEventListener('resize', place)
        return 'ok'
      })()`
    )
    .catch(() => {})
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  })

  const child = spawn(
    process.env.DSH_MIN_BIN || 'dsh',
    ['web', '--no-open', '--host', '127.0.0.1', '--port', '0'],
    { cwd: WORKSPACE, env: { ...process.env, DSH_HOME, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }
  )

  let done = false
  const finish = (payload) => {
    if (done) return
    done = true
    write(payload)
    try { child.kill('SIGTERM') } catch {}
    setTimeout(() => app.quit(), 1500)
  }

  const onChunk = async (buf) => {
    const m = buf.toString().replace(/\u001B\[[0-9;]*m/g, '')
      .match(/dsh web:\s*(http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/)
    if (!m) return

    const result = { layout: null, points: [], css: CSS }
    // 原生窗口的拖拽区域由 CSS 决定，但 token URL 得先加载进去才能测。
    await win.loadURL(m[1])
    await win.webContents.insertCSS(CSS)
    installDragRegion(win)
    await new Promise((r) => setTimeout(r, 3000))

    const probe = `(() => {
      const el = document.getElementById('dsh-min-drag-region')
      const r = el ? el.getBoundingClientRect() : null
      const cs = el ? getComputedStyle(el) : null
      // 拖拽条中心点会不会命中它自己（若被别的东西盖住就命不中）
      let hitAtCenter = null
      if (r && r.width > 0) {
        const h = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
        hitAtCenter = h ? (h.id || (typeof h.className === 'string' ? h.className : h.tagName)).slice(0, 30) : null
      }
      // 侧栏顶部留白是否生效
      const sidebar = document.querySelector('#root > div > div:first-child')
      const brand = document.querySelector('span[class*="brandMark"]')
      return JSON.stringify({
        dragRegion: el
          ? {
              found: true,
              rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
              appRegion: cs.getPropertyValue('-webkit-app-region'),
              pointerEvents: cs.pointerEvents,
              zIndex: cs.zIndex,
              hitAtCenter
            }
          : { found: false },
        sidebarPadTop: sidebar ? getComputedStyle(sidebar).getPropertyValue('padding-top') : null,
        brandMarkY: brand ? Math.round(brand.getBoundingClientRect().top) : null,
        innerWidth: window.innerWidth
      }, null, 1)
    })()`

    try {
      result.layout = JSON.parse(await win.webContents.executeJavaScript(probe))
    } catch (e) {
      result.error = String(e && e.message ? e.message : e)
    }
    finish(result)
  }

  child.stdout.on('data', (b) => void onChunk(b))
  child.stderr.on('data', (b) => void onChunk(b))
  setTimeout(() => finish({ error: 'timeout: 后端未在 40 秒内就绪' }), 40000)
})
