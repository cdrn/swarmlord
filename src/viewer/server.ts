/**
 * Local HTTP viewer for a running Swarm: serves the single-file UI plus a
 * small JSON/SSE API, all over node:http. Zero dependencies, same-origin
 * only (no CORS), bound to loopback by default.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import type { Socket } from 'node:net'
import type { Swarm } from '../core/runtime.js'
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
}

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

export function startViewer(swarm: Swarm, opts: ViewerOptions = {}): Promise<ViewerHandle> {
  const port = opts.port ?? DEFAULT_PORT
  const host = opts.host ?? DEFAULT_HOST

  // Every open socket (including long-lived SSE connections) is tracked so
  // close() can destroy them — otherwise server.close() waits forever on the
  // event streams and the promise never resolves.
  const sockets = new Set<Socket>()

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    if (req.method !== 'GET') {
      sendJson(res, { error: 'not found' }, 404)
      return
    }

    switch (url.pathname) {
      case '/': {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(VIEWER_HTML)
        return
      }

      case '/assets/swarmlord.png': {
        const art = loadHeroArt()
        if (art === null) {
          sendJson(res, { error: 'not found' }, 404)
          return
        }
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' })
        res.end(art)
        return
      }

      case '/api/state': {
        sendJson(res, stateOf(swarm))
        return
      }

      case '/api/events': {
        const sinceId = intParam(url, 'since_id', 0)
        const limit = intParam(url, 'limit', 200)
        sendJson(res, swarm.log.query({ sinceId, limit }))
        return
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
        return
      }

      default: {
        sendJson(res, { error: 'not found' }, 404)
      }
    }
  }

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
