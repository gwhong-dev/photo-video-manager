@echo off
rem 파일 위치: scripts/build-exe.bat
rem 역할: git pull 한 뒤 더블클릭 한 번으로 exe 만들기 + 바탕화면 바로가기 만들기
rem   결과: 프로젝트 폴더\release\win-unpacked\photo-video-manager.exe (폴더째 있어야 켜져요)
rem   설정과 갤러리 목록은 예전처럼 %APPDATA%\photo-video-manager 를 그대로 써요
chcp 65001 > nul
rem 이 파일이 있는 곳의 한 칸 위(프로젝트 폴더)로 이동. 한글이 든 경로도 따옴표로 감싸서 안전해요
cd /d "%~dp0.." || goto fail

rem 프로그램이 켜져 있으면 exe 파일을 덮어쓸 수 없어서 먼저 끄도록 알려요
tasklist /FI "IMAGENAME eq photo-video-manager.exe" | find /I "photo-video-manager.exe" > nul
if not errorlevel 1 (
  echo 사진 영상 정리 프로그램이 켜져 있어요. 프로그램을 끈 뒤 다시 더블클릭해 주세요.
  pause
  exit /b 1
)

call npm install || goto fail
call npm run dist || goto fail

rem 바탕화면에 바로가기를 만들어요 (이미 있으면 새로 덮어써요)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$exe = Join-Path (Get-Location) 'release\win-unpacked\photo-video-manager.exe'; $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) '사진 영상 정리.lnk'; $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk); $s.TargetPath = $exe; $s.WorkingDirectory = Split-Path $exe; $s.Save(); Write-Host ('바로가기: ' + $lnk)" || goto fail

echo.
echo exe를 만들었어요. 바탕화면의 "사진 영상 정리"를 더블클릭하면 켜져요.
echo 위치: %CD%\release\win-unpacked\photo-video-manager.exe
pause
exit /b 0

:fail
echo.
echo exe를 만들지 못했어요. 위에 나온 오류 메시지를 확인해 주세요.
pause
exit /b 1
