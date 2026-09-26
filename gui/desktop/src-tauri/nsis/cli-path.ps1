param(
  [Parameter(Mandatory = $true)][ValidateSet('add', 'remove')][string]$Action,
  [Parameter(Mandatory = $true)][string]$InstallDir
)

$ErrorActionPreference = 'Stop'
$marker = Join-Path $InstallDir '.sharecut-cli-path-added'
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if ($null -eq $key) { throw 'Current user Environment registry key is unavailable' }
$changed = $false
try {
  $current = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $kind = if ($null -eq $key.GetValue('Path', $null)) {
    [Microsoft.Win32.RegistryValueKind]::ExpandString
  } else {
    $key.GetValueKind('Path')
  }
  $entries = @($current -split ';' | Where-Object { $_ -ne '' })
  $normalized = $InstallDir.TrimEnd('\', '/')
  $matches = @($entries | Where-Object { $_.TrimEnd('\', '/') -ieq $normalized })
  if ($Action -eq 'add') {
    if ($matches.Count -eq 0) {
      $next = (@($entries) + $InstallDir) -join ';'
      $key.SetValue('Path', $next, $kind)
      [System.IO.File]::WriteAllText($marker, $normalized)
      $changed = $true
    }
  } elseif (Test-Path -LiteralPath $marker) {
    $owned = [System.IO.File]::ReadAllText($marker)
    if ($owned -ieq $normalized) {
      $next = @($entries | Where-Object { $_.TrimEnd('\', '/') -ine $normalized }) -join ';'
      $key.SetValue('Path', $next, $kind)
      $changed = $true
    }
    Remove-Item -LiteralPath $marker -Force
  }
} finally {
  $key.Dispose()
}
if ($changed) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SharecutEnvironmentChange {
  [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wparam,
    string lparam, uint flags, uint timeout, out IntPtr result);
}
'@
  $result = [IntPtr]::Zero
  [void][SharecutEnvironmentChange]::SendMessageTimeout([IntPtr]0xffff, 0x1a,
    [IntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
}
