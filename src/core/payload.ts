/** Construcción determinista del payload de la OC (PRD 7.4) con trazabilidad campo a campo (HU-3). */
import { createHash } from "node:crypto"
import type { Maestros } from "./maestros.ts"
import { buscarProveedor } from "./reglas.ts"
import { soloFecha } from "./textos.ts"
import { OrdenCompraSchema, type OrdenCompra, type Paquete, type Resultado, type Validacion } from "./tipos.ts"

export type Trazabilidad = Record<string, string>

/** Texto de evidencia de aprobación. Su sha256 se usa en el payload y en el archivo generado: misma función, mismo hash. */
export function textoEvidencia(p: Paquete): string | null {
  const a = p.aprobacion
  if (!a) return null
  return [
    "EVIDENCIA DE APROBACIÓN — ORDEN DE COMPRA",
    `Solicitud: ${p.solicitud.solicitud_id}`,
    `De: ${a.de}`,
    `Para: ${a.para}`,
    `Fecha: ${a.fecha}`,
    `Asunto: ${a.asunto}`,
    "",
    a.texto,
    "",
  ].join("\n")
}

export const sha256 = (texto: string | Uint8Array) => createHash("sha256").update(texto).digest("hex")

/** Unidad SAP inferida de la descripción. */
function unidad(descripcion: string): "UN" | "H" | "MES" {
  if (/\bhoras?\b/i.test(descripcion)) return "H"
  if (/\b(mes|meses|mensual)\b/i.test(descripcion) && !/vigencia/i.test(descripcion)) return "MES"
  return "UN"
}

/** Texto breve SAP: máximo 40 caracteres, cortado en palabra. */
export function textoBreve(descripcion: string): string {
  if (descripcion.length <= 40) return descripcion
  const corte = descripcion.slice(0, 40)
  const espacio = corte.lastIndexOf(" ")
  return (espacio > 25 ? corte.slice(0, espacio) : corte)
    .replace(/[\s,;:-]+$/, "")
    .replace(/\s+(de|del|para|la|el|con|y|en)$/i, "")
}

export function construirOrden(p: Paquete, v: Validacion, m: Maestros): Resultado<{ orden: OrdenCompra; trazabilidad: Trazabilidad }> {
  if (!v.apta) return { ok: false, error: `No se construye la OC: hay bloqueos (${v.bloqueos.map((b) => b.regla).join(", ")}).` }
  const s = p.solicitud
  const { proveedor } = buscarProveedor(p, m)
  const evidencia = textoEvidencia(p)
  if (!proveedor || !p.aprobacion || !evidencia) return { ok: false, error: "Faltan proveedor o aprobación para construir la OC." }

  const derivado = (campo: string) => v.derivados.find((d) => d.campo === campo)?.valor
  const ivaCodigo = s.indicador_iva ?? derivado("indicador_iva")
  const pago = s.condiciones_pago ?? derivado("condiciones_pago")
  const iva = m.iva.find((x) => x.codigo === ivaCodigo)
  if (!ivaCodigo || !pago || !iva) return { ok: false, error: "No se pudo determinar indicador de IVA o condiciones de pago." }

  // Supuesto documentado: los valores de solicitud y cotización vienen con IVA incluido.
  // En SAP el precio neto va sin IVA y el impuesto lo calcula el indicador; así se evita cobrar IVA dos veces.
  const precioNeto = Math.round((s.valor_unitario / (1 + iva.tasa)) * 100) / 100

  const orden: OrdenCompra = {
    referencia: { solicitud_id: s.solicitud_id, correo_id: p.correo.id, cotizacion_ref: p.cotizacion?.referencia ?? null },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: { codigo_sap: proveedor.codigo_sap, nit: proveedor.nit, nombre: proveedor.nombre },
    moneda: s.moneda,
    condiciones_pago: pago,
    aprobador: { email: p.aprobacion.de, fecha_aprobacion: soloFecha(p.aprobacion.fecha), evidencia_sha256: sha256(evidencia) },
    posiciones: [
      {
        numero: 10,
        descripcion: textoBreve(s.descripcion),
        cantidad: s.cantidad,
        unidad: unidad(s.descripcion),
        precio_unitario: precioNeto,
        centro_costo: s.centro_costo,
        subarea: s.subarea,
        indicador_iva: ivaCodigo,
      },
    ],
    excepciones: v.confirmaciones.map((c) => ({ codigo: c.regla, detalle: c.detalle, confirmado_por: null })),
  }

  const trazabilidad: Trazabilidad = {
    "referencia.solicitud_id": "solicitud.solicitud_id",
    "referencia.correo_id": "correo.id",
    "referencia.cotizacion_ref": p.cotizacion ? "cotizacion (encabezado)" : "sin cotización",
    sociedad: "constante (sociedad 1000)",
    organizacion_compras: "constante (org. compras 1000)",
    "proveedor.codigo_sap": "maestro.proveedores",
    "proveedor.nit": s.proveedor_nit ? "solicitud.proveedor_nit + maestro.proveedores" : "derivado (maestro.proveedores por nombre)",
    "proveedor.nombre": "maestro.proveedores",
    moneda: "solicitud.moneda",
    condiciones_pago: s.condiciones_pago ? "solicitud.condiciones_pago" : "derivado (maestro.proveedores.condiciones_pago_default)",
    "aprobador.email": "aprobacion.de (validado contra maestro.centros-costo)",
    "aprobador.fecha_aprobacion": "aprobacion.fecha",
    "aprobador.evidencia_sha256": "derivado (sha256 de la evidencia de aprobación)",
    "posiciones[0].numero": "constante (primera posición = 10)",
    "posiciones[0].descripcion": s.descripcion.length > 40 ? "solicitud.descripcion (recortada a 40 caracteres, límite SAP)" : "solicitud.descripcion",
    "posiciones[0].cantidad": "solicitud.cantidad",
    "posiciones[0].unidad": "derivado (inferida de solicitud.descripcion)",
    "posiciones[0].precio_unitario": `derivado (solicitud.valor_unitario ${s.valor_unitario} IVA incluido ÷ (1 + ${iva.tasa}) de maestro.indicadores-iva)`,
    "posiciones[0].centro_costo": "solicitud.centro_costo",
    "posiciones[0].subarea": "solicitud.subarea",
    "posiciones[0].indicador_iva": s.indicador_iva ? "solicitud.indicador_iva" : "derivado (maestro.proveedores.indicador_iva_default)",
    excepciones: "oc_validar (confirmaciones)",
  }

  const valido = OrdenCompraSchema.safeParse(orden)
  if (!valido.success) return { ok: false, error: `Payload inválido: ${valido.error.issues.map((i) => i.message).join("; ")}` }
  return { ok: true, data: { orden: valido.data, trazabilidad } }
}
