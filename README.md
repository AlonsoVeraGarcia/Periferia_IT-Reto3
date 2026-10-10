# Reto 03 · Agente conversacional "Órdenes de Compra SAP"

El agente lee el paquete de una solicitud de compra, lo valida contra los maestros (RC1–RC10), arma la OC tal como quedaría en SAP, genera la evidencia de aprobación y crea la OC en un SAP simulado. Los bloqueos no se fuerzan y las dudas se convierten en confirmaciones humanas.

- **Link de prueba:** https://agente-oc-sap-m9pc.onrender.com
- **Clave de acceso al link:** se entrega por correo junto con este repositorio (el repositorio es público y la clave protege el crédito del modelo).
- El plan gratuito de Render se duerme tras 15 min sin uso: la primera carga puede tardar cerca de un minuto.

## Levantar en local (un comando)

Requisitos: Node 20+ (o Bun).

```bash
cp .env.example .env        # y pon tu ANTHROPIC_API_KEY
npm install && npm run dev  # http://localhost:3000
```

Con Bun: `bun install && bun run src/server.ts`.

Sin `ANTHROPIC_API_KEY` el servidor arranca igual con el proveedor **sin-modelo**: un guion determinista que recorre las mismas herramientas. Sirve para probar el front y la API, pero no conversa en lenguaje natural.

## Verificación sin modelo

```bash
bun install && bun run demo.ts     # o: npm install && npm run demo
```

Procesa los 6 casos llamando directamente a las herramientas. Muestra la idempotencia (sol-001 dos veces), la confirmación explícita de sol-004, la marca retroactiva de sol-005 y un caso inexistente con error legible. No necesita clave. Limpia `out/` al inicio.

## Variables de entorno

| Variable | Obligatoria | Uso |
|---|---|---|
| `ANTHROPIC_API_KEY` | Para usar el modelo | Solo en el backend. Nunca llega al front, a los logs ni a las respuestas. |
| `ANTHROPIC_MODEL` | No | Por defecto `claude-haiku-5-5`. |
| `LLM_PROVIDER` | No | `anthropic` o `sin-modelo`. |
| `MAX_ITERACIONES` | No | Tope de pasos herramienta → modelo por turno (25). |
| `MAX_TOKENS_SESION` | No | Tope de tokens por sesión (300 000). |
| `LLM_TIMEOUT_MS` | No | Timeout al proveedor (45 000). |
| `ACCESS_KEY` | No | Si se define, la API exige el header `x-access-key` (el front lo pide). |
| `OUT_DIR` | No | Carpeta de salida; por defecto `./out`. |

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, tokensSesion }` |
| `GET` | `/api/sessions/:id` | `{ id, eventos[], tokens, pendientes[] }` |
| `GET` | `/api/health` | `{ ok, provider, model, acceso_protegido }` (sin claves) |

## Salidas (`out/`)

| Archivo | Contenido |
|---|---|
| `out/sap/ordenes.jsonl` | OC creadas en el SAP simulado (desde 4500000001). |
| `out/control.csv` | Un registro por intento: creada, idempotente, bloqueada o pendiente. Incluye `retroactiva`. |
| `out/log.jsonl` | Cada llamada a herramienta. |
| `out/<caso>/payload.json`, `trazabilidad.json` | OC calculada y la fuente de cada campo. |
| `out/<caso>/aprobacion.txt`, `aprobacion.pdf` | Evidencia de aprobación con sha256. |
| `out/sessions/<id>.json` | Historial de cada sesión. |

## Despliegue (Render, plan gratuito)

1. Sube el repositorio a GitHub.
2. En Render: **New → Blueprint** y selecciona el repo (usa `render.yaml`).
3. Define `ANTHROPIC_API_KEY` (y opcionalmente `ACCESS_KEY`) en *Environment*.
4. Abre la URL. En el plan gratuito el servicio se duerme tras 15 min sin tráfico y tarda cerca de un minuto en despertar: ábrelo antes de la defensa.

## Estructura

```
agent/prompt.md                 comportamiento (system prompt)
src/knowledge/ordenes-compra.md conocimiento del proceso
src/tools/oc.ts                 ejecución: herramientas oc_*
src/tools/registro.ts           nombres, validación zod y JSON Schema para el modelo
src/core/                       reglas RC1–RC10, payload, evidencia, ciclo del agente, control
src/llm/                        adaptador de proveedor (anthropic, sin-modelo)
src/sap/                        interfaz SapAdapter + mock sobre archivos
web/index.html                  front de chat
modulo/                         bonus: agente empaquetado (generado con npm run modulo)
demo.ts                         verificación sin modelo
```

`npm run check` corre el typecheck y verifica que `modulo/` siga alineado con sus fuentes.
