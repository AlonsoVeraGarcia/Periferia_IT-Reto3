/** Parsers deterministas de los textos de cotización y factura. Sin modelo de lenguaje. */
import type { Cotizacion, Factura } from "./tipos.ts"

/** "COP 11.400.000" o "11.400.000,50" → 11400000 / 11400000.5 (formato colombiano). */
export function parsearMonto(texto: string): number | null {
  const limpio = texto.replace(/[^\d.,]/g, "")
  if (!limpio) return null
  const normal = limpio.replace(/\./g, "").replace(",", ".")
  const n = Number(normal)
  return Number.isFinite(n) ? n : null
}

/** NIT sin puntos ni dígito de verificación: "900.555.111-2" → "900555111". */
export function normalizarNit(nit: string): string {
  return nit.split("-")[0].replace(/\D/g, "")
}

/** Nombre comparable: sin tildes, sin puntuación, sin sufijos societarios. */
export function normalizarNombre(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\b(s\s?a\s?s|s\s?a|ltda|sas|sa)\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

const campo = (texto: string, etiqueta: RegExp): string | null => texto.match(etiqueta)?.[1]?.trim() ?? null

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

export function parsearCotizacion(texto: string): Cotizacion | { error: string } {
  const proveedor = campo(texto, /^Proveedor:\s*(.+)$/m)
  const totalTxt = campo(texto, /^TOTAL[^:\n]*:\s*(.+)$/m)
  if (!proveedor || !totalTxt) return { error: "La cotización no tiene proveedor o TOTAL legible." }
  const total = parsearMonto(totalTxt)
  if (total === null) return { error: `TOTAL de la cotización no numérico: "${totalTxt}"` }
  const nit = campo(texto, /^NIT:\s*(.+)$/m)
  const fecha = campo(texto, /^Fecha:\s*(\d{4}-\d{2}-\d{2})/m)
  const dias = Number(campo(texto, /Validez[^:]*:\s*(\d+)\s*d[ií]as/i) ?? NaN)
  return {
    referencia: campo(texto, /^COTIZACI[ÓO]N\s+(\S+)/m),
    proveedor,
    nit: nit ? normalizarNit(nit) : null,
    total,
    moneda: totalTxt.match(/\b(COP|USD)\b/)?.[1] ?? "COP",
    fecha,
    validez_hasta: fecha && Number.isFinite(dias) ? sumarDias(fecha, dias) : null,
    texto,
  }
}

export function parsearFactura(texto: string): Factura | { error: string } {
  const numero = campo(texto, /No\.\s*(\S+)/)
  const fecha = campo(texto, /Fecha de emisi[óo]n:\s*(\d{4}-\d{2}-\d{2})/i)
  const totalTxt = campo(texto, /^TOTAL:\s*(.+)$/m)
  if (!numero || !fecha || !totalTxt) return { error: "La factura no tiene número, fecha de emisión o TOTAL legible." }
  const total = parsearMonto(totalTxt)
  if (total === null) return { error: `TOTAL de la factura no numérico: "${totalTxt}"` }
  return { numero, fecha, total }
}

/** "Aprobado" como palabra; descarta "no aprobado" explícito. */
export function contieneAprobado(cuerpo: string): boolean {
  if (/\bno\s+(est[aá]\s+)?aprobad[oa]\b/i.test(cuerpo)) return false
  return /\baprobad[oa]\b/i.test(cuerpo)
}

export const soloFecha = (isoOFecha: string) => isoOFecha.slice(0, 10)

export const formatoCOP = (n: number) => n.toLocaleString("es-CO", { maximumFractionDigits: 2 })
