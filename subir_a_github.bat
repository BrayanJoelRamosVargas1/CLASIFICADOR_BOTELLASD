@echo off
title Subir a GitHub - CLASIFICADOR_BOTELLASD
echo ========================================================
echo   Subiendo StockVision AI a tu repositorio:
echo   https://github.com/BrayanJoelRamosVargas1/CLASIFICADOR_BOTELLASD.git
echo ========================================================
echo.

git push -u origin main

if errorlevel 1 (
    echo.
    echo Si te sale la ventana de GitHub, dale clic a "Sign in with your browser" para confirmar.
    echo.
) else (
    echo.
    echo ========================================================
    echo   [EXITO TOTAL] Proyecto subido exitosamente a GitHub!
    echo   Repositorio: https://github.com/BrayanJoelRamosVargas1/CLASIFICADOR_BOTELLASD
    echo ========================================================
    echo.
    echo PASO FINAL PARA TU PAGINA WEB PUBLICA (GitHub Pages):
    echo 1. Abre este enlace:
    echo    https://github.com/BrayanJoelRamosVargas1/CLASIFICADOR_BOTELLASD/settings/pages
    echo 2. En 'Branch', selecciona 'main' y la carpeta '/ (root)'.
    echo 3. Haz clic en 'Save'.
    echo.
    echo En 1 minuto tu enlace quedara activo en:
    echo https://brayanjoelramosvargas1.github.io/CLASIFICADOR_BOTELLASD/
    echo.
)
pause
