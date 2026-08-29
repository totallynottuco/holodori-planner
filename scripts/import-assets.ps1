param(
  [string]$ExtractedDirectory,
  [string]$HolodoriCommand = 'holodori'
)

$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$temporaryRoot = $null

if ([string]::IsNullOrWhiteSpace($ExtractedDirectory)) {
  $temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('holodori-planner-assets-' + [guid]::NewGuid().ToString('N'))
  $downloadDirectory = Join-Path $temporaryRoot 'downloads'
  $ExtractedDirectory = Join-Path $temporaryRoot 'extracted'
  $catalogPath = Join-Path $temporaryRoot 'octo_list.json'
  New-Item -ItemType Directory -Path $downloadDirectory, $ExtractedDirectory -Force | Out-Null

  $manifest = Get-Content (Join-Path $projectDirectory 'src\data\progression.json') -Raw | ConvertFrom-Json
  $assetNames = @($manifest.cards | ForEach-Object { 'img_card_thumb_' + $_.assetId }) + @(
    $manifest.resourceAssets.psobject.Properties.Value | ForEach-Object { $_.sourceAssetName }
  )
  $filter = '^(' + (($assetNames | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')$'

  for ($attempt = 1; $attempt -le 3; $attempt++) {
    & $HolodoriCommand download $downloadDirectory --catalog $catalogPath --filter $filter --workers 4 --no-overwrite
    if ($LASTEXITCODE -ne 0) { throw "holodori download failed with exit code $LASTEXITCODE" }
  }
  $downloadedCatalog = Get-Content $catalogPath -Raw | ConvertFrom-Json
  if ([int]$downloadedCatalog.revisionId -ne [int]$manifest.metadata.assetCatalogRevision) {
    throw "Asset catalog revision changed from $($manifest.metadata.assetCatalogRevision) to $($downloadedCatalog.revisionId); review and update the manifest before importing"
  }
  & $HolodoriCommand extract $downloadDirectory $ExtractedDirectory
  if ($LASTEXITCODE -ne 0) { throw "holodori extract failed with exit code $LASTEXITCODE" }
}

try {
  & node (Join-Path $PSScriptRoot 'process-assets.mjs') $ExtractedDirectory
  if ($LASTEXITCODE -ne 0) { throw "Asset processing failed with exit code $LASTEXITCODE" }
  & node (Join-Path $PSScriptRoot 'verify-assets.mjs')
  if ($LASTEXITCODE -ne 0) { throw "Asset verification failed with exit code $LASTEXITCODE" }
} finally {
  if ($temporaryRoot) {
    $resolvedTemporary = [System.IO.Path]::GetFullPath($temporaryRoot)
    $resolvedSystemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $systemTempPrefix = $resolvedSystemTemp.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolvedTemporary.StartsWith($systemTempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove unexpected temporary directory: $resolvedTemporary"
    }
    Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
  }
}
