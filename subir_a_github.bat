@echo off
title Subir Proyecto a GitHub - StockVision AI
echo ========================================================
echo   Subiendo StockVision AI a GitHub (Usuario: brayanjoelrv)
echo ========================================================
echo.
echo Recuerda haber creado el repositorio vacio previamente en:
echo https://github.com/new
echo.
set /p REPO_NAME="Escribe el nombre del repositorio (ej. stockvision-ia o reciclaapp.io): "

git remote remove origin 2>nul
git remote add origin https://github.com/brayanjoelrv/%REPO_NAME%.git
git branch -M main
git push -u origin main

if errorlevel 1 (
    echo.
    echo [AVISO] Si fallo la subida, verifica:
    echo 1. Que hayas creado el repositorio en https://github.com/new con el nombre: %REPO_NAME%
    echo 2. Que no hayas marcado 'Add a README' en GitHub al crearlo (debe estar vacio).
    echo.
) else (
    echo.
    echo ========================================================
    echo   [EXITO] Proyecto subido exitosamente a GitHub!
    echo   Repositorio: https://github.com/brayanjoelrv/%REPO_NAME%
    echo ========================================================
    echo.
    echo Para activar la pagina web publica (GitHub Pages):
    echo 1. Abre: https://github.com/brayanjoelrv/%REPO_NAME%/settings/pages
    echo 2. En 'Branch', selecciona 'main' y la carpeta '/ (root)'.
    echo 3. Dale clic a 'Save'.
    echo.
    echo Tu enlace web quedara listo en:
    echo https://brayanjoelrv.github.io/%REPO_NAME%/
    echo.
)
pause
