#!/usr/bin/env node
'use strict'

/**
 * 生成 App 图标：**纯黑圆角方块 + 白色官方鲸鱼**。
 *
 *   node tools/make-icon.js [--fill 0.60]
 *
 * 图标里的鲸鱼不是自己描的，而是**直接从 dsh 官方包里取**：
 *
 *   node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon.svg
 *
 * 那是官方 Web UI 的 favicon，也是 manifest.webmanifest 里唯一的图标条目，
 * 即官方承认的品牌图形。本脚本只做两件事：把它的 path 拿出来、换成白色，
 * 放到一个黑色圆角方块上 —— 图形本身一笔不改。
 *
 * 为什么要借 Chromium 渲染
 * ────────────────────────
 * 那个 path 有 4 个子路径且互相嵌套（鲸鱼身体 / 鳍 / 两只眼睛），靠
 * `fill-rule="nonzero"` 的环绕方向挖空。用 PIL 的 polygon 或任何按「简单多边形」
 * 处理的库都画不出那些挖空。Chromium 是唯一现成的、能正确处理它的渲染器，
 * 而 Electron 里就自带一个。所以这个脚本自己用 electron 重新拉起自己。
 *
 * 另外官方 SVG 带一段 `@media (prefers-color-scheme: dark) { path { fill:#fff } }`，
 * 系统是深色模式时 Direct 渲染会得到白鲸鱼 —— 所以这里**只用它的 path 数据**，
 * 颜色由我们显式指定，不受媒体查询影响。
 *
 * 产物：
 *   build/icon.icns     打包时 electron-builder 用的图标
 *   build/icon.png      1024x1024 主图，留档 / 需要时改尺寸
 *   build/icon.svg      最终 SVG（同样留档，改配色时看它最直观）
 */

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const BUILD = path.join(ROOT, 'build')
const WORK = path.join(BUILD, 'icon-build')

const CANVAS = 1024
const TILE = 824 // macOS 图标的内容区：1024 画布里四周各留 100pt
const RADIUS_RATIO = 0.2237 // 接近 Apple 连续圆角的圆角比例
const CAPTURE = 2048 // 渲染分辨率（2 倍超采样，再缩到各档）

/** 各档尺寸 —— iconutil 要求的完整清单。 */
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

/** 在 node_modules 里找官方 favicon。找不到就报错说清楚该装什么。 */
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

/** 取 <path> 的 d 属性。注意不能直接找 `d="` —— `id="path"` 里也含这个子串。 */
function extractPathData(svg) {
  const tag = svg.match(/<path[^>]*>/)
  if (!tag) throw new Error('官方 SVG 里没有 <path>，格式可能变了')
  const d = tag[0].match(/\sd="([^"]*)"/)
  if (!d) throw new Error('官方 SVG 的 <path> 上没有 d 属性')
  return d[1]
}

/**
 * 把 path 里的三次贝塞尔展平，求墨迹包围盒 —— 这样才知道该把鲸鱼放大多少倍、
 * 往哪儿居中。硬编码包围盒在官方换图形时会静默画歪，所以这里现算。
 */
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
      i += 1 // Z 等闭合指令不影响包围盒
    }
  }

  if (points.length === 0) throw new Error('path 里没解析出任何点')
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys)
  }
}

/**
 * 拼出最终图标 SVG。
 * @param d      官方 path 数据
 * @param bounds 官方 path 的墨迹包围盒（官方坐标系，视口 50x50）
 * @param fill   鲸鱼宽度占黑色方块边长的比例
 */
function buildIconSvg(d, bounds, fill) {
  const gw = bounds.x1 - bounds.x0
  const gh = bounds.y1 - bounds.y0
  const cx = (bounds.x0 + bounds.x1) / 2
  const cy = (bounds.y0 + bounds.y1) / 2
  const radius = TILE * RADIUS_RATIO
  const scale = (TILE * fill) / gw
  const tx = CANVAS / 2 - cx * scale
  const ty = CANVAS / 2 - cy * scale

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <!-- 纯黑圆角方块 -->
  <rect x="100" y="100" width="${TILE}" height="${TILE}" rx="${radius.toFixed(4)}" ry="${radius.toFixed(4)}" fill="#000000"/>
  <!-- 官方鲸鱼，只换颜色，图形不动 -->
  <g transform="translate(${tx.toFixed(6)} ${ty.toFixed(6)}) scale(${scale.toFixed(8)})">
    <path d="${d}" fill="#ffffff" fill-rule="nonzero"/>
  </g>
</svg>
`
  return {
    svg,
    stats: {
      鲸鱼原始宽高: `${gw.toFixed(3)} x ${gh.toFixed(3)}`,
      缩放倍数: scale.toFixed(4),
      渲染宽高: `${(gw * scale).toFixed(1)} x ${(gh * scale).toFixed(1)}`,
      占方块比例: `${(fill * 100).toFixed(0)}% 宽 / ${(((gh * scale) / TILE) * 100).toFixed(0)}% 高`
    }
  }
}

// ── 渲染（需要 Electron 里的 Chromium） ─────────────────────────────────

/** 在 Electron 里：渲染 SVG，按各档尺寸导出 PNG，最后打 icns。 */
async function renderUnderElectron(svgPath, fill) {
  const { app, BrowserWindow, nativeImage } = require('electron')
  app.disableHardwareAcceleration() // 离屏渲染，关掉 GPU 更稳

  await app.whenReady()

  const win = new BrowserWindow({
    width: CANVAS,
    height: CANVAS,
    show: false,
    frame: false,
    useContentSize: true,
    transparent: true, // 方块之外必须透明，系统不会替我们裁形状
    backgroundColor: '#00000000'
  })

  const svg = fs.readFileSync(svgPath, 'utf8')
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:${CANVAS}px;height:${CANVAS}px;overflow:hidden;background:transparent}
    svg{display:block}
  </style>${svg}`

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 400))

  const shot = await win.webContents.capturePage()
  const master = shot.resize({ width: CAPTURE, height: CAPTURE, quality: 'best' })
  fs.writeFileSync(path.join(WORK, 'master.png'), master.toPNG())

  const iconset = path.join(WORK, 'icon.iconset')
  fs.rmSync(iconset, { recursive: true, force: true })
  fs.mkdirSync(iconset, { recursive: true })

  for (const [name, px] of ICONSET) {
    // 2048 → 1024/512 是整数倍，最干净；其余档交给 nativeImage 的双三次重采样
    const image = px === CAPTURE ? master : master.resize({ width: px, height: px, quality: 'best' })
    fs.writeFileSync(path.join(iconset, name), image.toPNG())
  }

  // 1024 主图单独留一份，方便肉眼检查
  const flat = master.resize({ width: CANVAS, height: CANVAS, quality: 'best' })
  fs.writeFileSync(path.join(BUILD, 'icon.png'), flat.toPNG())

  app.quit()

  // iconutil 必须在退出 Electron 之后跑：它是独立进程，不依赖渲染环境
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(BUILD, 'icon.icns')], {
    stdio: 'inherit'
  })

  report(checkAlpha(flat))
  console.log(`\n图标已更新：`)
  console.log(`  ${path.relative(ROOT, path.join(BUILD, 'icon.icns'))}   ${fs.statSync(path.join(BUILD, 'icon.icns')).size} bytes`)
  console.log(`  ${path.relative(ROOT, path.join(BUILD, 'icon.png'))}`)
  console.log(`  ${path.relative(ROOT, path.join(BUILD, 'icon.svg'))}`)
  console.log(`\n下一步：npm run dist`)
  void fill
}

/** 自检：方块外必须透明，中心必须是白的（鲸鱼盖住了方块中心）。 */
function checkAlpha(image) {
  const size = image.getSize()
  const bitmap = image.toBitmap() // BGRA
  const at = (x, y) => {
    const i = (y * size.width + x) * 4
    return { b: bitmap[i], g: bitmap[i + 1], r: bitmap[i + 2], a: bitmap[i + 3] }
  }
  const corners = [at(1, 1), at(size.width - 2, 1), at(1, size.height - 2), at(size.width - 2, size.height - 2)]
  const center = at(Math.floor(size.width / 2), Math.floor(size.height / 2))
  const tile = Math.round((TILE / CANVAS) * size.width)
  // 取样点要落在「方块之外的留白」里：留白宽度是 (画布 - 方块)，取它的一半
  const paddingHalf = Math.round((size.width - tile) / 4)
  const outside = at(paddingHalf, Math.floor(size.height / 2))
  return { corners, center, outside, size }
}

function report({ corners, center, outside, size }) {
  console.log(`\n自检（${size.width}x${size.height}）：`)
  console.log(
    `  四角透明: ${corners.every((c) => c.a === 0) ? '✅' : '❌ ' + JSON.stringify(corners)}`
  )
  console.log(`  方块外透明: ${outside.a === 0 ? '✅' : '❌ ' + JSON.stringify(outside)}`)
  console.log(
    `  中心是白色鲸鱼: ${
      center.a === 255 && center.r > 250 && center.g > 250 && center.b > 250
        ? '✅'
        : '❌ ' + JSON.stringify(center)
    }`
  )
}

// ── 入口 ────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2)
  const fillIndex = args.indexOf('--fill')
  const fill = fillIndex >= 0 ? Number(args[fillIndex + 1]) : 0.6
  if (!(fill > 0 && fill <= 1)) throw new Error(`--fill 要在 (0, 1] 之间，收到 ${fill}`)
  return fill
}

const FILL = main()

if (process.versions.electron) {
  // 已经在 Electron 里了 —— 直接渲染
  void renderUnderElectron(path.join(WORK, 'icon.svg'), FILL)
} else {
  // 普通 Node：取官方 path、生成 SVG，再用 electron 把自己重新拉起来
  const { file, svg } = officialLogoSvg()
  const d = extractPathData(svg)
  const bounds = glyphBounds(d)
  const { svg: iconSvg, stats } = buildIconSvg(d, bounds, FILL)

  fs.mkdirSync(WORK, { recursive: true })
  fs.writeFileSync(path.join(WORK, 'icon.svg'), iconSvg)
  fs.writeFileSync(path.join(BUILD, 'icon.svg'), iconSvg)

  console.log(`官方图形来源：${path.relative(ROOT, file)}`)
  console.log(`官方墨迹包围盒：x [${bounds.x0.toFixed(3)}, ${bounds.x1.toFixed(3)}]  y [${bounds.y0.toFixed(3)}, ${bounds.y1.toFixed(3)}]`)
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k}：${v}`)
  console.log()

  const electron = require('electron') // 在普通 Node 下它导出二进制路径
  execFileSync(electron, [__filename, '--fill', String(FILL)], { stdio: 'inherit' })
}
