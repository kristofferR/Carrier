; Chatpane was called Carrier. Tauri's installer keys the install folder,
; uninstall entry and shortcuts on the product name, so installing Chatpane over
; Carrier would leave the old copy beside it. After Chatpane is in place, this
; removes Carrier's copy and its entries.
;
; The old uninstaller runs with /UPDATE, which keeps Carrier's data and its
; "Carrier" Run value, and stops a running Carrier. On its first launch the app
; moves that data to Chatpane's identifier and the startup entry to "Chatpane".
;
; This file is included before the installer defines its names, so the keys
; are spelled out inside the macro, which expands where it is inserted.
!macro NSIS_HOOK_POSTINSTALL
  ; IsShortcutTarget and SetLnkAppUserModelId use $0 to $5.
  Push $R8
  Push $R9
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5

  ReadRegStr $R8 SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\Carrier" "UninstallString"
  ReadRegStr $R9 SHCTX "Software\${MANUFACTURER}\Carrier" ""
  ${If} $R8 != ""
    ; Installing into Carrier's own folder already replaced its files, and its
    ; uninstaller would now delete Chatpane's.
    ${If} $R9 != ""
    ${AndIf} $R9 != $INSTDIR
      ExecWait '$R8 /S /UPDATE _?=$R9'
      Delete "$R9\uninstall.exe"
      RMDir "$R9"
    ${EndIf}
    DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\Carrier"
  ${EndIf}

  ${If} $R9 != ""
    ; Put Chatpane shortcuts where Carrier's were. An update only refreshes
    ; shortcuts that already exist, so it wouldn't create these itself.
    ; Carrier's executable was carrier.exe.
    !insertmacro IsShortcutTarget "$SMPROGRAMS\Carrier.lnk" "$R9\carrier.exe"
    Pop $0
    ${If} $0 = 1
      Delete "$SMPROGRAMS\Carrier.lnk"
      CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}
    !insertmacro IsShortcutTarget "$DESKTOP\Carrier.lnk" "$R9\carrier.exe"
    Pop $0
    ${If} $0 = 1
      Delete "$DESKTOP\Carrier.lnk"
      CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
    ; A taskbar pin keeps working once it points at the new copy.
    !insertmacro IsShortcutTarget "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Carrier.lnk" "$R9\carrier.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro SetShortcutTarget "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Carrier.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    ${EndIf}

    DeleteRegKey SHCTX "Software\${MANUFACTURER}\Carrier"
    DeleteRegValue HKCU "Software\${MANUFACTURER}\Carrier" "Installer Language"
    DeleteRegKey /ifempty HKCU "Software\${MANUFACTURER}\Carrier"
  ${EndIf}

  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  Pop $R9
  Pop $R8
!macroend
