// COPY of Raku's src/frame-guard.js (Oct 30 2026), with this page's wording.
// GitHub Pages can't send frame-ancestors, so inside a frame the page shows only a link to open it in
// its own tab: no sign-in, no tiles, no buttons to trick (clickjacking).

export function isFramed(win = window) {
  try { return win.top !== win.self; } catch { return true; }
}

export function showOpenInOwnTab(root, href) {
  root.replaceChildren();
  const box = document.createElement('div');
  box.className = 'framed';
  const p = document.createElement('p');
  p.textContent = 'Acuity IP tools only run in their own tab.';
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = 'Open in its own tab';
  box.append(p, a);
  root.append(box);
}
