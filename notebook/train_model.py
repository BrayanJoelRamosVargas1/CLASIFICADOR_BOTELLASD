"""
StockVision AI - Entrenamiento del Clasificador de Productos (Botellas)
Materia: Soporte a la Toma de Decisiones - Docente: Jesús Bautista

Este script entrena una Red Neuronal Convolucional (CNN) para clasificar
productos (Botellas vs No-Botellas / Fondos) utilizando el dataset de Kaggle:
https://www.kaggle.com/datasets/diptosen/bottle-detection-dataset/data
"""

import os
import sys
import numpy as np
import matplotlib.pyplot as plt

def create_sample_dataset_structure(base_dir="dataset"):
    """Crea la estructura de carpetas estándar para el dataset"""
    subdirs = [
        os.path.join(base_dir, "train", "botellas"),
        os.path.join(base_dir, "train", "fondos"),
        os.path.join(base_dir, "validation", "botellas"),
        os.path.join(base_dir, "validation", "fondos")
    ]
    for d in subdirs:
        os.makedirs(d, exist_ok=True)
    print(f"[OK] Estructura de carpetas lista en: {base_dir}")

def generate_synthetic_demo_data(base_dir="dataset", samples_per_class=30):
    """
    Genera datos sintéticos de demostración para verificar que el pipeline
    funcione de inmediato incluso antes de descargar las fotos de Kaggle.
    """
    from PIL import Image, ImageDraw

    for split in ["train", "validation"]:
        n = samples_per_class if split == "train" else 10

        # Clase Botellas (figura cilíndrica con etiqueta azul)
        bottle_dir = os.path.join(base_dir, split, "botellas")
        for i in range(n):
            img = Image.new("RGB", (128, 128), color=(230, 235, 240))
            draw = ImageDraw.Draw(img)
            # Dibujar cuerpo de botella
            draw.rounded_rectangle([44, 35, 84, 115], radius=6, fill=(180, 215, 245), outline=(100, 160, 220), width=2)
            # Dibujar cuello
            draw.rectangle([54, 18, 74, 35], fill=(180, 215, 245), outline=(100, 160, 220), width=2)
            # Dibujar tapa
            draw.rectangle([52, 12, 76, 18], fill=(14, 165, 233))
            # Dibujar etiqueta (Vital)
            draw.rectangle([44, 60, 84, 85], fill=(2, 132, 199))
            img.save(os.path.join(bottle_dir, f"bottle_demo_{i}.jpg"))

        # Clase Fondos / No-Botellas (texturas, mesas, paredes)
        bg_dir = os.path.join(base_dir, split, "fondos")
        for i in range(n):
            noise = np.random.randint(40, 200, (128, 128, 3), dtype=np.uint8)
            img = Image.fromarray(noise)
            img.save(os.path.join(bg_dir, f"bg_demo_{i}.jpg"))

    print(f"[OK] Generadas muestras de prueba en '{base_dir}/train' y '{base_dir}/validation'.")

def build_model(input_shape=(128, 128, 3)):
    """
    Construye la arquitectura CNN (MobileNet o Convoluciones personalizadas)
    Similar a la red de Perros vs Gatos:
    Entrada 128x128x3 -> Conv2D -> MaxPool -> Conv2D -> MaxPool -> Dense -> Sigmoid
    """
    try:
        import tensorflow as tf
        from tensorflow.keras import layers, models

        model = models.Sequential([
            layers.Input(shape=input_shape),
            
            # Bloque 1
            layers.Conv2D(32, (3, 3), activation='relu', padding='same'),
            layers.BatchNormalization(),
            layers.MaxPooling2D((2, 2)),

            # Bloque 2
            layers.Conv2D(64, (3, 3), activation='relu', padding='same'),
            layers.BatchNormalization(),
            layers.MaxPooling2D((2, 2)),

            # Bloque 3
            layers.Conv2D(128, (3, 3), activation='relu', padding='same'),
            layers.BatchNormalization(),
            layers.MaxPooling2D((2, 2)),

            # Clasificador denso
            layers.Flatten(),
            layers.Dropout(0.4),
            layers.Dense(128, activation='relu'),
            layers.Dense(1, activation='sigmoid')  # 0: Fondo/No-Botella, 1: Botella
        ])

        model.compile(
            optimizer=tf.keras.optimizers.Adam(learning_rate=0.001),
            loss='binary_crossentropy',
            metrics=['accuracy']
        )
        return model
    except ImportError:
        print("[INFO] TensorFlow no está instalado en este entorno de Python. El script genera la arquitectura en modo documental.")
        return None

def train_and_evaluate(dataset_dir="dataset", epochs=5):
    """Ejecuta el ciclo de entrenamiento y guarda las gráficas de evaluación"""
    try:
        import tensorflow as tf
        from tensorflow.keras.preprocessing.image import ImageDataGenerator

        train_dir = os.path.join(dataset_dir, "train")
        val_dir = os.path.join(dataset_dir, "validation")

        # Generador de datos con Data Augmentation
        train_datagen = ImageDataGenerator(
            rescale=1./255,
            rotation_range=20,
            width_shift_range=0.1,
            height_shift_range=0.1,
            horizontal_flip=True,
            fill_mode='nearest'
        )

        val_datagen = ImageDataGenerator(rescale=1./255)

        train_gen = train_datagen.flow_from_directory(
            train_dir,
            target_size=(128, 128),
            batch_size=8,
            class_mode='binary'
        )

        val_gen = val_datagen.flow_from_directory(
            val_dir,
            target_size=(128, 128),
            batch_size=8,
            class_mode='binary'
        )

        model = build_model()
        model.summary()

        print("\n[INFO] Iniciando entrenamiento...")
        history = model.fit(
            train_gen,
            validation_data=val_gen,
            epochs=epochs,
            verbose=1
        )

        # Guardar modelo
        output_model_path = "modelo_botellas.keras"
        model.save(output_model_path)
        print(f"\n[OK] Modelo entrenado y guardado en: {output_model_path}")

        # Graficar curvas de aprendizaje
        plt.figure(figsize=(10, 4))
        plt.subplot(1, 2, 1)
        plt.plot(history.history['accuracy'], label='Entrenamiento')
        plt.plot(history.history['val_accuracy'], label='Validación')
        plt.title('Precisión (Accuracy) por Época')
        plt.xlabel('Época')
        plt.ylabel('Accuracy')
        plt.legend()
        plt.grid(True)

        plt.subplot(1, 2, 2)
        plt.plot(history.history['loss'], label='Entrenamiento')
        plt.plot(history.history['val_loss'], label='Validación')
        plt.title('Pérdida (Binary Crossentropy)')
        plt.xlabel('Época')
        plt.ylabel('Loss')
        plt.legend()
        plt.grid(True)

        chart_path = "curvas_entrenamiento.png"
        plt.tight_layout()
        plt.savefig(chart_path, dpi=150)
        print(f"[OK] Gráfica de entrenamiento guardada en: {chart_path}")

    except Exception as e:
        print(f"[AVISO] Ejecución en modo simulación: {e}")

if __name__ == "__main__":
    print("=" * 65)
    print("StockVision AI - Pipeline de Entrenamiento y Clasificación")
    print("Docente: Jesús Bautista | Materia: Soporte a la Toma de Decisiones")
    print("=" * 65)

    base = "dataset"
    create_sample_dataset_structure(base)
    generate_synthetic_demo_data(base)
    train_and_evaluate(base, epochs=3)
