/**
 * Herramientas del agente de Órdenes de Compra. Cada export se expone al modelo como `oc_<export>`.
 * Contrato (PRD 6.2): description + args zod + execute(args, ctx) → string JSON { ok, data } | { ok:false, error }. Nunca lanza.
 * Las herramientas son la única fuente de valores: el modelo no calcula ni corrige montos.
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { escribir, rutaFixtures, rutaOut, type ToolCtx } from "../core/archivos.ts"
import { registrarControl } from "../core/control.ts"
import { generarEvidencia } from "../core/evidencia.ts"
import { cargarMaestros } from "../core/maestros.ts"
import { leerPaquete } from "../core/paquete.ts"
import { construirOrden } from "../core/payload.ts"
import { validarPaquete } from "../core/reglas.ts"
import { OrdenCompraSchema, type OrdenCompra, type Resultado } from "../core/tipos.ts"
import { SapMock } from "../sap/mock.ts"
import type { SapAdapter } from "../sap/adapter.ts"

export type { ToolCtx }

const json = (r: Resultado<unknown>) => JSON.stringify(r)
const falla = (e: unknown) => json({ ok: false, error: e instanceof Error ? e.message : String(e) })

/** Fábrica del adaptador SAP. En producción se cambia por la implementación real sin tocar las herramientas. */
let fabricaSap: (ctx: ToolCtx) => SapAdapter = (ctx) => new SapMock(rutaOut(ctx), rutaFixtures(ctx))
export const usarAdaptadorSap = (f: (ctx: ToolCtx) => SapAdapter) => {
  fabricaSap = f
}

/** Serializa las creaciones para que la numeración secuencial y la idempotencia no compitan entre sesiones. */
let cola: Promise<unknown> = Promise.resolve()
function enSerie<T>(fn: () => Promise<T>): Promise<T> {
  const siguiente = cola.then(fn, fn)
  cola = siguiente.catch(() => undefined)
  return siguiente
}

const argCaso = z.string().describe('Carpeta del caso en fixtures/reto-03/solicitudes/, por ejemplo "sol-001"')
const argPaquete = z
  .unknown()
  .optional()
  .describe("Paquete devuelto por oc_leer_paquete. Opcional: la herramienta relee el caso del disco, que es la fuente de verdad")

/** Pipeline común: lee, valida y (si es apta) construye. Garantiza que ningún valor venga del modelo. */
async function evaluar(caso: string, ctx: ToolCtx) {
  const paquete = await leerPaquete(caso, ctx)
  if (!paquete.ok) return paquete
  const maestros = await cargarMaestros(ctx)
  const validacion = validarPaquete(paquete.data, maestros)
  return { ok: true as const, data: { paquete: paquete.data, maestros, validacion } }
}

function coincide(enviado: OrdenCompra, esperado: OrdenCompra): boolean {
  const sinConfirmacion = (o: OrdenCompra) => JSON.stringify({ ...o, excepciones: o.excepciones.map((e) => ({ ...e, confirmado_por: null })) })
  return sinConfirmacion(enviado) === sinConfirmacion(esperado)
}

export const listar_casos = {
  description: "Lista los casos (solicitudes de compra) disponibles para procesar.",
  args: {},
  async execute(_args: Record<string, never>, ctx: ToolCtx): Promise<string> {
    try {
      const dir = path.join(rutaFixtures(ctx), "solicitudes")
      const casos = (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()
      return json({ ok: true, data: { casos } })
    } catch (e) {
      return falla(e)
    }
  },
}

export const leer_paquete = {
  description: "Lee y normaliza el paquete de un caso: correo, solicitud, cotización, aprobación y factura si existe.",
  args: { caso: argCaso },
  async execute(args: { caso: string }, ctx: ToolCtx): Promise<string> {
    try {
      const r = await leerPaquete(args.caso, ctx)
      if (!r.ok) return json(r)
      // El texto completo de la cotización no se envía al modelo: ahorra tokens y evita que "lea" montos por su cuenta.
      const cotizacion = r.data.cotizacion ? { ...r.data.cotizacion, texto: `[${r.data.cotizacion.texto.length} caracteres]` } : null
      return json({ ok: true, data: { ...r.data, cotizacion } })
    } catch (e) {
      return falla(e)
    }
  },
}

export const validar = {
  description: "Aplica las reglas de control RC1–RC10 y devuelve apta, bloqueos, confirmaciones, derivados y si es retroactiva.",
  args: { caso: argCaso, paquete: argPaquete },
  async execute(args: { caso: string; paquete?: unknown }, ctx: ToolCtx): Promise<string> {
    try {
      const r = await evaluar(args.caso, ctx)
      if (!r.ok) return json(r)
      const v = r.data.validacion
      if (!v.apta) {
        await registrarControl(ctx, {
          solicitud_id: v.solicitud_id,
          resultado: "bloqueada",
          numero_oc: "",
          retroactiva: v.retroactiva,
          bloqueos: v.bloqueos.map((b) => b.regla),
          confirmaciones: v.confirmaciones.map((c) => c.regla),
        })
      }
      return json({ ok: true, data: v })
    } catch (e) {
      return falla(e)
    }
  },
}

export const construir_payload = {
  description: "Construye la OC tal como quedaría en SAP (validada con zod) y guarda su trazabilidad campo a campo.",
  args: {
    caso: argCaso,
    paquete: argPaquete,
    derivados: z.unknown().optional().describe("Derivados devueltos por oc_validar. Opcional: se recalculan desde los maestros"),
  },
  async execute(args: { caso: string; paquete?: unknown; derivados?: unknown }, ctx: ToolCtx): Promise<string> {
    try {
      const r = await evaluar(args.caso, ctx)
      if (!r.ok) return json(r)
      const c = construirOrden(r.data.paquete, r.data.validacion, r.data.maestros)
      if (!c.ok) return json(c)
      const ruta = path.join(rutaOut(ctx), args.caso, "trazabilidad.json")
      await escribir(ruta, JSON.stringify(c.data.trazabilidad, null, 2))
      await escribir(path.join(rutaOut(ctx), args.caso, "payload.json"), JSON.stringify(c.data.orden, null, 2))
      const total_con_iva = r.data.paquete.solicitud.valor_total
      return json({ ok: true, data: { orden: c.data.orden, total_con_iva, trazabilidad: `out/${args.caso}/trazabilidad.json` } })
    } catch (e) {
      return falla(e)
    }
  },
}

export const generar_evidencia = {
  description: "Genera la evidencia de aprobación del caso (aprobacion.txt y aprobacion.pdf) con su sha256.",
  args: { caso: argCaso },
  async execute(args: { caso: string }, ctx: ToolCtx): Promise<string> {
    try {
      const p = await leerPaquete(args.caso, ctx)
      if (!p.ok) return json(p)
      return json(await generarEvidencia(p.data, ctx))
    } catch (e) {
      return falla(e)
    }
  },
}

export const crear = {
  description:
    "Crea la OC en SAP. Solo si no hay bloqueos y, si hubo confirmaciones, el usuario confirmó en su último mensaje (confirmado=true). Idempotente por solicitud_id.",
  args: {
    caso: argCaso,
    payload: OrdenCompraSchema.optional().describe("OC de oc_construir_payload. Si se envía, debe coincidir exactamente con la calculada"),
    confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente las excepciones en su último mensaje"),
  },
  async execute(args: { caso: string; payload?: OrdenCompra; confirmado?: boolean }, ctx: ToolCtx): Promise<string> {
    try {
      const r = await evaluar(args.caso, ctx)
      if (!r.ok) return json(r)
      const { paquete, maestros, validacion: v } = r.data
      const fila = {
        solicitud_id: v.solicitud_id,
        retroactiva: v.retroactiva,
        bloqueos: v.bloqueos.map((b) => b.regla),
        confirmaciones: v.confirmaciones.map((c) => c.regla),
      }
      const sap = fabricaSap(ctx)

      return await enSerie(async () => {
        const existente = await sap.buscarOrdenPorReferencia(v.solicitud_id)
        if (existente) {
          await registrarControl(ctx, { ...fila, resultado: "idempotente", numero_oc: existente.numero_oc })
          return json({ ok: true, data: { numero_oc: existente.numero_oc, fecha: null, idempotente: true, retroactiva: v.retroactiva } })
        }
        if (!v.apta) {
          // La fila "bloqueada" ya la dejó oc_validar; no se duplica.
          return json({ ok: false, error: `Bloqueada por ${fila.bloqueos.join(", ")}. ${v.bloqueos.map((b) => b.accion_sugerida).join(" ")}` })
        }
        if (v.confirmaciones.length > 0) {
          const confirmadoDeVerdad =
            args.confirmado === true && ctx.confirmacionHumana === true && (ctx.casosConfirmables?.includes(args.caso) ?? true)
          if (!confirmadoDeVerdad) {
            await registrarControl(ctx, { ...fila, resultado: "pendiente_confirmacion", numero_oc: "" })
            const motivo = args.confirmado
              ? "el usuario todavía no ha confirmado en su último mensaje (pregúntale y espera su respuesta; cualquier \"sí\" o \"confirmo\" sirve)"
              : "requiere confirmación humana"
            return json({ ok: false, error: `Pendiente: ${motivo} de ${fila.confirmaciones.join(", ")}.` })
          }
        }
        const c = construirOrden(paquete, v, maestros)
        if (!c.ok) return json(c)
        if (args.payload && !coincide(args.payload, c.data.orden)) {
          return json({ ok: false, error: "El payload enviado no coincide con el calculado por oc_construir_payload. No se modifica la OC desde el chat." })
        }
        const orden: OrdenCompra = {
          ...c.data.orden,
          excepciones: c.data.orden.excepciones.map((e) => ({ ...e, confirmado_por: `analista (sesión ${ctx.sessionId})` })),
        }
        const evidencia = await generarEvidencia(paquete, ctx)
        if (!evidencia.ok) return json(evidencia)
        const creada = await sap.crearOrden(orden)
        await registrarControl(ctx, { ...fila, resultado: "creada", numero_oc: creada.numero_oc })
        return json({
          ok: true,
          data: { ...creada, idempotente: false, retroactiva: v.retroactiva, evidencia: evidencia.data.ruta_pdf, sha256: evidencia.data.sha256 },
        })
      })
    } catch (e) {
      return falla(e)
    }
  },
}
