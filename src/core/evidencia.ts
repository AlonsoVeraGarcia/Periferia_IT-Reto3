import path from "node:path"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { escribir, rutaOut, type ToolCtx } from "./archivos.ts"
import { sha256, textoEvidencia } from "./payload.ts"
import type { Paquete, Resultado } from "./tipos.ts"

/** Las fuentes estándar de PDF usan WinAnsi: se reemplaza lo que no se puede codificar. */
const winAnsi = (t: string) => t.replace(/[^\x20-\x7E\xA0-\xFF\n—–“”‘’…]/g, "?")

async function pdfDe(texto: string, sha: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  // Fecha fija para que el PDF sea reproducible byte a byte entre corridas.
  doc.setCreationDate(new Date("2026-01-01T00:00:00Z"))
  doc.setModificationDate(new Date("2026-01-01T00:00:00Z"))
  const fuente = await doc.embedFont(StandardFonts.Helvetica)
  const pagina = doc.addPage([595, 842])
  let y = 790
  const lineas = [...winAnsi(texto).split("\n"), "", `sha256 del contenido: ${sha}`]
  for (const linea of lineas) {
    for (let i = 0; i < Math.max(1, linea.length); i += 90) {
      pagina.drawText(linea.slice(i, i + 90), { x: 50, y, size: 10, font: fuente })
      y -= 15
    }
  }
  return doc.save()
}

/** HU-4: P0 aprobacion.txt con sha256; P1 aprobacion.pdf con el mismo contenido. */
export async function generarEvidencia(p: Paquete, ctx: ToolCtx): Promise<Resultado<{ ruta: string; ruta_pdf: string; sha256: string }>> {
  const texto = textoEvidencia(p)
  if (!texto) return { ok: false, error: "No hay correo de aprobación: no se puede generar evidencia." }
  const sha = sha256(texto)
  const dir = path.join(rutaOut(ctx), p.caso)
  await escribir(path.join(dir, "aprobacion.txt"), `${texto}\nsha256: ${sha}\n`)
  await escribir(path.join(dir, "aprobacion.pdf"), await pdfDe(texto, sha))
  return { ok: true, data: { ruta: `out/${p.caso}/aprobacion.txt`, ruta_pdf: `out/${p.caso}/aprobacion.pdf`, sha256: sha } }
}
