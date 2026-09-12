#!/usr/bin/env node
'use strict'

/**
 * 生成 App 图标：**纯白背景 + 纯黑官方鲸鱼**。
 *
 *   node tools/make-icon.js                       # 出 build/icon.icns
 *   node tools/make-icon.js --fill 0.9            # 鲸鱼占方块宽度的比例
 *   node tools/make-icon.js --preview /tmp/a.png  # 只出一张 1024 PNG，用来比对
 *
 * 图标里的鲸鱼不是自己描的，是**直接从 dsh 官方包里取**：
 *
 *   node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon.svg
 *
 * 那是官方 Web UI 的 favicon，也是它 manifest.webmanifest 里唯一的图标条目 ——
 * 即官方承认的品牌图形。本脚本只做两件事：把它的 path 拿出来、换成黑色，
 * 放到一个白色圆角方块上。**图形本身一笔不改。**
 *
 * ⚠️ 背景方块是本脚本自己生成的。
 * 官方包里**只有鲸鱼那一条 path，没有任何背景/底板资源**（那个 SVG 里就一个
 * <path>，连 <rect> 都没有）。所以白色圆角底板是按 macOS 官方图标的实测几何
 * 合成的，不是官方素材 —— 详见下面「形状」一节。
 *
 * 形状：为什么不是普通圆角矩形
 * ────────────────────────────
 * 实测系统图标（Finder / Preview / Notes / Calculator 的 .icns，取 alpha≥128
 * 即 50% 覆盖率的真实几何边界）：
 *
 *   主体    824x824，位于 1024 画布的正中 (100,100) —— 占画布 80.5%
 *   角      **不是圆弧**：角沿边延伸 209px（顶边平坦段只剩 406px），
 *           而半径 184.3 的普通圆角矩形平坦段是 455px
 *
 * 也就是说用 border-radius 画出来的角比系统图标「方」一圈。这里改用超椭圆
 * 拟合实测轮廓，角盒 E = 0.2536 × 边长、指数 n = 2.31：
 *
 *   x(y) = E * (1 - (1 - ((E-y)/E)^n)^(1/n))
 *
 * 该式与实测角轮廓逐点吻合（dy=20 算得 103.6 实测 102；dy=80 算得 31.6 实测 32；
 * dy=120 算得 13.3 实测 13）。
 */

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const BUILD = path.join(ROOT, 'build')
const WORK = path.join(BUILD, 'icon-build')

const CANVAS = 1024
/** 方块边长占画布比例 —— 实测系统图标 824/1024。 */
const TILE_RATIO = 824 / 1024
/** 角盒占方块边长比例 —— 实测系统图标 209/824。 */
const CORNER_RATIO = 209 / 824
/** 超椭圆指数 —— 拟合实测角轮廓得到。 */
const CORNER_EXPONENT = 2.31
const CAPTURE = 2048 // 渲染分辨率，再缩到各档

const DEFAULTS = { bg: '#ffffff', fg: '#000000', fill: 0.9, tile: TILE_RATIO }

const ICONSET = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024]
]

// ── 官方图形 ────────────────────────────────────────────────────────────

function officialLogoSvg() {
  const candidates = [
    path.join(ROOT, 'node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon.svg'),
    path.join(ROOT, 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon.svg')
  ]
  for (const file of candidates) {
    if (fs.existsSync(file)) return { file, svg: fs.readFileSync(file, 'utf8') }
  }
  throw new Error(
    '找不到官方图标 dsh-web-frontend/dist/favicon.svg。\n' +
      '请先 npm install（它会装上 @deepseek-ai/dsh，图标就在里面）。'
  )
}

/** 取 <path> 的 d。注意不能直接找 `d="` —— `id="path"` 里也含这个子串。 */
function extractPathData(svg) {
  const tag = svg.match(/<path[^>]*>/)
  if (!tag) throw new Error('官方 SVG 里没有 <path>，格式可能变了')
  const d = tag[0].match(/\sd="([^"]*)"/)
  if (!d) throw new Error('官方 SVG 的 <path> 上没有 d 属性')
  return d[1]
}

/** 展平三次贝塞尔求墨迹包围盒 —— 官方换图形时缩放/居中才不会静默画歪。 */
function glyphBounds(d, steps = 48) {
  const tokens = d.match(/[MCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []
  const points = []
  let cursor = null
  let i = 0

  const cubic = (p0, p1, p2, p3) => {
    for (let k = 1; k <= steps; k++) {
      const t = k / steps
      const u = 1 - t
      points.push([
        u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
        u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
      ])
    }
  }

  while (i < tokens.length) {
    const op = tokens[i].toUpperCase()
    if (op === 'M') {
      cursor = [Number(tokens[i + 1]), Number(tokens[i + 2])]
      points.push(cursor)
      i += 3
    } else if (op === 'C') {
      const n = tokens.slice(i + 1, i + 7).map(Number)
      const p3 = [n[4], n[5]]
      cubic(cursor, [n[0], n[1]], [n[2], n[3]], p3)
      cursor = p3
      i += 7
    } else {
      i += 1
    }
  }

  if (points.length === 0) throw new Error('path 里没解析出任何点')
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

// ── 底板形状：超椭圆连续角（对齐系统图标实测轮廓） ──────────────────────

/**
 * 生成方块轮廓 path。四个角用超椭圆曲线，四条边是直线。
 *
 * 四个角都是同一条曲线的镜像，**但遍历方向必须一致**，否则会得到自交路径：
 * 系统按 nonzero 填充时，方向反了的那个角会往外鼓出一个三角形。
 *
 *   左上 tl(t): (E,0) → (0,E)        基准曲线
 *   右上 tr(t) = 水平镜像 tl(t)       (side-E,0) → (side,E)
 *   右下 br(t) = 水平+垂直镜像 tl(t)  (side,side-E) → (side-E,side)
 *   左下 bl(t) = 垂直镜像 tl(t)       (E,side) → (0,side-E)
 *
 * 顺时针走：M 落在 tl 的**终点侧**，所以最后一段要把 tl 反着走回去闭合。
 *
 * @param pad 方块左上角在画布中的坐标
 * @param side 方块边长
 */
function tilePath(pad, side, segments = 40) {
  const E = side * CORNER_RATIO
  const n = CORNER_EXPONENT

  /** 基准曲线：y 从 0 到 E，x 由超椭圆给出。t=0 → (E,0)，t=1 → (0,E) */
  const tl = (t) => {
    const y = E * t
    const v = (E - y) / E
    return [E * (1 - Math.pow(1 - Math.pow(v, n), 1 / n)), y]
  }
  const mirrorH = ([x, y]) => [side - x, y]
  const mirrorV = ([x, y]) => [x, side - y]
  const mirrorHV = ([x, y]) => [side - x, side - y]

  const pts = []
  const at = ([x, y]) => [pad + x, pad + y]
  const push = (p) => pts.push(at(p))
  const tAt = (k) => k / segments

  const corner = (fn, reverse = false) => {
    for (let k = 0; k <= segments; k++) {
      const t = tAt(reverse ? segments - k : k)
      push(fn(tl(t)))
    }
  }

  push(tl(0)) // M = (E,0)，顶边的左端
  push(mirrorH(tl(0))) // 顶边 → (side-E, 0)
  corner((p) => mirrorH(p)) // 右上角 → (side, E)
  push([side, side - E]) // 右边
  corner((p) => mirrorHV(p), true) // 右下角 → (side-E, side)
  push([E, side]) // 底边
  corner((p) => mirrorV(p)) // 左下角 → (0, side-E)
  push([0, E]) // 左边
  corner((p) => p, true) // 左上角，反向走回 (E,0) 闭合

  const round = (v) => v.toFixed(3)
  return `M${pts.map(([x, y]) => `${round(x)} ${round(y)}`).join('L')}Z`
}

/**
 * 拼出最终图标 SVG。
 * @param d      官方 path 数据
 * @param bounds 官方 path 的墨迹包围盒（官方坐标系，视口 50x50）
 */
function buildIconSvg(d, bounds, { fill, bg, fg, tile }) {
  const side = CANVAS * tile
  const pad = (CANVAS - side) / 2

  const gw = bounds.x1 - bounds.x0
  const gh = bounds.y1 - bounds.y0
  const cx = (bounds.x0 + bounds.x1) / 2
  const cy = (bounds.y0 + bounds.y1) / 2

  const scale = ((tile > 0 ? side : CANVAS) * fill) / gw
  const tx = CANVAS / 2 - cx * scale
  const ty = CANVAS / 2 - cy * scale

  // tile = 0：不画底板，只把图形交给系统 —— 用来看 macOS 会怎么处理「裸图标」
  const plate =
    tile > 0
      ? `  <!-- 底板：自绘的超椭圆连续角方块（官方包没有底板资源） -->\n  <path d="${tilePath(pad, side)}" fill="${bg}"/>\n`
      : '  <!-- 无底板：图形之外全部透明，看系统怎么兜底 -->\n'

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
${plate}  <!-- 官方鲸鱼，只换颜色，图形不动 -->
  <g transform="translate(${tx.toFixed(6)} ${ty.toFixed(6)}) scale(${scale.toFixed(8)})">
    <path d="${d}" fill="${fg}" fill-rule="nonzero"/>
  </g>
</svg>
`
  return {
    svg,
    stats: {
      底板: tile > 0 ? `${side.toFixed(1)}x${side.toFixed(1)} @ (${pad.toFixed(1)},${pad.toFixed(1)})  占画布 ${((side / CANVAS) * 100).toFixed(1)}%` : '无（只交图形给系统）',
      角: `角盒 ${(side * CORNER_RATIO).toFixed(1)}px  指数 ${CORNER_EXPONENT}（超椭圆连续角）`,
      鲸鱼原始宽高: `${gw.toFixed(3)} x ${gh.toFixed(3)}`,
      鲸鱼渲染宽高: `${(gw * scale).toFixed(1)} x ${(gh * scale).toFixed(1)}`,
      鲸鱼占底板: tile > 0 ? `${(fill * 100).toFixed(0)}% 宽 / ${(((gh * scale) / side) * 100).toFixed(0)}% 高` : '—',
      鲸鱼占画布: `${(((gw * scale) / CANVAS) * 100).toFixed(1)}% 宽`
    }
  }
}

// ── 渲染（借 Electron 里的 Chromium） ───────────────────────────────────

async function renderUnderElectron(svgPath, options) {
  const { app, BrowserWindow } = require('electron')
  app.disableHardwareAcceleration()

  await app.whenReady()

  const win = new BrowserWindow({
    width: CANVAS,
    height: CANVAS,
    show: false,
    frame: false,
    useContentSize: true,
    transparent: true, // 方块之外必须透明，系统不会替 App 裁形状
    backgroundColor: '#00000000'
  })

  const svg = fs.readFileSync(svgPath, 'utf8')
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:${CANVAS}px;height:${CANVAS}px;overflow:hidden;background:transparent}
    svg{display:block}
  </style>${svg}`

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 400))

  const master = (await win.webContents.capturePage()).resize({
    width: CAPTURE,
    height: CAPTURE,
    quality: 'best'
  })
  const master1024 = master.resize({ width: CANVAS, height: CANVAS, quality: 'best' })

  if (options.preview) {
    fs.writeFileSync(options.preview, master1024.toPNG())
    checkAlpha(master1024, options, true)
    app.quit()
    return
  }

  fs.mkdirSync(WORK, { recursive: true })
  fs.writeFileSync(path.join(WORK, 'master.png'), master.toPNG())

  const iconset = path.join(WORK, 'icon.iconset')
  fs.rmSync(iconset, { recursive: true, force: true })
  fs.mkdirSync(iconset, { recursive: true })
  for (const [name, px] of ICONSET) {
    const image = px === CAPTURE ? master : master.resize({ width: px, height: px, quality: 'best' })
    fs.writeFileSync(path.join(iconset, name), image.toPNG())
  }
  fs.writeFileSync(path.join(BUILD, 'icon.png'), master1024.toPNG())

  app.quit()

  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(BUILD, 'icon.icns')], {
    stdio: 'inherit'
  })

  checkAlpha(master1024, options, false)
  console.log(`\n图标已更新：`)
  for (const f of ['icon.icns', 'icon.png', 'icon.svg']) {
    console.log(`  ${path.relative(ROOT, path.join(BUILD, f))}  ${fs.statSync(path.join(BUILD, f)).size} bytes`)
  }
  console.log(`\n下一步：npm run dist`)
}

/** 自检：方块外必须透明。正方形的四角是唯一能验证连续角画对了的地方。 */
function checkAlpha(image, options, quiet) {
  const { width, height } = image.getSize()
  const bitmap = image.toBitmap() // BGRA
  const at = (x, y) => {
    const i = (y * width + x) * 4
    return { b: bitmap[i], g: bitmap[i + 1], r: bitmap[i + 2], a: bitmap[i + 3] }
  }
  const corners = [at(1, 1), at(width - 2, 1), at(1, height - 2), at(width - 2, height - 2)]
  const side = width * options.tile
  const pad = (width - side) / 2
  const paddingHalf = Math.round(pad / 2)
  const outside = at(paddingHalf, Math.floor(height / 2))
  const center = at(Math.floor(width / 2), Math.floor(height / 2))
  const hex = (c) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`

  const ok = corners.every((c) => c.a === 0) && outside.a === 0
  console.log(`\n自检（${width}x${height}）：`)
  console.log(`  四角透明: ${corners.every((c) => c.a === 0) ? '✅' : '❌ ' + JSON.stringify(corners)}`)
  console.log(`  底板外透明: ${outside.a === 0 ? '✅' : '❌ ' + JSON.stringify(outside)}`)
  console.log(`  中心像素: ${hex(center)}（应为 ${options.fg}，鲸鱼压在这里）`)
  if (!quiet && !ok) process.exitCode = 1
}

// ── 入口 ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { ...DEFAULTS, preview: undefined }
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === '--preview') options.preview = argv[++i]
    else if (key === '--fill') options.fill = Number(argv[++i])
    else if (key === '--bg') options.bg = argv[++i]
    else if (key === '--fg') options.fg = argv[++i]
    else if (key === '--tile') options.tile = Number(argv[++i])
    else throw new Error(`未知参数 ${key}`)
  }
  if (!(options.fill > 0 && options.fill <= 1)) throw new Error(`--fill 要在 (0,1] 之间，收到 ${options.fill}`)
  if (!(options.tile >= 0 && options.tile <= 1)) throw new Error(`--tile 要在 [0,1] 之间，收到 ${options.tile}`)
  return options
}

const OPTIONS = parseArgs(process.argv.slice(2))

if (process.versions.electron) {
  void renderUnderElectron(path.join(WORK, 'icon.svg'), OPTIONS)
} else {
  const { file, svg } = officialLogoSvg()
  const d = extractPathData(svg)
  const bounds = glyphBounds(d)
  const { svg: iconSvg, stats } = buildIconSvg(d, bounds, OPTIONS)

  fs.mkdirSync(WORK, { recursive: true })
  fs.writeFileSync(path.join(WORK, 'icon.svg'), iconSvg)
  if (!OPTIONS.preview) fs.writeFileSync(path.join(BUILD, 'icon.svg'), iconSvg)

  if (!OPTIONS.preview) {
    console.log(`官方图形来源：${path.relative(ROOT, file)}`)
    for (const [k, v] of Object.entries(stats)) console.log(`  ${k}：${v}`)
  }

  const electron = require('electron') // 普通 Node 下它导出二进制路径
  const args = [__filename, '--fill', String(OPTIONS.fill), '--bg', OPTIONS.bg, '--fg', OPTIONS.fg, '--tile', String(OPTIONS.tile)]
  if (OPTIONS.preview) args.push('--preview', OPTIONS.preview)
  execFileSync(electron, args, { stdio: 'inherit' })
}
