param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  $candidates = @(
    (Join-Path $env:ProgramFiles "nodejs\node.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe")
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { $node = $candidate; break }
  }
}
if (-not $node) { throw "找不到 node.exe，请先安装 Node.js。" }

$server = Join-Path $Root "server\index.js"
if (-not (Test-Path $server)) { throw "找不到服务端入口：$server" }

function Escape-Vbs([string]$value) {
  return $value.Replace('"', '""')
}

$vbsPath = Join-Path $Root "start-hidden.vbs"
$vbs = @"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$(Escape-Vbs $Root)"
sh.Run """$(Escape-Vbs $node)"" ""$(Escape-Vbs $server)""", 0, False
"@
Set-Content -LiteralPath $vbsPath -Value $vbs -Encoding Unicode

$startup = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startup "RemoteDeck.lnk"
$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:WINDIR "System32\wscript.exe"
$shortcut.Arguments = '"' + $vbsPath + '"'
$shortcut.WorkingDirectory = $Root
$shortcut.WindowStyle = 7
$shortcut.Description = "RemoteDeck 开机自启动"
$shortcut.Save()

Write-Output "已启用开机自启动：$shortcutPath"
