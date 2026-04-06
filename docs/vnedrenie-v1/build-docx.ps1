# Сборка .docx из всех .md в этой папке (кроме README).
# Требуется Pandoc в PATH: winget install JohnMacFarlane.Pandoc
# Запуск из PowerShell: .\build-docx.ps1

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$out = Join-Path $here "docx"
New-Item -ItemType Directory -Force -Path $out | Out-Null

Get-ChildItem -Path $here -Filter "*.md" | Where-Object { $_.Name -ne "README.md" } | ForEach-Object {
    $docx = Join-Path $out ($_.BaseName + ".docx")
    Write-Host "pandoc $($_.Name) -> docx\$($_.BaseName).docx"
    & pandoc $_.FullName -o $docx
}

Write-Host "Done: $out"
