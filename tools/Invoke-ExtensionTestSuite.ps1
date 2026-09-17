[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path $repositoryRoot 'tests\extension'

$requiredBaseline = @(
    'architecture.test.mjs',
    'automation-control.behavior.test.mjs',
    'bounded-recovery.behavior.test.mjs',
    'click-route-source.test.mjs',
    'coordinator.behavior.test.mjs',
    'cross-desktop-click.behavior.test.mjs',
    'current-request-error.behavior.test.mjs',
    'delivery-dedupe.behavior.test.mjs',
    'delivery-reliability.behavior.test.mjs',
    'explicit-interruption-precedence.behavior.test.mjs',
    'hidden-tab-completion.behavior.test.mjs',
    'hidden-window-diagnostics.behavior.test.mjs',
    'post-refresh-continuation.integration.test.mjs',
    'request-completion-status-probe.behavior.test.mjs',
    'response-stream-status.behavior.test.mjs',
    'runtime-identity.behavior.test.mjs',
    'status-policy.behavior.test.mjs',
    'v0914-safety-regression.test.mjs',
    'version-sync.test.mjs'
)

if (-not (Test-Path -LiteralPath $testRoot -PathType Container)) {
    throw "Extension test directory is missing: $testRoot"
}

$testFiles = @(
    Get-ChildItem -LiteralPath $testRoot -File -Filter '*.test.mjs' |
        Sort-Object -Property Name
)
$discoveredNames = @($testFiles | ForEach-Object { $_.Name })
$missingBaseline = @($requiredBaseline | Where-Object { $discoveredNames -notcontains $_ })

if ($missingBaseline.Count -gt 0) {
    throw ('Required extension test files are missing: ' + ($missingBaseline -join ', '))
}
if ($testFiles.Count -lt $requiredBaseline.Count) {
    throw "Extension test discovery regressed: discovered $($testFiles.Count), baseline requires $($requiredBaseline.Count)."
}

Write-Host "EXTENSION_TEST_DISCOVERY discovered=$($testFiles.Count); baseline=$($requiredBaseline.Count)"
foreach ($testFile in $testFiles) {
    Write-Host "EXTENSION_TEST_FILE $($testFile.Name)"
}

$relativeTestPaths = @(
    $testFiles | ForEach-Object { Join-Path '.\tests\extension' $_.Name }
)

Push-Location $repositoryRoot
try {
    & node --test @relativeTestPaths
    $nodeExitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}

if ($nodeExitCode -ne 0) {
    throw "Extension test suite failed with node exit code $nodeExitCode."
}

Write-Host "EXTENSION_TEST_EXECUTION executed=$($testFiles.Count); result=pass"
