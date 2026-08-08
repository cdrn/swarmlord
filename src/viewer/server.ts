/**
 * Local HTTP viewer over node:http. Zero dependencies, same-origin only
 * (no CORS), bound to loopback by default. Two modes share one UI and one
 * per-swarm API implementation:
 *
 * - startViewer(swarm): the single-swarm dashboard, swarm routes at the root.
 * - startHive(hive): a home screen over many swarms — /api/swarms collection
 *   routes plus the same swarm routes prefixed under /s/<id>.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Socket } from 'node:net'
import type { Swarm } from '../core/runtime.js'
import type { Hive } from '../hive.js'
import { VIEWER_HTML } from './ui.js'

// Package root relative to this module — same depth from src/ and dist/.
const HERO_ART_URL = new URL('../../assets/swarmlord.png', import.meta.url)
let heroArt: Buffer | null | undefined
function loadHeroArt(): Buffer | null {
  if (heroArt === undefined) {
    try {
      heroArt = readFileSync(HERO_ART_URL)
    } catch {
      heroArt = null
    }
  }
  return heroArt
}

export interface ViewerOptions {
  /** Default 7717. Use 0 to bind an ephemeral port (reported in the handle). */
  port?: number
  /** Default '127.0.0.1'. */
  host?: string
  /**
   * Hot-reload the UI: re-import ui.ts per request and auto-refresh open
   * pages when it changes. Defaults to true when running from src/ (tsx),
   * false from a build.
   */
  dev?: boolean
}

const DEV_DEFAULT = import.meta.url.includes('/src/')

/** In dev, pull the freshest UI module so edits to ui.ts show up live. */
async function currentHtml(dev: boolean): Promise<string> {
  if (!dev) return VIEWER_HTML
  try {
    const href = new URL(`./ui.js?t=${Date.now()}`, import.meta.url).href
    const mod = (await import(href)) as { VIEWER_HTML: string }
    return mod.VIEWER_HTML
  } catch {
    return VIEWER_HTML
  }
}

function uiHash(html: string): string {
  return createHash('sha1').update(html).digest('hex').slice(0, 12)
}

const RELOAD_POLLER = (hash: string): string =>
  `<script>(function(){var h=${JSON.stringify(hash)};setInterval(function(){` +
  `fetch('/api/ui-hash').then(function(r){return r.json()}).then(function(d){` +
  `if(d.hash&&d.hash!==h)location.reload()}).catch(function(){})},1500)})()</script>`

export interface ViewerHandle {
  url: string
  port: number
  close(): Promise<void>
}

const DEFAULT_PORT = 7717
const DEFAULT_HOST = '127.0.0.1'
const TICK_MS = 400
const HEARTBEAT_MS = 15_000

/** The `state` payload shared by GET /api/state and the SSE tick. */
function stateOf(swarm: Swarm): {
  snapshot: ReturnType<Swarm['snapshot']>
  channels: ReturnType<Swarm['board']['catalog']>
  pins: ReturnType<Swarm['board']['pins']>
} {
  return {
    snapshot: swarm.snapshot(),
    channels: swarm.board.catalog(),
    pins: swarm.board.pins(),
  }
}

function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name)
  if (raw === null) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : fallback
}

function sendJson(res: ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/**
 * Buffer the request body, parse it as JSON, and hand it to `fn`. Any throw —
 * bad JSON or an error out of `fn` itself — becomes a 400 {error} response.
 */
function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  fn: (payload: Record<string, unknown>) => void,
): void {
  let body = ''
  req.on('data', chunk => {
    body += chunk
  })
  req.on('end', () => {
    try {
      fn(JSON.parse(body || '{}') as Record<string, unknown>)
    } catch (e) {
      sendJson(res, { error: e instanceof Error ? e.message : String(e) }, 400)
    }
  })
}

/**
 * The swarm-scoped API: state/events/stream/config/message. `pathname` is the
 * route suffix ('/api/state', ...) — the root in single-swarm mode, the part
 * after /s/<id> in hive mode. Returns whether the request was handled.
 */
function handleSwarmRoute(
  swarm: Swarm,
  pathname: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (req.method === 'POST' && (pathname === '/api/config' || pathname === '/api/message')) {
    readJsonBody(req, res, payload => {
      if (pathname === '/api/config') {
        sendJson(res, swarm.configure(payload))
        return
      }
      const agent = typeof payload.agent === 'string' ? payload.agent : ''
      const text = typeof payload.text === 'string' ? payload.text.trim() : ''
      if (agent === '' || text === '') {
        sendJson(res, { error: 'both "agent" and "text" are required' }, 400)
        return
      }
      const result = swarm.message(agent, text)
      sendJson(res, result, result.ok ? 200 : 400)
    })
    return true
  }

  if (req.method !== 'GET') return false

  switch (pathname) {
    case '/api/config': {
      sendJson(res, swarm.config())
      return true
    }

    case '/api/state': {
      sendJson(res, stateOf(swarm))
      return true
    }

    case '/api/events': {
      const sinceId = intParam(url, 'since_id', 0)
      const limit = intParam(url, 'limit', 200)
      sendJson(res, swarm.log.query({ sinceId, limit }))
      return true
    }

    case '/api/stream': {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(': connected\n\n')

      // Cursor starts at ?since_id, defaulting to the current tail — the UI
      // is expected to backfill history via /api/events first.
      let cursor = intParam(url, 'since_id', swarm.log.lastId())

      const tick = setInterval(() => {
        const lastId = swarm.log.lastId()
        const events =
          lastId > cursor ? swarm.log.query({ sinceId: cursor, limit: lastId - cursor }) : []
        const tail = events[events.length - 1]
        if (tail !== undefined) cursor = tail.id
        res.write(`event: tick\ndata: ${JSON.stringify({ state: stateOf(swarm), events })}\n\n`)
      }, TICK_MS)

      const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n')
      }, HEARTBEAT_MS)

      // 'close' fires on client disconnect and when close() destroys the
      // socket, so timers can never outlive the connection.
      res.on('close', () => {
        clearInterval(tick)
        clearInterval(heartbeat)
      })
      return true
    }

    default: {
      return false
    }
  }
}

/**
 * Mode-independent GET routes: the UI page, the dev-reload hash, and the hero
 * art. Returns whether the request was handled.
 */
function handleGlobalRoute(pathname: string, dev: boolean, res: ServerResponse): boolean {
  switch (pathname) {
    case '/': {
      void currentHtml(dev).then(html => {
        if (dev) html = html.replace('</body>', `${RELOAD_POLLER(uiHash(html))}</body>`)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(html)
      })
      return true
    }

    case '/api/ui-hash': {
      void currentHtml(dev).then(html => sendJson(res, { hash: uiHash(html) }))
      return true
    }

    case '/assets/swarmlord.png': {
      const art = loadHeroArt()
      if (art === null) {
        sendJson(res, { error: 'not found' }, 404)
        return true
      }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' })
      res.end(art)
      return true
    }

    default: {
      return false
    }
  }
}

/**
 * Bind an HTTP server around `handle`, tracking every open socket (including
 * long-lived SSE connections) so close() can destroy them — otherwise
 * server.close() waits forever on the event streams.
 */
function serve(
  handle: (req: IncomingMessage, res: ServerResponse) => void,
  opts: ViewerOptions,
): Promise<ViewerHandle> {
  const port = opts.port ?? DEFAULT_PORT
  const host = opts.host ?? DEFAULT_HOST
  const sockets = new Set<Socket>()

  const server = createServer((req, res) => {
    try {
      handle(req, res)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (!res.headersSent) {
        sendJson(res, { error: message }, 500)
      } else {
        res.end()
      }
    }
  })

  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  return new Promise<ViewerHandle>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const addr = server.address()
      const boundPort = typeof addr === 'object' && addr !== null ? addr.port : port
      resolve({
        url: `http://${host}:${boundPort}`,
        port: boundPort,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            for (const socket of sockets) socket.destroy()
            sockets.clear()
            server.close(err => (err ? rejectClose(err) : resolveClose()))
          }),
      })
    })
  })
}

export function startViewer(swarm: Swarm, opts: ViewerOptions = {}): Promise<ViewerHandle> {
  const dev = opts.dev ?? DEV_DEFAULT

  return serve((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (req.method === 'GET' && handleGlobalRoute(url.pathname, dev, res)) return
    if (handleSwarmRoute(swarm, url.pathname, url, req, res)) return
    sendJson(res, { error: 'not found' }, 404)
  }, opts)
}

// Per-swarm routes live under /s/<id>/api/... in hive mode.
const SWARM_PREFIX = /^\/s\/([^/]+)(\/api\/.+)$/
// Collection actions: POST /api/swarms/<id>/(stop|archive|unarchive), DELETE /api/swarms/<id>.
const SWARM_ACTION = /^\/api\/swarms\/([^/]+)(?:\/(stop|archive|unarchive))?$/

export function startHive(hive: Hive, opts: ViewerOptions = {}): Promise<ViewerHandle> {
  const dev = opts.dev ?? DEV_DEFAULT

  return serve((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const pathname = url.pathname

    if (req.method === 'GET' && handleGlobalRoute(pathname, dev, res)) return

    // Per-swarm routes, resolved through the hive.
    const scoped = SWARM_PREFIX.exec(pathname)
    if (scoped !== null) {
      const swarm = hive.swarm(decodeURIComponent(scoped[1]))
      if (swarm === null) {
        sendJson(res, { error: 'not found' }, 404)
        return
      }
      if (handleSwarmRoute(swarm, scoped[2], url, req, res)) return
      sendJson(res, { error: 'not found' }, 404)
      return
    }

    // Collection: list and create-and-start.
    if (pathname === '/api/swarms') {
      if (req.method === 'GET') {
        sendJson(res, hive.list())
        return
      }
      if (req.method === 'POST') {
        readJsonBody(req, res, payload => {
          const task = typeof payload.task === 'string' ? payload.task.trim() : ''
          const title = typeof payload.title === 'string' ? payload.title : ''
          if (task === '') {
            sendJson(res, { error: '"task" is required' }, 400)
            return
          }
          sendJson(res, hive.create(title, task))
        })
        return
      }
      sendJson(res, { error: 'not found' }, 404)
      return
    }

    // Lifecycle: stop/archive/unarchive/delete on a known swarm.
    const action = SWARM_ACTION.exec(pathname)
    if (action !== null) {
      const id = decodeURIComponent(action[1])
      const verb = action[2] as 'stop' | 'archive' | 'unarchive' | undefined
      if (hive.get(id) === null) {
        sendJson(res, { error: 'not found' }, 404)
        return
      }
      try {
        if (req.method === 'DELETE' && verb === undefined) {
          hive.delete(id)
          res.writeHead(204).end()
          return
        }
        if (req.method === 'POST' && verb !== undefined) {
          const record =
            verb === 'stop' ? hive.stop(id) : verb === 'archive' ? hive.archive(id) : hive.unarchive(id)
          sendJson(res, record)
          return
        }
      } catch (e) {
        // The hive refuses e.g. archiving or deleting a running swarm.
        sendJson(res, { error: e instanceof Error ? e.message : String(e) }, 400)
        return
      }
    }

    sendJson(res, { error: 'not found' }, 404)
  }, opts)
}
