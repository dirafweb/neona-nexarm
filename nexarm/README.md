# Nexarm

CRM operado por agentes de IA a través de MCP, con gobernanza basada en ISO 9001, 27001 y 42001.
Contexto en `../ARQUITECTURA.md` y `../GOBERNANZA-ISO.md`.

## Uso

```sh
pnpm install
pnpm seed      # crea lo que falte del cliente cero (Nexarm): supervisor, embudo y agentes; credenciales en .tokens.local.json
pnpm start     # consola en http://127.0.0.1:8787 y servidor MCP en http://127.0.0.1:8787/mcp
pnpm libro     # imprime el libro de auditoria y verifica su cadena; con el servidor detenido (con el arrancado, usa la consola)
pnpm agente prospeccion "Nuevo prospecto: ..."   # un agente de venta trabaja un encargo
pnpm test      # comprobaciones de las fases 1 a 7
```

Un agente se identifica de dos formas:

- Token fijo: `Authorization: Bearer <token>`.
- OAuth 2.1 con PKCE: el cliente MCP se conecta sin credencial, el servidor le indica donde pedirla,
  y una persona con sesion en la consola elige con que agente actua ese cliente.

La consola pide el usuario y la clave que `pnpm seed` deja en `.tokens.local.json`. `pnpm seed` no rota credenciales:
solo crea lo que falta. Corre con el servidor detenido, porque la base admite un solo proceso.
Si el servidor se publica en otra direccion, se indica con `NEXARM_URL`.

## Como esta hecho

- `src/gateway.ts`: unica puerta de entrada. Identifica al agente, autoriza, evalua politicas, ejecuta y registra.
- `src/policies.ts`: motor de politicas.
- `src/tools.ts`: las herramientas del CRM. Cada una declara el rol minimo que la puede usar.
- `src/audit.ts`: libro de auditoria de solo agregar, con cadena de hashes por cliente.
- `src/schema.sql`: tablas, aislamiento por cliente con seguridad por fila y bloqueo de edicion del libro.
- `src/server.ts`: servidor MCP por HTTP.
- `src/console.ts`: consola de supervision. Aprobar, rechazar, suspender, detener todo, revertir y leer el libro.
- `src/channels.ts`: canales de envio (correo y WhatsApp), directos o por Chatwoot.
- `src/chatwoot.ts`: entrada de los mensajes que llegan a Chatwoot.
- `src/xencrm.ts`: entrada de los mensajes que escribe un cliente en XENCRM y puerta de gobierno de su modo agentico.
- `src/brand.ts`: identidad de Neona Tech en la consola (colores, tipografia y simbolo de su manual de marca).
- `src/humans.ts`: inicio de sesion de personas.
- `src/oauth.ts`: servidor de autorizacion OAuth para clientes MCP.
- `src/sales/agents.ts`: los agentes de venta propios: trabajo, herramientas y prompt de cada uno.
- `src/sales/run.ts`: corre un agente con un modelo de Anthropic o de OpenAI. El agente solo llama herramientas MCP con su credencial.

## Gobernanza

Cada llamada pasa por la pasarela en este orden: identificar, autorizar, validar, evaluar politicas,
esperar a una persona si hace falta, ejecutar, registrar.

| Control | Como se usa |
|---|---|
| Rol | `lector` busca y lista; `operador` ademas escribe; `admin` ademas lee el libro y administra |
| Permiso fino | `agent_grant_set` permite o deniega una herramienta a un agente por encima de su rol |
| Monto maximo | `policy_set` tipo `monto_maximo` con `{campo, maximo}` |
| Frecuencia | tipo `limite_frecuencia` con `{maximo, ventana_minutos}` |
| Horario | tipo `horario` con `{zona, dias, desde, hasta}`; 0 es domingo |
| Campos restringidos | tipo `campos_restringidos` con `{campos}`: el agente no los escribe ni los ve, y el libro no los guarda |
| Credenciales | `agent_create`, `agent_rotate_token`, `agent_suspend`; el token se muestra una sola vez y puede vencer |
| Aprobacion humana | tipo `requiere_aprobacion` con `{campo, desde, vence_horas}`; sin `desde`, siempre |

Una politica sin `agent_id` aplica a todos los agentes, y sin `tool` a todas las herramientas.
Por defecto alcanza solo a las herramientas que escriben; `applies_to: "todas"` incluye las de lectura.

Las herramientas de administracion (`agent_*`, `policy_*`) quedan fuera del motor de politicas,
para que una politica nunca impida corregirla. Siempre quedan en el libro.
Un agente no cambia sus propios permisos ni se suspende a si mismo.

### Aprobacion humana

- La pasarela detiene la llamada: el agente recibe `pendiente` con un `approvalId` y nada cambia en el CRM.
- Solo una persona con rol `supervisor` decide, en la consola. No existe herramienta MCP para aprobar.
- Al aprobar, la llamada se ejecuta como el agente que la pidio. Al rechazar, el agente recibe la nota.
- Sin decision, la solicitud vence (24 horas por defecto).
- El agente consulta el estado con `approval_status`.
- Un bloqueo gana a una aprobacion: lo que otra politica prohibe no llega a la persona.
- El libro guarda la solicitud, la decision con el nombre de la persona y la ejecucion.

Un agente `admin` propone los cambios de gobierno y una persona los aprueba: crear agentes, rotar tokens,
reactivar, cambiar permisos y politicas. Suspender es inmediato. El token de un agente nuevo lo ve solo
la persona, una vez, en la consola. Se apaga por cliente con `tenants.governance_approval`.

## Reversion y freno general

- **Revertir.** En el libro de la consola, cada accion de un agente que se puede deshacer tiene un boton Revertir:
  crear o actualizar un contacto, crear una empresa, crear o mover un trato y registrar una actividad.
- Las acciones sobre un mismo registro se revierten de la mas reciente a la mas antigua.
- Un registro del que dependen otros no se borra: primero se revierten los que dependen de el.
- La reversion es una entrada nueva del libro con el nombre de la persona. La entrada original no cambia.
- No se revierten los mensajes enviados ni los cambios de gobierno, que ya pasan por aprobacion.
- **Detener todos los agentes.** Un boton de la consola frena al instante a cada agente del cliente, hasta reanudar.

## Canales

`message_send` envia un mensaje a un contacto por correo o WhatsApp y lo deja en su historial.

- El destino sale de la ficha del contacto: el agente no escribe direcciones.
- Con las politicas de arranque, cada mensaje espera la aprobacion de una persona y hay un tope de 20 al dia por agente.
- Un contacto marcado `do_not_contact` no recibe nada, aunque una persona apruebe.
- Si el proveedor falla, no queda actividad de un envio que no ocurrio.

| Canal | Variables de entorno |
|---|---|
| Correo por SMTP | `NEXARM_CORREO_REMITENTE`, `NEXARM_SMTP_HOST`, `NEXARM_SMTP_PORT`, `NEXARM_SMTP_USER`, `NEXARM_SMTP_PASS` |
| Correo por Resend | `NEXARM_CORREO_REMITENTE`, `RESEND_API_KEY` |
| WhatsApp (API de la nube de Meta) | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_API_VERSION` |

Un canal sin sus variables no existe: enviar por el devuelve un error con la causa. La consola muestra los canales activos.

## Chatwoot

Chatwoot es la bandeja de mensajes; Nexarm gobierna lo que hacen los agentes. La instalacion y los pasos de conexion
estan en `../chatwoot/README.md`.

- **Sale.** Con `CHATWOOT_URL`, `CHATWOOT_TOKEN`, `CHATWOOT_ACCOUNT_ID` y una bandeja por canal (`CHATWOOT_INBOX_CORREO`,
  `CHATWOOT_INBOX_WHATSAPP`), `message_send` escribe en la conversacion abierta del contacto en esa bandeja, o abre una.
  Un canal con bandeja sale por Chatwoot y no por el proveedor directo.
- **Entra.** Chatwoot entrega cada mensaje de un contacto en `POST /chatwoot/webhook`, firmado con `CHATWOOT_WEBHOOK_SECRET`.
  Una entrega mal firmada o con mas de cinco minutos no entra. La entrega pasa por la pasarela como una llamada de
  `message_receive` del agente `entrada-chatwoot`: busca al contacto por correo o telefono, lo crea si es nuevo y deja
  el mensaje en su historial. La misma entrega no se registra dos veces.
- `entrada-chatwoot` solo puede usar `message_receive`, y los agentes de venta no pueden usarla.
- El boton de detener todos los agentes tambien frena la entrada: el mensaje sigue en Chatwoot y no entra a Nexarm.

## XENCRM

XENCRM es la bandeja y el tablero del equipo (WhatsApp, chat web, tickets, citas); Nexarm gobierna lo que hacen los agentes.
El puente usa la API del tablero de XENCRM y no cambia su codigo.

| Variable | Valor |
|---|---|
| `XENCRM_URL` | Direccion del tablero del negocio, sin `/admin`: `http://127.0.0.1:3000` o `https://host/c/<cliente>` |
| `XENCRM_ADMIN_TOKEN` | El token de administracion de ese negocio en XENCRM |
| `NEXARM_XENCRM_TENANT` | Cliente de Nexarm que recibe. Por defecto `Nexarm` |

- **Entra.** Nexarm escucha el flujo en vivo de XENCRM. Cada mensaje que escribe un cliente pasa por la pasarela como
  una llamada de `message_receive` del agente `entrada-xencrm`. Lo que responde el asistente de XENCRM o su equipo no entra.
- Entra quien tiene telefono (WhatsApp) o dejo su correo en la ficha. Un visitante del chat sin datos se queda en XENCRM.
- **Sale.** Con las dos variables, `message_send` por WhatsApp escribe en la conversacion del contacto en XENCRM, firmado Nexarm.
  XENCRM solo escribe a quien ya le escribio, y al responder pausa a su asistente en esa conversacion.
- Si la conexion se cae, la entrada vuelve sola. Lo escrito durante la caida queda solo en XENCRM.
- `entrada-xencrm` solo puede usar `message_receive`. El boton de detener todos los agentes tambien frena esta entrada.
- Tras configurar, ejecuta `pnpm seed` con el servidor detenido: crea el agente `entrada-xencrm`.

### El modo agentico de XENCRM bajo la pasarela

XENCRM tiene agentes propios: el asistente que atiende clientes (texto, voz y telefono) y el copiloto del equipo.
Antes de ejecutar cada herramienta que pide su modelo, XENCRM pregunta a Nexarm en `POST /gobierno/xencrm`.

| En el `.env` de XENCRM | Para que |
|---|---|
| `NEXARM_GOBIERNO_URL` | Direccion de Nexarm: `http://127.0.0.1:8787` |
| `NEXARM_GOBIERNO_TOKEN` | Token del agente `agentico-xencrm` (lo crea `pnpm seed`, queda en `.tokens.local.json`) |

- Una consulta entra como `xencrm_read`; una accion segura o propuesta, como `xencrm_act`. Las dos quedan en el libro
  con el lado (cliente o equipo), la herramienta, sus datos, quien la pidio y para que contacto.
- XENCRM ejecuta solo si la pasarela responde `ejecutado`. Denegada, pendiente o sin respuesta de Nexarm: no se hace,
  y el modelo recibe el motivo.
- Obedece lo mismo que cualquier agente: suspension, permisos finos, politicas (frecuencia, horario) y el boton de detener.
- Con una politica `requiere_aprobacion` sobre `xencrm_act`, una accion propuesta espera en la consola; al aprobarla,
  Nexarm ejecuta en XENCRM la ruta del tablero que la hace. Una accion segura no trae ruta: para esas usa politicas de
  bloqueo o de frecuencia.
- `agentico-xencrm` solo puede usar `xencrm_read` y `xencrm_act`.
- En XENCRM: `src/agentico/gobierno.ts` y una llamada en `src/agentico/nucleo.ts`. Sin las dos variables no hace nada.

## Marca

La consola usa la identidad de Neona Tech segun `https://neona.tech/marca`: azul profundo `#0A2A5E`, gris antracita `#2E3440`,
cian `#00A3E0` como acento y verde esmeralda `#00B386` solo como enfasis. Sora en titulares, IBM Plex Sans en el cuerpo e
IBM Plex Mono en las etiquetas `// 0N · NOMBRE`. Todo vive en `src/brand.ts`.

## Agentes de venta propios

Nexarm se vende con Nexarm: tres agentes trabajan el embudo del cliente cero bajo las mismas reglas que se le venden al cliente.

| Agente | Trabajo |
|---|---|
| `prospeccion` | Convierte un prospecto en empresa, contacto y trato, sin duplicar |
| `calificacion` | Evalua cada trato con cuatro preguntas y mueve a Calificado los que las responden |
| `seguimiento` | Lee el historial de los tratos abiertos y envia el siguiente mensaje, con aprobacion de una persona |

```sh
pnpm agente prospeccion "Nuevo prospecto: Laura Gomez, de Acme, laura@acme.test. Quiere una demo."
pnpm agente calificacion        # sin encargo, hace su tarea habitual
pnpm agente seguimiento
```

- Necesita el servidor arrancado y una clave de modelo en el entorno: `ANTHROPIC_API_KEY` (modelo `claude-opus-5-5`)
  o `OPENAI_API_KEY` (modelo `gpt-5.5`, o el que indique `OPENAI_MODEL`). Con las dos, manda `NEXARM_PROVEEDOR`.
- La gobernanza no depende del modelo: vive en la pasarela, asi que las reglas son las mismas con cualquier proveedor.
- Cada agente ve solo las herramientas de su trabajo, y la pasarela le deniega el resto con permisos finos.
- Politicas de arranque: un trato desde 10.000 espera aprobacion humana; 60 escrituras por hora por agente.
- El agente recibe `denegado` o `pendiente`, no busca otro camino y lo dice en su informe.
- El texto de un prospecto se trata como dato, no como instruccion.
- El encargo y los datos del CRM que el agente lee viajan a la API del proveedor del modelo.

## Limites actuales

- La consola y el servidor MCP viven en un mismo proceso, porque PGlite admite uno solo.
  La consola en Next.js llega con el paso a un servidor PostgreSQL.
- La consola aprueba, rechaza y suspende. Las politicas se crean por MCP y se aprueban en la consola.
- Una sola persona puede pedir (a traves de su agente) y aprobar. Falta exigir un segundo supervisor.
- Clave de consola sin segundo factor. Cinco fallos bloquean 15 minutos.
- Registro de clientes OAuth abierto; lo que protege es el consentimiento de una persona.
- Los agentes de venta corren a mano, un encargo por vez. Falta la entrada automatica de prospectos y un horario.
- La conexion con Chatwoot esta probada contra un Chatwoot simulado, no contra uno instalado.
- Un mensaje que entra no despierta a ningun agente: los agentes de venta lo leen en su siguiente corrida.
- Lo que una persona responde desde Chatwoot no entra al historial de Nexarm.
- La entrada cuenta en el limite de escritura por agente (60 por hora con las politicas de arranque).
- WhatsApp envia texto libre, que Meta solo entrega dentro de las 24 horas tras el ultimo mensaje del contacto. Faltan plantillas.
- Un agente mueve un trato a Ganado o Perdido sin aprobacion humana.
- Base PGlite en `data/pg`. El esquema es PostgreSQL estandar.
- El servidor escucha solo en 127.0.0.1.
- El libro guarda los argumentos de cada llamada, datos personales incluidos, salvo los campos restringidos.
