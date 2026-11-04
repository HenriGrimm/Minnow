!macroundef StartApp
!macro StartApp
  Call MinnowStartAfterUpdate
!macroend

; UAC syncs $INSTDIR and the registers, not arbitrary global variables such
; as $appExe. Launch from the original user's process, never the admin one.
Function MinnowLaunchAsOriginalUser
  ClearErrors
  Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --updated'
  StrCpy $0 "ok"
  ${If} ${Errors}
    StrCpy $0 "error"
  ${EndIf}
FunctionEnd

Function MinnowStartAfterUpdate
  Push $0
  Push $1
  StrCpy $1 0
  minnowLaunchRetry:
    ${If} ${UAC_IsInnerInstance}
      StrCpy $0 "error"
      !insertmacro UAC_AsUser_Call Function MinnowLaunchAsOriginalUser ${UAC_SYNCREGISTERS}|${UAC_SYNCINSTDIR}
    ${Else}
      ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" "--updated"
    ${EndIf}
    ${If} $0 == "ok"
    ${OrIf} $0 == "fallback"
      Goto minnowLaunchDone
    ${EndIf}
    ; A timeout may already have created a process. Don't blindly retry it.
    ${If} $0 == "error"
    ${OrIf} $0 == "not_found"
      IntOp $1 $1 + 1
      ${If} $1 < 3
        Sleep 1000
        Goto minnowLaunchRetry
      ${EndIf}
    ${EndIf}
    MessageBox MB_OK|MB_ICONEXCLAMATION|MB_TOPMOST "Minnow was updated, but Windows could not reopen it ($0). Please open Minnow from the Start menu."
  minnowLaunchDone:
  Pop $1
  Pop $0
FunctionEnd
