; Tauri invokes these hooks after files are copied and before files are removed.
; PATH exposure is a per-user opt-in. Silent installs leave PATH untouched.
!macro NSIS_HOOK_POSTINSTALL
  IfSilent sharecut_cli_path_done
  MessageBox MB_YESNO|MB_DEFBUTTON2 "Add Sharecut CLI commands (podcast and podcast-mcp) to your user PATH?" IDNO sharecut_cli_path_done
  nsExec::ExecToStack 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\cli-path.ps1" -Action add -InstallDir "$INSTDIR"'
  Pop $0
  Pop $1
  StrCmp $0 "0" sharecut_cli_path_done
  MessageBox MB_OK|MB_ICONEXCLAMATION "Could not add Sharecut CLI commands to PATH: $1"
  sharecut_cli_path_done:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; The script removes only a path entry added by this installer.
  nsExec::ExecToStack 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\cli-path.ps1" -Action remove -InstallDir "$INSTDIR"'
  Pop $0
  Pop $1
!macroend
