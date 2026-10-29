$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$results = New-Object 'System.Collections.Generic.List[object]'
try {
    # Accept only the installed desktop package registered to this Windows user.
    $packages = 'Registry::HKEY_CLASSES_ROOT\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages'
    $executables = @(Get-ChildItem $packages | Where-Object { $_.PSChildName -like 'OpenAI.Codex_*__2p2nqsd0c76g0' } | ForEach-Object {
        $installation = (Get-ItemProperty $_.PSPath).PackageRootFolder
        if ($installation) { [System.IO.Path]::GetFullPath((Join-Path $installation 'app\ChatGPT.exe')) }
    })
    if ($executables.Count -eq 0) { throw 'No registered desktop package' }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CodexConnectPipeOwner {
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint processId);
}
'@ | Out-Null
    # These are existing OS-published endpoints, never generated or guessed names.
    $pipes = @([System.IO.Directory]::GetFiles('\\.\pipe\') | Where-Object {
        $_ -match '^\\\\\.\\pipe\\codex-browser-use-[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'
    } | Select-Object -First 32)
    foreach ($path in $pipes) {
        $client = $null
        try {
            $name = $path.Substring('\\.\pipe\'.Length)
            $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $name, [System.IO.Pipes.PipeDirection]::InOut)
            $client.Connect(200)
            [uint32]$serverPid = 0
            if (-not [CodexConnectPipeOwner]::GetNamedPipeServerProcessId($client.SafePipeHandle.DangerousGetHandle(), [ref]$serverPid)) { continue }
            $server = [System.Diagnostics.Process]::GetProcessById([int]$serverPid)
            $image = [System.IO.Path]::GetFullPath($server.MainModule.FileName)
            if ($executables -notcontains $image) { continue }
            $results.Add([pscustomobject]@{pipePath=$path;serverPid=$serverPid})
        } catch {} finally { if ($null -ne $client) { $client.Dispose() } }
    }
} catch {}
ConvertTo-Json -InputObject $results.ToArray() -Compress
