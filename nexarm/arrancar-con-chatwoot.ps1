# Arranca Nexarm conectado al Chatwoot local. Lee la conexion de .chatwoot.local.json.
# Uso: powershell -File arrancar-con-chatwoot.ps1 [-Sembrar]
param([switch]$Sembrar)
Set-Location $PSScriptRoot
$c = Get-Content .chatwoot.local.json -Raw | ConvertFrom-Json
$winIp = ([uri]$c.webhook_url).Host
$env:CHATWOOT_URL = $c.url
$env:CHATWOOT_TOKEN = $c.token
$env:CHATWOOT_ACCOUNT_ID = "$($c.account_id)"
$env:CHATWOOT_WEBHOOK_SECRET = $c.webhook_secret
# El correo sale por la bandeja de pruebas: se ve en Chatwoot y no llega a un buzon real.
$env:CHATWOOT_INBOX_CORREO = "$($c.inbox_pruebas)"
$env:NEXARM_HOST = "127.0.0.1,$winIp"
# XENCRM: si existe .xencrm.local.json, entra lo que escriben sus clientes y WhatsApp sale por sus conversaciones.
if (Test-Path .xencrm.local.json) {
  $x = Get-Content .xencrm.local.json -Raw | ConvertFrom-Json
  $env:XENCRM_URL = $x.url
  $env:XENCRM_ADMIN_TOKEN = $x.admin_token
}
if ($Sembrar) { pnpm seed }
pnpm start
