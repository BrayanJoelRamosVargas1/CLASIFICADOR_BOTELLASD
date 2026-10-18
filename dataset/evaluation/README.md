# Evaluación con fotografías reales

12 imágenes originales de [Bottle Object Detection Dataset](https://github.com/rhiosutoyo/Bottle-Object-Detection-Dataset), carpeta RAW. Se conserva la licencia MIT del repositorio en LICENSE. El manifiesto registra la revisión exacta, URL y SHA-256 de cada archivo.

Referencia: F. S. P. Akbar, S. Y. P. Ginting, G. C. Wu, S. Achmad y R. Sutoyo, “Object Detection on Bottles Using the YOLO Algorithm”, ICORIS 2022, DOI: 10.1109/ICORIS56080.2022.10031554.

Estas imágenes se usan para **evaluación, no entrenamiento**. No se mezclan con los datos sintéticos del cuaderno. La muestra incluye botellas de bebida, un vaso térmico y un cilindro de gas; no todas son positivos válidos de botella PET. El repositorio de origen no proporciona cajas de referencia en RAW; por tanto, contar imágenes con detecciones **no mide precisión, recall ni mAP**. Faltan anotaciones, más negativos y escenas de la cámara del usuario para una evaluación completa.

## Reproducir

Requiere Node.js, Playwright y Microsoft Edge. Si Playwright está en el runtime incluido de Codex, establecer NODE_PATH a su carpeta node_modules.

```powershell
node tools/benchmark-bottles.cjs
node --test tests/bottle-detection.test.cjs
```

La comparación ejecuta Lite MobileNet V2, MobileNet V2 y YOLOv10 Nano con el mismo filtro que la aplicación. Redimensiona las imágenes conservando proporciones a un máximo de 640 píxeles. Guarda detecciones, cajas y tiempos por imagen. Los tiempos de Edge sin ventana en escritorio no representan el rendimiento de un teléfono. Los dos modelos de TensorFlow se midieron en CPU JavaScript; YOLO se ejecutó en WASM, así que la comparación de tiempos incluye tanto modelo como motor de ejecución.

## Resultado observado (2026-10-18)

| Detector / motor | Escenas con detecciones | Mediana por análisis |
| --- | --- | --- |
| Lite MobileNet V2 / TF.js CPU | 6 de 12 (umbral 0.30) | 5082.5 ms |
| MobileNet V2 / TF.js CPU | 6 de 12 (umbral 0.30) | 9077 ms |
| YOLOv10s Cuantizado / ONNX WASM SIMD + Web Worker + Filtro de Clase Dominante | **10 de 12** (10/10 botellas reales, 0/2 negativos) | **685 ms** (675 ms en 1 pasada) |

Los primeros dos están en `results.json`; YOLO está en `yolo-results.json`. De las 12 fotografías del conjunto, **10 contienen botellas reales** (`1.PNG`, `6.jpeg`, `10.jpg`, `15.jpeg`, `16.jpeg`, `18.jpeg`, `19.jpeg`, `20.jpeg`, `39.jpeg`, `40.jpeg`) y **todas (10/10) son detectadas correctamente**, mientras que las **2 fotografías negativas** (`17.jpeg` vaso térmico blanco y `21.jpeg` cilindro de gas rosa) dan **0 detecciones de botella**.

Se verificó además la página real con `SMOKE_APP=1`: inicializa YOLO, registra `16.jpeg` una sola vez y un escaneo manual posterior no duplica el registro, sin errores JavaScript no controlados. `BENCHMARK_MODELS=yolov10n` permite ejecutar solo YOLO; `BENCHMARK_BACKEND` elige el backend de TensorFlow (CPU por defecto).
