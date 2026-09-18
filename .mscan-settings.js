const out = new Map();
const scan = (tag) => {
  for (const el of document.querySelectorAll('.settings-content *, .models-page *, .models-content *')) {
    if (!el.offsetParent) continue;
    if (el.closest('button, .settings-action-btn, label.settings-action-btn')) continue;
    const txt = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    if (txt.length < 8) continue;
    const r = el.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 18;
    const words = txt.split(/\s+/).length;
    if (r.width > 0 && r.width < 120 && r.height > lh * 1.9 && words >= 2) {
      let p = el; const chain = [];
      for (let i = 0; i < 4 && p; i++) { chain.push(p.tagName.toLowerCase() + '.' + String(p.className).split(' ').filter(Boolean).join('.')); p = p.parentElement; }
      const k = chain.join(' < ');
      if (!out.has(k)) out.set(k, tag + ': ' + Math.round(r.width) + 'px "' + txt.slice(0, 28) + '"');
    }
  }
};
