/**
 * Mapa para buscar basureros y puntos de reciclaje cerca.
 * La foto del clasificador no sale del dispositivo.
 * La ubicación solo se envía a OpenStreetMap para pedir los puntos del mapa.
 */
(function () {
  "use strict";

  const mapaNodo = document.getElementById("mapa");
  const estado = document.getElementById("mapa-estado");
  const lista = document.getElementById("mapa-lista");
  const botonAqui = document.getElementById("buscar-basureros");
  const botonLugar = document.getElementById("buscar-lugar");
  const campo = document.getElementById("lugar-basureros");
  if (!mapaNodo || !window.L) return;

  const mapa = L.map(mapaNodo).setView([0, 0], 2);
  setTimeout(() => mapa.invalidateSize(), 200);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(mapa);
  const marcas = L.layerGroup().addTo(mapa);

  function decir(texto, esError) {
    if (!estado) return;
    estado.textContent = texto;
    estado.style.color = esError ? (document.body.classList.contains("tablero") ? "#ffb4b4" : "#9b2c2c") : "";
  }

  function escapar(texto) {
    return String(texto).replace(/[&<>"']/g, (letra) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[letra]));
  }

  function tipoDe(elemento) {
    const amenity = (elemento.tags || {}).amenity;
    if (amenity === "recycling" || amenity === "waste_disposal") return amenity;
    return "waste_basket";
  }

  function titulo(elemento) {
    const etiquetas = elemento.tags || {};
    if (etiquetas.name) return etiquetas.name;
    if (tipoDe(elemento) === "recycling") return "Punto de reciclaje";
    if (tipoDe(elemento) === "waste_disposal") return "Contenedor de basura";
    return "Basurero";
  }

  function dibujoBasurero(tipo) {
    const cuerpo = tipo === "recycling" ? "#2f9bff" : tipo === "waste_disposal" ? "#1faa59" : "#ffd23f";
    const tapa = tipo === "recycling" ? "#9ad8ff" : tipo === "waste_disposal" ? "#b6f3cc" : "#fff3c4";
    const marca = tipo === "recycling"
      ? '<path fill="#fff" d="M16 16h8a4 4 0 0 1 0 8h-2v2h2a4 4 0 0 1 0 8h-6v-3h4a1 1 0 0 0 0-2h-3v-2h3a1 1 0 0 0 0-2h-6z"/>'
      : '<rect x="16" y="16" width="6" height="16" rx="1.5" fill="' + tapa + '"/>';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="44" viewBox="0 0 36 44" aria-hidden="true">' +
      '<ellipse cx="18" cy="40" rx="10" ry="3" fill="rgba(0,0,0,.28)"/>' +
      '<path fill="' + tapa + '" d="M6 10h24l-2 4H8z"/>' +
      '<rect x="7" y="14" width="22" height="22" rx="3" fill="' + cuerpo + '"/>' +
      marca +
      "</svg>";
  }

  function pintar(puntos, centro) {
    marcas.clearLayers();
    if (lista) lista.replaceChildren();
    if (!puntos.length) {
      decir("No hay basureros marcados en OpenStreetMap cerca de ese punto.", true);
      mapa.setView(centro, 15);
      return;
    }
    const bounds = [];
    puntos.forEach((punto) => {
      const marca = L.marker([punto.lat, punto.lon], {
        icon: L.divIcon({
          className: "marca-basura",
          html: dibujoBasurero(punto.tipo),
          iconSize: [36, 44],
          iconAnchor: [18, 42],
          popupAnchor: [0, -36]
        })
      }).addTo(marcas);
      marca.bindPopup(escapar(punto.nombre));
      bounds.push([punto.lat, punto.lon]);
      if (!lista) return;
      const item = document.createElement("li");
      item.innerHTML = dibujoBasurero(punto.tipo).replace('width="36" height="44"', 'width="18" height="22"') + escapar(punto.nombre);
      lista.append(item);
    });
    mapa.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 });
    decir(puntos.length === 1 ? "1 lugar cerca." : puntos.length + " lugares cerca.");
  }

  async function buscarAlrededor(lat, lon) {
    decir("Buscando basureros cerca…");
    const consulta = `[out:json][timeout:25];(node["amenity"="waste_basket"](around:1200,${lat},${lon});node["amenity"="waste_disposal"](around:1200,${lat},${lon});node["amenity"="recycling"](around:1200,${lat},${lon});way["amenity"="recycling"](around:1200,${lat},${lon}););out center;`;
    const respuesta = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: consulta
    });
    if (!respuesta.ok) throw new Error("El mapa no respondió. Inténtalo de nuevo.");
    const datos = await respuesta.json();
    const puntos = (datos.elements || []).map((elemento) => {
      const latitud = elemento.lat || (elemento.center && elemento.center.lat);
      const longitud = elemento.lon || (elemento.center && elemento.center.lon);
      if (!Number.isFinite(latitud) || !Number.isFinite(longitud)) return null;
      return { lat: latitud, lon: longitud, nombre: titulo(elemento), tipo: tipoDe(elemento) };
    }).filter(Boolean);
    pintar(puntos, [lat, lon]);
  }

  if (botonAqui) {
    botonAqui.addEventListener("click", () => {
      if (!navigator.geolocation) {
        decir("Este navegador no puede usar la ubicación. Escribe un lugar.", true);
        return;
      }
      decir("Pidiendo tu ubicación…");
      navigator.geolocation.getCurrentPosition(async (posicion) => {
        try {
          await buscarAlrededor(posicion.coords.latitude, posicion.coords.longitude);
        } catch (error) {
          decir(error.message || "No se pudo buscar en el mapa.", true);
        }
      }, () => {
        decir("No hay permiso de ubicación. Escribe una dirección o una ciudad.", true);
      }, { enableHighAccuracy: true, timeout: 10000 });
    });
  }

  if (botonLugar && campo) {
    botonLugar.addEventListener("click", async () => {
      const texto = campo.value.trim();
      if (!texto) {
        decir("Escribe una ciudad o una dirección.", true);
        return;
      }
      decir("Buscando ese lugar…");
      try {
        const respuesta = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(texto));
        if (!respuesta.ok) throw new Error("No se pudo buscar el lugar.");
        const sitios = await respuesta.json();
        if (!sitios.length) {
          decir("No encontré ese lugar.", true);
          return;
        }
        await buscarAlrededor(Number(sitios[0].lat), Number(sitios[0].lon));
      } catch (error) {
        decir(error.message || "No se pudo buscar el lugar.", true);
      }
    });
  }
})();
