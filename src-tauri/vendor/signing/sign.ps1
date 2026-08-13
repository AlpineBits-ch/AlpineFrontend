# Authenticode signing for Windows bundles, via Azure Artifact Signing.
#
# Tauri invokes this once per file it needs signed (the app exe, then the NSIS
# installer) through `bundle.windows.signCommand` - see tauri.conf.json. It must
# stay a signCommand rather than a post-build step in CI: the bundler generates
# the updater's minisign .sig *after* signCommand runs, so the .sig covers the
# signed installer. Signing after `tauri build` would leave every shipped .sig
# describing a file that no longer exists, and clients would reject the update
# as a signature failure - silently, behind the splash-screen update gate.
#
# Authentication is DefaultAzureCredential, resolved by the Artifact Signing
# dlib. In CI that lands on the Azure CLI session left behind by azure/login,
# which is OIDC-federated - there is no client secret anywhere in this repo or
# in GitHub secrets. Locally, `az login` is enough.
#
# metadata.json pins that chain to AzureCliCredential alone via ExcludeCredentials,
# and that is not tidiness. Left unpinned, the chain walks past the CLI credential
# to InteractiveBrowserCredential, which launches Edge to ask a human to log in.
# On a headless runner nothing answers, so signing does not fail - it blocks
# forever. That cost a 39 minute hang on the first signed release, visible only as
# three orphan msedge processes in the job cleanup.
#
# Neither signtool nor the dlib lives at a stable path, so both are discovered
# rather than hard-coded: a wrong hard-coded path fails at the end of a 20 minute
# Windows build, and only on the machine that does not have it.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Path,

    # A signing call is one network round trip plus a timestamp fetch - seconds, not
    # minutes. The ceiling exists so that a credential or network stall dies here
    # instead of sitting on a runner until the six hour job timeout.
    [int]$TimeoutSeconds = 300,

    # Appended to, never truncated: one build signs several binaries and the failure
    # is not always the first one.
    [string]$LogPath = $(
        if ($env:SIGNING_LOG) { $env:SIGNING_LOG }
        elseif ($env:RUNNER_TEMP) { Join-Path $env:RUNNER_TEMP 'signing.log' }
        else { Join-Path $env:TEMP 'venta-signing.log' }
    )
)

$ErrorActionPreference = 'Stop'

$stdoutLog = "$LogPath.out"
$stderrLog = "$LogPath.err"

function Write-SigningLog {
    foreach ($stream in @(@{ f = $stdoutLog; l = 'stdout' }, @{ f = $stderrLog; l = 'stderr' })) {
        if (Test-Path $stream.f) {
            $content = Get-Content -Path $stream.f -Raw
            if ($content -and $content.Trim()) {
                Add-Content -Path $LogPath -Value "--- signtool $($stream.l) ---"
                Add-Content -Path $LogPath -Value $content.TrimEnd()
            }
            Remove-Item $stream.f -Force -ErrorAction SilentlyContinue
        }
    }
}

# The dlib ships as a NuGet package with no installer, so CI extracts it and
# points here. Fall back to the paths the MSI installer uses for a dev machine.
function Resolve-Dlib {
    if ($env:ARTIFACT_SIGNING_DLIB -and (Test-Path $env:ARTIFACT_SIGNING_DLIB)) {
        return $env:ARTIFACT_SIGNING_DLIB
    }

    $candidates = @(
        "$env:ProgramFiles\Microsoft\Artifact Signing Client Tools\bin\x64\Azure.CodeSigning.Dlib.dll"
        "${env:ProgramFiles(x86)}\Microsoft\Artifact Signing Client Tools\bin\x64\Azure.CodeSigning.Dlib.dll"
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return $candidate }
    }

    throw @"
Could not find Azure.CodeSigning.Dlib.dll.

Set ARTIFACT_SIGNING_DLIB to its full path, or install the client tools:
    winget install -e --id Microsoft.Azure.ArtifactSigningClientTools
"@
}

# 20348 is explicitly unsupported by the dlib, and the runner image ships
# several SDKs side by side - so pick the newest and skip that one build.
function Resolve-SignTool {
    $roots = @(
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
        "$env:ProgramFiles\Windows Kits\10\bin"
    ) | Where-Object { Test-Path $_ }

    $signtool = Get-ChildItem -Path $roots -Filter 'signtool.exe' -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\' -and $_.FullName -notmatch '10\.0\.20348' } |
        Sort-Object { [version]($_.Directory.Parent.Name) } -Descending |
        Select-Object -First 1

    if (-not $signtool) {
        throw 'Could not find an x64 signtool.exe in the Windows 10/11 SDK. Install the Windows 11 SDK (10.0.26100 or later).'
    }

    return $signtool.FullName
}

$dlib = Resolve-Dlib
$signtool = Resolve-SignTool
$metadata = Join-Path $PSScriptRoot 'metadata.json'

if (-not (Test-Path $metadata)) {
    throw "Missing $metadata - it carries the Artifact Signing endpoint, account and certificate profile."
}

Add-Content -Path $LogPath -Value @"

=== $(Get-Date -Format 'HH:mm:ss') signing $Path ===
signtool: $signtool
dlib:     $dlib
metadata: $metadata
"@

# Artifact Signing certificates are valid for three days, so an untrusted
# timestamp is the difference between a signature that keeps verifying and one
# that expires the same week it shipped. /td must match /fd.
#
# Start-Process rather than the call operator, purely so the call can be given a
# deadline - see $TimeoutSeconds. Every path is quoted explicitly because the SDK
# and dlib both live under "Program Files (x86)".
$signtoolArgs = @(
    'sign'
    '/v'
    '/debug'
    '/fd', 'SHA256'
    '/tr', 'http://timestamp.acs.microsoft.com'
    '/td', 'SHA256'
    '/dlib', "`"$dlib`""
    '/dmdf', "`"$metadata`""
    "`"$Path`""
)

# signtool's output is redirected to a file rather than left on the console, because
# tauri-bundler captures the sign command's stdout and stderr and prints none of it -
# every failure in here surfaces as the bare string "failed to run powershell". The
# log is the only way to find out what actually happened; build.yml prints it.
$proc = Start-Process -FilePath $signtool `
    -ArgumentList $signtoolArgs `
    -NoNewWindow `
    -PassThru `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog

if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
    try { $proc.Kill() } catch { }
    Add-Content -Path $LogPath -Value "TIMEOUT after $TimeoutSeconds seconds - killed"
    Write-SigningLog
    throw @"
signtool did not finish within $TimeoutSeconds seconds while signing $Path, so it was killed.

This is almost always credential resolution, not signing. If Edge or another browser
was launched, DefaultAzureCredential fell through to InteractiveBrowserCredential and
is waiting for a human - check the ExcludeCredentials list in metadata.json.
"@
}

Write-SigningLog

if ($proc.ExitCode -ne 0) {
    throw "signtool failed with exit code $($proc.ExitCode) while signing $Path - see $LogPath"
}
