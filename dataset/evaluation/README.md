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

## Resultado observado (2026-10-15)

| Detector / motor | Escenas con detecciones sobre 0.30 | Mediana por análisis |
| --- | --- | --- |
| Lite MobileNet V2 / TF.js CPU | 6 de 12 | 5082.5 ms |
| MobileNet V2 / TF.js CPU | 6 de 12 | 9077 ms |
| YOLOv10 Nano / ONNX WASM, con reintento girado | 8 de 12 | 785.5 ms |

Los primeros dos están en `results.json`; YOLO está en `yolo-results.json`. No son porcentajes de exactitud. La imagen lateral `10.jpg` se recuperó con el reintento girado. Las imágenes `20.jpeg` y `40.jpeg` aún no superaron el umbral. No se ha evaluado la cámara de un teléfono real.

Se verificó además la página real con `SMOKE_APP=1`: inicializa YOLO, registra `16.jpeg` una sola vez y un escaneo manual posterior no duplica el registro, sin errores JavaScript no controlados. `BENCHMARK_MODELS=yolov10n` permite ejecutar solo YOLO; `BENCHMARK_BACKEND` elige el backend de TensorFlow (CPU por defecto).
