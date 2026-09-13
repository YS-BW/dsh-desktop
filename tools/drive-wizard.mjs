/**
 * 通过 CDP 驱动真实运行的 DSH Desktop Min，验证初始化向导。
 *
 * 为什么不用「模拟点击」的单元测试就完事：单元测试用的是桩，而这次要证的是
 * **真实安装版**里那个页面能拿到插件清单、且点击能穿过 will-navigate 被主进程接住。
 * CDP 是 Electron 自带的调试口，驱动的是真进程、真渲染器。
 *
 * 用法：node drive-wizard.mjs [调试端口]
 */

const port = Number(process.argv[2] || 9222)

async function targets() {
  const response = await fetch(`http://127.0.0.1:${port}/json`)
  return response.json()
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.addEventListener('open', () => resolve(socket), { once: true })
    socket.addEventListener('error', (event) => reject(new Error(String(event.message || 'ws error'))), {
      once: true
    })
  })
}

let nextId = 1
function evaluate(socket, expression) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      socket.removeEventListener('message', onMessage)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else if (message.result?.exceptionDetails) {
        reject(new Error(message.result.exceptionDetails.text || 'evaluate threw'))
      } else resolve(message.result?.result?.value)
    }
    socket.addEventListener('message', onMessage)
    socket.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true }
      })
    )
  })
}

const list = await targets()
const pages = list.filter((entry) => entry.type === 'page')
console.log('页面目标:', pages.map((page) => page.url).join(' | ') || '(无)')

const setupPage = pages.find((page) => page.url.includes('setup.html'))
if (!setupPage) {
  console.log('✖ 没找到初始化页 —— 应用可能没停在向导上')
  process.exit(2)
}

const socket = await connect(setupPage.webSocketDebuggerUrl)
try {
  const cards = await evaluate(socket, `document.querySelectorAll('.card').length`)
  const names = await evaluate(
    socket,
    `[...document.querySelectorAll('.card h2')].map((el) => el.textContent).join(',')`
  )
  const continueLabel = await evaluate(
    socket,
    `document.getElementById('continue').textContent`
  )
  const skipDisabled = await evaluate(socket, `document.getElementById('skip').disabled`)
  console.log(`插件卡片数 = ${cards}`)
  console.log(`卡片标题   = ${names || '(空)'}`)
  console.log(`继续按钮   = ${continueLabel}`)
  console.log(`跳过可用   = ${!skipDisabled}`)

  console.log('→ 点击「跳过」')
  await evaluate(socket, `document.getElementById('skip').click()`)
} finally {
  socket.close()
}
