import path from "node:path"
import { ahora, anexar, existe, rutaOut, type ToolCtx } from "./archivos.ts"

export type FilaControl = {
  solicitud_id: string
  resultado: "creada" | "idempotente" | "bloqueada" | "pendiente_confirmacion" | "error"
  numero_oc: string
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
}

const ENCABEZADO = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts"
const celda = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

/** out/control.csv: una fila por intento de creación (HU-5). Lo consume Contabilidad/Auditoría. */
export async function registrarControl(ctx: ToolCtx, f: FilaControl): Promise<void> {
  const ruta = path.join(rutaOut(ctx), "control.csv")
  if (!(await existe(ruta))) await anexar(ruta, ENCABEZADO)
  const fila = [f.solicitud_id, f.resultado, f.numero_oc, String(f.retroactiva), f.bloqueos.join("|"), f.confirmaciones.join("|"), ahora()]
  await anexar(ruta, fila.map(celda).join(","))
}

/** out/log.jsonl: toda llamada a herramienta (CA4). */
export async function registrarLog(ctx: ToolCtx, herramienta: string, args: unknown, resultado: string): Promise<void> {
  let ok = false
  let resumen = ""
  try {
    const r = JSON.parse(resultado) as { ok: boolean; error?: string }
    ok = r.ok
    resumen = r.ok ? "ok" : (r.error ?? "")
  } catch {
    resumen = "respuesta no JSON"
  }
  await anexar(
    path.join(rutaOut(ctx), "log.jsonl"),
    JSON.stringify({ ts: ahora(), sesion: ctx.sessionId, herramienta, args, ok, resumen: resumen.slice(0, 300) }),
  )
}
