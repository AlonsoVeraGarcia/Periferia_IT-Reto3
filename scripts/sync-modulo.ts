/**
 * Genera modulo/agent.md y modulo/skill/ordenes-compra/SKILL.md desde las fuentes únicas
 * (agent/prompt.md y src/knowledge/ordenes-compra.md). Con --check falla si están desalineados.
 *   npx tsx scripts/sync-modulo.ts [--check]
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const leer = (r: string) => fs.readFile(path.join(raiz, r), "utf8")

const prompt = await leer("agent/prompt.md")
const conocimiento = await leer("src/knowledge/ordenes-compra.md")

const archivos: Record<string, string> = {
  "modulo/agent.md": `---
description: Agente que lee paquetes de compra, valida controles RC1–RC10 y crea órdenes de compra en SAP con confirmación humana.
mode: primary
permission:
  edit: deny
  bash: deny
---

${prompt}`,
  "modulo/skill/ordenes-compra/SKILL.md": `---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra de Periferia (matriz de controles, criterios del payload SAP, OC retroactivas). Úsalo al procesar solicitudes de compra.
---

${conocimiento}`,
}

const check = process.argv.includes("--check")
let desalineado = false
for (const [ruta, contenido] of Object.entries(archivos)) {
  const destino = path.join(raiz, ruta)
  if (check) {
    const actual = await fs.readFile(destino, "utf8").catch(() => "")
    if (actual !== contenido) {
      console.error(`✗ ${ruta} no coincide con su fuente. Ejecuta: npm run modulo`)
      desalineado = true
    } else console.log(`✓ ${ruta} alineado con su fuente`)
  } else {
    await fs.mkdir(path.dirname(destino), { recursive: true })
    await fs.writeFile(destino, contenido)
    console.log(`→ ${ruta}`)
  }
}
if (desalineado) process.exit(1)
