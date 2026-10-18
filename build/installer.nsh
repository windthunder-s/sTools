!macro customInstall
  FileOpen $0 "$INSTDIR\resources\.ztools-nsis-installed" w
  FileWrite $0 "electron-updater-nsis"
  FileClose $0
!macroend

!macro customUnInstall
  # 覆盖升级也会执行卸载段，仅在用户主动卸载时清理开机启动项。
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${APP_ID}"

  ${endIf}
!macroend
