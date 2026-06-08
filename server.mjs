#!/usr/bin/env node
// MCP server for HarmonyOS ArkWeb, backed by playwright-core via connectOverCDP.
// Bootstrap (hdc connect + browser launch + fport) is delegated to ohos-playwright's setup.
//
// register.mjs MUST be imported first — it sets process.platform = 'linux'
// before playwright-core's hostPlatform detection runs.

import { createRequire } from 'node:module'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)

function resolveOrThrow(spec, hint) {
  // env override wins
  const envPath = process.env[hint]
  if (envPath) return envPath
  try { return require.resolve(spec) }
  catch (e) {
    throw new Error(
      `Cannot find "${spec}". Install it as a peer dependency, or set ${hint} to its absolute path. ` +
      `(original: ${e.message})`
    )
  }
}

const REGISTER_PATH = resolveOrThrow('ohos-playwright/register', 'ARKWEB_OHOS_PW_REGISTER')
const SETUP_PATH    = resolveOrThrow('ohos-playwright/setup',    'ARKWEB_OHOS_PW_SETUP')
const PW_CORE_PATH  = resolveOrThrow('playwright-core',          'ARKWEB_PW_CORE')
const INFO_PATH     = process.env.OHOS_PW_INFO_PATH ?? `${tmpdir()}/ohos-playwright-cdp.json`

let cdpEndpoint = null

await import(REGISTER_PATH)
const pwModule = await import(PW_CORE_PATH)
const chromium = pwModule.chromium ?? pwModule.default?.chromium
if (!chromium) throw new Error(`playwright-core loaded but no chromium export (keys: ${Object.keys(pwModule).join(',')})`)

const log = (...a) => console.error('[arkweb-cdp-mcp]', ...a)

let browser = null
let context = null
let currentPage = null
let bootstrapPromise = null

const consoleBuffer = []          // { pageUrl, type, text, ts }
const networkRequests = []        // { id, url, method, status, requestHeaders, responseHeaders, postData, fromCache, durationMs }
const networkById = new Map()
const dialogQueue = []            // pending dialog handlers; auto-dismiss with default
let dialogPolicy = { action: 'dismiss', promptText: '' }
const routeHandlers = new Map()   // pattern -> {handler, status: 'active', hits: 0}

async function ensureBootstrapped() {
  if (existsSync(INFO_PATH)) {
    try {
      const info = JSON.parse(readFileSync(INFO_PATH, 'utf8'))
      const r = await fetch(`${info.endpoint}/json/version`).catch(() => null)
      if (r?.ok) return info
      log('stale INFO_PATH, re-bootstrapping')
    } catch {}
  }
  const setup = await import(SETUP_PATH)
  await setup.default()
  return JSON.parse(readFileSync(INFO_PATH, 'utf8'))
}

async function connect() {
  const info = await ensureBootstrapped()
  cdpEndpoint = info.endpoint
  log('connecting to', info.endpoint)
  browser = await chromium.connectOverCDP(info.endpoint)
  context = browser.contexts()[0]
  if (!context) throw new Error('no browser context')

  context.on('page', wirePage)
  for (const p of context.pages()) wirePage(p)
  currentPage = context.pages().find(p => !p.url().startsWith('chrome-')) ?? context.pages()[0] ?? null

  log(`ready: ${context.pages().length} page(s), current=${currentPage?.url() ?? 'none'}`)
}

function wirePage(page) {
  page.on('console', msg => {
    consoleBuffer.push({
      pageUrl: page.url(), type: msg.type(), text: msg.text(),
      ts: Date.now(),
    })
    if (consoleBuffer.length > 1000) consoleBuffer.splice(0, consoleBuffer.length - 1000)
  })
  page.on('pageerror', err => {
    consoleBuffer.push({ pageUrl: page.url(), type: 'pageerror', text: err.message, ts: Date.now() })
  })
  page.on('dialog', async d => {
    if (dialogPolicy.action === 'accept') await d.accept(dialogPolicy.promptText)
    else await d.dismiss()
  })
  page.on('request', req => {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const entry = {
      id, url: req.url(), method: req.method(),
      resourceType: req.resourceType(),
      startedAt: Date.now(),
      postData: req.postDataBuffer()?.toString('base64'),
      requestHeaders: req.headers(),
    }
    req._mcpId = id
    networkRequests.push(entry)
    networkById.set(id, entry)
    if (networkRequests.length > 500) {
      const dropped = networkRequests.splice(0, networkRequests.length - 500)
      for (const d of dropped) networkById.delete(d.id)
    }
  })
  page.on('response', async resp => {
    const req = resp.request()
    const entry = networkById.get(req._mcpId)
    if (!entry) return
    entry.status = resp.status()
    entry.responseHeaders = resp.headers()
    entry.durationMs = Date.now() - entry.startedAt
    entry.fromCache = resp.fromServiceWorker?.() ?? false
  })
  page.on('close', () => {
    if (currentPage === page) currentPage = context?.pages().find(p => p !== page) ?? null
  })
}

async function httpNewTab(url) {
  const u = url ? `${cdpEndpoint}/json/new?${encodeURIComponent(url)}` : `${cdpEndpoint}/json/new`
  // Try PUT then GET — different Chromium versions accept different methods.
  let r = await fetch(u, { method: 'PUT' }).catch(() => null)
  if (!r || !r.ok) r = await fetch(u).catch(() => null)
  if (!r || !r.ok) throw new Error(`/json/new failed (${r?.status ?? 'no response'})`)
}

async function createBlankTab() {
  const pagePromise = context.waitForEvent('page', { timeout: 10000 }).catch(() => null)
  await httpNewTab()
  const p = await pagePromise
  if (p) return p
  return context.pages().find(x => !x.isClosed()) ?? null
}

async function getPage() {
  if (bootstrapPromise) await bootstrapPromise
  if (!browser || !browser.isConnected()) await (bootstrapPromise = connect().finally(() => { bootstrapPromise = null }))
  if (!currentPage || currentPage.isClosed()) {
    currentPage = context.pages().find(p => !p.isClosed()) ?? null
    if (!currentPage) currentPage = await createBlankTab()
    if (!currentPage) throw new Error('no usable page and could not create one')
  }
  return currentPage
}

// =========================================================================
// Tools
// =========================================================================

const TOOLS = []
const HANDLERS = {}

function tool(name, description, inputSchema, handler) {
  TOOLS.push({ name, description, inputSchema })
  HANDLERS[name] = handler
}

const sObj = (props = {}, required = []) => ({ type: 'object', properties: props, ...(required.length ? { required } : {}) })
const sStr = (description) => ({ type: 'string', ...(description ? { description } : {}) })
const sInt = (description, def) => ({ type: 'integer', ...(description ? { description } : {}), ...(def != null ? { default: def } : {}) })
const sBool = (description, def) => ({ type: 'boolean', ...(description ? { description } : {}), ...(def != null ? { default: def } : {}) })
const sNum = (description) => ({ type: 'number', ...(description ? { description } : {}) })

// -------------------- core navigation/state --------------------

tool('navigate', 'Navigate the current page to a URL. Waits for load by default.',
  sObj({ url: sStr(), wait_until: sStr('load|domcontentloaded|networkidle, default load') }, ['url']),
  async ({ url, wait_until }) => {
    return withRetryOnNavigation(async () => {
      const page = await getPage()
      await page.goto(url, { waitUntil: wait_until ?? 'load', timeout: 30000 })
      return `Navigated to ${page.url()}`
    })
  })

tool('navigate_back', 'Go back in history on the current page.',
  sObj({}),
  async () => { const page = await getPage(); await page.goBack({ waitUntil: 'commit', timeout: 5000 }).catch(() => {}); return `back → ${page.url()}` })

tool('navigate_forward', 'Go forward in history on the current page.',
  sObj({}),
  async () => { const page = await getPage(); await page.goForward({ waitUntil: 'commit', timeout: 5000 }).catch(() => {}); return `forward → ${page.url()}` })

tool('reload', 'Reload the current page.',
  sObj({}),
  async () => { const page = await getPage(); await page.reload(); return `reloaded ${page.url()}` })

tool('wait', 'Sleep for N milliseconds.',
  sObj({ ms: sInt('milliseconds', 1000) }),
  async ({ ms }) => { await new Promise(r => setTimeout(r, ms ?? 1000)); return `slept ${ms ?? 1000}ms` })

tool('wait_for', 'Wait for a condition: text to appear/disappear, selector to attach/detach, or time to elapse.',
  sObj({
    text: sStr('text to wait for (substring match in document)'),
    text_gone: sStr('text to wait to disappear'),
    selector: sStr('CSS selector to wait for'),
    state: sStr('visible|hidden|attached|detached, default visible (used with selector)'),
    time_ms: sInt('alternative: just sleep this long'),
    timeout_ms: sInt('overall timeout, default 30000', 30000),
  }),
  async ({ text, text_gone, selector, state, time_ms, timeout_ms }) => {
    const page = await getPage()
    const t = timeout_ms ?? 30000
    if (time_ms != null) { await page.waitForTimeout(time_ms); return `slept ${time_ms}ms` }
    if (selector) { await page.waitForSelector(selector, { state: state ?? 'visible', timeout: t }); return `selector ${state ?? 'visible'}: ${selector}` }
    if (text) { await page.waitForFunction(s => document.body.innerText.includes(s), text, { timeout: t }); return `text appeared: ${text}` }
    if (text_gone) { await page.waitForFunction(s => !document.body.innerText.includes(s), text_gone, { timeout: t }); return `text gone: ${text_gone}` }
    throw new Error('wait_for requires one of: text, text_gone, selector, time_ms')
  })

tool('evaluate', 'Evaluate JavaScript on the page. `expression` may be an expression or a `()=>...` function. Returns JSON.',
  sObj({ expression: sStr() }, ['expression']),
  async ({ expression }) => withRetryOnNavigation(async () => {
    const page = await getPage()
    const looksLikeFn = /^\s*(\([^)]*\)\s*=>|async\s|function\b)/.test(expression)
    const looksLikeIIFE = /^\s*\(\s*(\(|async\s|function\b)/.test(expression)
    const shouldInvoke = looksLikeFn && !looksLikeIIFE
    const r = await page.evaluate(shouldInvoke ? `(${expression})()` : expression)
    return JSON.stringify(r, null, 2) ?? 'undefined'
  }))

async function withRetryOnNavigation(fn) {
  try { return await fn() }
  catch (e) {
    if (!/Execution context was destroyed|frame got detached|Target page, context or browser/i.test(e.message)) throw e
    const page = await getPage()
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
    return await fn()
  }
}

tool('get_text', 'Return document.body.innerText.',
  sObj({}),
  async () => withRetryOnNavigation(async () => (await getPage()).evaluate(() => document.body.innerText)))

tool('get_html', 'Return document.documentElement.outerHTML.',
  sObj({}),
  async () => withRetryOnNavigation(async () => (await getPage()).content()))

tool('screenshot', 'Take a PNG screenshot. Default saves to a tmp path (ArkWeb resolutions often exceed MCP clients\' inline-image size limit). Pass `path` to choose location, or `inline: true` to return base64. Uses raw CDP to skip Playwright font-wait (which hangs on some ArkWeb pages).',
  sObj({
    path: sStr('save to this path (overrides default tmp location)'),
    full_page: sBool('capture full scrollable page', false),
    selector: sStr('limit to an element matching this selector'),
    inline: sBool('return base64 image instead of saving to disk (may exceed client size limits)', false),
  }),
  async ({ path, full_page, selector, inline }) => {
    const page = await getPage()
    let buf
    if (selector) {
      buf = await page.locator(selector).first().screenshot({ type: 'png', timeout: 15000, animations: 'disabled' })
    } else {
      const session = await context.newCDPSession(page)
      try {
        const r = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!full_page })
        buf = Buffer.from(r.data, 'base64')
      } finally { await session.detach().catch(() => {}) }
    }
    if (inline) {
      return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }] }
    }
    const outPath = path ?? join(tmpdir(), `ohos-screenshot-${Date.now()}.png`)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, buf)
    return `saved ${buf.length} bytes to ${outPath}`
  })

// -------------------- tabs/pages --------------------

function pageId(p) {
  // playwright doesn't expose target id; use index in context.pages() — caller passes 0..N-1 or a URL substring
  return context.pages().indexOf(p)
}

tool('list_pages', 'List all open pages in the context. Returns index (use as `id` for select_page), title, url.',
  sObj({}),
  async () => {
    await getPage()
    const pages = context.pages()
    return JSON.stringify(await Promise.all(pages.map(async (p, i) => ({
      id: i, title: await p.title().catch(() => ''), url: p.url(), current: p === currentPage,
    }))), null, 2)
  })

tool('select_page', 'Switch the current page. `id` is the index from list_pages, OR a substring of the URL.',
  sObj({ id: { oneOf: [{ type: 'integer' }, { type: 'string' }] } }, ['id']),
  async ({ id }) => {
    await getPage()
    const pages = context.pages()
    let target
    if (typeof id === 'number') target = pages[id]
    else target = pages.find(p => p.url().includes(id))
    if (!target) throw new Error(`no page matching ${id}`)
    currentPage = target
    return `selected [${pages.indexOf(target)}] ${target.url()}`
  })

tool('tab_new', 'Open a new tab. Optional `url` to navigate it.',
  sObj({ url: sStr() }),
  async ({ url }) => {
    await getPage()
    const pagePromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null)
    await httpNewTab(url)
    const p = await pagePromise
    if (!p) return `created tab via CDP HTTP, but no playwright page event; url=${url ?? 'about:blank'}`
    currentPage = p
    if (url) await p.waitForLoadState('load', { timeout: 30000 }).catch(() => {})
    return `opened tab [${context.pages().indexOf(p)}] ${p.url()}`
  })

tool('tab_close', 'Close a tab by index (default: current).',
  sObj({ id: sInt() }),
  async ({ id }) => {
    await getPage()
    const pages = context.pages()
    const target = (id == null) ? currentPage : pages[id]
    if (!target) throw new Error(`no page at ${id}`)
    const url = target.url()
    await target.close()
    return `closed ${url}`
  })

tool('close', 'Disconnect from the browser. Does NOT kill the ArkWeb process.',
  sObj({}),
  async () => { await browser?.close(); browser = null; return 'disconnected' })

tool('resize', 'Set viewport size for the current page.',
  sObj({ width: sInt(), height: sInt() }, ['width', 'height']),
  async ({ width, height }) => {
    const page = await getPage()
    await page.setViewportSize({ width, height })
    return `viewport ${width}x${height}`
  })

// -------------------- input --------------------

tool('click', 'Click an element matching a Playwright selector (CSS, text=, role=, etc).',
  sObj({
    selector: sStr(),
    button: sStr('left|right|middle, default left'),
    click_count: sInt('default 1'),
    modifiers: { type: 'array', items: { type: 'string' }, description: 'Alt|Control|Meta|Shift' },
    force: sBool('skip actionability checks'),
  }, ['selector']),
  async ({ selector, button, click_count, modifiers, force }) => {
    const page = await getPage()
    await page.locator(selector).first().click({ button, clickCount: click_count, modifiers, force, timeout: 15000 })
    return `clicked ${selector}`
  })

tool('hover', 'Hover an element matching a selector.',
  sObj({ selector: sStr() }, ['selector']),
  async ({ selector }) => {
    const page = await getPage()
    await page.locator(selector).first().hover({ timeout: 15000 })
    return `hovered ${selector}`
  })

tool('type', 'Type text into a focused-or-selectored element character-by-character (slower; fires keyboard events).',
  sObj({ selector: sStr(), text: sStr(), delay_ms: sInt('per-char delay', 0) }, ['selector', 'text']),
  async ({ selector, text, delay_ms }) => {
    const page = await getPage()
    await page.locator(selector).first().pressSequentially(text, { delay: delay_ms ?? 0, timeout: 15000 })
    return `typed ${text.length} chars into ${selector}`
  })

tool('fill', 'Set an input/textarea/contenteditable to the given value (fast; clears existing).',
  sObj({ selector: sStr(), value: sStr() }, ['selector', 'value']),
  async ({ selector, value }) => {
    const page = await getPage()
    await page.locator(selector).first().fill(value, { timeout: 15000 })
    return `filled ${selector}`
  })

tool('fill_form', 'Fill multiple fields at once. `fields`: [{selector, value}].',
  sObj({ fields: { type: 'array', items: { type: 'object', properties: { selector: sStr(), value: sStr() }, required: ['selector', 'value'] } } }, ['fields']),
  async ({ fields }) => {
    const page = await getPage()
    for (const f of fields) await page.locator(f.selector).first().fill(f.value, { timeout: 15000 })
    return `filled ${fields.length} field(s)`
  })

tool('press_key', 'Press a key (Enter, Tab, ArrowDown, etc). Optional selector to focus first.',
  sObj({ key: sStr(), selector: sStr() }, ['key']),
  async ({ key, selector }) => {
    const page = await getPage()
    if (selector) await page.locator(selector).first().press(key, { timeout: 15000 })
    else await page.keyboard.press(key)
    return `pressed ${key}`
  })

tool('select_option', 'Select <option>(s) in a <select>. `values` accepts strings (value attr), or {label}/{index}.',
  sObj({ selector: sStr(), values: { type: 'array', items: { type: ['string', 'object'] } } }, ['selector', 'values']),
  async ({ selector, values }) => {
    const page = await getPage()
    const r = await page.locator(selector).first().selectOption(values, { timeout: 15000 })
    return `selected ${JSON.stringify(r)}`
  })

tool('file_upload', 'Set files on a <input type="file">. `paths` are absolute paths on the host.',
  sObj({ selector: sStr(), paths: { type: 'array', items: { type: 'string' } } }, ['selector', 'paths']),
  async ({ selector, paths }) => {
    const page = await getPage()
    await page.locator(selector).first().setInputFiles(paths, { timeout: 15000 })
    return `uploaded ${paths.length} file(s)`
  })

tool('drag', 'Drag from one selector to another.',
  sObj({ from: sStr(), to: sStr() }, ['from', 'to']),
  async ({ from, to }) => {
    const page = await getPage()
    await page.locator(from).first().dragTo(page.locator(to).first(), { timeout: 15000 })
    return `dragged ${from} → ${to}`
  })

// -------------------- low-level mouse --------------------

tool('mouse_move_xy', 'Move mouse to (x, y).',
  sObj({ x: sNum(), y: sNum(), steps: sInt('intermediate steps', 1) }, ['x', 'y']),
  async ({ x, y, steps }) => { const p = await getPage(); await p.mouse.move(x, y, { steps: steps ?? 1 }); return `moved to ${x},${y}` })

tool('mouse_click_xy', 'Click at (x, y).',
  sObj({ x: sNum(), y: sNum(), button: sStr('left|right|middle, default left') }, ['x', 'y']),
  async ({ x, y, button }) => { const p = await getPage(); await p.mouse.click(x, y, { button }); return `clicked ${x},${y}` })

tool('mouse_down', 'Press a mouse button at current position.',
  sObj({ button: sStr('left|right|middle, default left') }),
  async ({ button }) => { const p = await getPage(); await p.mouse.down({ button }); return `mouse down` })

tool('mouse_up', 'Release a mouse button.',
  sObj({ button: sStr('left|right|middle, default left') }),
  async ({ button }) => { const p = await getPage(); await p.mouse.up({ button }); return `mouse up` })

tool('mouse_drag_xy', 'Drag from (x1,y1) to (x2,y2).',
  sObj({ x1: sNum(), y1: sNum(), x2: sNum(), y2: sNum(), steps: sInt('default 10', 10) }, ['x1', 'y1', 'x2', 'y2']),
  async ({ x1, y1, x2, y2, steps }) => {
    const p = await getPage()
    await p.mouse.move(x1, y1)
    await p.mouse.down()
    await p.mouse.move(x2, y2, { steps: steps ?? 10 })
    await p.mouse.up()
    return `dragged (${x1},${y1}) → (${x2},${y2})`
  })

tool('mouse_wheel', 'Scroll by (deltaX, deltaY).',
  sObj({ delta_x: sNum(), delta_y: sNum() }, ['delta_x', 'delta_y']),
  async ({ delta_x, delta_y }) => { const p = await getPage(); await p.mouse.wheel(delta_x, delta_y); return `wheel (${delta_x},${delta_y})` })

// -------------------- snapshot / locator --------------------

tool('snapshot', 'Return an accessibility snapshot of the current page as flat [role, name, value] rows.',
  sObj({ interactive_only: sBool('only button/link/textbox/etc', true) }),
  async ({ interactive_only }) => {
    const page = await getPage()
    const session = await context.newCDPSession(page)
    try {
      await session.send('Accessibility.enable').catch(() => {})
      const { nodes } = await session.send('Accessibility.getFullAXTree', {})
      const interactiveRoles = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'menuitem', 'tab', 'searchbox', 'switch', 'slider'])
      const onlyI = interactive_only !== false
      const rows = []
      for (const n of nodes) {
        const role = n.role?.value; const name = n.name?.value?.trim(); const value = n.value?.value
        if (!role || role === 'none' || role === 'generic') continue
        if (onlyI && !interactiveRoles.has(role)) continue
        if (!name && !value) continue
        rows.push({ role, name: name || undefined, value: value || undefined })
      }
      return JSON.stringify(rows, null, 2)
    } finally { await session.detach().catch(() => {}) }
  })

// -------------------- console / dialogs --------------------

tool('console_messages', 'Return buffered console messages (and pageerror) from all pages. Pass `clear: true` to drain.',
  sObj({ clear: sBool(), limit: sInt() }),
  async ({ clear, limit }) => {
    await getPage()
    const out = limit ? consoleBuffer.slice(-limit) : consoleBuffer.slice()
    if (clear) consoleBuffer.length = 0
    return JSON.stringify(out, null, 2)
  })

tool('handle_dialog', 'Set the default action for future JS dialogs (alert/confirm/prompt).',
  sObj({ action: sStr('accept|dismiss, default dismiss'), prompt_text: sStr() }),
  async ({ action, prompt_text }) => {
    dialogPolicy = { action: action ?? 'dismiss', promptText: prompt_text ?? '' }
    return `dialogs will be ${dialogPolicy.action}${dialogPolicy.promptText ? ` with "${dialogPolicy.promptText}"` : ''}`
  })

// -------------------- network --------------------

tool('network_requests', 'Return buffered network requests (last 500). Filter with `url_contains`, `method`, `status_min`, `since_ms`.',
  sObj({ url_contains: sStr(), method: sStr(), status_min: sInt(), since_ms: sInt(), clear: sBool() }),
  async ({ url_contains, method, status_min, since_ms, clear }) => {
    await getPage()
    const cutoff = since_ms ? Date.now() - since_ms : 0
    let out = networkRequests
    if (url_contains) out = out.filter(r => r.url.includes(url_contains))
    if (method) out = out.filter(r => r.method === method.toUpperCase())
    if (status_min != null) out = out.filter(r => (r.status ?? 0) >= status_min)
    if (since_ms) out = out.filter(r => r.startedAt >= cutoff)
    const result = out.map(({ id, url, method, status, resourceType, durationMs }) => ({ id, url, method, status, resourceType, durationMs }))
    if (clear) { networkRequests.length = 0; networkById.clear() }
    return JSON.stringify(result, null, 2)
  })

tool('network_request', 'Return full detail (headers, post body) for a single buffered request by id.',
  sObj({ id: sStr() }, ['id']),
  async ({ id }) => {
    await getPage()
    const r = networkById.get(id)
    if (!r) throw new Error(`no request with id ${id}`)
    return JSON.stringify(r, null, 2)
  })

tool('network_state_set', 'Set offline mode for the context.',
  sObj({ offline: sBool() }, ['offline']),
  async ({ offline }) => {
    await getPage()
    await context.setOffline(offline)
    return `offline=${offline}`
  })

tool('route', 'Intercept requests matching a glob (e.g. **/*.png). `action`: abort|continue|fulfill. If fulfill, provide `body`/`status`/`headers`.',
  sObj({
    pattern: sStr('URL glob: **/*.png, https://api.example.com/**, etc'),
    action: sStr('abort|continue|fulfill'),
    body: sStr('response body (for fulfill)'),
    status: sInt('response status (for fulfill, default 200)'),
    headers: { type: 'object' },
  }, ['pattern', 'action']),
  async ({ pattern, action, body, status, headers }) => {
    const page = await getPage()
    if (routeHandlers.has(pattern)) await page.unroute(pattern, routeHandlers.get(pattern).handler)
    const state = { hits: 0, action }
    const handler = async route => {
      state.hits++
      if (action === 'abort') return route.abort()
      if (action === 'fulfill') return route.fulfill({ status: status ?? 200, body: body ?? '', headers: headers ?? {} })
      return route.continue()
    }
    state.handler = handler
    routeHandlers.set(pattern, state)
    await page.route(pattern, handler)
    return `route registered: ${pattern} → ${action}`
  })

tool('route_list', 'List active route patterns and their hit counts.',
  sObj({}),
  async () => {
    await getPage()
    return JSON.stringify([...routeHandlers.entries()].map(([pattern, s]) => ({ pattern, action: s.action, hits: s.hits })), null, 2)
  })

tool('unroute', 'Remove a route pattern.',
  sObj({ pattern: sStr() }, ['pattern']),
  async ({ pattern }) => {
    const page = await getPage()
    const s = routeHandlers.get(pattern)
    if (!s) throw new Error(`no route ${pattern}`)
    await page.unroute(pattern, s.handler)
    routeHandlers.delete(pattern)
    return `unrouted ${pattern}`
  })

// -------------------- cookies --------------------

tool('cookie_list', 'List cookies (optionally filtered by `urls`).',
  sObj({ urls: { type: 'array', items: { type: 'string' } } }),
  async ({ urls }) => { await getPage(); return JSON.stringify(await context.cookies(urls), null, 2) })

tool('cookie_get', 'Get cookies by name (returns matching entries).',
  sObj({ name: sStr() }, ['name']),
  async ({ name }) => { await getPage(); return JSON.stringify((await context.cookies()).filter(c => c.name === name), null, 2) })

tool('cookie_set', 'Add cookies. Each: {name, value, url?, domain?, path?, expires?, httpOnly?, secure?, sameSite?}.',
  sObj({ cookies: { type: 'array', items: { type: 'object' } } }, ['cookies']),
  async ({ cookies }) => { await getPage(); await context.addCookies(cookies); return `added ${cookies.length} cookie(s)` })

tool('cookie_delete', 'Delete a cookie by name (and optional domain/path).',
  sObj({ name: sStr(), domain: sStr(), path: sStr() }, ['name']),
  async ({ name, domain, path }) => {
    await getPage()
    const all = await context.cookies()
    const keep = all.filter(c => !(c.name === name && (!domain || c.domain === domain) && (!path || c.path === path)))
    await context.clearCookies()
    await context.addCookies(keep)
    return `deleted; ${all.length - keep.length} removed`
  })

tool('cookie_clear', 'Clear all cookies from the context.',
  sObj({}),
  async () => { await getPage(); await context.clearCookies(); return 'cleared' })

// -------------------- storage (per-origin) --------------------

function originExpr(kind, op, args = {}) {
  if (op === 'list') return `Object.fromEntries(Object.keys(${kind}).map(k => [k, ${kind}.getItem(k)]))`
  if (op === 'get') return `${kind}.getItem(${JSON.stringify(args.key)})`
  if (op === 'set') return `${kind}.setItem(${JSON.stringify(args.key)}, ${JSON.stringify(args.value)})`
  if (op === 'delete') return `${kind}.removeItem(${JSON.stringify(args.key)})`
  if (op === 'clear') return `${kind}.clear()`
}

for (const kind of ['localStorage', 'sessionStorage']) {
  const prefix = kind === 'localStorage' ? 'localstorage' : 'sessionstorage'
  tool(`${prefix}_list`, `List all ${kind} entries (current page's origin).`, sObj({}),
    async () => (await getPage()).evaluate(`(() => ${originExpr(kind, 'list')})()`))
  tool(`${prefix}_get`, `Get a ${kind} value.`, sObj({ key: sStr() }, ['key']),
    async ({ key }) => (await getPage()).evaluate(`${kind}.getItem(${JSON.stringify(key)})`))
  tool(`${prefix}_set`, `Set a ${kind} value.`, sObj({ key: sStr(), value: sStr() }, ['key', 'value']),
    async ({ key, value }) => { await (await getPage()).evaluate(`${kind}.setItem(${JSON.stringify(key)},${JSON.stringify(value)})`); return `set ${key}` })
  tool(`${prefix}_delete`, `Delete a ${kind} key.`, sObj({ key: sStr() }, ['key']),
    async ({ key }) => { await (await getPage()).evaluate(`${kind}.removeItem(${JSON.stringify(key)})`); return `deleted ${key}` })
  tool(`${prefix}_clear`, `Clear all ${kind} for current origin.`, sObj({}),
    async () => { await (await getPage()).evaluate(`${kind}.clear()`); return 'cleared' })
}

tool('storage_state', 'Dump full storage state (cookies + localStorage). If `path` given, save to file.',
  sObj({ path: sStr() }),
  async ({ path }) => {
    await getPage()
    const state = await context.storageState({ path })
    return path ? `saved to ${path}` : JSON.stringify(state, null, 2)
  })

// -------------------- highlight (Overlay) --------------------

const highlighted = new Set()  // selectors currently shown

tool('highlight', 'Draw a colored outline around all elements matching a selector (page-side overlay, not Chrome devtools overlay).',
  sObj({ selector: sStr(), color: sStr('CSS color, default red'), label: sStr() }, ['selector']),
  async ({ selector, color, label }) => {
    const page = await getPage()
    await page.evaluate(({ sel, col, lbl }) => {
      const STYLE_ID = '__arkweb_mcp_hl__'
      let style = document.getElementById(STYLE_ID)
      if (!style) { style = document.createElement('style'); style.id = STYLE_ID; document.head.appendChild(style) }
      const cls = '__arkweb_hl_' + Math.abs([...sel].reduce((a, c) => a * 31 + c.charCodeAt(0), 0)).toString(36)
      style.appendChild(document.createTextNode(`.${cls}{outline:2px solid ${col} !important;outline-offset:1px}.${cls}::before{content:${JSON.stringify(lbl || sel)};position:absolute;background:${col};color:#fff;font:11px monospace;padding:1px 4px;z-index:99999}`))
      for (const el of document.querySelectorAll(sel)) el.classList.add(cls)
      return cls
    }, { sel: selector, col: color ?? 'red', lbl: label ?? '' })
    highlighted.add(selector)
    return `highlighted ${selector}`
  })

tool('hide_highlight', 'Remove all overlays added by `highlight`.',
  sObj({}),
  async () => {
    const page = await getPage()
    await page.evaluate(() => {
      document.getElementById('__arkweb_mcp_hl__')?.remove()
      for (const el of document.querySelectorAll('[class*="__arkweb_hl_"]')) {
        for (const c of [...el.classList]) if (c.startsWith('__arkweb_hl_')) el.classList.remove(c)
      }
    })
    highlighted.clear()
    return 'cleared'
  })

// -------------------- PDF / tracing --------------------

tool('pdf_save', 'Save the current page as PDF (headless-only in Chrome — may not work on ArkWeb foreground).',
  sObj({ path: sStr() }, ['path']),
  async ({ path }) => {
    const page = await getPage()
    mkdirSync(dirname(path), { recursive: true })
    await page.pdf({ path })
    return `saved PDF to ${path}`
  })

tool('start_tracing', 'Begin a Playwright trace. Stop with stop_tracing.',
  sObj({ snapshots: sBool('record DOM snapshots', true), screenshots: sBool('record screenshots', false), name: sStr() }),
  async ({ snapshots, screenshots, name }) => {
    await getPage()
    await context.tracing.start({ snapshots: snapshots !== false, screenshots: !!screenshots, name })
    return 'tracing started'
  })

tool('stop_tracing', 'Stop tracing and save the .zip to `path`.',
  sObj({ path: sStr() }, ['path']),
  async ({ path }) => {
    await getPage()
    mkdirSync(dirname(path), { recursive: true })
    await context.tracing.stop({ path })
    return `trace saved to ${path}`
  })

// =========================================================================
// MCP stdio framing
// =========================================================================

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n') }

async function handle(msg) {
  try {
    switch (msg.method) {
      case 'initialize':
        return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ohos-playwright-mcp', version: '0.2.4' } }
      case 'notifications/initialized':
        return null
      case 'tools/list':
        return { tools: TOOLS }
      case 'tools/call': {
        const h = HANDLERS[msg.params.name]
        if (!h) throw new Error(`unknown tool: ${msg.params.name}`)
        const result = await h(msg.params.arguments ?? {})
        if (result && typeof result === 'object' && result.content) return result
        return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] }
      }
      case 'ping':
        return {}
      default:
        throw { code: -32601, message: `unknown method: ${msg.method}` }
    }
  } catch (e) {
    throw e?.code ? e : { code: -32603, message: e.message || String(e) }
  }
}

process.on('unhandledRejection', e => log('unhandledRejection:', e?.message || e))
process.on('uncaughtException', e => log('uncaughtException:', e?.message || e))

let buf = ''
process.stdin.on('data', chunk => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { log('bad json:', line); continue }
    handle(msg).then(result => {
      if (msg.id === undefined || result === null) return
      send({ jsonrpc: '2.0', id: msg.id, result })
    }).catch(err => {
      if (msg.id === undefined) return
      send({ jsonrpc: '2.0', id: msg.id, error: { code: err.code ?? -32603, message: err.message ?? String(err) } })
    })
  }
})

process.stdin.on('end', () => process.exit(0))

bootstrapPromise = connect().catch(e => { log('bootstrap failed:', e.message); process.exit(1) }).finally(() => { bootstrapPromise = null })
