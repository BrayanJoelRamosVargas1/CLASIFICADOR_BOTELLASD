/**
 * StockVision AI - Módulo de Gestión de Inventario
 * Manejo de estado, persistencia local (LocalStorage), métricas y exportación
 */

class InventoryManager {
  constructor(storageKey = 'stockvision_inventory_v1') {
    this.storageKey = storageKey;
    this.items = this.load();
    this.subscribers = [];
  }

  // Carga inicial desde LocalStorage
  load() {
    try {
      const data = localStorage.getItem(this.storageKey);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      console.error('Error al cargar inventario de LocalStorage:', e);
      return [];
    }
  }

  // Guardado seguro
  save() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.items));
      this.notify();
    } catch (e) {
      console.error('Error al guardar inventario:', e);
    }
  }

  // Suscribir observadores para reactividad UI
  subscribe(callback) {
    this.subscribers.push(callback);
    callback(this.items, this.getMetrics());
  }

  notify() {
    const metrics = this.getMetrics();
    this.subscribers.forEach(cb => cb(this.items, metrics));
  }

  // Registro de nuevo producto detectado
  registerDetection({ label, category = 'Envases / Bebidas', confidence, thumbnail, box, quantity = 1 }) {
    const now = new Date();
    const id = 'SKU-' + String(Date.now()).slice(-6);

    const newItem = {
      id,
      label: label || 'Botella Plástica',
      category,
      confidence: Math.round((confidence || 0.85) * 100),
      quantity: Math.max(1, quantity),
      timestamp: now.toISOString(),
      formattedTime: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      formattedDate: now.toLocaleDateString(),
      thumbnail: thumbnail || null,
      box: box || null
    };

    this.items.unshift(newItem); // Añadir al inicio
    this.save();
    return newItem;
  }

  // Actualizar cantidad (+ / -)
  updateQuantity(id, delta) {
    const index = this.items.findIndex(it => it.id === id);
    if (index !== -1) {
      this.items[index].quantity += delta;
      if (this.items[index].quantity <= 0) {
        this.items.splice(index, 1);
      }
      this.save();
    }
  }

  // Eliminar producto
  deleteItem(id) {
    this.items = this.items.filter(it => it.id !== id);
    this.save();
  }

  // Vaciar inventario
  clearAll() {
    this.items = [];
    this.save();
  }

  // Cálculo de KPIs en tiempo real
  getMetrics() {
    const totalUnits = this.items.reduce((sum, it) => sum + (it.quantity || 1), 0);
    const uniqueItems = this.items.length;
    const avgConfidence = uniqueItems > 0
      ? Math.round(this.items.reduce((sum, it) => sum + (it.confidence || 0), 0) / uniqueItems)
      : 0;

    const lastDetected = uniqueItems > 0 ? this.items[0].formattedTime : 'Sin registros';

    // Agrupación por categoría
    const categories = {};
    this.items.forEach(it => {
      categories[it.label] = (categories[it.label] || 0) + it.quantity;
    });

    return {
      totalUnits,
      uniqueItems,
      avgConfidence,
      lastDetected,
      categories
    };
  }

  // Exportar reporte en formato CSV compatible con Excel (UTF-8 con BOM)
  exportCSV() {
    if (this.items.length === 0) {
      alert('El inventario está vacío. Registra productos antes de exportar.');
      return;
    }

    const headers = ['ID', 'Producto', 'Categoría', 'Cantidad', 'Confianza (%)', 'Fecha', 'Hora'];
    const rows = this.items.map(it => [
      `"${it.id}"`,
      `"${it.label}"`,
      `"${it.category}"`,
      it.quantity,
      it.confidence,
      `"${it.formattedDate}"`,
      `"${it.formattedTime}"`
    ]);

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inventario_stockvision_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Exportar reporte JSON estructurado
  exportJSON() {
    if (this.items.length === 0) {
      alert('El inventario está vacío. Registra productos antes de exportar.');
      return;
    }

    const payload = {
      project: 'StockVision AI - Clasificador de Productos',
      exportDate: new Date().toISOString(),
      metrics: this.getMetrics(),
      inventory: this.items
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inventario_stockvision_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
}

// Exportar instancia global
window.InventoryManager = InventoryManager;
