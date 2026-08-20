$ErrorActionPreference = 'Continue'

Write-Host 'Remote Minecraft Streaming Phase 1 - environment check'
Write-Host ''

$failed = $false
foreach ($tool in @('node', 'ffmpeg', 'nvidia-smi')) {
    $command = Get-Command $tool -ErrorAction SilentlyContinue
    if ($command) { Write-Host ('[OK]   {0}: {1}' -f $tool, $command.Source) }
    else { Write-Host ('[FAIL] {0}: not found on PATH' -f $tool); $failed = $true }
}

$projectFfmpeg = Join-Path (Split-Path $PSScriptRoot -Parent) 'vendor\ffmpeg-gfxcapture-runtime\ffmpeg.exe'
if (Test-Path -LiteralPath $projectFfmpeg) {
    Write-Host ('[OK]   project ffmpeg: {0}' -f $projectFfmpeg)
    $encoders = & $projectFfmpeg -hide_banner -encoders 2>&1
    if ($encoders -match 'h264_nvenc') { Write-Host '[OK]   FFmpeg exposes h264_nvenc' }
    else { Write-Host '[FAIL] FFmpeg does not expose h264_nvenc'; $failed = $true }
    $filters = & $projectFfmpeg -hide_banner -filters 2>&1
    if ($filters -match '\bgfxcapture\b') { Write-Host '[OK]   FFmpeg exposes exact-window Windows Graphics Capture' }
    else { Write-Host '[FAIL] FFmpeg does not expose gfxcapture'; $failed = $true }
    $muxers = & $projectFfmpeg -hide_banner -muxers 2>&1
    if ($encoders -match '\bmjpeg\b' -and $muxers -match '\bimage2pipe\b') { Write-Host '[OK]   FFmpeg exposes embedded MJPEG preview output' }
    else { Write-Host '[FAIL] FFmpeg does not expose MJPEG/image2pipe preview output'; $failed = $true }
    $null = & $projectFfmpeg -hide_banner -loglevel error -f lavfi -i 'color=size=256x256:rate=1' -frames:v 1 -pix_fmt nv12 -c:v h264_nvenc -preset p1 -tune ull -f null NUL 2>&1
    if ($LASTEXITCODE -eq 0) { Write-Host '[OK]   NVENC initialization and one-frame encode succeeded' }
    else { Write-Host '[FAIL] NVENC initialization failed (check FFmpeg build/driver compatibility)'; $failed = $true }
}
else { Write-Host '[FAIL] Project gfxcapture FFmpeg is missing'; $failed = $true }

if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
    & nvidia-smi --query-gpu=name,driver_version --format=csv,noheader
}

if ($failed) {
    Write-Host ''
    Write-Host 'Install NVIDIA driver 610.00 or newer, restart Windows, then rerun this check.'
    exit 1
}
Write-Host ''
Write-Host '[OK] Environment is ready for a live target test.'
