# Benchmark SendPulse — 2026-11-10

Fuente: 5 páginas de sendpulse.com/latam capturadas con Craft Anything v0.6.0 en modo Clean room
(solo lo que ve un visitante). Carpetas `capture-*`: captura de pantalla + `capture.json` con texto,
titulares, enlaces y diseño.

## Qué vende SendPulse hoy

| Frente | Lo que dice su sitio |
|---|---|
| Posicionamiento | "Plataforma de marketing por correo y chatbots impulsada por IA" |
| CRM | Gratis, 2 pipelines, tratos colaborativos, bandeja omnicanal (WhatsApp, Instagram, Messenger, Telegram, chat), llamadas y SMS, tableros de tareas |
| IA | Asistente integrado: redacta correos y sitios, arma flujos de chatbot, atiende chats (texto y voz), guarda contactos y tratos en el CRM |
| MCP | Servidor alojado en `mcp.sendpulse.com/mcp`. Clientes: Claude, OpenAI, Cursor, VS Code, Copilot, Cline, Devin. Cubre CRM, email, transaccionales, chatbots y cursos. 16 prompts listos |
| Precio email | Gratis 15.000 correos/mes. Standard US$9,60/mes y PRO US$11,52/mes (500 suscriptores, cobro anual). Enterprise desde 2.500 contactos |
| Prueba social | "+200 mil usuarios", "+6K reseñas", 4.6 |

## Gobernanza de IA: lo que sí dicen

- Inicio de sesión con la cuenta para autorizar el conector.
- El usuario elige qué herramientas activa.
- "Permisos de acceso flexibles" (una frase, sin detalle).
- El agente "pedirá aprobación en los pasos importantes". En sus ejemplos la aprobación la pide el prompt del usuario ("espera mi confirmación").
- Advierten: "es posible que tu agente de IA no siempre reconozca sus limitaciones".

## Gobernanza de IA: lo que no aparece en estas páginas

- Registro de auditoría de lo que hizo el agente.
- Roles o permisos por agente (qué agente puede tocar qué dato).
- Aprobación humana forzada por el sistema, no por el prompt.
- Políticas y límites (montos, volumen de envíos, datos sensibles).
- Reversión de acciones del agente.
- Cumplimiento y residencia de datos ligados a la IA.

Ausencia en 5 páginas de marketing no prueba que no exista en el producto. Se confirma abriendo
una cuenta gratis y leyendo la documentación del servidor MCP.

## Lectura para Nexarm

"CRM con IA conectado por MCP" ya no diferencia: SendPulse lo ofrece gratis.
La diferencia defendible es la gobernanza: SendPulse la deja en manos del prompt y del cliente de IA.

## Sin capturar

- Precios de CRM y chatbots (están tras pestañas de la página de precios).
- Documentación técnica del servidor MCP (lista de herramientas y permisos reales).
