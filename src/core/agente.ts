/**
 * Ciclo del agente: prompt → modelo → herramientas → modelo … → respuesta (PRD 6.3).
 * CA1 tope de iteraciones · CA3 confirmación humana verificada en el servidor · CA4 log · CA5 errores sin matar la sesión.
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import type { ErrorProveedor, Mensaje, ProveedorLLM } from "../llm/adapter.ts"
import { definiciones, ejecutar } from "../tools/registro.ts"
import { ahora, escribir, leerTexto, rutaOut, type ToolCtx } from "./archivos.ts"
import { registrarLog } from "./control.ts"

export type LlamadaVisible = { nombre: string; args: unknown; ok: boolean; resumen: string; resultado: unknown }
export type EventoChat =
  | { tipo: "usuario"; texto: string; ts: string }
  | { tipo: "agente"; texto: string; llamadas: LlamadaVisible[]; pide_confirmacion: boolean; ts: string }

export type Sesion = {
  id: string
  mensajes: Mensaje[]
  eventos: EventoChat[]
  tokens: number
  /** Caso con confirmaciones pendientes: lo fija el servidor a partir de resultados de herramientas, no el modelo. */
  pendientes: string[]
}

export type Config = { maxIteraciones: number; maxTokensSesion: number; directory: string }

const CONFIRMA = /^\s*(s[ií]|confirmo|confirmado|confirma|ok|okay|de acuerdo|adelante|procede|proceder|cr[eé]al[ao]s?|dale)(?=[\s,.;:!¡]|$)/i
const NIEGA = /(^|[\s,.;:!¡¿])(no|cancela|cancelar|espera|detente)(?=[\s,.;:!?]|$)/i
export const esConfirmacion = (t: string) => CONFIRMA.test(t) && !NIEGA.test(t)

/** Comportamiento (agent/prompt.md) + conocimiento (src/knowledge/). Se leen en cada turno: cambiar reglas no toca el servidor. */
export async function promptSistema(directory: string): Promise<string> {
  const prompt = (await leerTexto(path.join(directory, "agent", "prompt.md"))) ?? ""
  const conocimiento = (await leerTexto(path.join(directory, "src", "knowledge", "ordenes-compra.md"))) ?? ""
  return `${prompt}\n\n---\n# Conocimiento del proceso\n\n${conocimiento}`
}

function resumir(nombre: string, r: { ok: boolean; data?: Record<string, unknown>; error?: string }): string {
  if (!r.ok) return r.error ?? "error"
  const d = r.data ?? {}
  if (nombre === "oc_validar") {
    const b = (d.bloqueos as { regla: string }[]).map((x) => x.regla)
    const c = (d.confirmaciones as { regla: string }[]).map((x) => x.regla)
    return `apta=${d.apta}${b.length ? ` · bloqueos ${b.join(",")}` : ""}${c.length ? ` · confirmaciones ${c.join(",")}` : ""}${d.retroactiva ? " · retroactiva" : ""}`
  }
  if (nombre === "oc_crear") return `OC ${d.numero_oc}${d.idempotente ? " (idempotente)" : ""}`
  if (nombre === "oc_generar_evidencia") return `${d.ruta} · sha256 ${String(d.sha256).slice(0, 12)}…`
  if (nombre === "oc_construir_payload") return `payload válido · ${d.trazabilidad}`
  if (nombre === "oc_leer_paquete") return `paquete ${(d.solicitud as { solicitud_id: string }).solicitud_id}${(d.faltantes as string[]).length ? ` · faltan ${(d.faltantes as string[]).join(", ")}` : ""}`
  return "ok"
}

/** Actualiza el estado de confirmación pendiente según lo que devolvieron las herramientas. */
function actualizarPendiente(s: Sesion, nombre: string, args: unknown, r: { ok: boolean; data?: Record<string, unknown>; error?: string }) {
  const caso = (args as { caso?: string } | null)?.caso
  if (!caso) return
  const agregar = () => {
    if (!s.pendientes.includes(caso)) s.pendientes.push(caso)
  }
  if (nombre === "oc_validar" && r.ok && r.data?.apta && (r.data.confirmaciones as unknown[]).length > 0) agregar()
  if (nombre === "oc_crear" && r.ok) s.pendientes = s.pendientes.filter((c) => c !== caso)
  if (nombre === "oc_crear" && !r.ok && r.error?.startsWith("Pendiente")) agregar()
}

export async function turno(s: Sesion, texto: string, llm: ProveedorLLM, cfg: Config): Promise<EventoChat & { tipo: "agente" }> {
  // CA3: la confirmación humana se decide aquí, con el texto real del usuario, y viaja a las herramientas en ctx.
  s.pendientes ??= []
  const confirmacionHumana = s.pendientes.length > 0 && esConfirmacion(texto)
  const casosConfirmables = [...s.pendientes]
  if (s.pendientes.length && NIEGA.test(texto)) s.pendientes = []
  s.mensajes.push({ rol: "user", texto })
  s.eventos.push({ tipo: "usuario", texto, ts: ahora() })

  const ctx: ToolCtx = { directory: cfg.directory, sessionId: s.id, confirmacionHumana, casosConfirmables }
  const sistema = await promptSistema(cfg.directory)
  const herramientas = definiciones()
  const llamadas: LlamadaVisible[] = []
  const textos: string[] = []

  try {
    for (let i = 0; i < cfg.maxIteraciones; i++) {
      if (s.tokens >= cfg.maxTokensSesion) {
        textos.push(`Se alcanzó el tope de ${cfg.maxTokensSesion.toLocaleString("es-CO")} tokens de esta sesión. Abre una sesión nueva para continuar.`)
        break
      }
      const r = await llm.enviar(sistema, s.mensajes, herramientas)
      s.tokens += r.uso.entrada + r.uso.salida
      s.mensajes.push({ rol: "assistant", texto: r.texto, llamadas: r.llamadas, crudo: r.crudo })
      if (r.texto) textos.push(r.texto)
      if (r.llamadas.length === 0) break

      const resultados = []
      for (const l of r.llamadas) {
        const contenido = await ejecutar(l.nombre, l.args, ctx)
        await registrarLog(ctx, l.nombre, l.args, contenido)
        const parsed = JSON.parse(contenido) as { ok: boolean; data?: Record<string, unknown>; error?: string }
        actualizarPendiente(s, l.nombre, l.args, parsed)
        llamadas.push({ nombre: l.nombre, args: l.args, ok: parsed.ok, resumen: resumir(l.nombre, parsed), resultado: parsed })
        resultados.push({ id: l.id, nombre: l.nombre, contenido })
      }
      s.mensajes.push({ rol: "tool", resultados })

      if (i === cfg.maxIteraciones - 1) {
        textos.push(`Alcancé el tope de ${cfg.maxIteraciones} pasos en este turno. Lo hecho está arriba; pídeme que continúe para terminar.`)
      }
    }
  } catch (e) {
    // CA5: error del proveedor en lenguaje claro; la sesión sigue viva. Se cierra el historial de forma consistente.
    const ultimo = s.mensajes[s.mensajes.length - 1]
    if (ultimo?.rol === "assistant" && ultimo.llamadas.length > 0) s.mensajes.pop()
    textos.push(`⚠️ ${(e as ErrorProveedor).message ?? "Error inesperado."} Tu sesión sigue activa; vuelve a intentarlo.`)
  }

  const evento = {
    tipo: "agente" as const,
    texto: textos.join("\n\n") || "(sin respuesta)",
    llamadas,
    pide_confirmacion: s.pendientes.length > 0,
    ts: ahora(),
  }
  s.eventos.push(evento)
  await guardar(s, cfg)
  return evento
}

// ── Sesiones: memoria + archivo en out/sessions ──
const sesiones = new Map<string, Sesion>()
const rutaSesion = (cfg: Config, id: string) => path.join(rutaOut({ directory: cfg.directory, sessionId: id }), "sessions", `${id}.json`)

export async function obtenerSesion(id: string, cfg: Config): Promise<Sesion> {
  const enMemoria = sesiones.get(id)
  if (enMemoria) return enMemoria
  const guardada = await leerTexto(rutaSesion(cfg, id))
  const s: Sesion = guardada ? (JSON.parse(guardada) as Sesion) : { id, mensajes: [], eventos: [], tokens: 0, pendientes: [] }
  sesiones.set(id, s)
  return s
}

async function guardar(s: Sesion, cfg: Config) {
  await escribir(rutaSesion(cfg, s.id), JSON.stringify(s))
}

export async function existeSesion(id: string, cfg: Config): Promise<boolean> {
  if (sesiones.has(id)) return true
  try {
    await fs.access(rutaSesion(cfg, id))
    return true
  } catch {
    return false
  }
}
