# Chatwoot para Nexarm

Chatwoot es la bandeja de entrada y salida de mensajes (correo, WhatsApp, chat web). Nexarm decide que hace cada agente,
exige la aprobacion de una persona y lo registra. Chatwoot es de codigo abierto con licencia MIT; su carpeta `enterprise/`
tiene licencia comercial y esta instalacion no la activa.

## Requisitos del servidor

- Ubuntu con Docker, 2 CPU y 4 GB de memoria libres para Chatwoot.
- Un dominio apuntando al servidor, por ejemplo `chat.neona.tech`, con los puertos 80 y 443 abiertos.

## Instalar

```bash
bash instalar.sh chat.neona.tech
```

Genera los secretos en `.env`, prepara la base y arranca Chatwoot con HTTPS.

## Conectar con Nexarm

1. En Chatwoot crea la cuenta de administracion y anota el numero de cuenta (aparece en la direccion: `/app/accounts/1`).
2. Crea las bandejas: una de correo con `gerencia@neona.tech` (IMAP `imap.hostinger.com:993`, SMTP `smtp.hostinger.com:465`)
   y, cuando haya numero, una de WhatsApp. Anota el numero de cada bandeja.
3. En Perfil copia el token de acceso.
4. En Ajustes, Integraciones, Webhooks crea uno hacia `https://<direccion publica de Nexarm>/chatwoot/webhook`
   con el evento `message_created`, y copia su secreto.
5. En el servidor de Nexarm define estas variables y reinicia:

| Variable | Valor |
|---|---|
| `CHATWOOT_URL` | `https://chat.neona.tech` |
| `CHATWOOT_TOKEN` | token de acceso del paso 3 |
| `CHATWOOT_ACCOUNT_ID` | numero de cuenta del paso 1 |
| `CHATWOOT_INBOX_CORREO` | numero de la bandeja de correo |
| `CHATWOOT_INBOX_WHATSAPP` | numero de la bandeja de WhatsApp |
| `CHATWOOT_WEBHOOK_SECRET` | secreto del webhook del paso 4 |

6. En Nexarm ejecuta `pnpm seed` con el servidor detenido: crea el agente `entrada-chatwoot`.

## Que hace cada lado

- **Sale:** `message_send` de Nexarm, despues de la aprobacion de una persona, escribe en la conversacion del contacto
  en Chatwoot y Chatwoot lo entrega por el canal de la bandeja.
- **Entra:** cada mensaje que escribe un contacto llega firmado a `/chatwoot/webhook`. Nexarm verifica la firma, busca al
  contacto por correo o telefono, lo crea si es nuevo y deja el mensaje en su historial, a nombre de `entrada-chatwoot`.

Chatwoot necesita alcanzar a Nexarm por una direccion publica con HTTPS: un Nexarm que solo escucha en `127.0.0.1`
envia por Chatwoot pero no recibe.

## En local (misma PC que Nexarm, sin dominio)

Instalado el 2026-11-13 en la PC XENTRIS dentro de Ubuntu 24.04 (WSL 2) con Docker.

1. Encender Chatwoot: `powershell -File encender-local.ps1`. Abre en `http://localhost:3010`.
2. Encender Nexarm conectado: `powershell -File ..\nexarm\arrancar-con-chatwoot.ps1`.
3. Detener Nexarm: `pnpm detener` en `nexarm/`. Cierra la base antes de salir.
4. Probar ida y vuelta: `pnpm exec tsx test/chatwoot-real.ts` en `nexarm/`.

- Instalar desde cero: `bash instalar-local.sh` y luego `bash conectar-local.sh <correo>` dentro de Ubuntu.
- La conexion (direccion, token, secreto y clave de entrada a Chatwoot) queda en `nexarm/.chatwoot.local.json`.
- La bandeja "Pruebas Nexarm" no entrega a buzones reales: el mensaje se ve en Chatwoot y ahi termina.
- El Chatwoot local corre con `SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true` para que el webhook llegue a Nexarm por una
  direccion privada. En un servidor publico ese ajuste no se usa.
- La direccion de Windows vista desde Ubuntu cambia al reiniciar la PC: repetir `conectar-local.sh` actualiza el webhook.
