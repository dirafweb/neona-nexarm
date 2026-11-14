# Nexarm — Arquitectura

Fecha: 2026-11-10. Se apoya en `GOBERNANZA-ISO.md` y `benchmark-sendpulse/BENCHMARK.md`.

## Tres decisiones de Eathan

1. Se construye desde cero.
2. El agente es el usuario principal del CRM.
3. Nexarm se vende con Nexarm: el mismo sistema lleva su propia venta.

## Principio: primero el agente

- Toda capacidad nace como herramienta MCP. La pantalla llama a esas mismas herramientas.
- El agente opera: crea contactos, mueve tratos, escribe, hace seguimiento.
- La persona supervisa: aprueba, audita, fija políticas, suspende.
- Ninguna acción entra al CRM sin pasar por la pasarela de gobernanza. Tampoco las de la pantalla.

## Piezas

| Pieza | Qué hace |
|---|---|
| Núcleo CRM | Contactos, empresas, tratos, embudos, actividades, tareas. Multiempresa, con aislamiento por cliente |
| Servidor MCP | Expone el núcleo como herramientas. Acceso con inicio de sesión por agente |
| Pasarela de gobernanza | Identificar, autorizar, evaluar política, aprobar, registrar |
| Libro de auditoría | Solo se agrega, nunca se edita. Cada entrada encadenada a la anterior con un hash |
| Motor de políticas | Límites por agente: monto, volumen, horario, tipo de dato |
| Bandeja de aprobaciones | Acciones de riesgo detenidas hasta que una persona decide |
| Consola de supervisión | Web para aprobar, auditar, configurar y suspender agentes |

## Agentes

- **Propios de Nexarm**: prospección, calificación, seguimiento, cierre asistido, soporte. Cada uno con identidad, rol y límites.
- **Del cliente**: su Claude, ChatGPT o Cursor conectado por MCP, bajo las mismas reglas.

## Nexarm se vende con Nexarm

- La empresa número cero del sistema es la propia Nexarm. Ahí vive su embudo de ventas.
- Los agentes de venta trabajan bajo las mismas políticas que se le venden al cliente.
- El libro de auditoría de esa venta es la demostración comercial: el prospecto ve su propio recorrido registrado.
- Esa operación produce la evidencia que piden las normas: requisitos del cliente (9001 8.2), registros de eventos (42001 A.6.2.8), control de acceso (27001 5.15).

## Tecnología recomendada

- TypeScript de extremo a extremo.
- PostgreSQL con seguridad por fila para aislar a cada cliente.
- Servidor MCP por HTTP con OAuth.
- Consola en Next.js.
- Modelo por API para los agentes propios: Anthropic u OpenAI, intercambiables porque la gobernanza vive en la pasarela.

## Fases

| Fase | Entrega | Estimado |
|---|---|---|
| 1 | Núcleo CRM + servidor MCP + libro de auditoría | Hecha el 2026-11-10, en `nexarm/` |
| 2 | Roles y permisos finos por agente, motor de políticas, ciclo de vida de credenciales | Hecha el 2026-11-10 |
| 3 | Aprobación forzada + consola de supervisión + inicio de sesión OAuth | Hecha el 2026-11-11. Consola en el mismo proceso; Next.js llega con PostgreSQL en servidor |
| 4 | Agentes de venta propios y empresa cero operando | Agentes hechos el 2026-11-11 y probados en vivo con OpenAI. Falta la entrada automática de prospectos |
| 5 | Reversión, suspensión y canales (correo, WhatsApp) | Hecha el 2026-11-11. Primer correo real enviado el 2026-11-14 por SMTP de Hostinger (`gerencia@neona.tech`), con aprobación en la consola. WhatsApp espera credenciales de Meta |
| 6 | Chatwoot como bandeja de entrada y salida de mensajes | Lado de Nexarm hecho el 2026-11-12 y probado contra un Chatwoot simulado. Instalado en local (PC XENTRIS, WSL) el 2026-11-13 y probado de ida y vuelta con una bandeja de pruebas. Falta el servidor publico y el buzon real |
| 7 | XENCRM como bandeja y tablero del equipo, y marca de Neona Tech en la consola | Hecho el 2026-11-13. Probado contra el XENCRM real de la PC XENTRIS (puerto 3000): la entrada funciona de punta a punta; la salida espera a que XENCRM conecte su WhatsApp |
| 8 | El modo agéntico de XENCRM (asistente con clientes, copiloto del equipo, voz y teléfono) bajo la pasarela | Hecho el 2026-11-13. Cada herramienta que pide el modelo de XENCRM se consulta antes en Nexarm (`POST /gobierno/xencrm`): queda en el libro y obedece políticas, permisos y el freno general. Probado contra los dos servicios reales de la PC XENTRIS con consultas del copiloto; falta una conversación con un modelo de verdad (XENCRM no tiene configurado un motor con herramientas) |

Los estimados suponen trabajo con agentes de código y una persona revisando a diario.

## Criterio de éxito de la fase 1

Un agente externo conectado por MCP crea un contacto y un trato, y ambas acciones aparecen
en el libro de auditoría con agente, usuario, herramienta, datos y hora.
