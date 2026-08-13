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
# Neither signtool nor the dlib lives at a stable path, so both are discovered
# rather than hard-coded: a wrong hard-coded path fails at the end of a 20 minute
# Windows build, and only on the machine that does not have it.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Path
)

$ErrorActionPreference = 'Stop'

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

Write-Host "Signing $Path"
Write-Host "  signtool: $signtool"
Write-Host "  dlib:     $dlib"

# Artifact Signing certificates are valid for three days, so an untrusted
# timestamp is the difference between a signature that keeps verifying and one
# that expires the same week it shipped. /td must match /fd.
& $signtool sign `
    /v `
    /debug `
    /fd SHA256 `
    /tr 'http://timestamp.acs.microsoft.com' `
    /td SHA256 `
    /dlib $dlib `
    /dmdf $metadata `
    $Path

if ($LASTEXITCODE -ne 0) {
    throw "signtool failed with exit code $LASTEXITCODE while signing $Path"
}
