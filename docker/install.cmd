@echo off
setlocal

set ROOT_DIR=%~dp0..
pushd %ROOT_DIR%

if exist .\xzyw_web_helper.docker (
	docker load -i .\xzyw_web_helper.docker
)

npm run build
docker rm -f xyzw-web-local >nul 2>nul
docker rm -f xyzw-scheduler-local >nul 2>nul
docker compose up -d --build web scheduler

echo Web URL: http://127.0.0.1:8080
echo Scheduler API: http://127.0.0.1:8090/api/scheduler/health

popd
endlocal