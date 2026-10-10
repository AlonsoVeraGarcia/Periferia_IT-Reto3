/**
 * Matriz de controles RC1–RC10 (PRD 7.3). Función pura: mismo paquete + mismos maestros = mismo resultado.
 * Bloqueo → no se crea OC. Confirmación → se crea solo con confirmación humana. Derivado → se informa.
 */
import type { Maestros, Proveedor } from "./maestros.ts"
import { formatoCOP, normalizarNit, normalizarNombre, soloFecha } from "./textos.ts"
import type { Derivado, Hallazgo, Paquete, Validacion } from "./tipos.ts"

export const TOLERANCIA_COTIZACION = 0.02
export const TOLERANCIA_ARITMETICA = 1

export function buscarProveedor(p: Paquete, m: Maestros): { proveedor: Proveedor | null; por: "nit" | "nombre" } {
  const s = p.solicitud
  if (s.proveedor_nit) {
    const nit = normalizarNit(s.proveedor_nit)
    return { proveedor: m.proveedores.find((x) => x.nit === nit) ?? null, por: "nit" }
  }
  const nombre = normalizarNombre(s.proveedor_nombre)
  return { proveedor: m.proveedores.find((x) => normalizarNombre(x.nombre) === nombre) ?? null, por: "nombre" }
}

export function validarPaquete(p: Paquete, m: Maestros): Validacion {
  const s = p.solicitud
  const bloqueos: Hallazgo[] = []
  const confirmaciones: Hallazgo[] = []
  const derivados: Derivado[] = []
  const ok: string[] = []

  // RC1 · Proveedor existe y está activo
  const { proveedor, por } = buscarProveedor(p, m)
  if (!proveedor) {
    bloqueos.push({
      regla: "RC1",
      detalle: `El proveedor "${s.proveedor_nombre}"${s.proveedor_nit ? ` (NIT ${s.proveedor_nit})` : ""} no existe en el maestro de proveedores (búsqueda por ${por}).`,
      accion_sugerida: "Solicitar a Compras la creación del proveedor en SAP (RUT, certificación bancaria) o usar un proveedor ya registrado.",
    })
  } else if (!proveedor.activo) {
    bloqueos.push({
      regla: "RC1",
      detalle: `El proveedor ${proveedor.nombre} (${proveedor.codigo_sap}) existe pero está inactivo.`,
      accion_sugerida: "Solicitar a Compras la reactivación del proveedor antes de crear la OC.",
    })
  } else {
    ok.push("RC1")
    if (por === "nombre") derivados.push({ campo: "proveedor_nit", valor: proveedor.nit, fuente: "maestro.proveedores (por nombre normalizado)" })
  }

  // RC4 · Subárea pertenece al centro de costo
  const centro = m.centros.find((c) => c.centro_costo === s.centro_costo) ?? null
  if (!centro) {
    bloqueos.push({
      regla: "RC4",
      detalle: `El centro de costo ${s.centro_costo} no existe en el maestro.`,
      accion_sugerida: "Pedir al solicitante el centro de costo correcto.",
    })
  } else if (!centro.subareas.includes(s.subarea)) {
    bloqueos.push({
      regla: "RC4",
      detalle: `La subárea "${s.subarea}" no pertenece a ${s.centro_costo} (válidas: ${centro.subareas.join(", ")}).`,
      accion_sugerida: "Pedir al solicitante la subárea correcta.",
    })
  } else ok.push("RC4")

  // RC2 · Aprobación existe, dice "Aprobado" y viene de un aprobador del centro
  const a = p.aprobacion
  const aprobador = a && centro ? (centro.aprobadores.find((x) => x.email.toLowerCase() === a.de) ?? null) : null
  if (!a) {
    bloqueos.push({ regla: "RC2", detalle: "No hay correo de aprobación en el paquete.", accion_sugerida: "Pedir al solicitante el correo de aprobación de su líder." })
  } else if (!a.aprobado) {
    bloqueos.push({ regla: "RC2", detalle: `El correo de ${a.de} no contiene la palabra "Aprobado".`, accion_sugerida: "Pedir al líder una aprobación explícita." })
  } else if (centro && !aprobador) {
    const validos = centro.aprobadores.map((x) => `${x.email} (tope ${formatoCOP(x.tope)})`).join(", ")
    bloqueos.push({
      regla: "RC2",
      detalle: `${a.de} no es aprobador del centro ${s.centro_costo}. Aprobadores válidos: ${validos}.`,
      accion_sugerida: `Solicitar la aprobación a un aprobador de ${s.centro_costo} con tope suficiente.`,
    })
  } else if (aprobador) ok.push("RC2")

  // RC3 · Monto dentro del tope del aprobador (si no hay aprobador válido, se evalúa contra el mayor tope del centro)
  if (centro) {
    const tope = aprobador ? aprobador.tope : Math.max(0, ...centro.aprobadores.map((x) => x.tope))
    if (s.valor_total > tope) {
      bloqueos.push({
        regla: "RC3",
        detalle: aprobador
          ? `Valor ${formatoCOP(s.valor_total)} supera el tope de ${aprobador.email} en ${s.centro_costo} (${formatoCOP(tope)}).`
          : `Valor ${formatoCOP(s.valor_total)} supera incluso el mayor tope de aprobación de ${s.centro_costo} (${formatoCOP(tope)}).`,
        accion_sugerida: "Escalar la aprobación a un nivel con atribución suficiente o dividir la compra solo si el negocio lo justifica (no para evadir el tope).",
        valores: { valor_total: s.valor_total, tope },
      })
    } else if (aprobador) ok.push("RC3")
  }

  // RC10 · cantidad × valor_unitario = valor_total (± 1)
  const calculado = s.cantidad * s.valor_unitario
  if (Math.abs(calculado - s.valor_total) > TOLERANCIA_ARITMETICA) {
    bloqueos.push({
      regla: "RC10",
      detalle: `cantidad × valor_unitario = ${formatoCOP(calculado)} no cuadra con valor_total ${formatoCOP(s.valor_total)}.`,
      accion_sugerida: "Pedir al solicitante corregir el Excel.",
      valores: { calculado, valor_total: s.valor_total },
    })
  } else ok.push("RC10")

  // RC5 · Cotización vs solicitud (≤ 2 %)
  if (!p.cotizacion) {
    confirmaciones.push({ regla: "RC5", detalle: "El paquete no trae cotización del proveedor.", accion_sugerida: "Confirmar que se crea la OC sin cotización o pedirla al solicitante." })
  } else {
    const desvio = Math.abs(p.cotizacion.total - s.valor_total) / s.valor_total
    if (desvio > TOLERANCIA_COTIZACION) {
      confirmaciones.push({
        regla: "RC5",
        detalle: `La cotización (${formatoCOP(p.cotizacion.total)}) difiere ${(desvio * 100).toFixed(1)} % de la solicitud (${formatoCOP(s.valor_total)}). La OC se construye con el valor de la solicitud, que es el aprobado.`,
        accion_sugerida: "Confirmar con el valor de la solicitud, o pedir al solicitante actualizar solicitud y aprobación al valor cotizado.",
        valores: { solicitud: s.valor_total, cotizacion: p.cotizacion.total, desvio_pct: Number((desvio * 100).toFixed(2)) },
      })
    } else ok.push("RC5")
  }

  // RC6 · IVA ausente → derivado del proveedor + confirmación
  if (!s.indicador_iva) {
    const iva = proveedor?.indicador_iva_default ?? null
    if (iva) derivados.push({ campo: "indicador_iva", valor: iva, fuente: "maestro.proveedores.indicador_iva_default" })
    confirmaciones.push({
      regla: "RC6",
      detalle: iva ? `La solicitud no informa indicador de IVA; se propone ${iva} (default del proveedor).` : "La solicitud no informa indicador de IVA y no hay default disponible.",
      accion_sugerida: "Confirmar el indicador de IVA propuesto.",
      valores: { indicador_iva_propuesto: iva },
    })
  } else if (!m.iva.some((x) => x.codigo === s.indicador_iva)) {
    bloqueos.push({ regla: "RC6", detalle: `Indicador de IVA ${s.indicador_iva} no existe en el maestro.`, accion_sugerida: "Corregir el indicador de IVA." })
  } else ok.push("RC6")

  // RC7 · Condiciones de pago ausentes → derivadas del proveedor (solo se informa)
  if (!s.condiciones_pago) {
    if (proveedor) derivados.push({ campo: "condiciones_pago", valor: proveedor.condiciones_pago_default, fuente: "maestro.proveedores.condiciones_pago_default" })
  } else if (!m.pagos.some((x) => x.codigo === s.condiciones_pago)) {
    bloqueos.push({ regla: "RC7", detalle: `Condición de pago ${s.condiciones_pago} no existe en el maestro.`, accion_sugerida: "Corregir la condición de pago." })
  } else ok.push("RC7")

  // RC8 · Factura anterior a la solicitud → retroactiva
  const retroactiva = !!p.factura && p.factura.fecha < s.fecha_solicitud
  if (retroactiva && p.factura) {
    confirmaciones.push({
      regla: "RC8",
      detalle: `OC retroactiva: la factura ${p.factura.numero} (${p.factura.fecha}) es anterior a la solicitud (${s.fecha_solicitud}). La compra ocurrió antes de la OC.`,
      accion_sugerida: "Confirmar para regularizar; quedará marcada retroactiva = true en el log de control.",
      valores: { fecha_factura: p.factura.fecha, fecha_solicitud: s.fecha_solicitud },
    })
  } else ok.push("RC8")

  // RC9 · Aprobación con fecha ≥ solicitud
  if (a && soloFecha(a.fecha) < s.fecha_solicitud) {
    confirmaciones.push({
      regla: "RC9",
      detalle: `La aprobación (${soloFecha(a.fecha)}) es anterior a la fecha de la solicitud (${s.fecha_solicitud}).`,
      accion_sugerida: "Confirmar que la aprobación corresponde a esta solicitud.",
    })
  } else if (a) ok.push("RC9")

  return { solicitud_id: s.solicitud_id, apta: bloqueos.length === 0, bloqueos, confirmaciones, derivados, retroactiva, reglas_ok: ok }
}
