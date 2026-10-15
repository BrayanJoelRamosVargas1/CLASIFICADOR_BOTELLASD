# Dataset de Botellas y Productos — StockVision AI

Este directorio alberga los datos de entrenamiento y validación para el clasificador de productos.

## 1. Dataset de Kaggle Utilizado

* **Nombre:** [Bottle Detection Dataset](https://www.kaggle.com/datasets/diptosen/bottle-detection-dataset/data)
* **Autor:** Dipto Sen (Kaggle)
* **Contenido:**
  * `bottles_closeups/`: Fotografías de botellas en primer plano.
  * `bottles_occluded/`: Fotografías de botellas con oclusiones parciales, sombras y manos sosteniéndolas.

## 2. Estructura de Clases Binarias (Análogo a "Perros vs Gatos")

```text
dataset/
├── train/
│   ├── botellas/      # Clase positiva: Fotos de botellas (Kaggle + fotos locales como Vital)
│   └── fondos/        # Clase negativa: Fondos de mesas, escritorios, paredes, teclados
└── validation/
    ├── botellas/      # 20% reservado para pruebas de evaluación
    └── fondos/        # 20% reservado para pruebas de evaluación
```

## 3. Descarga Rápida

1. Descarga el archivo `.zip` desde el enlace de Kaggle.
2. Descomprime las imágenes de botellas en `dataset/train/botellas/`.
3. Para la clase negativa (`fondos`), puedes colocar fotos de tu entorno de escritorio, mesas de aula o fondos variados para entrenar la discriminación visual.
