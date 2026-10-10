/** Registro de herramientas: nombre `<archivo>_<export>`, validación zod de argumentos y JSON Schema para el modelo. */
import { z } from "zod"
import type { ToolCtx } from "../core/archivos.ts"
import * as oc from "./oc.ts"

type Herramienta = {
  description: string
  args: Record<string, z.ZodType>
  execute: (args: never, ctx: ToolCtx) => Promise<string>
}

export type DefinicionTool = { nombre: string; descripcion: string; esquema: Record<string, unknown> }

const MODULOS: Record<string, Record<string, unknown>> = { oc }

function esHerramienta(x: unknown): x is Herramienta {
  return typeof x === "object" && x !== null && "execute" in x && "args" in x && "description" in x
}

const registro = new Map<string, Herramienta>()
for (const [archivo, mod] of Object.entries(MODULOS)) {
  for (const [exp, valor] of Object.entries(mod)) if (esHerramienta(valor)) registro.set(`${archivo}_${exp}`, valor)
}

export function definiciones(): DefinicionTool[] {
  return [...registro.entries()].map(([nombre, h]) => {
    const esquema = z.toJSONSchema(z.object(h.args), { unrepresentable: "any" }) as Record<string, unknown>
    delete esquema.$schema
    return { nombre, descripcion: h.description, esquema }
  })
}

/** Valida argumentos con zod y ejecuta. Un error de validación vuelve al modelo como { ok:false } (PRD 6.2). */
export async function ejecutar(nombre: string, args: unknown, ctx: ToolCtx): Promise<string> {
  const h = registro.get(nombre)
  if (!h) return JSON.stringify({ ok: false, error: `Herramienta desconocida: ${nombre}` })
  const parse = z.object(h.args).safeParse(args ?? {})
  if (!parse.success) {
    const detalle = parse.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ")
    return JSON.stringify({ ok: false, error: `Argumentos inválidos para ${nombre}: ${detalle}` })
  }
  try {
    return await h.execute(parse.data as never, ctx)
  } catch (e) {
    return JSON.stringify({ ok: false, error: `Error inesperado en ${nombre}: ${(e as Error).message}` })
  }
}
