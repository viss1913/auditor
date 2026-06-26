# Сборка .docx для пакета встречи с DevOps.
# Требуется Pandoc: winget install JohnMacFarlane.Pandoc
# Запуск: .\build-meeting-packet.ps1

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$out = Join-Path $here "docx"
New-Item -ItemType Directory -Force -Path $out | Out-Null

$localFiles = @(
    "00-paket-na-vstrechu.md",
    "01-protokol-vstrechi.md",
    "02-akt-gotovnosti-stenda.md",
    "03-ollama-offline.md",
    "04-kompyuternoe-zrenie.md",
    "prilozhenie-4-dogovor.md"
)

foreach ($name in $localFiles) {
    $src = Join-Path $here $name
    $docx = Join-Path $out ($name -replace '\.md$', '.docx')
    Write-Host "pandoc $name -> docx\$($name -replace '\.md$', '.docx')"
    & pandoc $src -o $docx
}

$shared = @(
    (Join-Path $here "..\03-arhitektura.md"),
    (Join-Path $here "..\04-trebuemye-moshchnosti.md")
)
foreach ($src in $shared) {
    $base = [System.IO.Path]::GetFileNameWithoutExtension($src)
    $docx = Join-Path $out ($base + ".docx")
    Write-Host "pandoc $base -> docx\$base.docx"
    & pandoc $src -o $docx
}

Write-Host "Done: $out"
