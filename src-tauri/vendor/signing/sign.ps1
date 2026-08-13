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
# Authentication is DefaultAzureCredential, resolved by the Artifact Signing dlib.
# There is no client secret anywhere in this repo or in GitHub secrets: in CI the
# script mints a fresh GitHub OIDC assertion just below and redeems it through
# WorkloadIdentityCredential; locally, `az login` is enough.
#
# metadata.json prunes that chain via ExcludeCredentials, and that is not tidiness.
# Left unpinned, the chain walks past every credential that could work and reaches
# InteractiveBrowserCredential, which launches Edge to ask a human to log in. On a
# headless runner nothing answers, so signing does not fail - it blocks forever.
# That cost a 39 minute hang on the first signed release, visible only as three
# orphan msedge processes in the job cleanup.
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

# GitHub's OIDC assertion is valid for five minutes, and `azure/login` runs before a
# twenty minute Rust build - so by the time the bundler reaches signing, the assertion
# the Azure CLI stored at login has been dead for a quarter of an hour. The CLI does
# not notice. It holds no refresh token for a federated service principal, so it
# replays that same assertion for every scope it has not already cached, and a
# codesigning token is by definition the first request that needs one. The login step
# goes green and signing dies seventeen minutes later on AADSTS700024, "client
# assertion is not within its valid time range", which reads like a clock problem and
# is not one.
#
# So the assertion is minted here instead, seconds before it is redeemed, and handed
# to the dlib through WorkloadIdentityCredential - which reads the file when it needs
# a token rather than caching one at login. Returns $null off a runner, where the
# chain falls through to the Azure CLI session instead.
function New-FederatedTokenFile {
    if (-not $env:ACTIONS_ID_TOKEN_REQUEST_URL -or -not $env:ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
        return $null
    }

    if (-not $env:AZURE_CLIENT_ID -or -not $env:AZURE_TENANT_ID) {
        throw @"
Running on a GitHub runner, but AZURE_CLIENT_ID / AZURE_TENANT_ID are not set.
WorkloadIdentityCredential needs both to redeem the OIDC assertion - they are set on
the Build Tauri step in .github/workflows/build.yml.
"@
    }

    # The audience Entra expects for workload identity federation. The url already
    # carries an api-version query, hence & rather than ?.
    $uri = "$($env:ACTIONS_ID_TOKEN_REQUEST_URL)&audience=api%3A%2F%2FAzureADTokenExchange"

    $response = Invoke-RestMethod -Uri $uri -Method Get -Headers @{
        Authorization = "Bearer $($env:ACTIONS_ID_TOKEN_REQUEST_TOKEN)"
    }

    if (-not $response.value) {
        throw 'GitHub returned no OIDC token. The job needs `id-token: write` permission.'
    }

    # No newline and no BOM: the file content is the assertion, byte for byte.
    $file = Join-Path ([System.IO.Path]::GetTempPath()) "gha-oidc-$PID.jwt"
    Set-Content -Path $file -Value $response.value -NoNewline -Encoding ascii

    return $file
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

$tokenFile = New-FederatedTokenFile
if ($tokenFile) {
    $env:AZURE_FEDERATED_TOKEN_FILE = $tokenFile
}

Add-Content -Path $LogPath -Value @"

=== $(Get-Date -Format 'HH:mm:ss') signing $Path ===
signtool:   $signtool
dlib:       $dlib
metadata:   $metadata
credential: $(if ($tokenFile) { 'workload identity, from an assertion minted just now' } else { 'Azure CLI session' })
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
try {
    $proc = Start-Process -FilePath $signtool `
        -ArgumentList $signtoolArgs `
        -NoNewWindow `
        -PassThru `
        -RedirectStandardOutput $stdoutLog `
        -RedirectStandardError $stderrLog

    # Not decorative. Start-Process -PassThru hands back a Process whose ExitCode reads as
    # empty once it exits, unless the handle was touched while the process was still alive -
    # and '' -ne 0, so the check below would fail a signature that had just succeeded.
    $null = $proc.Handle

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
}
finally {
    # It is a bearer assertion, so it does not outlive the signtool call that used it.
    if ($tokenFile) { Remove-Item $tokenFile -Force -ErrorAction SilentlyContinue }
}
