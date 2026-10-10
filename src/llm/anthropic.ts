/** Implementación Anthropic (Claude) vía HTTP, sin SDK. La clave solo se lee de ANTHROPIC_API_KEY en el backend. */
import type { DefinicionTool } from "../tools/registro.ts"
import { ErrorProveedor, type Mensaje, type ProveedorLLM, type Respuesta } from "./adapter.ts"

type Bloque =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string }

type RespuestaApi = {
  content: Bloque[]
  stop_reason: string
  usage: { input_tokens: number; output_tokens: number }
}

function aApi(mensajes: Mensaje[]) {
  return mensajes.map((m) => {
    if (m.rol === "user") return { role: "user", content: m.texto }
    if (m.rol === "tool")
      return { role: "user", content: m.resultados.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.contenido })) }
    if (Array.isArray(m.crudo)) return { role: "assistant", content: m.crudo }
    const bloques: Bloque[] = []
    if (m.texto) bloques.push({ type: "text", text: m.texto })
    for (const l of m.llamadas) bloques.push({ type: "tool_use", id: l.id, name: l.nombre, input: l.args ?? {} })
    return { role: "assistant", content: bloques }
  })
}

export class ProveedorAnthropic implements ProveedorLLM {
  readonly nombre = "anthropic"
  constructor(
    private readonly clave: string,
    readonly modelo: string,
    private readonly timeoutMs: number,
    private readonly maxTokens: number,
  ) {}

  async enviar(sistema: string, mensajes: Mensaje[], herramientas: DefinicionTool[]): Promise<Respuesta> {
    const control = new AbortController()
    const timer = setTimeout(() => control.abort(), this.timeoutMs)
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: control.signal,
        headers: { "content-type": "application/json", "x-api-key": this.clave, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: this.modelo,
          max_tokens: this.maxTokens,
          // Prompt caching del system prompt y las herramientas: baja el costo de cada iteración del ciclo.
          system: [{ type: "text", text: sistema, cache_control: { type: "ephemeral" } }],
          tools: herramientas.map((h, i) => ({
            name: h.nombre,
            description: h.descripcion,
            input_schema: h.esquema,
            ...(i === herramientas.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
          })),
          messages: aApi(mensajes),
        }),
      })
      if (!res.ok) {
        const cuerpo = await res.text()
        const motivo =
          res.status === 401 ? "clave de API inválida" : res.status === 429 ? "límite de uso del proveedor alcanzado" : res.status >= 500 ? "el proveedor no está disponible" : "solicitud rechazada"
        // No se reenvía el cuerpo completo al usuario: puede traer detalles internos.
        console.error(`[anthropic] ${res.status}: ${cuerpo.slice(0, 300)}`)
        throw new ErrorProveedor(`El modelo no respondió (${res.status}: ${motivo}).`)
      }
      const data = (await res.json()) as RespuestaApi
      const texto = data.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n")
      const llamadas = data.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, nombre: b.name, args: b.input }] : []))
      return {
        texto,
        llamadas,
        fin: data.stop_reason === "tool_use" ? "herramientas" : data.stop_reason === "max_tokens" ? "limite_tokens" : "fin_turno",
        uso: { entrada: data.usage.input_tokens, salida: data.usage.output_tokens },
        crudo: data.content,
      }
    } catch (e) {
      if (e instanceof ErrorProveedor) throw e
      if ((e as Error).name === "AbortError") throw new ErrorProveedor(`El modelo no respondió en ${this.timeoutMs / 1000} s. Intenta de nuevo.`)
      throw new ErrorProveedor(`No se pudo contactar al modelo: ${(e as Error).message}`)
    } finally {
      clearTimeout(timer)
    }
  }
}
