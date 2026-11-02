// Printable reports. A tile sends plain data (title, tables, notes); the page checks it here, then builds its
// own print view from it with textContent only. Nothing from a tile is ever put on the page as HTML, and nothing
// is stored: the report lives in the page until it's printed (or saved as PDF by the browser) or dismissed.
//
// report = { title, subtitle?, sections: [{ heading, columns: [..], rows: [[..], ..] }], notes?: [..] }

const LIMITS = { title: 120, subtitle: 240, heading: 80, cell: 80, note: 400, sections: 8, columns: 8, rows: 40, notes: 10 };

const text = (v, max) => (typeof v === 'string' || typeof v === 'number') ? String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : null;

/** The tile's report, checked and trimmed; null if it isn't one. */
export function checkReport(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const title = text(raw.title, LIMITS.title);
  if (!title) return null;
  if (!Array.isArray(raw.sections) || !raw.sections.length || raw.sections.length > LIMITS.sections) return null;
  const sections = [];
  for (const s of raw.sections) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.columns) || !Array.isArray(s.rows)) return null;
    if (!s.columns.length || s.columns.length > LIMITS.columns || s.rows.length > LIMITS.rows) return null;
    const columns = s.columns.map((c) => text(c, LIMITS.cell) ?? '');
    const rows = [];
    for (const r of s.rows) {
      if (!Array.isArray(r) || r.length !== columns.length) return null;
      rows.push(r.map((c) => text(c, LIMITS.cell) ?? ''));
    }
    sections.push({ heading: text(s.heading, LIMITS.heading) ?? '', columns, rows });
  }
  const notes = Array.isArray(raw.notes) ? raw.notes.slice(0, LIMITS.notes).map((n) => text(n, LIMITS.note)).filter(Boolean) : [];
  const subtitle = text(raw.subtitle, LIMITS.subtitle);
  return { title, ...(subtitle ? { subtitle } : {}), sections, notes };
}

/** Fill `box` with the printable report (the page's own elements; textContent only). */
export function renderReport(box, report, { h, firm, generated = new Date() }) {
  const when = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeStyle: 'short' }).format(generated);
  box.replaceChildren(
    h('header', { class: 'r-head' },
      h('div', { class: 'r-brand' }, firm),
      h('h1', {}, report.title),
      report.subtitle ? h('p', { class: 'r-sub' }, report.subtitle) : null,
      h('p', { class: 'r-when' }, `Generated ${when}. Source: USPTO Open Data Portal, through Acuity IP's proxy.`)),
    ...report.sections.map((s) => h('section', { class: 'r-sec' },
      s.heading ? h('h2', {}, s.heading) : null,
      h('table', {},
        h('thead', {}, h('tr', {}, ...s.columns.map((c, i) => h('th', i ? { class: 'n' } : {}, c)))),
        h('tbody', {}, ...s.rows.map((r) => h('tr', {}, ...r.map((c, i) => h('td', i ? { class: 'n' } : {}, c)))))))),
    report.notes.length ? h('section', { class: 'r-notes' }, h('ul', {}, ...report.notes.map((n) => h('li', {}, n)))) : null,
    h('p', { class: 'r-foot' }, 'A snapshot of USPTO data on the date above, for information. Not docketing advice; the USPTO record controls.'));
}
