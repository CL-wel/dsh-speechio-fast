<#
.SYNOPSIS
  Download the Qwen3-ASR model files and the llama.cpp Windows runtime.

.DESCRIPTION
  This repository contains only the plugin code. It does NOT ship model
  weights or llama.cpp binaries. This script downloads them into a layout
  the plugin understands:

    <Root>\ASR\Qwen3-ASR-0.6B-Q8_0.gguf
    <Root>\ASR\mmproj-Qwen3-ASR-0.6B-Q8_0.gguf
    <Root>\llama.cpp\<backend>\llama-server.exe

  Default Root: %DSH_HOME%\speechio, or %USERPROFILE%\.dsh\speechio.

.PARAMETER Backend
  vulkan, cpu, or both (default both).

.PARAMETER LlamaTag
  llama.cpp release tag. The default b12199 is the version this plugin was
  tested with. Passing another tag skips the pinned SHA256 checks.

.PARAMETER Proxy
  Explicit HTTP(S) proxy. Default: HTTPS_PROXY/HTTP_PROXY environment variables,
  then the Windows system proxy (HKCU Internet Settings).

.PARAMETER VerifyOnly
  Only verify existing files; do not download anything.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Backend cpu
#>
param(
  [string]$Root = "",
  [ValidateSet("vulkan", "cpu", "both")]
  [string]$Backend = "both",
  [string]$LlamaTag = "b12199",
  [string]$Proxy = "",
  [switch]$SkipModels,
  [switch]$SkipRuntime,
  [switch]$Force,
  [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if (-not $Root) {
  $Root = if ($env:DSH_HOME) { Join-Path $env:DSH_HOME "speechio" } else { Join-Path $env:USERPROFILE ".dsh\speechio" }
}
$Root = [IO.Path]::GetFullPath($Root)
$AsrDir = Join-Path $Root "ASR"
$LlamaDir = Join-Path $Root "llama.cpp"

function Resolve-Proxy {
  param([string]$Explicit)
  if ($Explicit) { return $Explicit }
  foreach ($name in @("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy")) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($value) { return $value }
  }
  $key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
  $settings = Get-ItemProperty $key -ErrorAction SilentlyContinue
  if ($settings.ProxyEnable -eq 1 -and $settings.ProxyServer) {
    $server = $settings.ProxyServer
    if ($server -match "=") {
      $map = @{}
      foreach ($part in $server -split ";") {
        $pair = $part -split "=", 2
        if ($pair.Count -eq 2) { $map[$pair[0].ToLower()] = $pair[1] }
      }
      if ($map.ContainsKey("https")) { $server = $map["https"] }
      elseif ($map.ContainsKey("http")) { $server = $map["http"] }
    }
    if ($server -notmatch "^[a-z]+://") { $server = "http://$server" }
    return $server
  }
  return ""
}

$script:Proxy = Resolve-Proxy $Proxy
if ($script:Proxy) {
  Write-Host "  proxy:   $script:Proxy"
}

$ModelRepo = "https://huggingface.co/unslothai/Qwen3-ASR-0.6B-GGUF/resolve/main"
$Models = @(
  @{
    Name   = "Qwen3-ASR-0.6B-Q8_0.gguf"
    Size   = 804749248
    Sha256 = "bca259818b50ca7c4c05e9bdb35a5dc04fa039653a6d6f3f0f331f96f6aa1971"
    Url    = "$ModelRepo/Qwen3-ASR-0.6B-Q8_0.gguf"
  },
  @{
    Name   = "mmproj-Qwen3-ASR-0.6B-Q8_0.gguf"
    Size   = 214392480
    Sha256 = "41a342b5e4c514e968cb756de6cd1b7be39eff43c44c57a2ef5fc6522e36603d"
    Url    = "$ModelRepo/mmproj-Qwen3-ASR-0.6B-Q8_0.gguf"
  }
)

$PinnedRuntime = $LlamaTag -eq "b12199"
$Runtimes = @{
  vulkan = @{
    Asset  = "llama-$LlamaTag-bin-win-vulkan-x64.zip"
    Size   = if ($PinnedRuntime) { 37715448 } else { 0 }
    Sha256 = if ($PinnedRuntime) { "7bb426133c32a424b2b74a14d6dae6aaf7ff56a742f1a93af0bc34dd6f224ce9" } else { "" }
    Url    = "https://github.com/ggml-org/llama.cpp/releases/download/$LlamaTag/llama-$LlamaTag-bin-win-vulkan-x64.zip"
  }
  cpu = @{
    Asset  = "llama-$LlamaTag-bin-win-cpu-x64.zip"
    Size   = if ($PinnedRuntime) { 24758741 } else { 0 }
    Sha256 = if ($PinnedRuntime) { "1cde1df073c2526ef3ad34a5b2884998802b837ed4b965a36d0af2920f10a1ae" } else { "" }
    Url    = "https://github.com/ggml-org/llama.cpp/releases/download/$LlamaTag/llama-$LlamaTag-bin-win-cpu-x64.zip"
  }
}

function Get-RemoteFile {
  param(
    [string]$Url,
    [string]$Out,
    [long]$Size = 0,
    [string]$Sha256 = ""
  )

  if ((Test-Path $Out) -and -not $Force) {
    $item = Get-Item $Out
    $sizeOk = (-not $Size) -or ($item.Length -eq $Size)
    $hashOk = $true
    if ($Sha256) {
      $hashOk = (Get-FileHash $Out -Algorithm SHA256).Hash.ToLower() -eq $Sha256.ToLower()
    }
    if ($sizeOk -and $hashOk) {
      Write-Host "  [ok] $Out"
      return
    }
    Write-Host "  [retry] $Out is incomplete or has a wrong hash"
  }

  $part = "$Out.part"
  if (Test-Path $part) { Remove-Item $part -Force -ErrorAction SilentlyContinue }
  Write-Host "  [get] $Url"
  $downloaded = $false

  if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    $curlArgs = @(
      "-L", "--fail", "--retry", "3", "--retry-delay", "2",
      "--connect-timeout", "15", "--silent", "--show-error", "-o", $part
    )
    if ($script:Proxy) { $curlArgs += @("--proxy", $script:Proxy) }
    $curlArgs += $Url
    & curl.exe @curlArgs
    if ($LASTEXITCODE -eq 0 -and (Test-Path $part)) {
      $downloaded = $true
    } else {
      Write-Host "  [warn] curl failed (exit $LASTEXITCODE); trying Invoke-WebRequest"
      Remove-Item $part -Force -ErrorAction SilentlyContinue
    }
  }

  if (-not $downloaded) {
    $iwrArgs = @{ Uri = $Url; OutFile = $part; UseBasicParsing = $true; TimeoutSec = 3600 }
    if ($script:Proxy) { $iwrArgs.Proxy = $script:Proxy }
    try {
      Invoke-WebRequest @iwrArgs
    } catch {
      Remove-Item $part -Force -ErrorAction SilentlyContinue
      throw "Download failed: $Url`nCheck your network/proxy, or download it manually and place it at: $Out"
    }
  }
  if (-not (Test-Path $part)) { throw "Download produced no file: $Url" }
  if ($Size -and (Get-Item $part).Length -ne $Size) {
    throw "Size mismatch for $Out (expected $Size, got $((Get-Item $part).Length))"
  }
  if ($Sha256) {
    $actual = (Get-FileHash $part -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $Sha256.ToLower()) {
      throw "SHA256 mismatch for $Out (expected $Sha256, got $actual)"
    }
  }
  Move-Item $part $Out -Force
  Write-Host "  [ok] $Out"
}

function Test-Models {
  $missing = 0
  Write-Host "Models:"
  foreach ($model in $Models) {
    $path = Join-Path $AsrDir $model.Name
    if (Test-Path $path) {
      $size = (Get-Item $path).Length
      Write-Host ("  [ok] {0} ({1:N1} MB)" -f $path, ($size / 1MB))
    } else {
      Write-Host "  [missing] $path"
      $missing++
    }
  }
  return $missing
}

function Test-Runtime {
  param([string[]]$Names)
  $missing = 0
  Write-Host "Runtime:"
  foreach ($name in $Names) {
    $exe = Join-Path (Join-Path $LlamaDir $name) "llama-server.exe"
    if (Test-Path $exe) {
      Write-Host "  [ok] $exe"
    } else {
      Write-Host "  [missing] $exe"
      $missing++
    }
  }
  return $missing
}

$targets = if ($Backend -eq "both") { @("vulkan", "cpu") } else { @($Backend) }

Write-Host "speechio-fast setup"
Write-Host "  root:    $Root"
Write-Host "  backend: $Backend"
Write-Host "  llama:   $LlamaTag"
Write-Host ""

if ($VerifyOnly) {
  $missing = (Test-Models) + (Test-Runtime @("vulkan", "cpu"))
  if ($missing -gt 0) { exit 1 }
  Write-Host "All files are present."
  exit 0
}

New-Item -ItemType Directory -Force -Path $AsrDir | Out-Null
New-Item -ItemType Directory -Force -Path $LlamaDir | Out-Null

if (-not $SkipModels) {
  Write-Host "Models (Hugging Face: unslothai/Qwen3-ASR-0.6B-GGUF, Apache-2.0):"
  foreach ($model in $Models) {
    Get-RemoteFile -Url $model.Url -Out (Join-Path $AsrDir $model.Name) -Size $model.Size -Sha256 $model.Sha256
  }
  Write-Host ""
}

if (-not $SkipRuntime) {
  Write-Host "llama.cpp runtime (github.com/ggml-org/llama.cpp, $LlamaTag):"
  foreach ($name in $targets) {
    $runtime = $Runtimes[$name]
    $zip = Join-Path $env:TEMP $runtime.Asset
    Get-RemoteFile -Url $runtime.Url -Out $zip -Size $runtime.Size -Sha256 $runtime.Sha256
    $dest = Join-Path $LlamaDir $name
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Write-Host "  [unzip] $dest"
    Expand-Archive -Path $zip -DestinationPath $dest -Force
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
  }
  Write-Host ""
}

$missing = 0
if (-not $SkipModels) { $missing += Test-Models }
if (-not $SkipRuntime) { $missing += Test-Runtime $targets }
if ($missing -gt 0) {
  Write-Host ""
  Write-Host "Some requested files are still missing." -ForegroundColor Yellow
  exit 1
}

Write-Host ""
Write-Host "Done. Model root: $Root" -ForegroundColor Green
Write-Host "The plugin reads <DSH_HOME>/speechio by default."
Write-Host "If your DSH_HOME differs, set speechio-provider.config.asrRoot to:"
Write-Host "  $Root"
Write-Host ""
Write-Host "Optional: start the server once to verify:"
Write-Host "  $LlamaDir\vulkan\llama-server.exe -m `"$AsrDir\Qwen3-ASR-0.6B-Q8_0.gguf`" --mmproj `"$AsrDir\mmproj-Qwen3-ASR-0.6B-Q8_0.gguf`" -c 2048 -t 8 --host 127.0.0.1 --port 10012 --no-webui -ngl 99 --mmproj-offload"
