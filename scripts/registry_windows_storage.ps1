param([switch]$Cleanup)
$ErrorActionPreference = 'Stop'

function Invoke-DiskPart([string[]]$Commands) {
    $script = Join-Path $env:RUNNER_TEMP ("sharecut-diskpart-" + [guid]::NewGuid().ToString('N') + '.txt')
    try {
        $Commands | Set-Content -LiteralPath $script -Encoding ascii
        & "$env:SystemRoot\System32\diskpart.exe" /s $script
        if ($LASTEXITCODE -ne 0) { throw "Owned NTFS volume operation failed with status $LASTEXITCODE" }
    } finally {
        Remove-Item -LiteralPath $script -ErrorAction SilentlyContinue
    }
}

if ($Cleanup) {
    if (-not $env:SHARECUT_PROOF_VHD) { exit 0 }
    $image = [IO.Path]::GetFullPath($env:SHARECUT_PROOF_VHD)
    $parent = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
    if ([IO.Path]::GetDirectoryName($image) -ne $parent -or
        [IO.Path]::GetFileName($image) -notmatch '^sharecut-proof-[0-9a-f]{32}\.vhdx$') {
        throw 'Refusing cleanup of an unowned volume image'
    }
    if (Test-Path -LiteralPath $image) {
        if ((Get-DiskImage -ImagePath $image).Attached) {
            Invoke-DiskPart @("select vdisk file=`"$image`"", 'detach vdisk')
            if ((Get-DiskImage -ImagePath $image).Attached) { throw 'Owned volume remains attached' }
        }
        Remove-Item -LiteralPath $image
    }
    exit 0
}

$diagnostic = Join-Path $env:RUNNER_TEMP ("sharecut-ancestry-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $diagnostic | Out-Null
try {
    $env:SHARECUT_ANCESTRY_DIAGNOSTIC = $diagnostic
    python -c "import os; from pathlib import Path; from podcast_mcp.util.registry_backup_windows import BackupDirectory; d=BackupDirectory(Path(os.environ['SHARECUT_ANCESTRY_DIAGNOSTIC'])); d.close()"
    if ($LASTEXITCODE -ne 0) { Write-Host 'Ordinary runner storage failed production admission. Provisioning an owned NTFS volume.' }
} finally {
    Remove-Item -LiteralPath $diagnostic
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SharecutDriveNames {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern uint QueryDosDevice(string name, char[] target, int size);
}
'@
$letter = $null
foreach ($candidate in [char[]]'ZYXWVUTSRQPONMLKJIHGFED') {
    $name = [string]$candidate
    $buffer = New-Object char[] 32768
    $count = [SharecutDriveNames]::QueryDosDevice("${name}:", $buffer, $buffer.Length)
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($count -eq 0 -and $code -eq 2 -and -not (Get-PSDrive -Name $name -ErrorAction SilentlyContinue)) {
        $letter = $name
        break
    }
}
if (-not $letter) { throw 'No unused drive letter for owned NTFS proof storage' }

$image = Join-Path $env:RUNNER_TEMP ("sharecut-proof-" + [guid]::NewGuid().ToString('N') + '.vhdx')
"SHARECUT_PROOF_VHD=$image" | Add-Content -LiteralPath $env:GITHUB_ENV
$env:SHARECUT_PROOF_VHD = $image
Invoke-DiskPart @(
    "create vdisk file=`"$image`" maximum=2048 type=expandable",
    "select vdisk file=`"$image`"",
    'attach vdisk',
    'create partition primary',
    'format fs=ntfs quick label=SharecutProof',
    "assign letter=$letter"
)
$disk = Get-DiskImage -ImagePath $image | Get-Disk
$partition = $disk | Get-Partition | Where-Object DriveLetter -eq $letter
if (-not $partition -or (Get-Volume -DriveLetter $letter).FileSystem -ne 'NTFS') {
    throw 'Owned image is not mounted at the selected NTFS drive'
}

$root = "${letter}:\"
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($owner)
$acl.SetAccessRuleProtection($true, $false)
$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
foreach ($sid in @($owner.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $trustee = New-Object Security.Principal.SecurityIdentifier($sid)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        $trustee, 'FullControl', $inherit, 'None', 'Allow'
    )
    $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $root -AclObject $acl
$proof = Join-Path $root 'proof'
New-Item -ItemType Directory -Path $proof | Out-Null
Set-Acl -LiteralPath $proof -AclObject $acl
$env:SHARECUT_PROOF_ROOT = $proof
python -c "import os; from pathlib import Path; from podcast_mcp.util.registry_backup_windows import BackupDirectory; from podcast_mcp.edits.share_registry import SqliteShareRegistry; p=Path(os.environ['SHARECUT_PROOF_ROOT']); d=BackupDirectory(p); d.close(); r=SqliteShareRegistry(p/'preflight'/'registry.sqlite'); assert len(r.recording_key_secret()) == 32; r.close(); print('Owned NTFS ancestry and source admission passed')"
if ($LASTEXITCODE -ne 0) { throw 'Owned NTFS storage failed production admission' }
@(
    "SHARECUT_PROOF_ROOT=$proof",
    "PODCAST_SHARE_IDENTITY=$(Join-Path $proof 'identity.sqlite')",
    "PODCAST_MCP_CACHE=$(Join-Path $proof 'cache')"
) | Add-Content -LiteralPath $env:GITHUB_ENV
