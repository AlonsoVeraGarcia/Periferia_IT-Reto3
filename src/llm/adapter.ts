/** Interfaz propia del proveedor LLM (PRD 6.1). El ciclo del agente solo conoce estos tipos. */
import type { DefinicionTool } from "../tools/registro.ts"

export type LlamadaTool = { id: string; nombre: string; args: unknown }

export type Mensaje =
  | { rol: "user"; texto: string }
  | { rol: "assistant"; texto: string; llamadas: LlamadaTool[]; crudo?: unknown }
  | { rol: "tool"; resultados: { id: string; nombre: string; contenido: string }[] }

export type Respuesta = {
  texto: string
  llamadas: LlamadaTool[]
  fin: "fin_turno" | "herramientas" | "limite_tokens"
  uso: { entrada: number; salida: number }
  /** Contenido original del proveedor (p. ej. bloques de razonamiento firmados) para reenviarlo tal cual. */
  crudo?: unknown
}

export interface ProveedorLLM {
  readonly nombre: string
  readonly modelo: string
  enviar(sistema: string, mensajes: Mensaje[], herramientas: DefinicionTool[]): Promise<Respuesta>
}

export class ErrorProveedor extends Error {}
