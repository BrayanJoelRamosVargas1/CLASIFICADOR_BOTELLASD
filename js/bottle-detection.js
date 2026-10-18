/* Shared by the camera and the reproducible image benchmark. */
(() => {
  'use strict';
  const config = Object.freeze({
    modelBase: 'yolov10n',
    minScore: 0.10,
    threshold: 0.30,
    maxBoxes: 30,
    nmsIoU: 0.45
  });

  function iou(a, b) {
    const intersection = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
      Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const union = a.w * a.h + b.w * b.h - intersection;
    return union > 0 ? intersection / union : 0;
  }

  function select(predictions, width, height, threshold = config.threshold) {
    const candidates = predictions.filter(p => p.class === 'bottle' && p.score >= threshold)
      .map(p => {
        const [x, y, w, h] = p.bbox;
        const left = Math.max(0, x), top = Math.max(0, y);
        return { x: left, y: top, w: Math.min(width, x + w) - left,
          h: Math.min(height, y + h) - top, score: p.score, rawClass: p.class };
      })
      .filter(b => [b.x, b.y, b.w, b.h, b.score].every(Number.isFinite) && b.w >= 14 && b.h >= 14)
      .sort((a, b) => b.score - a.score);
    const selected = [];
    for (const box of candidates) {
      if (selected.every(other => iou(box, other) < config.nmsIoU)) selected.push(box);
    }
    return selected;
  }

  const api = Object.freeze({ config, iou, select });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.BottleDetection = api;
})();
