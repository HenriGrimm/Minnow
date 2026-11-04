; Override only the silent updater launch; keep the assisted Finish-page action.
!macro customHeader
  !ifndef BUILD_UNINSTALLER
    !include "${BUILD_RESOURCES_DIR}\update-launch.nsh"
  !endif
!macroend
