/* ==========================================================
   Trainer — app logic
   Reads plan.json (or a pasted plan) and draws each screen.
   Never changes the plan. Everything in the plan is optional:
   missing fields are skipped, unknown fields are ignored.
   ========================================================== */
'use strict';

(function () {
  const APP_VERSION = '1.0.0';

  // Keys used to store things on the phone (localStorage)
  const LS = {
    imported: 'trainer.importedPlan',
    checkins: 'trainer.checkins',
    shop: 'trainer.shopping',
  };

  const state = {
    plan: null,          // the plan in use
    source: '',          // 'website' or 'pasted'
    repoPlan: null,      // plan.json from the website
    repoError: '',
    importedPlan: null,  // plan pasted on the Settings screen
    weekOffset: 0,       // Agenda: 0 = this week, -1 = last week, ...
    navDepth: 0,         // for the Back button
    route: 'today',
    importMsg: '',       // message shown on the Settings screen
    importText: '',
    pendingDelete: '',   // check-in date waiting for a 2nd tap to delete
  };

  /* ---------------- small helpers ---------------- */

  const $ = (sel) => document.querySelector(sel);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const txt = (v) => (typeof v === 'string' ? v.trim() : isNum(v) ? String(v) : '');

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function prettify(s) {
    s = txt(s).replace(/_/g, ' ');
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }

  function num(v, digits) {
    if (!isNum(v)) return '';
    return digits != null ? String(Math.round(v * 10 ** digits) / 10 ** digits) : String(v);
  }

  function lsGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function lsSet(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  // Draw one part of a screen. If the data is weird, show a small warning instead of crashing.
  function safe(fn, what) {
    try {
      return fn();
    } catch (e) {
      console.error('Could not show ' + what, e);
      return `<div class="card warn">Couldn't show ${esc(what)}: the plan has unexpected data here.</div>`;
    }
  }

  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), 2600);
  }

  /* ---------------- dates ---------------- */

  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  function parseDate(s) {
    if (typeof s !== 'string') return null;
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s.trim());
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return isNaN(d) ? null : d;
  }
  function iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  const normDate = (s) => { const d = parseDate(s); return d ? iso(d) : ''; };
  const today = () => iso(new Date());
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function mondayOf(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return addDays(x, -((x.getDay() + 6) % 7)); }
  function daysBetween(a, b) {
    return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
  }
  function fmtDate(s, opts) {
    const d = typeof s === 'string' ? parseDate(s) : s;
    if (!d) return txt(s);
    return d.toLocaleDateString('en-GB', opts || { weekday: 'short', day: 'numeric', month: 'short' });
  }
  const fmtLong = (s) => fmtDate(s, { weekday: 'long', day: 'numeric', month: 'long' });
  function relDay(s) {
    const d = parseDate(s);
    if (!d) return '';
    const n = daysBetween(new Date(), d);
    return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n === -1 ? 'Yesterday' : '';
  }

  /* ---------------- plan access ---------------- */

  const P = () => obj(state.plan);

  // Every workout together with its position in the list (used for links)
  function allWorkouts() {
    return arr(P().workouts)
      .map((w, i) => ({ w: obj(w), i, ok: w && typeof w === 'object' && !Array.isArray(w) }))
      .filter((x) => x.ok)
      .map((x) => ({ w: x.w, i: x.i, date: normDate(x.w.date) }));
  }
  const workoutsOn = (date) => allWorkouts().filter((x) => x.date === date);

  const nutrition = () => obj(P().nutrition);
  const dayTypes = () => obj(nutrition().day_types);
  function mealsOn(date) {
    return arr(nutrition().meals).map(obj).filter((m) => normDate(m.date) === date);
  }
  function zones() { return arr(P().zones).map(obj).filter((z) => txt(z.id) || txt(z.name)); }

  const TYPES = {
    rest: { label: 'Rest', icon: '😴', cls: 't-rest' },
    easy: { label: 'Easy ride', icon: '🚴', cls: 't-easy' },
    recovery: { label: 'Recovery ride', icon: '🌿', cls: 't-easy' },
    tempo: { label: 'Tempo', icon: '⏱️', cls: 't-tempo' },
    vo2_intervals: { label: 'VO2max intervals', icon: '🔥', cls: 't-hard' },
    long_ride: { label: 'Long ride', icon: '🛣️', cls: 't-long' },
    long_ride_intervals: { label: 'Long ride + intervals', icon: '🛣️', cls: 't-long' },
    strength: { label: 'Strength', icon: '🏋️', cls: 't-strength' },
    benchmark_test: { label: 'Benchmark test', icon: '📊', cls: 't-hard' },
  };
  function typeInfo(t) {
    return TYPES[t] || { label: prettify(t) || 'Workout', icon: '•', cls: 't-other' };
  }

  function zoneClass(id) {
    const m = /(\d+)/.exec(txt(id));
    if (!m) return 'z0';
    return 'z' + Math.min(6, Math.max(1, +m[1]));
  }
  function zoneChip(id) {
    const t = txt(id);
    return t ? `<span class="zone ${zoneClass(t)}">${esc(t)}</span>` : '';
  }

  function blockStatus(date) {
    const b = obj(P().block);
    const start = parseDate(b.start);
    if (!start) return null;
    const d = parseDate(date);
    const weeks = isNum(b.weeks) && b.weeks > 0 ? Math.round(b.weeks) : null;
    const week = Math.floor(daysBetween(start, d) / 7) + 1;
    const inBlock = week >= 1 && (!weeks || week <= weeks);
    const lights = Array.isArray(b.light_week) ? b.light_week : [b.light_week];
    return { b, start, weeks, week, inBlock, light: inBlock && lights.includes(week), isLight: (w) => lights.includes(w) };
  }

  /* ---------------- workout steps ---------------- */

  const repCount = (s) => (isNum(s.repeat) && s.repeat > 0 ? Math.round(s.repeat) : 0);
  const isOnOff = (s) => isNum(s.on_s) || isNum(s.off_s) || isNum(s.on_min) || isNum(s.off_min);
  const onSec = (s) => (isNum(s.on_s) ? s.on_s : isNum(s.on_min) ? s.on_min * 60 : 0);
  const offSec = (s) => (isNum(s.off_s) ? s.off_s : isNum(s.off_min) ? s.off_min * 60 : 0);
  const restSec = (s) => (isNum(s.rest_between_min) ? s.rest_between_min * 60 : isNum(s.rest_between_s) ? s.rest_between_s : 0);
  function baseSec(s) {
    if (isNum(s.min)) return s.min * 60;
    if (isNum(s.duration_min)) return s.duration_min * 60;
    if (isNum(s.sec)) return s.sec;
    if (isNum(s.s)) return s.s;
    return 0;
  }

  // Total seconds of a step (works for nested repeat groups)
  function stepSeconds(s, depth) {
    s = obj(s);
    depth = depth || 0;
    if (depth > 10) return 0;
    let one;
    if (Array.isArray(s.steps)) one = s.steps.reduce((t, c) => t + stepSeconds(c, depth + 1), 0);
    else if (isOnOff(s)) one = onSec(s) + offSec(s);
    else one = baseSec(s);
    const rep = repCount(s);
    return rep ? rep * one + (rep - 1) * restSec(s) : one;
  }

  function fmtDur(sec) {
    sec = Math.round(sec);
    if (!(sec > 0)) return '';
    if (sec < 60) return sec + ' s';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const parts = [];
    if (h) parts.push(h + ' h');
    if (m) parts.push(m + ' min');
    if (s && !h) parts.push(s + ' s');
    return parts.join(' ');
  }

  // Short text for a step, e.g. "3 sets × 13 × (30 s on / 15 s off)"
  function stepTitle(s, depth) {
    s = obj(s);
    depth = depth || 0;
    if (depth > 10) return '';
    const rep = repCount(s);
    if (Array.isArray(s.steps)) {
      const kids = s.steps.map(obj);
      const parts = kids.map((k) => stepTitle(k, depth + 1)).filter(Boolean);
      let inner = parts.length === 1 ? parts[0] : parts.length ? '(' + parts.join(' + ') + ')' : '';
      if (!rep) return inner || txt(s.title);
      return `${rep} ${rep === 1 ? 'set' : 'sets'}${inner ? ' × ' + inner : ''}`;
    }
    if (isOnOff(s)) {
      const on = fmtDur(onSec(s)), off = fmtDur(offSec(s));
      const core = on && off ? `${on} on / ${off} off` : on ? `${on} on` : `${off} off`;
      return rep ? `${rep} × (${core})` : core;
    }
    const d = fmtDur(baseSec(s));
    if (rep) return `${rep} × ${d || 'rep'}`;
    return d || txt(s.title);
  }

  function rangeText(v, unit) {
    if (Array.isArray(v) && v.length >= 2 && isNum(v[0]) && isNum(v[1])) return `${v[0]}–${v[1]} ${unit}`;
    if (isNum(v)) return `${v} ${unit}`;
    return txt(v);
  }

  function targetsHTML(s) {
    const t = [];
    if (txt(s.target)) t.push(esc(txt(s.target)));
    if (txt(s.on_target)) t.push('<span><b>On:</b> ' + esc(txt(s.on_target)) + '</span>');
    if (txt(s.off_target)) t.push('<span><b>Off:</b> ' + esc(txt(s.off_target)) + '</span>');
    if (s.power_w != null && rangeText(s.power_w, 'W')) t.push('<span class="muted">Power: ' + esc(rangeText(s.power_w, 'W')) + '</span>');
    if (s.hr_bpm != null && rangeText(s.hr_bpm, 'bpm')) t.push('<span class="muted">Heart rate: ' + esc(rangeText(s.hr_bpm, 'bpm')) + '</span>');
    if (s.cadence_rpm != null && rangeText(s.cadence_rpm, 'rpm')) t.push('<span class="muted">Cadence: ' + esc(rangeText(s.cadence_rpm, 'rpm')) + '</span>');
    const note = txt(s.note) || txt(s.notes);
    if (note) t.push('<span class="muted">' + esc(note) + '</span>');
    return t.length ? `<div class="step-targets">${t.join('')}</div>` : '';
  }

  function restLine(s, what) {
    const r = restSec(s);
    if (!r || repCount(s) < 2) return '';
    const extra = txt(s.rest_target) ? ` (${esc(txt(s.rest_target))})` : '';
    return `<div class="step-rest">↺ ${esc(fmtDur(r))} easy between ${what}${extra}</div>`;
  }

  function renderStep(s, depth, hideTitle) {
    s = obj(s);
    if (depth > 8) return '';
    const zone = txt(s.zone);
    const zc = zone ? zoneClass(zone) : '';
    const total = fmtDur(stepSeconds(s));

    if (Array.isArray(s.steps)) {
      const kids = s.steps;
      // "3 sets × 13 × (30/15)": the single child is already in the title, so only show its targets
      const single = kids.length === 1 && !Array.isArray(obj(kids[0]).steps);
      const body = kids.map((k) => renderStep(k, depth + 1, single)).join('');
      return `<div class="step group">
        <div class="step-head"><span class="step-title">${esc(stepTitle(s))}</span>${zoneChip(zone)}<span class="step-dur">${esc(total)}</span></div>
        ${restLine(s, 'sets')}
        ${targetsHTML(s)}
        <div class="group-body">${body}</div>
      </div>`;
    }

    const title = stepTitle(s);
    const targets = targetsHTML(s);
    if (!title && !targets && !zone) return ''; // empty or unreadable step: skip it
    if (hideTitle) {
      if (!targets && !zone) return '';
      return `<div class="step inline ${zc}">${zone ? `<div class="step-head">${zoneChip(zone)}</div>` : ''}${targets}${restLine(s, 'reps')}</div>`;
    }
    return `<div class="step ${zc}">
      <div class="step-head"><span class="step-title">${esc(title || 'Step')}</span>${zoneChip(zone)}${repCount(s) || isOnOff(s) ? `<span class="step-dur">${esc(total)}</span>` : ''}</div>
      ${targets}
      ${restLine(s, 'reps')}
    </div>`;
  }

  function workoutTotalSec(w) {
    const steps = arr(w.steps);
    const fromSteps = steps.reduce((t, s) => t + stepSeconds(s), 0);
    return fromSteps > 0 ? fromSteps : isNum(w.duration_min) ? w.duration_min * 60 : 0;
  }
  function durationLabel(w) {
    if (isNum(w.duration_min) && w.duration_min > 0) return fmtDur(w.duration_min * 60);
    return fmtDur(workoutTotalSec(w));
  }

  /* ---------------- shared building blocks ---------------- */

  function workoutCard(x) {
    const w = x.w, t = typeInfo(txt(w.type));
    const dur = durationLabel(w);
    return `<a class="card workout ${t.cls}" href="#workout/${x.i}">
      <div class="wk-top"><span>${t.icon} ${esc(t.label)}</span>${zoneChip(w.zone)}</div>
      <div class="wk-title">${esc(txt(w.title) || t.label)}</div>
      ${dur ? `<div class="wk-meta"><span>⏱ ${esc(dur)}</span></div>` : ''}
      ${txt(w.purpose) ? `<div class="wk-purpose">${esc(txt(w.purpose))}</div>` : ''}
      <span class="chev">›</span>
    </a>`;
  }

  function fuelHTML(fuel, w) {
    const f = obj(fuel);
    const rows = [];
    if (txt(f.before)) rows.push(['Before', esc(txt(f.before))]);
    const during = [];
    if (isNum(f.during_carbs_g_per_h)) {
      if (f.during_carbs_g_per_h > 0) {
        let line = `<span class="big">${esc(num(f.during_carbs_g_per_h))} g carbs per hour</span>`;
        const sec = w ? workoutTotalSec(w) : 0;
        if (sec >= 3600) line += `<br><span class="muted small">≈ ${Math.round((f.during_carbs_g_per_h * sec) / 3600)} g in total for ${esc(fmtDur(sec))}</span>`;
        during.push(line);
      } else {
        during.push('Water is enough');
      }
    }
    if (isNum(f.during_fluid_ml_per_h)) during.push(`${esc(num(f.during_fluid_ml_per_h))} ml fluid per hour`);
    if (txt(f.during)) during.push(esc(txt(f.during)));
    if (during.length) rows.push(['During', during.join('<br>')]);
    if (txt(f.after)) rows.push(['After', esc(txt(f.after))]);
    // Any extra text fields the coach adds later are shown too
    const known = ['before', 'after', 'during', 'during_carbs_g_per_h', 'during_fluid_ml_per_h'];
    Object.keys(f).forEach((k) => {
      if (!known.includes(k) && txt(f[k])) rows.push([esc(prettify(k)), esc(txt(f[k]))]);
    });
    if (!rows.length) return '';
    return `<div class="fuel">${rows.map(([k, v]) => `<div class="fuel-row"><div class="fuel-k">${k}</div><div class="fuel-v">${v}</div></div>`).join('')}</div>`;
  }

  function targetStats(dt) {
    const t = obj(dayTypes()[dt]);
    const cells = [
      ['carbs_g', 'g carbs'],
      ['protein_g', 'g protein'],
      ['kcal', 'kcal'],
    ].filter(([k]) => isNum(t[k]) && t[k] > 0);
    if (!cells.length) return '';
    return `<div class="stats">${cells.map(([k, l]) => `<div class="stat"><div class="v">${esc(num(t[k]))}</div><div class="l">${l}</div></div>`).join('')}</div>`;
  }

  function mealItemHTML(it) {
    let s = txt(it);
    if (!s && it && typeof it === 'object') {
      const o = obj(it);
      const label = txt(o.meal) || txt(o.time) || txt(o.name);
      const body = txt(o.text) || txt(o.items) || txt(o.description) || (Array.isArray(o.items) ? o.items.map(txt).filter(Boolean).join(', ') : '');
      s = label && body ? `${label}: ${body}` : label || body;
    }
    if (!s) return '';
    const i = s.indexOf(':');
    if (i > 0 && i < 40) return `<li><span class="lbl">${esc(s.slice(0, i))}</span>${esc(s.slice(i + 1).trim())}</li>`;
    return `<li>${esc(s)}</li>`;
  }

  function mealCard(m, withTargets) {
    const dt = txt(m.day_type);
    const items = arr(m.items).map(mealItemHTML).filter(Boolean).join('');
    return `<div class="card">
      ${dt ? `<div class="chips" style="margin-top:0"><span class="chip accent day-type">${esc(prettify(dt))} day</span></div>` : ''}
      ${withTargets && dt ? `<div style="margin-top:10px">${targetStats(dt)}</div>` : ''}
      ${items ? `<ul class="meal-list">${items}</ul>` : '<div class="muted small" style="margin-top:8px">No meals listed.</div>'}
    </div>`;
  }

  function noteHTML() {
    const n = P().notes;
    const t = Array.isArray(n) ? n.map(txt).filter(Boolean).join('\n\n') : txt(n);
    if (!t) return '';
    return `<div class="note"><div class="who">Coach</div>${esc(t)}</div>`;
  }

  function noPlanHTML() {
    return `<div class="card error">
      <b>No plan loaded yet.</b>
      <p class="muted small">${esc(state.repoError || "The app couldn't find a plan.")} You can paste a plan from your coach in Settings.</p>
      <a class="btn primary" href="#settings">Open Settings</a>
    </div>`;
  }

  /* ---------------- screen: Today ---------------- */

  function viewToday() {
    const t = today();
    const bs = blockStatus(t);
    let html = `<div class="page-head">
      <div class="eyebrow">Today</div>
      <h2>${esc(fmtLong(t))}</h2>
      ${bs && bs.inBlock ? `<div class="chips"><span class="chip accent">${esc(txt(bs.b.name) || 'Block')} · week ${bs.week}${bs.weeks ? ' of ' + bs.weeks : ''}</span>${bs.light ? '<span class="chip light-badge">Light week</span>' : ''}</div>` : ''}
    </div>`;
    if (!state.plan) return html + noPlanHTML();

    html += safe(() => {
      const ws = workoutsOn(t);
      if (!ws.length) {
        const next = allWorkouts().filter((x) => x.date > t).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
        return `<div class="card"><b>No workout planned today.</b><div class="muted small">Enjoy the day.</div></div>` +
          (next ? `<div class="section"><h3>Next up · ${esc(fmtDate(next.date))}</h3>${workoutCard(next)}</div>` : '');
      }
      return `<div class="section" style="margin-top:0"><h3>Workout${ws.length > 1 ? 's' : ''}</h3>${ws.map(workoutCard).join('')}</div>` +
        ws.map((x) => {
          const f = fuelHTML(x.w.fuel, x.w);
          if (!f) return '';
          return `<div class="section"><h3>Fuelling${ws.length > 1 ? ' · ' + esc(txt(x.w.title) || typeInfo(x.w.type).label) : ''}</h3>${f}</div>`;
        }).join('');
    }, "today's workout");

    html += safe(() => {
      const ms = mealsOn(t);
      if (!ms.length) return '';
      return `<div class="section"><h3>Meals today</h3>${ms.map((m) => mealCard(m, true)).join('')}</div>`;
    }, "today's meals");

    html += safe(() => {
      const n = noteHTML();
      return n ? `<div class="section"><h3>Coach's note</h3>${n}</div>` : '';
    }, "the coach's note");

    html += safe(() => {
      const tm = iso(addDays(parseDate(t), 1));
      const ws = workoutsOn(tm);
      if (!ws.length) return '';
      return `<div class="section"><h3>Tomorrow</h3>${ws.map(workoutCard).join('')}</div>`;
    }, 'tomorrow');

    html += safe(() => {
      const g = goalsSorted().find((x) => x.days >= 0 && txt(x.g.status || 'active') !== 'done');
      if (!g) return '';
      return `<div class="section"><h3>Next goal</h3><a class="card tap" href="#goals" style="display:flex;justify-content:space-between;align-items:center;gap:12px">
        <span><b>${esc(txt(g.g.title) || 'Goal')}</b><br><span class="muted small">${esc(fmtDate(g.date, { day: 'numeric', month: 'short', year: 'numeric' }))}</span></span>
        <span class="chip accent">${g.days === 0 ? 'Today!' : g.days + ' days'}</span></a></div>`;
    }, 'next goal');

    return html;
  }

  /* ---------------- screen: Agenda ---------------- */

  function calendarHTML() {
    const bs = blockStatus(today());
    const t = today();
    let start, weeks, label;
    if (bs && bs.start) {
      start = mondayOf(bs.start);
      weeks = bs.weeks || 4;
      label = true;
    } else {
      start = mondayOf(new Date());
      weeks = 4;
      label = false;
    }
    const blockStart = bs ? bs.start : null;
    const blockEnd = bs && bs.weeks ? addDays(bs.start, bs.weeks * 7 - 1) : null;
    let cells = DOW.map((d) => `<div class="dow">${d.charAt(0)}</div>`).join('');
    for (let w = 0; w < weeks; w++) {
      const weekNo = w + 1;
      if (label) {
        cells += `<div class="wk-label">Week ${weekNo}${bs.isLight(weekNo) ? ' <span class="chip light-badge" style="padding:1px 7px;font-size:11px">Light</span>' : ''}</div>`;
      }
      for (let d = 0; d < 7; d++) {
        const day = addDays(start, w * 7 + d);
        const ds = iso(day);
        const out = blockStart && (day < blockStart || (blockEnd && day > blockEnd));
        const cls = ['cal-day', 'tap'];
        if (out) cls.push('out');
        if (ds === t) cls.push('today');
        else if (ds < t) cls.push('past');
        if (label && bs.isLight(weekNo) && !out) cls.push('light');
        const dots = workoutsOn(ds).map((x) => `<span class="dot ${typeInfo(txt(x.w.type)).cls}"></span>`).join('');
        cells += `<a class="${cls.join(' ')}" href="#day/${ds}" aria-label="${esc(fmtLong(ds))}">${day.getDate()}<span class="dots">${dots}</span></a>`;
      }
    }
    return `<div class="cal">${cells}</div>`;
  }

  function viewAgenda() {
    if (!state.plan) return `<div class="page-head"><div class="eyebrow">Agenda</div><h2>Your week</h2></div>` + noPlanHTML();
    const bs = blockStatus(today());
    const b = obj(P().block);
    let html = `<div class="page-head"><div class="eyebrow">Agenda</div><h2>Your week</h2></div>`;

    html += safe(() => {
      const mon = addDays(mondayOf(new Date()), state.weekOffset * 7);
      const sun = addDays(mon, 6);
      const wbs = blockStatus(iso(mon));
      const sub = state.weekOffset === 0 ? 'This week' : state.weekOffset === 1 ? 'Next week' : state.weekOffset === -1 ? 'Last week' : '';
      const blockTxt = wbs && wbs.inBlock ? `${txt(wbs.b.name) || 'Block'} · week ${wbs.week}${wbs.light ? ' (light)' : ''}` : '';
      let rows = '';
      for (let i = 0; i < 7; i++) {
        const d = addDays(mon, i), ds = iso(d);
        const ws = workoutsOn(ds);
        const items = ws.length
          ? ws.map((x) => {
              const ti = typeInfo(txt(x.w.type));
              const dur = durationLabel(x.w);
              return `<div class="item"><span class="dot ${ti.cls}"></span><span>${esc(txt(x.w.title) || ti.label)}</span>${dur ? `<span class="dur">${esc(dur)}</span>` : ''}</div>`;
            }).join('')
          : '<div class="item muted" style="font-weight:500">Nothing planned</div>';
        rows += `<a class="card day-row tap${ds === today() ? ' today' : ''}" href="#day/${ds}">
          <div class="date"><div class="w">${DOW[i]}</div><div class="d">${d.getDate()}</div></div>
          <div class="items">${items}</div><span class="chev">›</span></a>`;
      }
      return `<div class="week-nav">
          <button class="btn icon" data-action="week" data-dir="-1" aria-label="Previous week">‹</button>
          <div class="label">${esc(fmtDate(mon, { day: 'numeric', month: 'short' }))} – ${esc(fmtDate(sun, { day: 'numeric', month: 'short' }))}<small>${esc([sub, blockTxt].filter(Boolean).join(' · ') || ' ')}</small></div>
          <button class="btn icon" data-action="week" data-dir="1" aria-label="Next week">›</button>
        </div>
        ${state.weekOffset !== 0 ? '<button class="btn small" data-action="week" data-dir="0" style="margin:0 auto 12px">Back to this week</button>' : ''}
        ${rows}`;
    }, 'the week');

    html += safe(() => {
      const title = bs && bs.start ? esc(txt(b.name) || 'Current block') : 'Next 4 weeks';
      const info = bs && bs.start
        ? `<div class="block-banner" style="margin-bottom:12px"><div><div class="name">${title}</div>
            <div class="focus">${esc([txt(b.focus), `from ${fmtDate(bs.start)}`, bs.weeks ? bs.weeks + ' weeks' : ''].filter(Boolean).join(' · '))}</div></div>
            ${bs.inBlock ? `<span class="chip accent">Week ${bs.week}</span>` : ''}</div>`
        : '';
      return `<div class="section"><h3>${bs && bs.start ? 'Block calendar' : 'Calendar'}</h3><div class="card">${info}${calendarHTML()}</div></div>`;
    }, 'the block calendar');

    return html;
  }

  /* ---------------- screen: Day detail ---------------- */

  function viewDay(ds) {
    ds = normDate(ds) || today();
    const rel = relDay(ds);
    const bs = blockStatus(ds);
    let html = `<div class="page-head"><div class="eyebrow">${esc(rel || fmtDate(ds, { weekday: 'long' }))}</div>
      <h2>${esc(fmtDate(ds, { day: 'numeric', month: 'long', year: 'numeric' }))}</h2>
      ${bs && bs.inBlock ? `<div class="chips"><span class="chip accent">${esc(txt(bs.b.name) || 'Block')} · week ${bs.week}</span>${bs.light ? '<span class="chip light-badge">Light week</span>' : ''}</div>` : ''}
    </div>`;
    if (!state.plan) return html + noPlanHTML();

    html += safe(() => {
      const ws = workoutsOn(ds);
      if (!ws.length) return '<div class="card"><b>No workout planned.</b></div>';
      return `<div class="section" style="margin-top:0"><h3>Workout${ws.length > 1 ? 's' : ''}</h3>${ws.map(workoutCard).join('')}</div>` +
        ws.map((x) => {
          const f = fuelHTML(x.w.fuel, x.w);
          return f ? `<div class="section"><h3>Fuelling · ${esc(txt(x.w.title) || typeInfo(x.w.type).label)}</h3>${f}</div>` : '';
        }).join('');
    }, 'the workouts');

    html += safe(() => {
      const ms = mealsOn(ds);
      return ms.length ? `<div class="section"><h3>Meals</h3>${ms.map((m) => mealCard(m, true)).join('')}</div>` : '';
    }, 'the meals');

    html += safe(() => {
      const c = obj(getCheckins()[ds]);
      if (!Object.keys(c).length) return '';
      return `<div class="section"><h3>Your check-in</h3><div class="card ci-item"><div class="ci-body">${esc(checkinLines(c).join('\n'))}</div>
        <div class="ci-actions"><a class="btn small" href="#checkin/${ds}">Edit</a></div></div></div>`;
    }, 'your check-in');

    return html;
  }

  /* ---------------- screen: Workout detail ---------------- */

  function zoneTableHTML(highlight) {
    const zs = zones();
    if (!zs.length) return '';
    const hl = txt(highlight).toUpperCase();
    const rows = zs.map((z) => `<tr class="${txt(z.id).toUpperCase() === hl && hl ? 'hl' : ''}">
        <td>${zoneChip(z.id) || ''}<div style="margin-top:4px;font-weight:600">${esc(txt(z.name))}</div></td>
        <td>${esc(rangeText(z.power_w, 'W'))}</td>
        <td>${esc(rangeText(z.hr_bpm, 'bpm'))}</td>
      </tr>${txt(z.feel) ? `<tr class="${txt(z.id).toUpperCase() === hl && hl ? 'hl' : ''}"><td colspan="3" class="feel" style="border-top:0;padding-top:0">${esc(txt(z.feel))}</td></tr>` : ''}`).join('');
    return `<div class="card" style="padding:12px 10px"><table class="zone-table"><thead><tr><th>Zone</th><th>Power</th><th>Heart rate</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function viewWorkout(idx) {
    const raw = arr(P().workouts)[+idx];
    if (!state.plan || !raw || typeof raw !== 'object') {
      return `<div class="empty">This workout isn't in the current plan any more.<br><br><a class="btn" href="#agenda">Go to Agenda</a></div>`;
    }
    const w = obj(raw);
    const t = typeInfo(txt(w.type));
    const ds = normDate(w.date);
    const dur = durationLabel(w);
    let html = `<div class="page-head">
      <div class="eyebrow">${t.icon} ${esc(t.label)}</div>
      <h2>${esc(txt(w.title) || t.label)}</h2>
      <div class="chips">
        ${ds ? `<a class="chip" href="#day/${ds}">📅 ${esc(fmtDate(ds))}${relDay(ds) ? ' · ' + relDay(ds) : ''}</a>` : ''}
        ${dur ? `<span class="chip">⏱ ${esc(dur)}</span>` : ''}
        ${zoneChip(w.zone)}
      </div>
    </div>`;

    html += safe(() => (txt(w.purpose) ? `<div class="section" style="margin-top:0"><h3>Purpose</h3><div class="card">${esc(txt(w.purpose))}</div></div>` : ''), 'the purpose');

    html += safe(() => {
      const steps = arr(w.steps);
      if (!steps.length) return '';
      const total = fmtDur(workoutTotalSec(w));
      return `<div class="section"><h3>Steps</h3><div class="steps">${steps.map((s) => renderStep(s, 0)).join('')}
        ${total ? `<div class="total-row"><span>Total</span><span>${esc(total)}</span></div>` : ''}</div></div>`;
    }, 'the steps');

    html += safe(() => (txt(w.cue) ? `<div class="section"><h3>Coaching cue</h3><div class="cue">“${esc(txt(w.cue))}”</div></div>` : ''), 'the coaching cue');

    html += safe(() => {
      const f = fuelHTML(w.fuel, w);
      return f ? `<div class="section"><h3>Fuel plan</h3>${f}</div>` : '';
    }, 'the fuel plan');

    html += safe(() => {
      const n = txt(w.notes) || txt(w.note);
      return n ? `<div class="section"><h3>Notes</h3><div class="card" style="white-space:pre-wrap">${esc(n)}</div></div>` : '';
    }, 'the notes');

    html += safe(() => {
      const zt = zoneTableHTML(w.zone);
      return zt ? `<div class="section"><h3>Zone reference</h3>${zt}</div>` : '';
    }, 'the zone reference');

    return html;
  }

  /* ---------------- screen: Goals ---------------- */

  function goalsSorted() {
    return arr(P().goals).map(obj).filter((g) => Object.keys(g).length).map((g) => {
      const d = parseDate(g.date);
      return { g, date: d ? iso(d) : '', days: d ? daysBetween(new Date(), d) : null };
    }).sort((a, b) => (a.date || '9999') < (b.date || '9999') ? -1 : 1);
  }

  function viewGoals() {
    let html = `<div class="page-head"><div class="eyebrow">Goals</div><h2>What you're training for</h2></div>`;
    if (!state.plan) return html + noPlanHTML();
    html += safe(() => {
      const gs = goalsSorted();
      if (!gs.length) return '<div class="empty">No goals in the plan yet.</div>';
      return gs.map(({ g, date, days }) => {
        const status = txt(g.status);
        const past = days != null && days < 0;
        let cd = '';
        if (days != null) {
          if (days === 0) cd = `<div class="countdown"><div class="n">🎉</div><div class="u">Today!</div></div>`;
          else if (past) cd = `<div class="countdown past"><div class="n">${-days}</div><div class="u">days ago</div></div>`;
          else cd = `<div class="countdown"><div class="n">${days}</div><div class="u">${days === 1 ? 'day' : 'days'} to go</div></div>`;
        }
        const weeks = days > 13 ? ` · ${Math.floor(days / 7)} weeks ${days % 7 ? days % 7 + ' d' : ''}` : '';
        return `<div class="card goal">
          <div>
            <div class="title">${esc(txt(g.title) || 'Goal')}</div>
            ${txt(g.metric) ? `<div class="metric">${esc(txt(g.metric))}</div>` : ''}
            <div class="date">${date ? esc(fmtDate(date, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })) + esc(weeks) : 'No date set'}</div>
            ${status && status !== 'active' ? `<div class="chips"><span class="chip">${esc(prettify(status))}</span></div>` : ''}
          </div>
          ${cd}
        </div>`;
      }).join('');
    }, 'the goals');
    return html;
  }

  /* ---------------- screen: Food ---------------- */

  function shopKey() { return normDate(P().updated) || 'plan'; }
  function shopTicks() {
    const s = obj(lsGet(LS.shop, {}));
    return s.plan === shopKey() ? obj(s.ticked) : {};
  }

  function shopItemParts(it) {
    if (txt(it)) return { name: txt(it), qty: '', cat: '' };
    const o = obj(it);
    return {
      name: txt(o.item) || txt(o.name) || txt(o.text),
      qty: txt(o.qty) || txt(o.quantity) || txt(o.amount),
      cat: txt(o.category) || txt(o.aisle),
    };
  }

  function viewFood() {
    let html = `<div class="page-head"><div class="eyebrow">Nutrition</div><h2>Food</h2></div>`;
    if (!state.plan) return html + noPlanHTML();
    const t = today();
    const todayType = txt(obj(mealsOn(t)[0]).day_type);

    html += safe(() => {
      const dts = Object.keys(dayTypes()).filter((k) => Object.keys(obj(dayTypes()[k])).length);
      if (!dts.length) return '';
      const cell = (v) => `<div class="n">${isNum(v) && v > 0 ? esc(num(v)) : '–'}</div>`;
      return `<div class="section" style="margin-top:0"><h3>Daily targets</h3><div class="targets-grid">
        <div class="target-row head"><div>Day type</div><div class="n">Carbs g</div><div class="n">Protein g</div><div class="n">kcal</div></div>
        ${dts.map((k) => {
          const d = obj(dayTypes()[k]);
          return `<div class="target-row${k === todayType ? ' hl' : ''}"><div class="dt">${esc(prettify(k))}</div>${cell(d.carbs_g)}${cell(d.protein_g)}${cell(d.kcal)}</div>`;
        }).join('')}
      </div>${todayType ? `<div class="muted small" style="margin:8px 2px 0">Today's day type: <b>${esc(prettify(todayType))}</b> (highlighted).</div>` : ''}</div>`;
    }, 'the daily targets');

    html += safe(() => {
      const meals = arr(nutrition().meals).map(obj).filter((m) => Object.keys(m).length)
        .sort((a, b) => (normDate(a.date) < normDate(b.date) ? -1 : 1));
      if (!meals.length) return '';
      return `<div class="section"><h3>Meal plan</h3>${meals.map((m) => {
        const ds = normDate(m.date);
        const dt = txt(m.day_type);
        const items = arr(m.items).map(mealItemHTML).filter(Boolean).join('');
        return `<details class="card${ds === t ? ' today' : ''}"${ds === t ? ' open' : ''}>
          <summary><span>${esc(ds ? fmtDate(ds) : txt(m.date) || 'Day')}${ds === t ? ' · Today' : ''}</span>${dt ? `<span class="chip day-type">${esc(prettify(dt))}</span>` : ''}</summary>
          <div class="inner">${dt ? targetStats(dt) : ''}${items ? `<ul class="meal-list">${items}</ul>` : '<div class="muted small">No meals listed.</div>'}</div>
        </details>`;
      }).join('')}</div>`;
    }, 'the meal plan');

    html += safe(() => {
      const list = arr(nutrition().shopping_list).map(shopItemParts).filter((x) => x.name);
      if (!list.length) return '';
      const ticks = shopTicks();
      const done = list.filter((x) => ticks[x.name]).length;
      const check = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
      // group by category if the coach used categories
      const groups = {};
      list.forEach((x) => { (groups[x.cat] = groups[x.cat] || []).push(x); });
      const body = Object.keys(groups).map((cat) => `
        ${cat ? `<div class="muted small" style="font-weight:650;margin:12px 2px 2px">${esc(cat)}</div>` : ''}
        <ul class="shop">${groups[cat].map((x) => `<li><label>
          <input type="checkbox" data-shop="${esc(x.name)}"${ticks[x.name] ? ' checked' : ''}>
          <span class="box">${check}</span><span class="txt">${esc(x.name)}</span>${x.qty ? `<span class="qty">${esc(x.qty)}</span>` : ''}
        </label></li>`).join('')}</ul>`).join('');
      return `<div class="section"><h3><span>Shopping list · ${done}/${list.length}</span>${done ? '<button class="btn small" data-action="shop-clear">Untick all</button>' : ''}</h3>
        <div class="card">${body}</div></div>`;
    }, 'the shopping list');

    return html;
  }

  /* ---------------- screen: Check-in ---------------- */

  function getCheckins() { return obj(lsGet(LS.checkins, {})); }

  function seg(name, options, current) {
    return `<div class="seg seg-${options.length}">${options.map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return `<label><input type="radio" name="${name}" value="${esc(v)}"${String(current) === String(v) ? ' checked' : ''}><span>${esc(l)}</span></label>`;
    }).join('')}</div>`;
  }

  function checkinLines(c) {
    const lines = [];
    const doneMap = { yes: 'yes', partly: 'partly', no: 'no' };
    if (c.done || c.what) lines.push(`Session done: ${doneMap[c.done] || '–'}${c.what ? ' — ' + c.what : ''}`);
    const perf = [];
    if (c.duration_min) perf.push(`${c.duration_min} min`);
    if (c.power_w) perf.push(`avg ${c.power_w} W`);
    if (c.hr_bpm) perf.push(`avg HR ${c.hr_bpm} bpm`);
    if (perf.length) lines.push('Duration/avg: ' + perf.join(', '));
    const feel = [];
    if (c.rpe) feel.push(`RPE ${c.rpe}/10`);
    if (c.legs) feel.push(`legs ${c.legs}/5`);
    if (c.sleep_h) feel.push(`sleep ${c.sleep_h} h`);
    if (c.stress) feel.push(`stress ${c.stress}/5`);
    if (feel.length) lines.push(feel.join(', '));
    if (c.fuelled) lines.push(`Fuelled as planned: ${c.fuelled}`);
    if (c.notes) lines.push(`Notes: ${c.notes}`);
    return lines;
  }

  function checkinsText() {
    const all = getCheckins();
    const dates = Object.keys(all).sort();
    const name = txt(obj(P().athlete).name);
    const out = [`Check-ins${name ? ' – ' + name : ''} (${dates.length}, copied ${today()})`, ''];
    dates.forEach((d) => {
      out.push(`${d} (${fmtDate(d, { weekday: 'short' })})`);
      checkinLines(obj(all[d])).forEach((l) => out.push('- ' + l));
      out.push('');
    });
    return out.join('\n').trim();
  }

  function viewCheckin(dateArg) {
    const ds = normDate(dateArg) || today();
    const all = getCheckins();
    const c = obj(all[ds]);
    const planned = state.plan ? workoutsOn(ds) : [];
    const plannedTitle = planned.map((x) => txt(x.w.title) || typeInfo(txt(x.w.type)).label).join(' + ');
    const plannedMin = planned.reduce((t, x) => t + (isNum(x.w.duration_min) ? x.w.duration_min : 0), 0);

    let html = `<div class="page-head"><div class="eyebrow">Daily check-in</div><h2>How did it go?</h2>
      <div class="sub">${all[ds] ? 'Editing your check-in for this day.' : 'Takes one minute. Saved on this phone.'}</div></div>`;

    html += `<form id="ciForm" class="card" autocomplete="off">
      <div class="field"><label class="lbl" for="ci-date">Date</label>
        <input type="date" id="ci-date" name="date" value="${ds}" max="${iso(addDays(new Date(), 1))}"></div>

      <div class="field"><span class="lbl">Session done?</span>
        ${seg('done', [['yes', 'Yes'], ['partly', 'Partly'], ['no', 'No']], c.done)}
        <input type="text" name="what" value="${esc(c.what || '')}" placeholder="${esc(plannedTitle ? 'What did you do? (planned: ' + plannedTitle + ')' : 'What did you do?')}" style="margin-top:8px"></div>

      <div class="field"><span class="lbl">Duration and averages</span>
        <div class="row-3">
          <label><span class="mini">Minutes</span><input type="number" inputmode="numeric" name="duration_min" min="0" value="${esc(c.duration_min || '')}" placeholder="${plannedMin || ''}"></label>
          <label><span class="mini">Avg power W</span><input type="number" inputmode="numeric" name="power_w" min="0" value="${esc(c.power_w || '')}"></label>
          <label><span class="mini">Avg HR bpm</span><input type="number" inputmode="numeric" name="hr_bpm" min="0" value="${esc(c.hr_bpm || '')}"></label>
        </div></div>

      <div class="field"><span class="lbl">RPE <small>(how hard, 1–10)</small></span>
        ${seg('rpe', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'], c.rpe)}
        <div class="seg-hint"><span>1 = very easy</span><span>10 = max</span></div></div>

      <div class="field"><span class="lbl">Legs <small>(1–5)</small></span>
        ${seg('legs', ['1', '2', '3', '4', '5'], c.legs)}
        <div class="seg-hint"><span>1 = dead</span><span>5 = fresh</span></div></div>

      <div class="field"><label class="lbl" for="ci-sleep">Sleep <small>(hours)</small></label>
        <input type="number" id="ci-sleep" inputmode="decimal" step="0.25" min="0" max="24" name="sleep_h" value="${esc(c.sleep_h || '')}" placeholder="e.g. 7.5"></div>

      <div class="field"><span class="lbl">Stress <small>(1–5)</small></span>
        ${seg('stress', ['1', '2', '3', '4', '5'], c.stress)}
        <div class="seg-hint"><span>1 = relaxed</span><span>5 = very stressed</span></div></div>

      <div class="field"><span class="lbl">Fuelled as planned?</span>
        ${seg('fuelled', [['yes', 'Yes'], ['no', 'No']], c.fuelled)}</div>

      <div class="field"><label class="lbl" for="ci-notes">Notes</label>
        <textarea id="ci-notes" name="notes" placeholder="Anything your coach should know: pain, illness, motivation, weather…">${esc(c.notes || '')}</textarea></div>

      <button class="btn primary" type="submit">Save check-in</button>
    </form>`;

    const dates = Object.keys(all).sort().reverse();
    html += `<div class="section"><h3><span>Saved check-ins · ${dates.length}</span></h3>
      <div class="stack" style="margin-bottom:14px">
        <button class="btn primary" data-action="copy-checkins"${dates.length ? '' : ' disabled style="opacity:.5"'}>📋 Copy all for my coach</button>
      </div>
      ${dates.length ? dates.map((d) => {
        const x = obj(all[d]);
        return `<div class="card ci-item">
          <div class="ci-head"><span class="ci-date">${x.done ? `<span class="status-dot status-${esc(x.done)}"></span>` : ''}${esc(fmtDate(d))}</span>
            <span class="muted small">${esc(relDay(d))}</span></div>
          <div class="ci-body">${esc(checkinLines(x).join('\n'))}</div>
          <div class="ci-actions">
            <a class="btn small" href="#checkin/${d}">Edit</a>
            <button class="btn small danger" data-action="delete-checkin" data-date="${d}">${state.pendingDelete === d ? 'Tap again to delete' : 'Delete'}</button>
          </div></div>`;
      }).join('') : '<div class="empty" style="padding:20px">No check-ins yet.</div>'}
    </div>`;
    return html;
  }

  function saveCheckin(form) {
    const fd = new FormData(form);
    const g = (k) => String(fd.get(k) || '').trim();
    const ds = normDate(g('date'));
    if (!ds) { toast('Please pick a date first'); return; }
    const c = {
      done: g('done'), what: g('what'),
      duration_min: g('duration_min'), power_w: g('power_w'), hr_bpm: g('hr_bpm'),
      rpe: g('rpe'), legs: g('legs'), sleep_h: g('sleep_h'), stress: g('stress'),
      fuelled: g('fuelled'), notes: g('notes'),
    };
    Object.keys(c).forEach((k) => { if (!c[k]) delete c[k]; });
    if (!Object.keys(c).length) { toast('Nothing filled in yet'); return; }
    c.saved_at = new Date().toISOString();
    const all = getCheckins();
    all[ds] = c;
    if (!lsSet(LS.checkins, all)) { toast('Could not save on this phone'); return; }
    toast('Check-in saved ✓');
    state.pendingDelete = '';
    if (location.hash !== '#checkin') location.hash = '#checkin';
    else render();
    window.scrollTo(0, 0);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // Fallback for older browsers
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  /* ---------------- screen: Settings / Import ---------------- */

  function friendlyJsonError(err, text) {
    const msg = String(err && err.message || err);
    let where = '';
    const m = /position (\d+)/i.exec(msg);
    if (m) {
      const pos = +m[1];
      const line = text.slice(0, pos).split('\n').length;
      const snippet = text.slice(Math.max(0, pos - 40), pos + 40);
      where = `<br>Problem around line ${line}:<pre>${esc(snippet)}</pre>`;
    }
    return `The plan isn't valid JSON, so I didn't save it.${where}
      <ul><li>Make sure you copied the <b>whole</b> plan, from the first <code>{</code> to the last <code>}</code>.</li>
      <li>Ask your coach to "send plan.json again as valid JSON".</li></ul>
      <span class="muted small">Technical detail: ${esc(msg)}</span>`;
  }

  // Check pasted text and turn it into a plan. Returns { data, warnings } or { error }.
  function parsePlanText(raw) {
    let t = String(raw || '').trim();
    if (!t) return { error: 'The box is empty. Paste the plan from your coach first.' };
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
    if (fence) t = fence[1].trim();
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a === -1 || b <= a) return { error: "This doesn't look like a plan: I can't find the opening <b>{</b> and closing <b>}</b>. Make sure you copied the whole plan." };
    t = t.slice(a, b + 1);
    const warnings = [];
    let data;
    try {
      data = JSON.parse(t);
    } catch (e) {
      // Try fixing two common copy/paste problems: curly quotes and trailing commas
      const fixed = t.replace(/[“”„]/g, '"').replace(/,\s*([}\]])/g, '$1');
      try {
        data = JSON.parse(fixed);
        warnings.push('I fixed a small formatting problem (curly quotes or an extra comma).');
      } catch (e2) {
        return { error: friendlyJsonError(e, t) };
      }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: "That's valid JSON, but it isn't a plan (it should start with <b>{</b>)." };
    if (!normDate(data.updated)) warnings.push('The plan has no valid "updated" date (like 2026-10-05), so the app can\'t tell if it is newer than the website plan.');
    if (!Array.isArray(data.workouts)) warnings.push('No "workouts" list found.');
    return { data, warnings };
  }

  function planSummary(p) {
    p = obj(p);
    const n = (v) => arr(v).length;
    return `${n(p.workouts)} workouts, ${n(p.goals)} goals, ${n(obj(p.nutrition).meals)} meal days`;
  }

  function viewSettings() {
    const p = P();
    const imp = state.importedPlan;
    const repo = state.repoPlan;
    let html = `<div class="page-head"><div class="eyebrow">Settings</div><h2>Plan &amp; import</h2></div>`;

    html += `<div class="section" style="margin-top:0"><h3>Plan in use</h3><div class="card">
      ${state.plan ? `<dl class="kv">
        <dt>Source</dt><dd>${state.source === 'pasted' ? 'Pasted in the app' : 'Website (plan.json)'}</dd>
        <dt>Version</dt><dd>${esc(txt(p.version) || '–')}</dd>
        <dt>Updated</dt><dd>${esc(normDate(p.updated) ? fmtDate(p.updated, { day: 'numeric', month: 'short', year: 'numeric' }) : '–')}</dd>
        <dt>Contains</dt><dd>${esc(planSummary(p))}</dd>
        ${txt(obj(p.block).name) ? `<dt>Block</dt><dd>${esc(txt(obj(p.block).name))}</dd>` : ''}
      </dl>` : '<div class="muted">No plan loaded.</div>'}
      <div class="muted small" style="margin-top:12px">
        Website plan: ${repo ? esc(normDate(repo.updated) || 'no date') : esc(state.repoError || 'not loaded')}<br>
        Pasted plan: ${imp ? esc(normDate(imp.updated) || 'no date') : 'none'}
      </div>
      <div class="stack" style="margin-top:14px">
        <button class="btn" data-action="reload">↻ Check website for a new plan</button>
        ${imp ? '<button class="btn danger" data-action="forget-import">Remove pasted plan (use website plan)</button>' : ''}
      </div>
    </div></div>`;

    html += `<div class="section"><h3>Import a new plan</h3><div class="card">
      <p class="small muted" style="margin-top:0">Copy the plan.json text from your coach, paste it below and tap <b>Check &amp; save</b>. The app uses it when its "updated" date is newer than the website plan.</p>
      <textarea id="importBox" class="code" placeholder='{ "version": 1, "updated": "2026-10-05", … }' spellcheck="false" autocapitalize="off" autocorrect="off">${esc(state.importText)}</textarea>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn" data-action="paste">Paste</button>
        <button class="btn primary" data-action="import">Check &amp; save</button>
      </div>
      <div id="importMsg">${state.importMsg}</div>
    </div></div>`;

    const a = obj(p.athlete);
    const facts = [['FTP', a.ftp_w, 'W'], ['CP', a.cp_w, 'W'], ['Best 5 min', a.best_5min_w, 'W'], ['Max HR', a.max_hr, 'bpm'], ['Weight', a.weight_kg, 'kg']]
      .filter(([, v]) => isNum(v));
    if (txt(a.name) || facts.length) {
      html += `<div class="section"><h3>Athlete</h3><div class="card"><dl class="kv">
        ${txt(a.name) ? `<dt>Name</dt><dd>${esc(txt(a.name))}</dd>` : ''}
        ${facts.map(([k, v, u]) => `<dt>${k}</dt><dd>${esc(num(v))} ${u}</dd>`).join('')}
      </dl></div></div>`;
    }
    html += safe(() => {
      const zt = zoneTableHTML('');
      return zt ? `<div class="section"><h3>Zones</h3>${zt}</div>` : '';
    }, 'the zones');

    html += `<p class="center muted small" style="margin-top:28px">Trainer v${APP_VERSION} · your check-ins stay on this phone</p>`;
    return html;
  }

  function doImport() {
    const box = $('#importBox');
    state.importText = box ? box.value : '';
    const r = parsePlanText(state.importText);
    if (r.error) {
      state.importMsg = `<div class="card error msg">${r.error}</div>`;
      render(true);
      return;
    }
    if (!lsSet(LS.imported, r.data)) {
      state.importMsg = '<div class="card error msg">Could not save on this phone (storage full or blocked).</div>';
      render(true);
      return;
    }
    state.importedPlan = r.data;
    choosePlan();
    const used = state.source === 'pasted';
    const warn = r.warnings.length ? `<ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '';
    state.importMsg = `<div class="card ${used ? 'success' : 'warn'} msg">
      ${used
        ? `<b>✓ Plan saved and in use.</b><br>${esc(planSummary(r.data))}, updated ${esc(normDate(r.data.updated) || '?')}.`
        : `<b>Saved, but not in use.</b> The website plan (${esc(normDate(obj(state.repoPlan).updated) || '?')}) is the same date or newer than this one (${esc(normDate(r.data.updated) || 'no date')}). Ask your coach to set a newer "updated" date.`}
      ${warn}</div>`;
    state.importText = '';
    render(true);
    toast(used ? 'New plan loaded ✓' : 'Saved, website plan is newer');
  }

  /* ---------------- loading the plan ---------------- */

  function choosePlan() {
    const r = state.repoPlan, m = state.importedPlan;
    const key = (p) => normDate(obj(p).updated);
    if (m && (!r || key(m) > key(r))) {
      state.plan = m;
      state.source = 'pasted';
    } else if (r) {
      state.plan = r;
      state.source = 'website';
    } else {
      state.plan = null;
      state.source = '';
    }
  }

  async function loadPlan() {
    const imp = lsGet(LS.imported, null);
    state.importedPlan = imp && typeof imp === 'object' && !Array.isArray(imp) ? imp : null;
    state.repoError = '';
    try {
      const res = await fetch('plan.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const r = parsePlanText(await res.text());
      if (r.error) {
        state.repoPlan = null;
        state.repoError = 'The plan.json on the website has an error (not valid JSON).';
      } else {
        state.repoPlan = r.data;
      }
    } catch (e) {
      state.repoPlan = null;
      state.repoError = "Couldn't load plan.json (are you offline?).";
    }
    choosePlan();
  }

  /* ---------------- navigation ---------------- */

  const TITLES = { today: 'Today', agenda: 'Agenda', goals: 'Goals', food: 'Food', checkin: 'Check-in', settings: 'Settings', day: 'Day', workout: 'Workout' };
  const TOP_LEVEL = ['today', 'agenda', 'goals', 'food', 'checkin'];

  function parseRoute() {
    const h = decodeURIComponent(location.hash.replace(/^#/, '')) || 'today';
    const [name, arg] = h.split('/');
    return { name: TITLES[name] ? name : 'today', arg: arg || '' };
  }

  function render(keepScroll) {
    const r = parseRoute();
    state.route = r.name;
    let html;
    try {
      switch (r.name) {
        case 'agenda': html = viewAgenda(); break;
        case 'goals': html = viewGoals(); break;
        case 'food': html = viewFood(); break;
        case 'checkin': html = viewCheckin(r.arg); break;
        case 'settings': html = viewSettings(); break;
        case 'day': html = viewDay(r.arg); break;
        case 'workout': html = viewWorkout(r.arg); break;
        default: html = viewToday();
      }
    } catch (e) {
      console.error(e);
      html = `<div class="card error"><b>Something went wrong showing this screen.</b><p class="muted small">${esc(e.message)}</p><a class="btn" href="#settings">Open Settings</a></div>`;
    }
    $('#view').innerHTML = html;

    let title = TITLES[r.name];
    if (r.name === 'workout') {
      const w = obj(arr(P().workouts)[+r.arg]);
      title = txt(w.title) || typeInfo(txt(w.type)).label;
    } else if (r.name === 'day') {
      title = fmtDate(r.arg) || 'Day';
    }
    $('#title').textContent = title;
    document.title = title + ' · Trainer';

    const isTop = TOP_LEVEL.includes(r.name);
    $('#backBtn').hidden = isTop;
    $('#gearBtn').classList.toggle('active', r.name === 'settings');
    const activeTab = { day: 'agenda', workout: 'agenda' }[r.name] || r.name;
    document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === activeTab));
    if (!keepScroll) window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', () => {
    state.navDepth++;
    state.pendingDelete = '';
    if (parseRoute().name !== 'settings') state.importMsg = '';
    render();
  });

  /* ---------------- taps and form events ---------------- */

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;

    if (action === 'back') {
      if (state.navDepth > 0) history.back();
      else location.hash = '#today';
    } else if (action === 'week') {
      const dir = +el.dataset.dir;
      state.weekOffset = dir === 0 ? 0 : state.weekOffset + dir;
      render(true);
    } else if (action === 'shop-clear') {
      lsSet(LS.shop, { plan: shopKey(), ticked: {} });
      render(true);
    } else if (action === 'copy-checkins') {
      const ok = await copyText(checkinsText());
      toast(ok ? 'Copied! Paste it into your coach chat.' : "Couldn't copy. Try again.");
    } else if (action === 'delete-checkin') {
      const d = el.dataset.date;
      if (state.pendingDelete === d) {
        const all = getCheckins();
        delete all[d];
        lsSet(LS.checkins, all);
        state.pendingDelete = '';
        toast('Check-in deleted');
      } else {
        state.pendingDelete = d;
      }
      render(true);
    } else if (action === 'import') {
      doImport();
    } else if (action === 'paste') {
      try {
        const t = await navigator.clipboard.readText();
        $('#importBox').value = t;
        state.importText = t;
      } catch (err) {
        toast('Tap and hold in the box, then choose Paste');
        $('#importBox').focus();
      }
    } else if (action === 'forget-import') {
      lsSet(LS.imported, null);
      state.importedPlan = null;
      choosePlan();
      state.importMsg = '<div class="card success msg">Pasted plan removed. Using the website plan.</div>';
      render(true);
    } else if (action === 'reload') {
      el.textContent = 'Checking…';
      await loadPlan();
      state.importMsg = '';
      render(true);
      toast(state.repoPlan ? `Website plan: ${normDate(state.repoPlan.updated) || 'loaded'}` : state.repoError);
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('input[data-shop]')) {
      const ticks = shopTicks();
      if (t.checked) ticks[t.dataset.shop] = true;
      else delete ticks[t.dataset.shop];
      lsSet(LS.shop, { plan: shopKey(), ticked: ticks });
      render(true);
    } else if (t.id === 'ci-date') {
      const ds = normDate(t.value);
      if (ds) location.hash = '#checkin/' + ds;
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'importBox') state.importText = e.target.value;
  });

  document.addEventListener('submit', (e) => {
    if (e.target.id === 'ciForm') {
      e.preventDefault();
      saveCheckin(e.target);
    }
  });

  // Keep "today" and the goal countdowns correct when the app is reopened on a new day
  let lastDay = today();
  function refreshIfNewDay() {
    if (today() !== lastDay) {
      lastDay = today();
      render(true);
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshIfNewDay();
      // quietly check for a new plan when the app comes back to the front
      loadPlan().then(() => { if (!document.activeElement || !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) render(true); });
    }
  });
  setInterval(refreshIfNewDay, 60 * 1000);

  /* ---------------- start ---------------- */

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  loadPlan().then(() => render());
})();
