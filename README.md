# arkweb-cdp-mcp

MCP server that drives **HarmonyOS ArkWeb** (Chromium 132-based) via [`playwright-core`](https://www.npmjs.com/package/playwright-core) over the Chrome DevTools Protocol.

Bootstrap (hdc connect → `aa start` ArkWeb → `hdc fport` → CDP endpoint) is delegated to [`ohos-playwright`](https://github.com/social4hyq/ohos-playwright). This package focuses on exposing browser automation as MCP tools.

## Why this exists

ArkWeb on HarmonyOS denies `AF_UNIX` socket creation in its sandbox, which breaks any tool that tries to launch Chrome the playwright way. `connectOverCDP` over a TCP-forwarded port works fine, and that's what this server uses end-to-end.

## Install

```bash
npm i -g arkweb-cdp-mcp ohos-playwright playwright-core
```

Node ≥ 22. `hdc` must be on `PATH` and an OpenHarmony / HarmonyOS device reachable.

## MCP client config

```json
{
  "mcpServers": {
    "arkweb": {
      "command": "arkweb-cdp-mcp"
    }
  }
}
```

If the peer deps live in a non-standard location, point at them explicitly:

```json
{
  "mcpServers": {
    "arkweb": {
      "command": "node",
      "args": ["/abs/path/to/server.mjs"],
      "env": {
        "ARKWEB_OHOS_PW_REGISTER": "/abs/path/to/ohos-playwright/dist/register.mjs",
        "ARKWEB_OHOS_PW_SETUP":    "/abs/path/to/ohos-playwright/dist/setup.mjs",
        "ARKWEB_PW_CORE":          "/abs/path/to/playwright-core/index.mjs"
      }
    }
  }
}
```

Other env vars:

- `OHOS_PW_INFO_PATH` — where the CDP endpoint cache lives (default: `<tmpdir>/ohos-playwright-cdp.json`).
- Any `OHOS_PW_*` vars consumed by `ohos-playwright/setup` (device serial, browser bundle name, port, etc.) — see that project's README.

## Tools (56)

**Navigation** — `navigate`, `navigate_back`, `navigate_forward`, `reload`, `wait`, `wait_for`

**Read-only** — `evaluate`, `get_text`, `get_html`, `screenshot`, `snapshot`

**Tabs / lifecycle** — `list_pages`, `select_page`, `tab_new`, `tab_close`, `close`, `resize`

**Input (selector-based)** — `click`, `hover`, `type`, `fill`, `fill_form`, `press_key`, `select_option`, `file_upload`, `drag`

**Input (raw mouse)** — `mouse_move_xy`, `mouse_click_xy`, `mouse_down`, `mouse_up`, `mouse_drag_xy`, `mouse_wheel`

**Diagnostics** — `console_messages`, `handle_dialog`

**Network** — `network_requests`, `network_request`, `network_state_set`, `route`, `route_list`, `unroute`

**Cookies** — `cookie_list`, `cookie_get`, `cookie_set`, `cookie_delete`, `cookie_clear`

**Storage** — `localstorage_list`, `localstorage_get`, `localstorage_set`, `localstorage_delete`, `localstorage_clear`, `sessionstorage_list`, `sessionstorage_get`, `sessionstorage_set`, `sessionstorage_delete`, `sessionstorage_clear`, `storage_state`

**Visualization** — `highlight`, `hide_highlight`

**Heavy** — `pdf_save` (may not work on foreground ArkWeb), `start_tracing`, `stop_tracing`

Each tool's JSON schema is published via standard MCP `tools/list`.

## ArkWeb-specific notes

- `screenshot` uses raw CDP `Page.captureScreenshot` to skip Playwright's font-wait, which hangs on some ArkWeb pages.
- `snapshot` calls `Accessibility.getFullAXTree` via a fresh CDP session because Playwright 1.x removed `page.accessibility`.
- `tab_new` uses the `/json/new` HTTP endpoint with `PUT` (ArkWeb rejects the playwright `context.newPage()` path).
- ArkWeb tabs can occasionally crash into `arkweb-error://webdata/` under heavy CDP load. The server auto-recovers by spawning a blank tab.

## License

MIT © 2026 social4hyq
