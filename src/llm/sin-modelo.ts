/**
 * Proveedor de respaldo SIN modelo de lenguaje: un guion determinista que recorre las herramientas.
 * Sirve para (1) demostrar que cambiar de proveedor no toca el ciclo del agente y (2) mantener el link
 * funcional si no hay clave. No interpreta lenguaje natural: solo reconoce "sol-00X" y confirmaciones.
 */
import type { DefinicionTool } from "../tools/registro.ts"
import type { LlamadaTool, Mensaje, ProveedorLLM, Respuesta } from "./adapter.ts"

type Resultado = { ok: boolean; data?: Record<string, unknown>; error?: string }
type Hallazgo = { regla: string; detalle: string; accion_sugerida: string }

const CASO = /\bsol-\d{3}\b/i
let contador = 0
const id = () => `script_${++contador}`

function ultimo<T extends Mensaje["rol"]>(m: Mensaje[], rol: T) {
  for (let i = m.length - 1; i >= 0; i--) if (m[i].rol === rol) return m[i] as Extract<Mensaje, { rol: T }>
  return null
}

function casoDe(mensajes: Mensaje[]): string | null {
  for (let i = mensajes.length - 1; i >= 0; i--) {
    const m = mensajes[i]
    if (m.rol === "user" && CASO.test(m.texto)) return m.texto.match(CASO)![0].toLowerCase()
  }
  return null
}

const llamar = (nombre: string, args: unknown): Respuesta => ({
  texto: "",
  llamadas: [{ id: id(), nombre, args } satisfies LlamadaTool],
  fin: "herramientas",
  uso: { entrada: 0, salida: 0 },
})
const decir = (texto: string): Respuesta => ({ texto, llamadas: [], fin: "fin_turno", uso: { entrada: 0, salida: 0 } })

export class ProveedorSinModelo implements ProveedorLLM {
  readonly nombre = "sin-modelo"
  readonly modelo = "guion-determinista"

  async enviar(_sistema: string, mensajes: Mensaje[], _h: DefinicionTool[]): Promise<Respuesta> {
    const usuario = ultimo(mensajes, "user")
    const caso = casoDe(mensajes)
    if (!usuario) return decir("Escribe, por ejemplo: procesa la solicitud sol-001.")
    if (!caso) return decir("Modo sin modelo de lenguaje: indica un caso, por ejemplo \"procesa sol-004\". Configura ANTHROPIC_API_KEY para conversar libremente.")

    // Llamadas ya hechas en este turno (después del último mensaje del usuario).
    const desde = mensajes.lastIndexOf(usuario)
    const turno = mensajes.slice(desde + 1)
    const hechas = turno.flatMap((m) => (m.rol === "tool" ? m.resultados : []))
    const res = (n: string) => {
      const r = [...hechas].reverse().find((x) => x.nombre === n)
      return r ? (JSON.parse(r.contenido) as Resultado) : null
    }
    const confirma = !CASO.test(usuario.texto)

    if (!res("oc_validar")) return llamar("oc_validar", { caso })
    const v = res("oc_validar")!
    if (!v.ok) return decir(`No pude validar ${caso}: ${v.error}`)
    const d = v.data as { apta: boolean; bloqueos: Hallazgo[]; confirmaciones: Hallazgo[]; retroactiva: boolean }
    if (!d.apta) return decir(`**${caso} no se puede crear.**\n\n${d.bloqueos.map((b) => `- ${b.regla}: ${b.detalle}\n  → ${b.accion_sugerida}`).join("\n")}`)

    if (!res("oc_construir_payload")) return llamar("oc_construir_payload", { caso })
    if (d.confirmaciones.length > 0 && !confirma && !res("oc_crear")) {
      return decir(
        `**${caso} requiere tu confirmación antes de crear la OC:**\n\n${d.confirmaciones.map((c) => `- ${c.regla}: ${c.detalle}`).join("\n")}\n\n¿Confirmas que cree la OC? Responde "confirmo" para continuar.`,
      )
    }
    if (!res("oc_crear")) return llamar("oc_crear", { caso, confirmado: d.confirmaciones.length > 0 })
    const c = res("oc_crear")!
    if (!c.ok) return decir(`No se creó la OC de ${caso}: ${c.error}`)
    const o = c.data as { numero_oc: string; idempotente: boolean; evidencia?: string; retroactiva: boolean }
    return decir(
      `OC **${o.numero_oc}** ${o.idempotente ? "ya existía (no se creó otra)" : "creada"} para ${caso}.${o.evidencia ? ` Evidencia: ${o.evidencia}.` : ""}${o.retroactiva ? " Marcada **retroactiva** en el log de control." : ""}`,
    )
  }
}
