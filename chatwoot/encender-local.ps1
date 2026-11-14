# Enciende el Chatwoot local y lo mantiene encendido. Uso: powershell -File encender-local.ps1
# Ubuntu (WSL) se apaga solo cuando nadie lo usa; este proceso oculto lo mantiene despierto hasta cerrar sesion o reiniciar.
$vivo = Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" | Where-Object { $_.CommandLine -like '*sleep infinity*' }
if (-not $vivo) {
  Start-Process wsl -ArgumentList '-d','Ubuntu-24.04','-u','root','--exec','sleep','infinity' -WindowStyle Hidden
}
foreach ($i in 1..40) {
  try { (Invoke-WebRequest http://localhost:3010/api -UseBasicParsing -TimeoutSec 5).Content; exit 0 } catch { Start-Sleep 5 }
}
Write-Output "Chatwoot no respondio en http://localhost:3010 despues de 200 segundos"
exit 1
