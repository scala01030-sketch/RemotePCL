param(
  [string]$JavaHome = $env:JAVA_HOME
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $projectRoot 'src\remote\agent'
$classesRoot = Join-Path $projectRoot 'build\input-agent\classes'
$packageRoot = Join-Path $projectRoot 'build\input-agent-package'
$outputRoot = Join-Path $projectRoot 'vendor\remote-input-agent'

$sourcePath = Join-Path $sourceRoot 'RemoteInputAgent.java'
$sha256 = [Security.Cryptography.SHA256]::Create()
$sourceStream = [IO.File]::OpenRead($sourcePath)
try { $sourceHash = ([BitConverter]::ToString($sha256.ComputeHash($sourceStream))).Replace('-', '').Substring(0, 12).ToLowerInvariant() }
finally { $sourceStream.Dispose(); $sha256.Dispose() }
$outputJar = Join-Path $outputRoot "remote-input-agent-$sourceHash.jar"
New-Item -ItemType Directory -Force -Path $packageRoot, $outputRoot | Out-Null

if (-not (Test-Path -LiteralPath $outputJar)) {
  if ([string]::IsNullOrWhiteSpace($JavaHome)) {
    $javacCommand = Get-Command javac.exe -ErrorAction SilentlyContinue
    if ($null -ne $javacCommand) {
      $JavaHome = Split-Path -Parent (Split-Path -Parent $javacCommand.Source)
    } else {
      $runtime = Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('java.exe', 'javaw.exe') -and -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) } |
        ForEach-Object { Split-Path -Parent (Split-Path -Parent $_.ExecutablePath) } |
        Where-Object { Test-Path -LiteralPath (Join-Path $_ 'bin\javac.exe') } |
        Select-Object -First 1
      if ($null -eq $runtime) { throw 'JDK_NOT_FOUND: no matching prebuilt agent exists; set JAVA_HOME to a JDK 17+ directory.' }
      $JavaHome = $runtime
    }
  }

  $javac = Join-Path $JavaHome 'bin\javac.exe'
  $jar = Join-Path $JavaHome 'bin\jar.exe'
  if (-not (Test-Path -LiteralPath $javac) -or -not (Test-Path -LiteralPath $jar)) {
    throw "JDK_NOT_FOUND: javac.exe and jar.exe are required under $JavaHome\bin"
  }

  New-Item -ItemType Directory -Force -Path $classesRoot | Out-Null
  Get-ChildItem -LiteralPath $classesRoot -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
  & $javac --release 17 --add-modules jdk.attach -encoding UTF-8 -d $classesRoot $sourcePath
  if ($LASTEXITCODE -ne 0) { throw "javac failed with exit code $LASTEXITCODE" }
  & $jar --create --file $outputJar --manifest (Join-Path $sourceRoot 'MANIFEST.MF') -C $classesRoot .
  if ($LASTEXITCODE -ne 0) { throw "jar failed with exit code $LASTEXITCODE" }
} else {
  Write-Output "Using matching prebuilt input agent: $outputJar"
}

$currentManifest = Join-Path $outputRoot 'current-agent.txt'
[IO.File]::WriteAllText($currentManifest, [IO.Path]::GetFileName($outputJar), [Text.UTF8Encoding]::new($false))
$packagedJar = Join-Path $packageRoot 'remote-input-agent.jar'
Copy-Item -LiteralPath $outputJar -Destination $packagedJar -Force
Write-Output $outputJar
