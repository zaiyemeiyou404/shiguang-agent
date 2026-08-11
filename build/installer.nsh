!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "Do you also want to delete local conversations, memories, settings, caches, and legacy AppData files?$\r$\n$\r$\nChoose Yes for a clean uninstall.$\r$\nChoose No to keep data for a later reinstall." IDYES deleteShiguangData IDNO keepShiguangData

  keepShiguangData:
    DetailPrint "Keeping Shiguang Agent data."
    Goto shiguangDataDone

  deleteShiguangData:
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

  shiguangDataDone:
!macroend
