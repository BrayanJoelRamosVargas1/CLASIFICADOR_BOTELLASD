# YOLOv10 Small (Cuantizado UINT8 / INT8)

Pesos ONNX preentrenados en COCO, sin reentrenamiento local. Fuente: [onnx-community/yolov10s](https://huggingface.co/onnx-community/yolov10s), archivo `onnx/model_quantized.onnx` (7.4 MB, servido en `models/yolov10n/model.onnx` por compatibilidad de rutas).

Modelo original: [THU-MIG/YOLOv10](https://github.com/THU-MIG/yolov10). Licencia **AGPL-3.0**, conservada en LICENSE. La ficha del modelo convertido declara la misma licencia.

Contrato del adaptador: RGB float32 NCHW, rango 0–1, lado mayor de 640 píxeles conservando proporciones, relleno negro inferior/derecho. Salida `[1, N, 6]`: xmin, ymin, xmax, ymax, score, classId. La clase COCO `39` corresponde a bottle, filtrando candidatos donde otra clase COCO (ej. taza `41`, celular `67`, persona `0`, florero `75`, hidrante/cilindro `10`) obtenga mayor probabilidad sobre la misma caja (`IoU >= 0.70`).

La aplicación sirve los pesos desde este repositorio y utiliza ONNX Runtime Web 1.20.1 desde jsDelivr con ejecución en Web Worker (`ort.env.wasm.proxy = true`) y SIMD.

SHA-256 de model.onnx: `0be5b02c522e295e9820105f813e41993ae16d29b79eea4cb7de7e97058d85c7`.

