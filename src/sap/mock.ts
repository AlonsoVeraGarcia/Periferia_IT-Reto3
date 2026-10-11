import path from "node:path"
import { anexar, leerJson, leerTexto } from "../core/archivos.ts"
import type { OrdenCompra } from "../core/tipos.ts"
import type { SapAdapter } from "./adapter.ts"

type Registro = { numero_oc: string; fecha: string; orden: OrdenCompra }

const PRIMER_NUMERO = 4500000001

/** SAP simulado sobre archivos: out/sap/ordenes.jsonl. Numeración secuencial desde 4500000001. */
export class SapMock implements SapAdapter {
  constructor(
    private readonly outDir: string,
    private readonly fixturesDir: string,
  ) {}

  private get archivo() {
    return path.join(this.outDir, "sap", "ordenes.jsonl")
  }

  private async ordenes(): Promise<Registro[]> {
    const texto = await leerTexto(this.archivo)
    if (!texto) return []
    return texto
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Registro)
  }

  async consultarProveedor(nit: string) {
    const leido = await leerJson(path.join(this.fixturesDir, "maestros", "proveedores.json"))
    if (!leido?.ok) return null
    const lista = leido.valor as { nit: string; codigo_sap: string; activo: boolean }[]
    const p = lista.find((x) => x.nit === nit)
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async buscarOrdenPorReferencia(solicitud_id: string) {
    const r = (await this.ordenes()).find((o) => o.orden.referencia.solicitud_id === solicitud_id)
    return r ? { numero_oc: r.numero_oc } : null
  }

  async crearOrden(orden: OrdenCompra) {
    const existentes = await this.ordenes()
    const numero_oc = String(PRIMER_NUMERO + existentes.length)
    // Fecha de negocio en la zona horaria de la operación (Colombia por defecto), no en UTC del servidor.
    const fecha = new Date().toLocaleDateString("en-CA", { timeZone: process.env.ZONA_HORARIA || "America/Bogota" })
    await anexar(this.archivo, JSON.stringify({ numero_oc, fecha, orden } satisfies Registro))
    return { numero_oc, fecha }
  }
}
