# YOLOv10 Nano

Pesos ONNX preentrenados en COCO, sin reentrenamiento local. Fuente: [onnx-community/yolov10n](https://huggingface.co/onnx-community/yolov10n), revisión `57657320425ee34056408a57ad9d29c4d4815bd8`, archivo `onnx/model.onnx`.

Modelo original: [THU-MIG/YOLOv10](https://github.com/THU-MIG/yolov10). Licencia **AGPL-3.0**, conservada en LICENSE. La ficha del modelo convertido declara la misma licencia.

Contrato del adaptador: RGB float32 NCHW, rango 0–1, lado mayor de 640 píxeles conservando proporciones, relleno negro inferior/derecho. Salida `[1, N, 6]`: xmin, ymin, xmax, ymax, score, classId. La clase COCO `39` corresponde a bottle. Referencias de contrato: `preprocessor_config.json`, `config.json` y ejemplo de la ficha de la revisión indicada.

La aplicación sirve los pesos desde este repositorio y utiliza ONNX Runtime Web 1.20.1 desde jsDelivr. WASM monohilo funciona sin cabeceras de aislamiento entre orígenes de GitHub Pages.

SHA-256 de model.onnx: `a77dd863933f184a19e84361c64b788228a7c7dacc2c78939239a96ad3efca3b`.
