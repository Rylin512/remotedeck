$ErrorActionPreference = "Stop"
$startup = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startup "RemoteDeck.lnk"
if (Test-Path $shortcutPath) {
  Remove-Item -LiteralPath $shortcutPath -Force
  Write-Output "已关闭开机自启动。"
} else {
  Write-Output "开机自启动本来就没有启用。"
}
