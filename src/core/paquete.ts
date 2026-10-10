import path from "node:path"
import { leerJson, leerTexto, nombreCasoSeguro, rutaFixtures, type ToolCtx } from "./archivos.ts"
import { contieneAprobado, parsearCotizacion, parsearFactura } from "./textos.ts"
import { SolicitudSchema, type Aprobacion, type Paquete, type Resultado } from "./tipos.ts"

type Registro = Record<string, unknown>
const str = (r: Registro, k: string) => (typeof r[k] === "string" ? (r[k] as string) : "")

/** Lee y normaliza el paquete de un caso (HU-1). Un adjunto ausente queda en null y se lista en `faltantes`. */
export async function leerPaquete(caso: string, ctx: ToolCtx): Promise<Resultado<Paquete>> {
  if (!nombreCasoSeguro(caso)) return { ok: false, error: `Nombre de caso inválido: "${caso}"` }
  const dir = path.join(rutaFixtures(ctx), "solicitudes", caso)
  const faltantes: string[] = []

  const correoJ = await leerJson(path.join(dir, "correo.json"))
  const solJ = await leerJson(path.join(dir, "solicitud.json"))
  if (correoJ === null && solJ === null) return { ok: false, error: `No existe el caso "${caso}".` }
  if (solJ === null) return { ok: false, error: "Falta la solicitud (solicitud.xlsx). Pídela al solicitante." }
  if (!solJ.ok) return { ok: false, error: solJ.error }
  if (correoJ && !correoJ.ok) return { ok: false, error: correoJ.error }

  const sol = SolicitudSchema.safeParse(solJ.valor)
  if (!sol.success) {
    const detalle = sol.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    return { ok: false, error: `Solicitud inválida (${detalle}). Pide al solicitante corregir el Excel.` }
  }

  const correo = (correoJ?.ok ? correoJ.valor : {}) as Registro
  if (!correoJ) faltantes.push("correo.json (correo de entrada)")

  const cotTxt = await leerTexto(path.join(dir, "cotizacion.txt"))
  let cotizacion: Paquete["cotizacion"] = null
  if (cotTxt === null) faltantes.push("cotizacion (cotización del proveedor)")
  else {
    const c = parsearCotizacion(cotTxt)
    if ("error" in c) return { ok: false, error: c.error }
    cotizacion = c
  }

  const aprJ = await leerJson(path.join(dir, "aprobacion.json"))
  let aprobacion: Aprobacion | null = null
  if (aprJ === null) faltantes.push("aprobacion (correo de aprobación del líder)")
  else if (!aprJ.ok) return { ok: false, error: aprJ.error }
  else {
    const a = aprJ.valor as Registro
    aprobacion = {
      de: str(a, "de").toLowerCase(),
      para: str(a, "para"),
      asunto: str(a, "asunto"),
      fecha: str(a, "fecha"),
      aprobado: contieneAprobado(str(a, "cuerpo")),
      texto: str(a, "cuerpo"),
    }
  }

  const facTxt = await leerTexto(path.join(dir, "factura.txt"))
  let factura: Paquete["factura"] = null
  if (facTxt !== null) {
    const f = parsearFactura(facTxt)
    if ("error" in f) return { ok: false, error: f.error }
    factura = f
  }

  return {
    ok: true,
    data: {
      caso,
      correo: { id: str(correo, "id"), de: str(correo, "de"), asunto: str(correo, "asunto"), fecha: str(correo, "fecha") },
      solicitud: sol.data,
      cotizacion,
      aprobacion,
      factura,
      faltantes,
    },
  }
}
