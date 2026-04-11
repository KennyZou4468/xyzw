@echo off

if exist .\xzyw_web_helper.docker (
	docker load -i .\xzyw_web_helper.docker
)

docker rm -f xyzw-web-local >nul 2>nul
docker run -d --name xyzw-web-local ^
	-p 127.0.0.1:8080:80 ^
	--restart unless-stopped ^
	xyzw-web:local