param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"
$source = Join-Path $Root "vscode-bridge"
$targetRoot = Join-Path $env:USERPROFILE ".vscode\extensions"
$packagePath = Join-Path $source "package.json"
if (-not (Test-Path $packagePath)) {
  throw "找不到 $packagePath"
}
$package = Get-Content $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$package.version
$target = Join-Path $targetRoot "remotedeck.bridge-$version"

New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null
Get-ChildItem $targetRoot -Directory -Filter "remotedeck.bridge-*" -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.FullName -ne $target) { Remove-Item $_.FullName -Recurse -Force }
}
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
Copy-Item $source $target -Recurse -Force

Write-Output "已安装 RemoteDeck VS Code 桥接扩展：$target"
Write-Output "请完全退出并重新打开 VS Code（或执行 Developer: Reload Window）使其生效。"
