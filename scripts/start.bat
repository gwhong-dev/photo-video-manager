@echo off
rem 파일 위치: scripts/start.bat
rem 역할: git pull 한 뒤 더블클릭 한 번으로 설치 + 실행 (npm install 후 npm start)
chcp 65001 > nul
rem 이 파일이 있는 곳의 한 칸 위(프로젝트 폴더)로 이동. 한글이 든 경로도 따옴표로 감싸서 안전해요
cd /d "%~dp0.." || goto fail
call npm install || goto fail
call npm start || goto fail
exit /b 0

:fail
echo.
echo 실행하지 못했어요. 위에 나온 오류 메시지를 확인해 주세요.
pause
exit /b 1
