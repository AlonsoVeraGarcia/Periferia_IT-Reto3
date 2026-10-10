import path from "node:path"
import { z } from "zod"
import { leerJson, rutaFixtures, type ToolCtx } from "./archivos.ts"

const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
})
const CentroSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string().optional(),
  subareas: z.array(z.string()),
  aprobadores: z.array(z.object({ email: z.string(), nombre: z.string().optional(), tope: z.number() })),
})
const IvaSchema = z.object({ codigo: z.string(), descripcion: z.string(), tasa: z.number() })
const PagoSchema = z.object({ codigo: z.string(), descripcion: z.string(), dias: z.number() })

export type Proveedor = z.infer<typeof ProveedorSchema>
export type CentroCosto = z.infer<typeof CentroSchema>
export type IndicadorIva = z.infer<typeof IvaSchema>
export type CondicionPago = z.infer<typeof PagoSchema>

export type Maestros = {
  proveedores: Proveedor[]
  centros: CentroCosto[]
  iva: IndicadorIva[]
  pagos: CondicionPago[]
}

async function cargar<T>(ctx: ToolCtx, archivo: string, schema: z.ZodType<T>): Promise<T[]> {
  const leido = await leerJson(path.join(rutaFixtures(ctx), "maestros", archivo))
  if (leido === null) throw new Error(`Maestro no encontrado: ${archivo}`)
  if (!leido.ok) throw new Error(leido.error)
  return z.array(schema).parse(leido.valor)
}

/** Maestros de solo lectura. En producción vendrían de SAP en tiempo real (ver SOLUCION.md). */
export async function cargarMaestros(ctx: ToolCtx): Promise<Maestros> {
  const [proveedores, centros, iva, pagos] = await Promise.all([
    cargar(ctx, "proveedores.json", ProveedorSchema),
    cargar(ctx, "centros-costo.json", CentroSchema),
    cargar(ctx, "indicadores-iva.json", IvaSchema),
    cargar(ctx, "condiciones-pago.json", PagoSchema),
  ])
  return { proveedores, centros, iva, pagos }
}
