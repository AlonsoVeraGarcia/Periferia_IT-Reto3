import { z } from "zod"

/** Solicitud de compra (Excel normalizado a JSON). Campos opcionales según PRD 7.1. */
export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string(),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: z.number({ error: "cantidad debe ser numérica" }).positive(),
  valor_unitario: z.number({ error: "valor_unitario debe ser numérico" }).nonnegative(),
  valor_total: z.number({ error: "valor_total debe ser numérico" }).positive(),
  moneda: z.enum(["COP", "USD"]),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha_solicitud debe ser YYYY-MM-DD"),
})
export type Solicitud = z.infer<typeof SolicitudSchema>

export type Cotizacion = {
  referencia: string | null
  proveedor: string
  nit: string | null
  total: number
  moneda: string
  fecha: string | null
  validez_hasta: string | null
  texto: string
}

export type Aprobacion = { de: string; para: string; asunto: string; fecha: string; aprobado: boolean; texto: string }
export type Factura = { numero: string; fecha: string; total: number }

export type Paquete = {
  caso: string
  correo: { id: string; de: string; asunto: string; fecha: string }
  solicitud: Solicitud
  cotizacion: Cotizacion | null
  aprobacion: Aprobacion | null
  factura: Factura | null
  faltantes: string[]
}

/** Payload de la OC (PRD 7.4), validado con zod antes de entregarlo o crearlo. */
export const OrdenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string(),
    correo_id: z.string(),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string(),
  aprobador: z.object({ email: z.string(), fecha_aprobacion: z.string(), evidencia_sha256: z.string().length(64) }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int().positive(),
        descripcion: z.string().max(40),
        cantidad: z.number().positive(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number().nonnegative(),
        centro_costo: z.string(),
        subarea: z.string(),
        indicador_iva: z.string(),
      }),
    )
    .min(1),
  excepciones: z.array(z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() })),
})
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>

export type Hallazgo = {
  regla: string
  detalle: string
  accion_sugerida: string
  valores?: Record<string, string | number | null>
}

export type Derivado = { campo: string; valor: string; fuente: string }

export type Validacion = {
  solicitud_id: string
  apta: boolean
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  derivados: Derivado[]
  retroactiva: boolean
  reglas_ok: string[]
}

/** Resultado uniforme de toda herramienta. */
export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string }
