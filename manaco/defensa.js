(() => {
  const deck = document.getElementById('defensa');
  if (!deck) return;
  const slides = [...deck.querySelectorAll('.defense-slide')];
  const tabs = [...deck.querySelectorAll('[data-slide]')];
  const previous = deck.querySelector('[data-previous]');
  const next = deck.querySelector('[data-next]');
  const status = deck.querySelector('[data-slide-status]');
  let index = 0;
  function show(position) {
    index = Math.max(0, Math.min(slides.length - 1, position));
    slides.forEach((slide, i) => { slide.hidden = i !== index; });
    tabs.forEach((tab, i) => {
      if (i === index) tab.setAttribute('aria-current', 'step');
      else tab.removeAttribute('aria-current');
    });
    previous.disabled = index === 0;
    next.disabled = index === slides.length - 1;
    status.textContent = `${index + 1} de ${slides.length}`;
  }
  tabs.forEach((button, i) => button.addEventListener('click', () => show(i)));
  previous.addEventListener('click', () => show(index - 1));
  next.addEventListener('click', () => show(index + 1));
  deck.addEventListener('keydown', event => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      show(index + (event.key === 'ArrowRight' ? 1 : -1));
    }
  });
  const full = deck.querySelector('[data-fullscreen]');
  if (!deck.requestFullscreen) full.hidden = true;
  else full.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement === deck) await document.exitFullscreen();
      else await deck.requestFullscreen();
    } catch { status.textContent = 'Pantalla completa no disponible. Puedes continuar aquí.'; }
  });
  document.addEventListener('fullscreenchange', () => {
    full.textContent = document.fullscreenElement === deck ? 'Salir de pantalla completa' : 'Pantalla completa';
  });
  show(0);
})();
