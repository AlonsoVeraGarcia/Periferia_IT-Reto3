/** API HTTP + front estático. Node 20+ o Bun. Un comando: `npm run dev` (o `bun run src/server.ts`). */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { existeSesion, obtenerSesion, turno, type Config } from "./core/agente.ts"
import type { ProveedorLLM } from "./llm/adapter.ts"
import { ProveedorAnthropic } from "./llm/anthropic.ts"
import { ProveedorSinModelo } from "./llm/sin-modelo.ts"

// Carga .env si existe (Node ≥ 20.12; Bun lo hace solo). La clave nunca se imprime.
try {
  process.loadEnvFile?.()
} catch {
  /* sin .env: se usan las variables del entorno */
}

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const env = (k: string, def: string) => process.env[k] ?? def

const cfg: Config = {
  directory,
  maxIteraciones: Number(env("MAX_ITERACIONES", "25")),
  maxTokensSesion: Number(env("MAX_TOKENS_SESION", "300000")),
}
const PUERTO = Number(env("PORT", "3000"))
const CLAVE_ACCESO = process.env.ACCESS_KEY ?? ""
const MAX_MENSAJE = 4000

function crearProveedor(): ProveedorLLM {
  const clave = process.env.ANTHROPIC_API_KEY
  if (env("LLM_PROVIDER", clave ? "anthropic" : "sin-modelo") === "anthropic" && clave) {
    return new ProveedorAnthropic(clave, env("ANTHROPIC_MODEL", "claude-haiku-5-5"), Number(env("LLM_TIMEOUT_MS", "45000")), 2048)
  }
  return new ProveedorSinModelo()
}
const llm = crearProveedor()

/** Una petición de chat a la vez por sesión: evita historiales cruzados si el usuario hace doble clic. */
const ocupadas = new Set<string>()

function responder(res: ServerResponse, status: number, cuerpo: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(cuerpo))
}

async function leerCuerpo(req: IncomingMessage): Promise<unknown> {
  let datos = ""
  for await (const trozo of req) {
    datos += trozo
    if (datos.length > 20_000) throw new Error("Cuerpo demasiado grande")
  }
  return datos ? (JSON.parse(datos) as unknown) : {}
}

const TIPOS: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }

async function estatico(res: ServerResponse, ruta: string) {
  const archivo = path.join(directory, "web", ruta === "/" ? "index.html" : path.normalize(ruta).replace(/^(\.\.[/\\])+/, ""))
  if (!archivo.startsWith(path.join(directory, "web"))) return responder(res, 404, { ok: false, error: "No encontrado" })
  try {
    const contenido = await fs.readFile(archivo)
    res.writeHead(200, { "content-type": TIPOS[path.extname(archivo)] ?? "application/octet-stream" })
    res.end(contenido)
  } catch {
    responder(res, 404, { ok: false, error: "No encontrado" })
  }
}

const autorizado = (req: IncomingMessage) => !CLAVE_ACCESO || req.headers["x-access-key"] === CLAVE_ACCESO
const idValido = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{6,64}$/.test(id)

const servidor = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return responder(res, 200, { ok: true, provider: llm.nombre, model: llm.modelo, acceso_protegido: !!CLAVE_ACCESO })
    }
    if (url.pathname.startsWith("/api/") && !autorizado(req)) return responder(res, 401, { ok: false, error: "Clave de acceso inválida" })

    if (req.method === "POST" && url.pathname === "/api/chat") {
      const cuerpo = (await leerCuerpo(req)) as { sessionId?: unknown; message?: unknown }
      if (!idValido(cuerpo.sessionId)) return responder(res, 400, { ok: false, error: "sessionId inválido" })
      if (typeof cuerpo.message !== "string" || !cuerpo.message.trim()) return responder(res, 400, { ok: false, error: "message vacío" })
      if (cuerpo.message.length > MAX_MENSAJE) return responder(res, 400, { ok: false, error: `message supera ${MAX_MENSAJE} caracteres` })
      if (ocupadas.has(cuerpo.sessionId)) return responder(res, 409, { ok: false, error: "Esta sesión todavía está procesando el mensaje anterior." })
      ocupadas.add(cuerpo.sessionId)
      try {
        const sesion = await obtenerSesion(cuerpo.sessionId, cfg)
        const e = await turno(sesion, cuerpo.message.trim(), llm, cfg)
        return responder(res, 200, { reply: e.texto, toolCalls: e.llamadas, needsConfirmation: e.pide_confirmacion, tokensSesion: sesion.tokens })
      } finally {
        ocupadas.delete(cuerpo.sessionId)
      }
    }

    const m = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (req.method === "GET" && m) {
      if (!idValido(m[1]) || !(await existeSesion(m[1], cfg))) return responder(res, 404, { ok: false, error: "Sesión no encontrada" })
      const s = await obtenerSesion(m[1], cfg)
      return responder(res, 200, { id: s.id, eventos: s.eventos, tokens: s.tokens, pendientes: s.pendientes })
    }

    if (req.method === "GET" && !url.pathname.startsWith("/api/")) return estatico(res, url.pathname)
    responder(res, 404, { ok: false, error: "Ruta no encontrada" })
  } catch (e) {
    console.error("[server]", (e as Error).message)
    responder(res, 500, { ok: false, error: "Error interno. La sesión sigue activa." })
  }
})

servidor.listen(PUERTO, () => {
  console.log(`Agente OC SAP en http://localhost:${PUERTO} · proveedor ${llm.nombre} · modelo ${llm.modelo}`)
})
