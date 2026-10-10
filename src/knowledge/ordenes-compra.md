## Proceso de órdenes de compra (Periferia IT Group)

**Entrada.** Cada compra llega a compras@ con tres piezas: solicitud (Excel), cotización del proveedor (PDF) y correo de aprobación del líder. En casos de desvío llega también la factura.

**Matriz de controles**

| Regla | Qué verifica | Tipo |
|---|---|---|
| RC1 | Proveedor existe en el maestro (por NIT; sin NIT, por nombre normalizado) y está activo | Bloqueo |
| RC2 | Hay aprobación, dice "Aprobado" y viene de un aprobador del centro de costo | Bloqueo |
| RC3 | Valor total ≤ tope del aprobador en ese centro | Bloqueo |
| RC4 | La subárea pertenece al centro de costo | Bloqueo |
| RC5 | Cotización vs solicitud: diferencia ≤ 2 %; sin cotización también requiere confirmación | Confirmación |
| RC6 | IVA ausente: se deriva del proveedor y se confirma | Confirmación + derivado |
| RC7 | Condiciones de pago ausentes: se derivan del proveedor | Derivado |
| RC8 | Factura con fecha anterior a la solicitud: OC retroactiva | Confirmación + marca |
| RC9 | Aprobación con fecha anterior a la solicitud | Confirmación |
| RC10 | cantidad × valor unitario = valor total (± 1) | Bloqueo |

**Criterios del payload SAP**

- Sociedad y organización de compras: 1000.
- Texto breve de la posición: máximo 40 caracteres (límite SAP).
- Precio unitario **neto, sin IVA**: los valores de solicitud y cotización vienen con IVA incluido; el indicador de IVA calcula el impuesto en SAP. Así se evita duplicar el IVA.
- Unidad: H si la compra es por horas, MES si es mensualidad, UN en otro caso.
- Si la cotización difiere de la solicitud, la OC se crea por el valor de la **solicitud**, que es el que aprobó el líder. Si el negocio quiere el valor cotizado, se necesita nueva aprobación por ese valor.

**OC retroactiva.** Cuando la factura llega antes que la OC, la compra se hizo sin control previo. El agente no la rechaza (la política la define la dirección), pero la marca `retroactiva = true` en `out/control.csv` para medir el desvío.

**Acciones sugeridas típicas**

- Proveedor inexistente: solicitar a Compras su creación en SAP (RUT, certificación bancaria).
- Aprobador sin atribución: pedir aprobación a un aprobador del centro con tope suficiente o escalar.
- Diferencia de valores: confirmar el valor de la solicitud o actualizar solicitud y aprobación.

**Códigos de referencia**: IVA C0 (0 %), C1 (19 %), C2 (5 %). Pago Z000 inmediato, Z015, Z030, Z060 (días fecha factura).
