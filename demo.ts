/**
 * Verificación sin modelo de lenguaje (PRD 6.6). Llama directamente a las herramientas.
 *   bun install && bun run demo.ts      ó      npm install && npm run demo
 * No requiere ninguna clave. Limpia out/ al inicio para ser determinista.
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as oc from "./src/tools/oc.ts"
import type { ToolCtx } from "./src/core/archivos.ts"

const directory = path.dirname(fileURLToPath(import.meta.url))
const ctx: ToolCtx = { directory, sessionId: "demo" }
const out = process.env.OUT_DIR || path.join(directory, "out")

type R = { ok: boolean; data?: Record<string, unknown>; error?: string }
const parse = (s: string) => JSON.parse(s) as R
type Hallazgo = { regla: string; detalle: string }

async function procesar(caso: string, opciones: { confirmado?: boolean; etiqueta?: string } = {}) {
  const titulo = `${caso}${opciones.etiqueta ? ` (${opciones.etiqueta})` : ""}`
  console.log(`\n━━ ${titulo} ${"━".repeat(Math.max(0, 60 - titulo.length))}`)
  const leido = parse(await oc.leer_paquete.execute({ caso }, ctx))
  if (!leido.ok) return console.log(`  ✗ ${leido.error}`)

  const v = parse(await oc.validar.execute({ caso }, ctx)).data as {
    apta: boolean; bloqueos: Hallazgo[]; confirmaciones: Hallazgo[]; derivados: { campo: string; valor: string }[]; retroactiva: boolean
  }
  console.log(`  apta: ${v.apta}   retroactiva: ${v.retroactiva}`)
  for (const b of v.bloqueos) console.log(`  ⛔ ${b.regla}: ${b.detalle}`)
  for (const c of v.confirmaciones) console.log(`  ⚠️  ${c.regla}: ${c.detalle}`)
  for (const d of v.derivados) console.log(`  ↳ derivado ${d.campo} = ${d.valor}`)

  if (v.apta) {
    const p = parse(await oc.construir_payload.execute({ caso }, ctx))
    const orden = p.data?.orden as { posiciones: { descripcion: string; cantidad: number; unidad: string; precio_unitario: number; indicador_iva: string }[]; condiciones_pago: string } | undefined
    const pos = orden?.posiciones[0]
    if (pos) console.log(`  payload: "${pos.descripcion}" · ${pos.cantidad} ${pos.unidad} × ${pos.precio_unitario} neto · IVA ${pos.indicador_iva} · pago ${orden?.condiciones_pago}`)
  }

  const ctxCaso: ToolCtx = { ...ctx, confirmacionHumana: opciones.confirmado === true }
  const r = parse(await oc.crear.execute({ caso, confirmado: opciones.confirmado }, ctxCaso))
  if (r.ok) console.log(`  ✅ OC ${r.data?.numero_oc}${r.data?.idempotente ? " (idempotente: ya existía, no se creó otra)" : ""}${r.data?.evidencia ? ` · evidencia ${r.data.evidencia}` : ""}`)
  else console.log(`  ✋ ${r.error}`)
}

async function main() {
  await fs.rm(out, { recursive: true, force: true })
  console.log("Demo reto 03 · herramientas sin modelo · out/ limpio")

  await procesar("sol-001")
  await procesar("sol-001", { etiqueta: "segunda vez → idempotencia" })
  await procesar("sol-002")
  await procesar("sol-003")
  await procesar("sol-004", { etiqueta: "sin confirmar" })
  await procesar("sol-004", { confirmado: true, etiqueta: "usuario confirma" })
  await procesar("sol-005", { confirmado: true, etiqueta: "usuario confirma regularización" })
  await procesar("sol-006", { etiqueta: "sin confirmar" })
  await procesar("sol-006", { confirmado: true, etiqueta: "usuario confirma IVA" })
  await procesar("sol-999", { etiqueta: "caso inexistente → error legible" })

  console.log("\n━━ out/control.csv ━━")
  console.log(await fs.readFile(path.join(out, "control.csv"), "utf8"))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
