# SOLUCIÓN · Reto 03 · Agente "Órdenes de Compra SAP"

## 1. Problema en una frase

La analista administrativa digita a mano cada OC en SAP y valida de memoria que el aprobador pueda aprobar ese monto en ese centro de costo. Eso le cuesta tiempo a ella, a Contabilidad le cuesta errores que aparecen en el cierre, y la dirección no sabe cuántas compras se hacen antes de tener OC.

## 2. Arquitectura

```
┌────────────────────┐  POST /api/chat   ┌──────────────────────────────────────────────┐
│ web/index.html     │ ────────────────▶ │ src/server.ts (HTTP, sesiones, acceso)       │
│ chat · tool calls  │ ◀──────────────── │   └─ src/core/agente.ts  (ciclo del agente)  │
│ banda "confirmar"  │                   │        ├─ src/llm/adapter.ts  ◀ anthropic.ts │
└────────────────────┘                   │        │                      ◀ sin-modelo.ts│
                                         │        └─ src/tools/registro.ts (zod)        │
                                         │             └─ src/tools/oc.ts  (oc_*)       │
                                         │                  ├─ src/core/reglas.ts RC1–10│
                                         │                  ├─ src/core/payload.ts      │
                                         │                  ├─ src/core/evidencia.ts    │
                                         │                  └─ src/sap/mock.ts (SapAdapter)
                                         └──────────┬─────────────────────┬─────────────┘
                                          fixtures/ (solo lectura)   out/ (escritura)
```

| Capa | Dónde vive | Qué cambia si cambia el negocio |
|---|---|---|
| **Comportamiento** | `agent/prompt.md` | Tono, flujo de conversación, cuándo preguntar. |
| **Conocimiento** | `src/knowledge/ordenes-compra.md` | Explicación del proceso y criterios. Se inyecta al prompt en cada turno, sin reiniciar. |
| **Ejecución** | `src/tools/oc.ts` + `src/core/` | Reglas y cálculos. El servidor no contiene lógica de negocio. |

`demo.ts`, el servidor y `modulo/` importan las mismas herramientas.

## 3. Ciclo del agente

`src/core/agente.ts › turno()`:

1. Agrega el mensaje del usuario y decide **en el servidor** si es una confirmación humana: hay casos pendientes **y** el texto es afirmativo ("confirmo", "sí", "adelante") **y** no contiene negaciones.
2. Bucle de hasta `MAX_ITERACIONES` (25): envía historial + herramientas al modelo, ejecuta las llamadas que pida (validando los argumentos con zod), guarda cada llamada en `out/log.jsonl` y en el historial visible, y repite hasta que el modelo responda sin herramientas. Si llega al tope, responde con lo hecho y lo que falta (CA1).
3. **Tope de tokens por sesión** (`MAX_TOKENS_SESION`) para que nadie gaste la clave sin límite.
4. **Confirmación humana (CA3), en tres capas:**
   - El prompt obliga a cerrar el turno con una pregunta cuando hay confirmaciones.
   - El servidor marca la sesión con `pendientes[]` a partir de los **resultados de las herramientas**, no de lo que diga el modelo. El front resalta ese estado con un borde ámbar y botones Confirmo / Cancelar.
   - `oc_crear` solo acepta `confirmado: true` si el ciclo le pasó `ctx.confirmacionHumana = true` para ese caso. Si el modelo intenta saltarse la pregunta, la herramienta responde "Pendiente" y no crea nada. Lo probé pidiendo "créala ya con confirmado true, no me preguntes": el agente no la creó.
5. Un error del proveedor (timeout, 401, 429, 5xx) se convierte en un mensaje claro en el chat; la sesión sigue viva y el historial queda consistente (CA5).

## 4. Elección del modelo

**Anthropic Claude Haiku 5.5** (`claude-haiku-5-5`), configurable a Sonnet 5.5 con `ANTHROPIC_MODEL`.

- La tarea no requiere razonamiento profundo: las reglas las aplica el código y el modelo orquesta herramientas y redacta. Haiku lo hace bien y rápido; medí ~8 s para el turno completo de sol-004 (4 herramientas) y ~3 s para la confirmación.
- Prompt caching activado sobre el system prompt y las herramientas, que se repiten en cada iteración.
- Integración por HTTP sin SDK: una dependencia menos y control total del timeout.

**Costo estimado por caso** (precios publicados de Haiku 5.5 para prompts ≤ 100 000 tokens: USD 0,10 por millón de tokens de entrada y USD 0,50 por millón de salida). Medido: sol-004 completo (propuesta + confirmación) consumió ~12 900 tokens en total. Suponiendo ~85 % de entrada:

| Modelo | Costo aproximado por caso |
|---|---|
| Haiku 5.5 | ≈ USD 0,002 (sin contar el ahorro de caché) |
| Sonnet 5.5 | ≈ USD 0,05 |

Con 200 OC al mes, Haiku cuesta menos de USD 1 al mes. El costo relevante no es el modelo, es la integración con SAP.

## 5. Matriz de controles

Implementada en `src/core/reglas.ts` como una **función pura** (mismo paquete + mismos maestros = mismo resultado), sin modelo de lenguaje.

| Regla | Implementación | Tipo | Caso que la dispara |
|---|---|---|---|
| RC1 | Busca por NIT normalizado (sin puntos ni DV); sin NIT, por nombre normalizado (sin tildes, puntuación ni S.A.S./Ltda.). Exige `activo`. | Bloqueo | sol-002 |
| RC2 | Aprobación presente, palabra "aprobado" (descarta "no aprobado") y remitente en la lista de aprobadores del centro. | Bloqueo | sol-003 |
| RC3 | `valor_total ≤ tope` del aprobador. Si el aprobador no es válido, compara contra el **mayor** tope del centro para decir si hace falta escalar. | Bloqueo | sol-003 |
| RC4 | Subárea ∈ subáreas del centro. | Bloqueo | — |
| RC5 | `|cotización − solicitud| / solicitud ≤ 2 %`; sin cotización también confirma. Devuelve ambos valores y el % de desvío. | Confirmación | sol-004 (6 %) |
| RC6 | IVA ausente → `indicador_iva_default` del proveedor como derivado + confirmación. IVA presente pero inexistente → bloqueo. | Confirmación | sol-006 |
| RC7 | Condiciones de pago ausentes → default del proveedor, solo informado. | Derivado | sol-006 |
| RC8 | `factura.fecha < fecha_solicitud` → `retroactiva = true`, confirmación y marca en `control.csv`. | Confirmación | sol-005 |
| RC9 | Fecha de aprobación (solo la fecha, sin hora) ≥ fecha de solicitud. | Confirmación | — |
| RC10 | `|cantidad × valor_unitario − valor_total| ≤ 1`. | Bloqueo | — |

**La más difícil fue RC5, por lo que no dice el PRD.** En sol-004 la cotización es de 26,5 M, pero el líder escribió "Aprobado **por 25 millones**". Confirmar la diferencia no puede significar comprar por 26,5 M, porque esa cifra nadie la aprobó. Decidí que la OC siempre se construye con el valor de la solicitud (el aprobado) y que la confirmación lo dice explícitamente: "si el negocio quiere el valor cotizado, hace falta nueva aprobación". El agente lo comunicó así en la prueba en vivo.

**Segunda decisión delicada: el IVA.** Las cotizaciones dicen "Precio unitario (IVA incl.)". En SAP el precio neto de la posición va sin IVA y el indicador calcula el impuesto. Si se pasa 95 000 con indicador C1, SAP cobraría IVA sobre un valor que ya lo incluye. El payload lleva el precio neto (`valor_unitario / (1 + tasa)`; 95 000 → 79 831,93) y la trazabilidad registra la derivación. El total con IVA se muestra aparte para que la analista lo compare con la cotización.

Otros criterios del payload: texto breve recortado a 40 caracteres en límite de palabra; unidad H si la descripción habla de horas, MES si es mensualidad (y no "vigencia de 12 meses"), UN en otro caso.

## 6. Diseño del adaptador SAP real

**Opción elegida: OData `API_PURCHASEORDER_PROCESS_SRV`** (o su sucesor `API_PURCHASEORDER_2` en S/4HANA Cloud), expuesta a través de **SAP Integration Suite / API Management** si existe, o del SAP Gateway directamente si no.

| Opción | Por qué sí / por qué no |
|---|---|
| OData Purchase Order API | ✅ API publicada y versionada por SAP, REST/JSON, valida igual que la transacción ME21N, devuelve mensajes estructurados. Funciona en S/4 on-premise y cloud. |
| RFC/BAPI `BAPI_PO_CREATE1` | Válida en ECC sin Gateway, pero exige conector RFC (SAP JCo / node-rfc con SDK propietario), red privada y manejo de `BAPI_TRANSACTION_COMMIT`. Es el plan si el cliente sigue en ECC. |
| Integration Suite (iFlow) | Recomendable como capa intermedia: credenciales, reintentos y monitoreo fuera del agente. Requiere licencia. |
| Carga por archivo | Plan B (abajo). |

**Mapeo del payload a la API OData (ejemplo de campos):**

| Payload 7.4 | `A_PurchaseOrder` / `A_PurchaseOrderItem` |
|---|---|
| `sociedad` | `CompanyCode` |
| `organizacion_compras` | `PurchasingOrganization` (+ `PurchasingGroup` por configuración) |
| `proveedor.codigo_sap` | `Supplier` |
| `moneda` | `DocumentCurrency` |
| `condiciones_pago` | `PaymentTerms` |
| `referencia.solicitud_id` | `CorrespncExternalReference` (o campo Z) → clave de idempotencia |
| `posiciones[].numero` | `PurchaseOrderItem` |
| `descripcion` | `PurchaseOrderItemText` |
| `cantidad`, `unidad` | `OrderQuantity`, `PurchaseOrderQuantityUnit` (H→`H`, UN→`EA`/`ST`, MES→`MON`, según la tabla de unidades del cliente) |
| `precio_unitario` | `NetPriceAmount` (neto, sin IVA) |
| `indicador_iva` | `TaxCode` |
| `centro_costo` | `to_AccountAssignment.CostCenter` con `AccountAssignmentCategory = K` |
| `subarea` | Según el modelo del cliente: centro de beneficio, orden interna o campo Z de imputación. **Supuesto a validar con el área SAP.** |
| `aprobador`, `evidencia` | Nota de cabecera + adjunto vía `API_CV_ATTACHMENT_SRV` (GOS) con el PDF de evidencia. |

**Autenticación y credenciales:** OAuth 2.0 client credentials (cloud) o usuario técnico de comunicación con certificado X.509 (on-premise). Las credenciales viven en un gestor de secretos (Azure Key Vault, AWS Secrets Manager o el destino de Integration Suite) y solo las lee el adaptador. Nunca están en el prompt, en el modelo ni en los logs. El usuario técnico tiene rol mínimo: crear OC y leer proveedores.

**Idempotencia y errores parciales:**
- Antes de crear, `buscarOrdenPorReferencia(solicitud_id)` consulta por la referencia externa. Si existe, devuelve el número (igual que el mock).
- Cada creación lleva un ID de correlación. Si hay timeout, **no se reintenta a ciegas**: primero se consulta por referencia y solo se reintenta si no existe.
- Si SAP crea la cabecera pero rechaza una posición, o falla el adjunto, el agente lo reporta como "creada con incidencias" con los mensajes de SAP y deja la fila en `control.csv` para revisión. No borra ni compensa automáticamente: en compras es más seguro que un humano decida.
- Los mensajes de error de SAP (`sap-message`) se traducen a lenguaje de negocio en el chat.

**Plan B si la conexión no es viable:** el agente sigue ahorrando el ~80 % del trabajo, que es validar, armar y documentar.
1. Genera un **archivo de carga masiva** (CSV/Excel con el layout del LSMW, la app Fiori *Migrate Your Data* o un programa Z) con las OC aprobadas del día. La analista lo sube una vez.
2. Genera una **ficha "lista para pegar"** por OC, en el orden de los campos de ME21N, con la evidencia PDF lista para adjuntar.
3. `control.csv` sigue midiendo retroactivas aunque la creación sea manual.

Para pasar al adaptador real se cambia la fábrica `usarAdaptadorSap()` en `src/tools/oc.ts`. Herramientas, reglas y prompt no cambian.

## 7. Lectura del proceso: OC retroactivas

**Lo que le diría a la dirección:** una OC retroactiva no es un problema de digitación, es un control que no está ocurriendo. Cuando la factura llega antes que la OC, la compra ya se comprometió sin verificar proveedor, presupuesto ni atribución de aprobación. La OC se convierte en un trámite para poder pagar ("ya llegó la factura, por favor crear la OC para poder radicarla", dice el correo de sol-005). En ese momento los controles RC1–RC4 ya no previenen nada: solo documentan.

El caso sol-005 lo muestra con fechas: cotización del 5 de agosto, factura del 10 y solicitud del 27. La compra se hizo 17 días antes de pedir la OC.

**Qué propondría:**
1. **Medir antes de prohibir.** El agente ya marca `retroactiva = true` en `control.csv`. Con un mes de datos se ve el porcentaje real, por área, proveedor y aprobador. Sin esa línea base, cualquier política es opinión.
2. **Política "sin OC no hay pago" (no PO, no pay) gradual:** primer trimestre, retroactivas permitidas pero con justificación obligatoria y aprobación del nivel superior; después, la factura sin OC previa se devuelve al proveedor, con excepciones definidas (urgencias operativas, servicios públicos).
3. **Quitar la fricción que causa el desvío.** La gente compra primero porque crear la OC es lento. Con el agente, una OC limpia sale en minutos; esa es la razón para pedir que la OC sea previa.
4. **Comunicar a proveedores** que facturas sin número de OC no se radican. Es el control más efectivo y el más barato.
5. **Indicador mensual:** % de OC retroactivas sobre el total y monto comprometido sin OC. Meta sugerida: bajar a menos del 5 % en seis meses.

La decisión de tolerar o rechazar es de la dirección (pregunta abierta del PRD). El agente no la toma: la mide.

## 8. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | Las herramientas **releen el caso desde el disco**; `paquete` y `derivados` son opcionales en los argumentos. | Confiar en el paquete que el modelo reenvía. | El modelo podría alterar un monto al reenviarlo. El disco es la fuente de verdad y además se ahorran tokens. Si el modelo manda `payload` a `oc_crear`, se compara con el recalculado y se rechaza si difiere. |
| 2 | Confirmación verificada **en el servidor** (`ctx.confirmacionHumana`). | Confiar solo en el prompt. | Un prompt se puede saltar. Lo probé y el bypass falla. |
| 3 | Parsers deterministas (regex) para cotización y factura. | Que el modelo lea el texto y extraiga montos. | Los montos alimentan RC5 y RC8; deben ser reproducibles. El texto completo de la cotización ni siquiera se envía al modelo. |
| 4 | Precio neto sin IVA en el payload. | Copiar `valor_unitario` tal cual. | Evita duplicar el IVA en SAP. Se documenta como supuesto. |
| 5 | Servidor Node propio (`node:http`) en Render. | Netlify Functions. | El ciclo necesita sesiones con estado (confirmación pendiente) y un proceso vivo; en serverless cada llamada puede caer en otra instancia y la confirmación se perdería. |
| 6 | HTTP directo a la API de Anthropic. | SDK oficial. | Menos dependencias y timeout explícito. Coste: mantener el formato a mano. |
| 7 | Proveedor de respaldo `sin-modelo`. | Que el link falle sin clave. | Demuestra que cambiar de proveedor no toca el ciclo y mantiene el demo vivo. |

## 9. Supuestos

1. **Rúbrica:** el PRD remite a "la rúbrica de la sección 10", pero esa sección contiene riesgos y supuestos, no una rúbrica. Trabajé con el supuesto de que se evalúan por igual los componentes obligatorios de la sección 6 (front, ciclo, herramientas, adaptador, prompt), los criterios de aceptación de las HU, `demo.ts` y la estructura de `SOLUCION.md` de la sección 9.1, y que el bonus suma hasta 10 puntos.
2. Los valores de solicitud y cotización incluyen IVA (lo dice la cotización: "IVA incl.").
3. La OC se crea por el valor de la solicitud, que es el aprobado, aunque la cotización difiera.
4. Para RC9 se compara solo la fecha calendario de la aprobación, no la hora.
5. Si el aprobador no pertenece al centro, RC3 se evalúa contra el mayor tope del centro, para indicar si se puede aprobar o hay que escalar.
6. "Aprobado" se reconoce como palabra (aprobado/aprobada); "no aprobado" no cuenta.
7. Los maestros de los fixtures están completos (supuesto del PRD).
8. La numeración del SAP simulado es por proceso; en producción la asigna SAP.
9. La creación de OC se serializa en el proceso para que dos sesiones no generen el mismo número.

## 10. Cobertura

| Historia | Estado | Qué falta para producción |
|---|---|---|
| HU-1 Leer el paquete | Hecho | Leer `.xlsx` y PDF binarios reales (P1, no hecho) y el correo desde Exchange/Graph. |
| HU-2 Validar contra maestros | Hecho (RC1–RC10) | Maestros en vivo desde SAP; presupuesto disponible del centro. |
| HU-3 Construir payload | Hecho, con trazabilidad por campo | Mapeo de subárea y unidades al modelo del cliente. |
| HU-4 Evidencia | Hecho: P0 txt + P1 PDF con sha256 | Adjuntar en SAP (GOS) y, si Auditoría lo exige, firma digital. |
| HU-5 Crear OC | Hecho: idempotente, `control.csv`, numeración desde 4500000001 | Adaptador real (§6). |
| HU-6 Errores | Hecho: `{ ok:false, error }` legible, caso inexistente, JSON malformado, montos no numéricos | Alertas operativas. |
| Front, API, ciclo, adaptador LLM | Hecho | Autenticación real (SSO) y roles. |
| Bonus `modulo/` | Hecho: prompt y skill generados desde las fuentes; herramientas por re-export (`npm run check` verifica que no diverjan) | — |
| `oc_leer_excel` (P1) | No hecho | — |

## 11. Uso de IA

- **Claude (Anthropic)**, en conversación, como asistente de desarrollo: lectura comparada de los tres PRDs para elegir el reto, generación del código TypeScript, del front y de la documentación, bajo mi dirección y revisión.
- **Claude Haiku 5.5** es además el modelo que usa el agente en ejecución.
- **Lo que descarté de lo propuesto o considerado:**
  - Desplegar en Netlify Functions: el estado de sesión no sobrevive entre invocaciones.
  - Dejar que el modelo extraiga los montos de la cotización: no es determinista.
  - Confiar la confirmación humana solo al prompt: lo reemplacé por una verificación en el servidor.
  - Construir la OC con el valor cotizado en sol-004: contradice la aprobación de "25 millones".

## 12. Riesgos de producción y mitigación

| Riesgo | Mitigación |
|---|---|
| La integración con SAP no es viable a corto plazo | Plan B de carga masiva y ficha lista para pegar (§6). |
| El modelo "arregla" un monto o inventa un dato | Los valores salen solo de herramientas; `oc_crear` recalcula y rechaza payloads alterados. |
| Confirmación implícita o malinterpretada | Verificación en el servidor por caso; una negación cancela los pendientes. |
| Doble creación por reintentos | Idempotencia por `solicitud_id` + consulta previa en SAP + creación serializada. |
| Aprobaciones por correo falsificables | Validar remitente contra el directorio (DKIM/SPF) o migrar a aprobación en flujo con firma. |
| Costo descontrolado del modelo | Topes de iteraciones y de tokens por sesión, `ACCESS_KEY`, Haiku por defecto y caché de prompt. |
| Datos sensibles en logs | Los logs guardan argumentos y resúmenes, no claves. En producción: retención definida y enmascarar NIT/cuentas. |
| Disco efímero en el hosting gratuito | En producción, persistencia real (base de datos o almacenamiento de objetos) para sesiones, log y control. |
| Concurrencia entre instancias | El candado actual es por proceso; con varias instancias, la idempotencia debe resolverla SAP (referencia única) o un lock distribuido. |
