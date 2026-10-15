@echo off
title Iniciar StockVision AI - Servidor Local
echo ========================================================
echo   Iniciando StockVision AI (Servidor Web Local)
echo ========================================================
echo.
echo Abriendo aplicacion en http://localhost:8080 ...
echo (Para acceder desde tu celular, usa la IP local de tu PC)
echo.

start http://localhost:8080
python -m http.server 8080

pause
