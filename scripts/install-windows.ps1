# Copyright 2026 Workloom Solutions Private Limited
# SPDX-License-Identifier: MIT
# Release generation fills the version and app checksum before this script ships.
[CmdletBinding()]
param([switch]$NoLaunch, [ValidateNotNullOrEmpty()][string]$AppArchive)
$ErrorActionPreference = 'Stop'
$AppVersion = '__CODEBASE_TRAIL_VERSION__'
$AppSha256 = '__CODEBASE_TRAIL_APP_SHA256__'
$AppRepository = '__CODEBASE_TRAIL_REPOSITORY__'
$NodeVersion = '24.22.1'
$NodeSha256 = 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5'
function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Private runtime command failed with exit $LASTEXITCODE." }
}
function Get-HttpsFile([string]$Url, [string]$Output) {
    Add-Type -AssemblyName System.Net.Http
    $Handler = [System.Net.Http.HttpClientHandler]::new()
    $Handler.AllowAutoRedirect = $false
    $Client = [System.Net.Http.HttpClient]::new($Handler)
    $Client.Timeout = [TimeSpan]::FromMinutes(10)
    try {
        $Uri = [Uri]$Url
        for ($Redirect = 0; $Redirect -le 5; $Redirect++) {
            if ($Uri.Scheme -ne 'https' -or $Uri.UserInfo) { throw 'Download redirects must stay on HTTPS without embedded credentials.' }
            $Response = $Client.GetAsync($Uri).GetAwaiter().GetResult()
            try {
                if ([int]$Response.StatusCode -ge 300 -and [int]$Response.StatusCode -lt 400) {
                    if (-not $Response.Headers.Location) { throw 'Download redirect is missing its destination.' }
                    $Uri = [Uri]::new($Uri, $Response.Headers.Location)
                    continue
                }
                $Response.EnsureSuccessStatusCode() | Out-Null
                $Stream = [IO.File]::Create($Output)
                try { $Response.Content.CopyToAsync($Stream).GetAwaiter().GetResult() }
                finally { $Stream.Dispose() }
                return
            } finally { $Response.Dispose() }
        }
        throw 'Download exceeded the redirect limit.'
    } finally { $Client.Dispose(); $Handler.Dispose() }
}
function Assert-Hash([string]$File, [string]$Expected) {
    if ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected) { throw 'A downloaded archive failed SHA-256 verification. Nothing was activated.' }
}
function Install-CodebaseTrail {
    param([switch]$NoLaunch, [ValidateNotNullOrEmpty()][string]$AppArchive)
    if ($AppVersion -notmatch '^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$' -or $AppSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Use the generated installer from a versioned GitHub release.' }
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This installer supports Windows only.' }
    $OS = Get-CimInstance Win32_OperatingSystem
    $Processor = Get-CimInstance Win32_Processor | Select-Object -First 1
    if ([version]$OS.Version -lt [version]'10.0') { throw 'Windows 10 or newer is required.' }
    if ($Processor.Architecture -eq 12) {
        if ([int]$OS.BuildNumber -lt 22000) { throw 'Windows ARM64 requires Windows 11 x64 emulation for this app.' }
    } elseif ($Processor.Architecture -ne 9) { throw 'Supported Windows architectures are x64 and Windows 11 ARM64 with x64 emulation.' }
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Install Git separately before running this installer.' }
    & git --version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Git is not usable. Install Git separately, then retry.' }
    if ($AppArchive) {
        if (-not (Test-Path -LiteralPath $AppArchive -PathType Leaf)) { throw 'The local app archive must be an existing file.' }
        $AppArchive = (Get-Item -LiteralPath $AppArchive).FullName
    }
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is not set.' }
    $Root = Join-Path $env:LOCALAPPDATA 'CodebaseTrail\app'
    $Versions = Join-Path $Root 'versions'
    New-Item -ItemType Directory -Path $Versions -Force | Out-Null
    $LockPath = Join-Path $Root '.install-lock'
    try { $Lock = [IO.File]::Open($LockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }
    catch { throw 'Another installer holds the install lock. Wait for it to finish. A forcibly interrupted install may need its lock removed manually.' }
    $Stage = $null
    $TemporaryLauncher = $null
    $OldPath = $env:PATH

    try {
        $Destination = Join-Path $Versions "v$AppVersion-$($AppSha256.Substring(0,12))"
        $Node = Join-Path $Destination 'node\node.exe'
        $Launcher = Join-Path $Destination 'app\node_modules\codebase-trail\launcher.mjs'
        if (Test-Path -LiteralPath $Destination) {
            if (-not (Test-Path -LiteralPath (Join-Path $Destination '.complete')) -or (Get-Content -LiteralPath (Join-Path $Destination '.complete') -Raw).Trim() -ne $AppSha256) { throw 'An incomplete installation already occupies this version. It has not been modified.' }
            if ((& $Node --version) -ne "v$NodeVersion") { throw 'The existing private runtime is invalid. It has not been modified.' }
            Invoke-Checked $Node @($Launcher, '--help') | Out-Null
        } else {
            $Stage = Join-Path $Root ('.staging-' + [Guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $Stage | Out-Null
            $NodeArchive = Join-Path $Stage 'node.zip'
            $StagedAppArchive = Join-Path $Stage 'app.tgz'
            Get-HttpsFile "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" $NodeArchive
            Assert-Hash $NodeArchive $NodeSha256
            if ($AppArchive) { Copy-Item -LiteralPath $AppArchive -Destination $StagedAppArchive }
            else { Get-HttpsFile "https://github.com/$AppRepository/releases/download/v$AppVersion/codebase-trail-$AppVersion.tgz" $StagedAppArchive }
            Assert-Hash $StagedAppArchive $AppSha256
            Expand-Archive -LiteralPath $NodeArchive -DestinationPath $Stage
            Move-Item -LiteralPath (Join-Path $Stage "node-v$NodeVersion-win-x64") -Destination (Join-Path $Stage 'node')
            $PrivateNode = Join-Path $Stage 'node\node.exe'
            $PrivateNpm = Join-Path $Stage 'node\node_modules\npm\bin\npm-cli.js'
            if ((& $PrivateNode --version) -ne "v$NodeVersion") { throw 'The downloaded runtime did not report its pinned version.' }
            $env:PATH = (Join-Path $Stage 'node') + ';' + $OldPath
            $NpmConfig = Join-Path $Stage 'npmrc'; $GlobalConfig = Join-Path $Stage 'global-npmrc'
            [IO.File]::WriteAllText($NpmConfig, ''); [IO.File]::WriteAllText($GlobalConfig, '')
            Invoke-Checked $PrivateNode @($PrivateNpm, 'install', '--prefix', (Join-Path $Stage 'app'), $StagedAppArchive, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', (Join-Path $Root 'npm-cache'), '--userconfig', $NpmConfig, '--globalconfig', $GlobalConfig, '--registry', 'https://registry.npmjs.org')
            $PrivateLauncher = Join-Path $Stage 'app\node_modules\codebase-trail\launcher.mjs'
            Invoke-Checked $PrivateNode @($PrivateLauncher, '--help') | Out-Null
            $ParserCheck = "import {pathToFileURL} from 'node:url'; import {join} from 'node:path'; const {parseSource}=await import(pathToFileURL(join(process.argv[1],'syntax-analysis.mjs')).href); if(!parseSource('check.js','export const value=1;')) throw new Error('Native parser validation failed');"
            Invoke-Checked $PrivateNode @('--input-type=module', '-e', $ParserCheck, (Join-Path $Stage 'app\node_modules\codebase-trail'))
            Remove-Item -LiteralPath $NodeArchive, $StagedAppArchive, $NpmConfig, $GlobalConfig
            [IO.File]::WriteAllText((Join-Path $Stage '.complete'), $AppSha256 + "`n")
            Move-Item -LiteralPath $Stage -Destination $Destination
            $Stage = $null
        }
        $QuotedNode = $Node.Replace("'", "''")
        $QuotedLauncher = $Launcher.Replace("'", "''")
        $QuotedPath = (Join-Path $Destination 'node').Replace("'", "''")
        $Wrapper = "`$OldPath = `$env:PATH`ntry { `$env:PATH = '$QuotedPath;' + `$OldPath; & '$QuotedNode' '$QuotedLauncher' @args; exit `$LASTEXITCODE } finally { `$env:PATH = `$OldPath }`n"
        $TemporaryLauncher = Join-Path $Root ('.launcher-' + [Guid]::NewGuid().ToString('N') + '.ps1')
        [IO.File]::WriteAllText($TemporaryLauncher, $Wrapper, ([Text.UTF8Encoding]::new($true)))
        $StableLauncher = Join-Path $Root 'codebase-trail.ps1'
        if (Test-Path -LiteralPath $StableLauncher) { [IO.File]::Replace($TemporaryLauncher, $StableLauncher, $null) }
        else { [IO.File]::Move($TemporaryLauncher, $StableLauncher) }
        Write-Output "Installed Codebase Trail $AppVersion. Launch again with: & '$StableLauncher'"
    } finally {
        $env:PATH = $OldPath
        if ($Stage -and (Test-Path -LiteralPath $Stage)) { Remove-Item -LiteralPath $Stage -Recurse -Force }
        if ($TemporaryLauncher -and (Test-Path -LiteralPath $TemporaryLauncher)) { Remove-Item -LiteralPath $TemporaryLauncher }
        $Lock.Dispose()
        Remove-Item -LiteralPath $LockPath
    }
    if (-not $NoLaunch) { & $StableLauncher }
}
if ($MyInvocation.InvocationName -ne '.') {
    $InstallOptions = @{ NoLaunch = $NoLaunch }
    if ($PSBoundParameters.ContainsKey('AppArchive')) { $InstallOptions.AppArchive = $AppArchive }
    Install-CodebaseTrail @InstallOptions
}
