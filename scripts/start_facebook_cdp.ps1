[CmdletBinding()]
param(
    [int]$Port = 9222,
    [string]$ProfileDir = (Join-Path $env:USERPROFILE ".codex\browser-profiles\facebook-cdp"),
    [string]$ChromePath,
    [ValidateRange(1, 60)][int]$WaitSeconds = 15
)

$ErrorActionPreference = "Stop"
$ProfileDir = [System.IO.Path]::GetFullPath($ProfileDir)

function Write-Result([hashtable]$Value, [int]$ExitCode = 0) {
    $Value | ConvertTo-Json -Compress -Depth 6
    exit $ExitCode
}

function Get-ProfileProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and $_.CommandLine.IndexOf($ProfileDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    })
}

function Test-Cdp {
    try {
        $value = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
        return [bool]$value.webSocketDebuggerUrl
    } catch { return $false }
}

if (Test-Cdp) {
    $owners = Get-ProfileProcesses
    if ($owners.Count -eq 0) {
        Write-Result @{status="port_in_use_by_other_profile"; port=$Port; profile_dir=$ProfileDir; started=$false; reason="CDP port is active but not owned by the dedicated Facebook profile."} 3
    }
    Write-Result @{status="ready"; port=$Port; profile_dir=$ProfileDir; already_listening=$true; started=$false; process_ids=@($owners.ProcessId)}
}

$locked = Get-ProfileProcesses
if ($locked.Count -gt 0) {
    Write-Result @{status="profile_locked"; port=$Port; profile_dir=$ProfileDir; started=$false; process_ids=@($locked.ProcessId); action="Close only the dedicated Facebook CDP Chrome window, then rerun."} 4
}

if (-not $ChromePath) {
    $ChromePath = @(
        (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
        (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
}
if (-not $ChromePath) {
    Write-Result @{status="chrome_not_found"; port=$Port; profile_dir=$ProfileDir; started=$false} 2
}

New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
$arguments = @(
    "--remote-debugging-port=$Port",
    "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=`"$ProfileDir`"",
    "--no-first-run",
    "--no-default-browser-check",
    "https://www.facebook.com/"
)
$process = Start-Process -FilePath $ChromePath -ArgumentList $arguments -PassThru
for ($second = 1; $second -le $WaitSeconds; $second++) {
    Start-Sleep -Seconds 1
    if (Test-Cdp) {
        Write-Result @{status="ready"; port=$Port; profile_dir=$ProfileDir; already_listening=$false; started=$true; process_id=$process.Id; waited_seconds=$second}
    }
}
Write-Result @{status="cdp_not_listening"; port=$Port; profile_dir=$ProfileDir; started=$true; process_id=$process.Id; reason="Chrome did not expose CDP within $WaitSeconds seconds."} 5
