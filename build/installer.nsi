; 垂直摄像头工作室 —— NSIS 安装包脚本
; 用法：makensis build/installer.nsi（PROJECT_DIR 按实际项目路径调整）
; 依赖：release/win-unpacked/（由 electron-builder --dir 生成）
; 这是 electron-builder 内置 NSIS 流程之外的备用构建方式：不执行交互式安装程序，
; 适合无头/受限环境；安装、卸载、快捷方式与注册表卸载信息一应俱全。

!define PROJECT_DIR "H:\tmp\vert-cam-studio"

Unicode true
; 用非 solid 的 zlib 压缩：SOLID lzma 在部分机器上解压超大载荷(300MB+)到临时目录时
; 会触发 "Error writing temporary file. Make sure your temp folder is valid."
; zlib 分块压缩对临时目录压力小、兼容性更好，代价是安装包略大。
SetCompressor zlib

!include "MUI2.nsh"

!define APP_NAME       "垂直摄像头工作室"
!define APP_EXE        "垂直摄像头工作室.exe"
!define APP_VERSION    "0.1.0"
!define APP_PUBLISHER  "Vertical Cam Studio"
!define UNINST_KEY     "Software\Microsoft\Windows\CurrentVersion\Uninstall\VerticalCamStudio"

Name "${APP_NAME} ${APP_VERSION}"
OutFile "${PROJECT_DIR}\release\垂直摄像头工作室 Setup ${APP_VERSION}.exe"
InstallDir "$LOCALAPPDATA\${APP_NAME}"
InstallDirRegKey HKCU "${UNINST_KEY}" "InstallLocation"
RequestExecutionLevel user

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

Section "安装 ${APP_NAME}"
  SetOutPath "$INSTDIR"
  File /r "${PROJECT_DIR}\release\win-unpacked\*.*"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; 桌面与开始菜单快捷方式
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\卸载.lnk" "$INSTDIR\uninstall.exe"

  ; 注册到「应用和功能」，支持从系统设置卸载
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE},0"
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\uninstall.exe"
  RMDir /r "$INSTDIR"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\卸载.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd
