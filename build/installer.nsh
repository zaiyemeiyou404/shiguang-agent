!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除本地会话、记忆、设置、缓存以及旧版本 AppData 数据？$\r$\n$\r$\n选择“是”：干净卸载。$\r$\n选择“否”：保留数据，之后重装可继续使用。" IDYES deleteShiguangData IDNO keepShiguangData

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
