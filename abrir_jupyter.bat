@echo off
title Abrir Cuaderno Jupyter - StockVision AI
echo ========================================================
echo   Abriendo Cuaderno Jupyter (Entrenamiento IA)
echo ========================================================
echo.

cd notebook
jupyter notebook Clasificador_Productos_Inventario.ipynb

if errorlevel 1 (
    echo.
    echo [AVISO] Jupyter no parece estar instalado en tu Python global.
    echo Puedes instalarlo ejecutando: pip install jupyter notebook
    echo o puedes abrir el archivo .ipynb directamente en VS Code.
    echo.
    pause
)
