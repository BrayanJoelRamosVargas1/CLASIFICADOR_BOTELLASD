@echo off
title Iniciar StockVision AI - Servidor Local
echo ========================================================
echo   Iniciando StockVision AI (Servidor Web Local)
echo ========================================================
echo.
echo Abriendo aplicacion en http://localhost:8080 ...
echo (Servidor optimizado con cabeceras COOP/COEP para maximo rendimiento IA)
echo.

start http://localhost:8080
python serve.py 8080

pause
