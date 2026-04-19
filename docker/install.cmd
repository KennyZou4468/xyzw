@echo off
setlocal

set ROOT_DIR=%~dp0..
pushd %ROOT_DIR%

if not exist .\server-runtime mkdir .\server-runtime
if not exist .\server-runtime\playwright-profile mkdir .\server-runtime\playwright-profile
if not exist .\server-runtime\scheduler.tasks.json copy .\server\scheduler.tasks.example.json .\server-runtime\scheduler.tasks.json >nul
if not exist .\server-runtime\scheduler.ui.logs.json echo []>.\server-runtime\scheduler.ui.logs.json
if not exist .\server-runtime\scheduler.log type nul>.\server-runtime\scheduler.log

if exist .\xzyw_web_helper.docker (
	docker load -i .\xzyw_web_helper.docker
)

docker rm -f xyzw-web-local >nul 2>nul
docker rm -f xyzw-scheduler-local >nul 2>nul
docker compose up -d --build web scheduler

echo Web URL: http://127.0.0.1:8080
echo Scheduler API: http://127.0.0.1:8090/api/scheduler/health
echo Scheduler Runtime Dir: %ROOT_DIR%\server-runtime

popd
endlocal
