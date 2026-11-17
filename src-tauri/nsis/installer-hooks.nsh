!macro NSIS_HOOK_PREINSTALL
  ; Keep upgrades in the existing Tauri installation directory, even if the
  ; directory page was changed. This avoids creating another app copy.
  ReadRegStr $R4 HKCU "Software\JMJAJ\Mi Theme Studio" ""
  ReadRegStr $R5 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mi Theme Studio" "UninstallString"
  ${If} $R4 != ""
    StrCpy $INSTDIR $R4
    SetOutPath $INSTDIR
  ${ElseIf} $R5 != ""
    MessageBox MB_OK|MB_ICONSTOP "Mi Theme Studio is registered as installed, but its install location could not be found. Repair or uninstall the existing copy before updating."
    Abort
  ${Else}
    ; Migrate the previous Electron release from electron-builder's default
    ; per-user install location. Its user data is outside this directory and
    ; is left untouched by its uninstaller.
    StrCpy $R6 "$LOCALAPPDATA\Programs\Mi Theme Studio"
    StrCpy $R7 0
    legacy_uninstall_enum:
      EnumRegKey $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $R7
      StrCmp $R0 "" legacy_uninstall_done
      IntOp $R7 $R7 + 1

      ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R0" "DisplayName"
      StrCpy $R2 $R1 16
      StrCmp $R2 "Mi Theme Studio " 0 legacy_uninstall_enum
      ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R0" "Publisher"
      StrCmp $R1 "JMJAJ" 0 legacy_uninstall_enum
      ReadRegStr $R2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R0" "QuietUninstallString"
      StrCmp $R2 "" legacy_uninstall_unsafe
      StrCpy $R3 '"$R6\Uninstall Mi Theme Studio.exe"'
      StrCpy $R3 "$R3 /currentuser /S"
      StrCmp $R2 $R3 0 legacy_uninstall_unsafe
      IfFileExists "$R6\Uninstall Mi Theme Studio.exe" 0 legacy_uninstall_unsafe

      ; Leave the legacy directory before running its uninstaller so Windows
      ; can remove the directory. Then install Tauri at that same location.
      SetOutPath "$TEMP"
      ExecWait '$R2' $R3
      ${If} $R3 != 0
        Goto legacy_uninstall_failed
      ${EndIf}
      IfFileExists "$R6\Mi Theme Studio.exe" legacy_uninstall_failed
      ; Some NSIS uninstallers defer removing their own executable until exit.
      Delete "$R6\Uninstall Mi Theme Studio.exe"
      IfFileExists "$R6\Uninstall Mi Theme Studio.exe" legacy_uninstall_failed
      DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R0"

      StrCpy $INSTDIR $R6
      SetOutPath $INSTDIR
      Goto legacy_uninstall_done

    legacy_uninstall_unsafe:
      MessageBox MB_OK|MB_ICONSTOP "A previous Mi Theme Studio install was found, but its quiet uninstaller could not be verified. Remove the old copy from Windows Settings before installing this update."
      Abort

    legacy_uninstall_failed:
      MessageBox MB_OK|MB_ICONSTOP "The previous Mi Theme Studio install could not be removed. Close it and retry, or remove it from Windows Settings before installing this update."
      Abort

    legacy_uninstall_done:
      ; Also catch a leftover legacy directory with no matching registry entry;
      ; installing beside it would create two copies.
      IfFileExists "$R6\Mi Theme Studio.exe" 0 legacy_no_orphan
      MessageBox MB_OK|MB_ICONSTOP "A previous Mi Theme Studio copy remains at $R6 but has no usable uninstall entry. Remove it before installing this update."
      Abort
    legacy_no_orphan:
      SetOutPath $INSTDIR
  ${EndIf}
  ; adb or scrcpy started from this install keeps AdbWinApi.dll and other
  ; files open, so stop them before files are replaced.
  IfFileExists "$INSTDIR\scrcpy\adb.exe" 0 mts_no_bundled_adb
    nsExec::Exec '"$INSTDIR\scrcpy\adb.exe" kill-server'
    Pop $R8
  mts_no_bundled_adb:
  nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process adb,scrcpy -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like '$INSTDIR\*' } | Stop-Process -Force"`
  Pop $R8
  Sleep 500
!macroend
