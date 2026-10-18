# Estado actual de la aplicación (octubre de 2026)

La entrada de la aplicación es `index.html`, que carga `js/yolo-detector.js`, `js/bottle-detection.js` y `js/ecolens.js`. Los módulos `js/app.js`, `js/vision.js` y `js/inventory.js` pertenecen a una interfaz anterior y no se ejecutan desde esa entrada.

- Aplicación estática: HTML, CSS y JavaScript; no usa React ni un backend de inferencia.
- IA activa: **YOLOv10 Nano** preentrenado en COCO, con ONNX Runtime Web 1.20.1 / WebAssembly monohilo. Pesos locales en `models/yolov10n/model.onnx`, procedencia y licencia AGPL-3.0 en esa carpeta. TensorFlow.js y COCO-SSD se conservan solamente en el benchmark y los materiales anteriores.
- Solo se cuenta la clase `bottle`, desde un score de 0.30 y tras dos detecciones consecutivas. Ese score no equivale a una precisión medida del sistema.
- Filtrado de cajas y NMS compartidos con el banco de evaluación. No se descartan botellas únicamente por estar acostadas o por ocupar casi toda la imagen.
- Bucle secuencial con objetivo de 100 ms entre comienzos de análisis y pausa mínima de 16 ms. La frecuencia real depende del teléfono y del tiempo de inferencia. Si no hay una botella sobre el umbral, se hace una segunda pasada girada 90° y se convierten las coordenadas a la imagen original. No se garantizan 60 FPS de detección.
- Persistencia del inventario en localStorage; CSV y JSON disponibles.
- **Control Diario de Inventario y Ventas (Planilla con Foto):** Permite fijar el stock inicial del día (ej. `10` botellas), sincronizar automáticamente con el conteo en vivo de la cámara/IA (ej. `8` botellas restantes), calcular las unidades vendidas (`10 - 8 = 2 vendidas`) o reposición, y guardar el corte en base de datos local (`ecolens_daily_sheets_v1`) con miniatura fotográfica de evidencia, exportación a Excel (CSV UTF-8) e impresión de planilla.
- **Caso de Estudio Empresarial MANACO (`manaco/index.html`):** Incluye el entregable gerencial de 1 hoja (Estaciones 1 a 4 con el análisis de los 240 registros de comercio exterior de calzado 2020–2024, 3 gráficos e indicadores) más las 2 últimas hojas listas para imprimir (Rúbrica de Autoevaluación Estudiantil y Rúbrica de Evaluación del Docente).
- El material es una **estimación visual por color**, no una clasificación de material entrenada ni una identificación de marca.
- Los archivos Keras propios y el cuaderno se conservan como material de entrenamiento; sus pesos no intervienen en el detector activo. El script de entrenamiento existente genera ejemplos sintéticos y no acredita entrenamiento con fotografías reales.
- Se añadieron 12 fotografías reales, su licencia y procedencia para evaluación. No se ha reentrenado el modelo con ellas. Ver `dataset/evaluation/README.md` y el banco `tools/benchmark-bottles.cjs`.

Verificación local:

```powershell
node --test tests/*.test.cjs
python -m http.server 8080
```

Abrir `http://localhost:8080`. La cámara del teléfono necesita un contexto seguro HTTPS. El script `subir_a_github.bat` prepara un push a GitHub; publicar requiere subir los cambios a la rama que sirve GitHub Pages. Los cambios locales no actualizan por sí solos la página pública.

---

La documentación histórica siguiente describe el diseño inicial y puede diferir del código activo:

# StockVision AI — Clasificador Inteligente de Productos y Control de Inventario

Sistema de Visión por Computadora y Soporte a la Toma de Decisiones diseñado para la detección, clasificación y auditoría de inventario en tiempo real mediante cámaras de dispositivos móviles y navegadores web.

| Parámetro | Detalle |
| :--- | :--- |
| **Materia** | Sistemas de Soporte a la Toma de Decisiones |
| **Docente** | Ing. Jesús Bautista |
| **Entrega** | Jueves |
| **Arquitectura** | Edge AI (TensorFlow.js + MobileNet / CNN Convolucional) + Dashboard Reactivo |
| **Entorno de Notebook** | Jupyter Notebook (`notebook/Clasificador_Productos_Inventario.ipynb`) |
| **Dataset de referencia** | [Bottle Detection Dataset (Kaggle)](https://www.kaggle.com/datasets/diptosen/bottle-detection-dataset/data) |

---

## 🎯 1. Problema y Solución Desarrollada

El objetivo planteado por el docente consiste en crear un sistema capaz de leer productos con la cámara del celular (específicamente botellas de plástico, como el ejemplo de la botella de agua *Vital*), clasificarlos bajo la analogía canónica de **"Perros vs Gatos"** (clasificación supervisada binaria) y mantener un **conteo continuo y auditable de inventario**.

### ¿Qué aporta StockVision AI frente a proyectos convencionales?

1. **Diseño Empresarial e Industrial:** Interfaz moderna tipo Dashboard (SaaS), alejándose de interfaces infantiles y aportando valor profesional.
2. **Algoritmo de Debounce Espacial (Anti-Duplicados con IoU):** En una cámara a 30 FPS, un objeto quieto se registraría 30 veces por segundo. StockVision implementa cálculo de *Intersection over Union* (IoU > 0.35) para asegurar que una misma botella solo incremente el stock una vez mientras permanezca a la vista.
3. **Módulo de Liveness & Inspección Técnica (2D vs 3D):** Justificación científica integrada en la interfaz que explica por qué un clasificador 2D detecta tanto una botella real como su foto en pantalla, y cómo la visión por computadora industrial resuelve este reto mediante sensores de profundidad, paralaje óptico y análisis espectral.
4. **Exportación Empresarial:** Generación instantánea de reportes en CSV (compatible con Microsoft Excel con BOM UTF-8) y JSON estructurado.

---

## 🚀 2. Inicio Rápido (Cómo Ejecutar la Aplicación)

### Opción A: Servidor Local Rápido (PC o Celular)

La aplicación web corre directamente con cualquier servidor HTTP local:

```powershell
# En PowerShell desde la carpeta del proyecto:
cd C:\Users\ElCremosasWee\stockvision-ia\app
python -m http.server 8080
```

1. Abre tu navegador en: [http://localhost:8080](http://localhost:8080)
2. Para usarlo **desde tu celular**:
   - Conecta tu celular a la misma red Wi-Fi de tu computadora.
   - Abre en el navegador del celular la IP de tu PC: `http://TU_IP_LOCAL:8080` (ejemplo: `http://192.168.1.15:8080`).

### Opción B: Despliegue Gratis en GitHub Pages (Ideal para mostrar al profesor en el aula)

1. Sube esta carpeta a un nuevo repositorio de GitHub.
2. En GitHub: `Settings` -> `Pages` -> selecciona la rama `main` y la carpeta `/app` (o `/root`).
3. Te dará un enlace HTTPS público (ej. `https://tu-usuario.github.io/stockvision-ia/`) que abrirá la cámara en cualquier smartphone sin instalar nada.

---

## 🧪 3. Cuaderno de Entrenamiento (Jupyter Notebook)

Para presentar la parte de Machine Learning solicitada por el docente:

1. Abre tu terminal e inicia Jupyter:
   ```powershell
   cd C:\Users\ElCremosasWee\stockvision-ia\notebook
   jupyter notebook
   ```
2. Abre el archivo **`Clasificador_Productos_Inventario.ipynb`**.
3. El cuaderno incluye:
   - Carga y Data Augmentation sobre el dataset de Kaggle.
   - Definición de la CNN profunda con capas `Conv2D`, `BatchNormalization`, `Dropout` y `Dense(1, sigmoid)`.
   - Curvas de exactitud (`Accuracy`) y pérdida (`Binary Crossentropy`).
   - Algoritmo de decisión de inventario con matrices de solapamiento IoU.

---

## 📚 4. Guía de Defensa Técnica ante el Docente

Cuando el docente o el tribunal pregunte sobre el proyecto, tienes estas respuestas de nivel senior preparadas:

### P: ¿Por qué el modelo detecta una botella si le muestro una foto en otro celular?
> **Respuesta Senior:** *"Los modelos convolucionales estándar (CNNs, MobileNet, YOLO) operan sobre planos proyectivos bidimensionales de píxeles RGB. Una fotografía en pantalla comparte exactamente los mismos contornos, proporciones geométricas y textura que el objeto físico. En la industria, para mitigar esto se aplican sensores de profundidad 3D (LiDAR o Time-of-Flight), paralaje de movimiento (optical flow) o detección de frecuencias de patrón Moiré generadas por pantallas LCD."* (Puedes abrir el botón **"Inspección 2D vs 3D"** en la web app para mostrar esto en vivo).

### P: ¿Cómo evita la aplicación contar 100 veces la misma botella?
> **Respuesta Senior:** *"Implementamos un rastreador espacial en memoria que calcula el IoU (Intersection over Union) entre fotogramas consecutivos. Si la detección actual se solapa más de un 35% con un objeto ya identificado y registrado, el sistema bloquea el incremento hasta que el objeto sale del encuadre por más de 1.2 segundos."*
