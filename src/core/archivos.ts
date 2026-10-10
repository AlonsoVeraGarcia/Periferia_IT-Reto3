import { promises as fs } from "node:fs"
import path from "node:path"

/** Contexto que recibe toda herramienta (PRD 6.2). */
export type ToolCtx = {
  directory: string
  sessionId: string
  /** true solo si el último mensaje humano confirmó explícitamente (lo decide el ciclo del agente, no el modelo). */
  confirmacionHumana?: boolean
  /** Casos que tenían confirmaciones pendientes cuando el usuario confirmó. Si se omite, no se restringe por caso. */
  casosConfirmables?: string[]
}

export const rutaFixtures = (ctx: ToolCtx) => path.join(ctx.directory, "fixtures", "reto-03")

/** OUT_DIR permite usar /tmp en hosting con disco de solo lectura. */
export const rutaOut = (ctx: ToolCtx) => process.env.OUT_DIR || path.join(ctx.directory, "out")

/** Evita que un argumento del modelo escape de la carpeta de casos (path traversal). */
export function nombreCasoSeguro(caso: string): string | null {
  return /^[a-z0-9][a-z0-9-]{0,40}$/i.test(caso) ? caso : null
}

export async function leerTexto(ruta: string): Promise<string | null> {
  try {
    return await fs.readFile(ruta, "utf8")
  } catch {
    return null
  }
}

export async function leerJson(ruta: string): Promise<{ ok: true; valor: unknown } | { ok: false; error: string } | null> {
  const texto = await leerTexto(ruta)
  if (texto === null) return null
  try {
    return { ok: true, valor: JSON.parse(texto) as unknown }
  } catch (e) {
    return { ok: false, error: `JSON malformado en ${path.basename(ruta)}: ${(e as Error).message}` }
  }
}

export async function escribir(ruta: string, contenido: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(ruta), { recursive: true })
  await fs.writeFile(ruta, contenido)
}

export async function anexar(ruta: string, linea: string): Promise<void> {
  await fs.mkdir(path.dirname(ruta), { recursive: true })
  await fs.appendFile(ruta, linea.endsWith("\n") ? linea : linea + "\n")
}

export async function existe(ruta: string): Promise<boolean> {
  try {
    await fs.access(ruta)
    return true
  } catch {
    return false
  }
}

export const ahora = () => new Date().toISOString()
