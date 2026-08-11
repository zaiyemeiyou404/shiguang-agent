!macro customUnInstall
  DetailPrint "Removing Shiguang Agent data..."

  ; New data location used by packaged builds.
  RMDir /r "$INSTDIR\shiguang-agent-data"

  ; Legacy locations used by earlier builds before userData was redirected.
  RMDir /r "$APPDATA\shiguang-agent"
  Delete "$APPDATA\Electron\shiguang-state.sqlite"
  Delete "$APPDATA\Electron\shiguang-state.sqlite-shm"
  Delete "$APPDATA\Electron\shiguang-state.sqlite-wal"
  Delete "$APPDATA\Electron\shiguang-state.sqlite-journal"
  Delete "$APPDATA\Electron\shiguang-store.json"
  Delete "$APPDATA\Electron\shiguang.config.json"
!macroend
