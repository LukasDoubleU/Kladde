; NSIS hooks, wired up through bundle.windows.nsis.installerHooks in tauri.conf.json.

; Kladde registers itself for "Open with" and Windows' default apps from inside the app (per user). Ask the
; installed exe to take all of that out again before the uninstaller deletes it. An update runs the old
; uninstaller with /UPDATE and must keep the registration.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --unregister-integration'
  ${EndIf}
!macroend
