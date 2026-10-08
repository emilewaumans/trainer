/* ==========================================================
   Trainer — app logic
   Reads plan.json (or a pasted plan) and draws each screen.
   Never changes the plan. Everything in the plan is optional:
   missing fields are skipped, unknown fields are ignored.
   ========================================================== */
'use strict';

(function () {
  const APP_VERSION = '1.9.0';

  // Keys used to store things on the phone (localStorage)
  const LS = {
    imported: 'trainer.importedPlan',
    checkins: 'trainer.checkins',
    shop: 'trainer.shopping',
    goalSeen: 'trainer.goalSeen',
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
    focus: '',           // Today: the step shown in the big card
    focusDate: '',
    shopMode: 'week',    // Food: 'week' or 'day'
    shopDay: '',
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

  // Line icons (drawn, not emoji). They take the text colour around them.
  const svgIcon = (body) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
  const ICON = {
    bike: svgIcon('<circle cx="5.5" cy="16.5" r="3.8"/><circle cx="18.5" cy="16.5" r="3.8"/><path d="M5.5 16.5 9 9.5h6.5l3 7M9 9.5l3.2 7M12.2 16.5l3.3-7M7.5 7h3M15.5 9.5 14.6 6.5h2.4"/>'),
    run: svgIcon('<circle cx="15" cy="4.2" r="2"/><path d="M7 11.5 10.5 8h4l2.5 3.5 3 .5M10.5 8 9 14l3.5 3V22M9 14l-2.5 3.5H3"/>'),
    kettlebell: svgIcon('<path d="M8.6 10.2C7.6 5.2 9.4 3 12 3s4.4 2.2 3.4 7.2"/><circle cx="12" cy="15.2" r="6"/><path d="M9.5 15.2h5"/>'),
    swim: svgIcon('<circle cx="17.5" cy="6.5" r="2"/><path d="M3 12.5 8 9l4 2.5 3-2.5M2 17c1.7 0 2.3-1.2 4-1.2s2.3 1.2 4 1.2 2.3-1.2 4-1.2 2.3 1.2 4 1.2 2.3-1.2 4-1.2M2 21c1.7 0 2.3-1.2 4-1.2s2.3 1.2 4 1.2 2.3-1.2 4-1.2 2.3 1.2 4 1.2 2.3-1.2 4-1.2"/>'),
    rest: svgIcon('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/><path d="M15 3.5h3l-3 3.5h3"/>'),
    // an old-fashioned weight for a balance scale
    load: svgIcon('<circle cx="12" cy="5.8" r="2.6"/><path d="M7.2 9.5h9.6l3.2 11H4z"/>'),
    dot: svgIcon('<circle cx="12" cy="12" r="3"/>'),
    flame: svgIcon('<path d="M12 21.5c-3.9 0-6.5-2.6-6.5-6.2 0-3.4 2.4-5.4 3.6-8.3.5 1.6 1.4 2.6 2.4 3.1.2-3.1 1.6-5.6 4-7.6-.4 3.4 1.2 5.6 2.4 7.6.9 1.5 1.6 3.1 1.6 5.2 0 3.6-2.6 6.2-7.5 6.2z"/><path d="M12 21.5c-1.8 0-3-1.2-3-2.9 0-1.8 1.4-2.8 2.2-4.3.9 1.4 3.8 2.4 3.8 4.6 0 1.5-1.2 2.6-3 2.6z"/>'),
    bolt: svgIcon('<path d="M13.5 2.5 4.5 13.5h6.5l-1 8 9-11h-6.5z"/>'),
    trophy: svgIcon('<path d="M7 3.5h10v5.5a5 5 0 0 1-10 0z"/><path d="M7 5.5H4v1.5a3.5 3.5 0 0 0 3.4 3.5M17 5.5h3v1.5a3.5 3.5 0 0 1-3.4 3.5M12 14v3.5M8 20.5h8M9.5 17.5h5v3h-5z"/>'),
    sun: svgIcon('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>'),
    moon: svgIcon('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
    note: svgIcon('<rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M9 8.5h6M9 12h6M9 15.5h3.5"/>'),
    bowl: svgIcon('<path d="M3.5 11.5h17a8.5 8.5 0 0 1-17 0z"/><path d="M9 7.5c0-1.5 1-2 1-3.5M13.5 7.5c0-1.5 1-2 1-3.5"/>'),
    plate: svgIcon('<path d="M7 2.5v8.5M4.5 2.5v5a2.5 2.5 0 0 0 5 0v-5M7 11v10.5M17 21.5v-19c-2.5 1.5-3.5 4-3.5 7.5V14H17"/>'),
    bottle: svgIcon('<path d="M9.5 2.5h5M10 2.5v3l-2 2.5v12A1.5 1.5 0 0 0 9.5 21.5h5a1.5 1.5 0 0 0 1.5-1.5V8l-2-2.5v-3M8 12h8"/>'),
    apple: svgIcon('<path d="M12 7.5c-1.5-1-5.5-1.5-6.5 2.5-1 4 1.5 10 4 10 1 0 1.5-.5 2.5-.5s1.5.5 2.5.5c2.5 0 5-6 4-10-1-4-5-3.5-6.5-2.5z"/><path d="M12 7.5c0-2 1-3.5 2.5-4.5"/>'),
    flag: svgIcon('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
    copy: svgIcon('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>'),
    check: svgIcon('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    clock: svgIcon('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M10 2.5h4"/>'),
    calendar: svgIcon('<rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>'),
    heart: svgIcon('<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/>'),
    breath: svgIcon('<path d="M3 8h10a2.5 2.5 0 1 0-2.5-2.5M3 12h15a2.5 2.5 0 1 1-2.5 2.5M3 16h7"/>'),
    drop: svgIcon('<path d="M12 3.5s-6 6.5-6 10.5a6 6 0 0 0 12 0c0-4-6-10.5-6-10.5z"/>'),
    medal: svgIcon('<circle cx="12" cy="15" r="5.5"/><path d="M8.5 10.8 5.5 2.5h4l2.5 6 2.5-6h4l-3 8.3M12 12.5l.9 1.8 2 .3-1.4 1.4.3 2-1.8-.9-1.8.9.3-2-1.4-1.4 2-.3z"/>'),
    cloud: svgIcon('<path d="M7 18.5h10.5a4 4 0 0 0 .3-8A6 6 0 0 0 6.3 12 3.3 3.3 0 0 0 7 18.5z"/>'),
    cloudSun: svgIcon('<path d="M8.5 3v1.2M3.8 5l.9.9M2.5 9.5h1.2M5.3 12.3a3.5 3.5 0 1 1 5.7-4"/><path d="M9 20h8.5a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.4 1.3A2.9 2.9 0 0 0 9 20z"/>'),
    rain: svgIcon('<path d="M7 15.5h10a3.5 3.5 0 0 0 .3-7A5.5 5.5 0 0 0 6.6 9.8 2.9 2.9 0 0 0 7 15.5z"/><path d="M8.5 18.5l-1 2.5M12.5 18.5l-1 2.5M16.5 18.5l-1 2.5"/>'),
    storm: svgIcon('<path d="M7 15.5h10a3.5 3.5 0 0 0 .3-7A5.5 5.5 0 0 0 6.6 9.8 2.9 2.9 0 0 0 7 15.5z"/><path d="M12.5 16.5l-2 3h3l-2 3"/>'),
    snow: svgIcon('<path d="M7 15.5h10a3.5 3.5 0 0 0 .3-7A5.5 5.5 0 0 0 6.6 9.8 2.9 2.9 0 0 0 7 15.5z"/><path d="M8.5 19.5h.01M12 19.5h.01M15.5 19.5h.01M10.2 22h.01M13.8 22h.01"/>'),
    fog: svgIcon('<path d="M4 9h16M6 13h14M4 17h12"/>'),
  };

  const TYPES = {
    rest: { label: 'Rest', icon: ICON.rest, cls: 't-rest' },
    easy: { label: 'Easy ride', icon: ICON.bike, cls: 't-easy' },
    recovery: { label: 'Recovery ride', icon: ICON.bike, cls: 't-easy' },
    tempo: { label: 'Tempo', icon: ICON.bike, cls: 't-tempo' },
    vo2_intervals: { label: 'VO2max intervals', icon: ICON.bike, cls: 't-hard' },
    long_ride: { label: 'Long ride', icon: ICON.bike, cls: 't-long' },
    long_ride_intervals: { label: 'Long ride + intervals', icon: ICON.bike, cls: 't-long' },
    strength: { label: 'Strength', icon: ICON.kettlebell, cls: 't-strength' },
    benchmark_test: { label: 'Benchmark test', icon: ICON.bike, cls: 't-hard' },
    run: { label: 'Run', icon: ICON.run, cls: 't-run' },
    swim: { label: 'Swim', icon: ICON.swim, cls: 't-swim' },
  };
  function typeInfo(t) {
    return TYPES[t] || { label: prettify(t) || 'Workout', icon: ICON.dot, cls: 't-other' };
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

  // One workout, the same look everywhere: icon, title, duration, then load/intensity and a mini power chart
  // r (optional) = planned-vs-done result: a finished session gets a check badge and a "completed" footer
  function sessionHTML(w, wk, r) {
    const t = typeInfo(txt(w.type));
    const dur = durationLabel(w);
    const st = r && ['done', 'partly', 'skipped'].includes(r.status) ? r.status : '';
    return `<div class="sess ${t.cls}${st ? ' is-' + st : ''}">
      <div class="sess-head"><span class="sess-ic">${t.icon}${st === 'done' || st === 'partly' ? `<i class="sess-check">${ICON.check}</i>` : ''}</span><span class="sess-title">${esc(txt(w.title) || t.label)}</span>${dur ? `<span class="dur">${esc(dur)}</span>` : ''}</div>
      ${txt(w.type) === 'rest' ? '' : safe(() => plannedMiniHTML(w, wk), 'the chart')}
      ${st ? doneStripHTML(r) : ''}
    </div>`;
  }

  function workoutCard(x) {
    const w = x.w, t = typeInfo(txt(w.type));
    const d = parseDate(w.date);
    const wk = d ? icuWeek(mondayOf(d)) : null;
    const r = txt(w.type) === 'rest' ? null : matchFor(x, wk);
    const st = r && ['done', 'partly', 'skipped'].includes(r.status) ? ' card-' + r.status : '';
    return `<a class="card workout ${t.cls}${st}" href="#workout/${x.i}">${sessionHTML(w, wk, r)}<span class="chev">›</span></a>`;
  }

  // Today's workouts at the top of the Today page, or a rest-day card of the same size
  function todaySessionsHTML(ds) {
    const ws = workoutsOn(ds).filter((x) => txt(x.w.type) !== 'rest');
    if (ws.length) return `<div class="section today-sess" style="margin-top:0"><h3>Today's session${ws.length > 1 ? 's' : ''}</h3>${ws.map(workoutCard).join('')}</div>`;
    const rest = workoutsOn(ds).find((x) => txt(x.w.type) === 'rest');
    const sub = rest ? txt(rest.w.title).replace(/^rest day\s*/i, '').replace(/^\((.*)\)$/, '$1') : '';
    return `<div class="section today-sess" style="margin-top:0"><h3>Today's session</h3>
      <${rest ? `a href="#workout/${rest.i}"` : 'div'} class="card workout t-rest rest-card">
        <span class="rest-ic">${ICON.rest}</span>
        <div><div class="sess-title">Rest day</div><div class="muted small">${esc(sub || 'No training planned. Recover well.')}</div></div>
      </${rest ? 'a' : 'div'}></div>`;
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
      ${dt ? `<div class="chips" style="margin-top:0"><span class="chip day-type dt-${esc(dt)}">${esc(prettify(dt))} day</span></div>` : ''}
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

  /* ---------------- screen: Today (the daily quest) ---------------- */

  // Where each kind of meal goes in the day (hour of the day)
  const MEAL_SLOTS = [
    [/breakfast|ontbijt/i, 7],
    [/morning snack|mid-?morning/i, 10],
    [/lunch/i, 12.5],
    [/pre-?ride|pre-?workout|before (the )?(ride|workout|training|session)/i, 'pre'],
    [/on the bike|during/i, 'during'],
    [/recovery|after (the )?(ride|workout|training|session|strength)|post/i, 'post'],
    [/snack|afternoon/i, 15.5],
    [/dinner|supper|diner/i, 19],
    [/evening|before bed|bedtime/i, 21],
  ];

  function mealIcon(label) {
    const l = txt(label).toLowerCase();
    if (/breakfast/.test(l)) return ICON.bowl;
    if (/lunch/.test(l)) return ICON.plate;
    if (/dinner|supper/.test(l)) return ICON.plate;
    if (/recovery|after|post/.test(l)) return ICON.bottle;
    if (/bike|during/.test(l)) return ICON.bottle;
    if (/snack/.test(l)) return ICON.apple;
    return ICON.plate;
  }

  function parseTime(v) {
    const m = /^(\d{1,2})[:.h](\d{2})/.exec(txt(v));
    return m ? +m[1] + +m[2] / 60 : null;
  }

  function mealParts(it) {
    let s = txt(it), time = null;
    if (!s && it && typeof it === 'object') {
      const o = obj(it);
      time = parseTime(o.time);
      const label = txt(o.meal) || txt(o.name) || txt(o.label);
      const body = txt(o.text) || txt(o.description) || txt(o.items) || (Array.isArray(o.items) ? o.items.map(txt).filter(Boolean).join(', ') : '');
      return { label, body, time };
    }
    const i = s.indexOf(':');
    if (i > 0 && i < 40) return { label: s.slice(0, i).trim(), body: s.slice(i + 1).trim(), time };
    return { label: '', body: s, time };
  }

  // Build today's steps in time order
  function dayFlow(ds) {
    const c = obj(getCheckins()[ds]);
    const steps = [{ id: 'morning', kind: 'morning', slot: 0, icon: ICON.sun, title: 'Good morning', sub: 'Sleep, legs and stress' }];

    const ws = workoutsOn(ds);
    const wSlots = [];
    let k = 0;
    ws.forEach((x) => {
      const t = txt(x.w.type);
      const info = typeInfo(t);
      let slot = parseTime(x.w.time);
      if (slot == null) slot = t === 'rest' ? 7.5 : /^long_ride/.test(t) ? 9 + k * 0.5 : 17 + k * 0.5;
      if (t !== 'rest') { wSlots.push(slot); k++; }
      steps.push({ id: 'workout-' + x.i, kind: t === 'rest' ? 'rest' : 'workout', slot, x, icon: info.icon, title: txt(x.w.title) || info.label, sub: info.label });
    });
    const firstW = wSlots.length ? Math.min(...wSlots) : null;
    const lastW = wSlots.length ? Math.max(...wSlots) : null;
    if (wSlots.length) steps.push({ id: 'session', kind: 'session', slot: lastW + 0.2, icon: ICON.note, title: 'Session check-in', sub: 'How did it feel?' });

    let prev = 6.9;
    mealsOn(ds).forEach((m, mi) => {
      arr(m.items).forEach((it, ii) => {
        const p = mealParts(it);
        if (!p.label && !p.body) return;
        let slot = p.time;
        if (slot == null) {
          const hit = MEAL_SLOTS.find(([re]) => re.test(p.label || p.body));
          let v = hit ? hit[1] : null;
          if (v === 'pre') v = firstW != null ? firstW - 0.2 : null;
          else if (v === 'during') v = firstW != null ? firstW - 0.1 : null;
          else if (v === 'post') v = lastW != null ? lastW + 0.3 : null;
          slot = v != null ? v : prev + 0.01;
        }
        prev = slot;
        steps.push({ id: `meal-${mi}-${ii}`, kind: 'meal', slot, meal: p, dayType: txt(m.day_type), icon: mealIcon(p.label), title: p.label || 'Meal', sub: p.body });
      });
    });

    steps.push({ id: 'wrap', kind: 'wrap', slot: 23, icon: ICON.moon, title: 'Wrap up the day', sub: 'Anything for your coach?' });

    steps.forEach((s, i) => { s.order = i; });
    steps.sort((a, b) => a.slot - b.slot || a.order - b.order);
    steps.forEach((s) => { s.status = stepStatus(s, c); });

    // If every workout was skipped, the session check-in isn't needed
    const wk = steps.filter((s) => s.kind === 'workout');
    const sess = steps.find((s) => s.kind === 'session');
    if (sess && !sess.status && wk.length && wk.every((s) => s.status === 'no')) sess.status = 'no';
    return steps;
  }

  function stepStatus(s, c) {
    const st = obj(c.steps);
    if (st[s.id]) return st[s.id];
    switch (s.kind) {
      case 'morning': return c.sleep_h || c.legs || c.stress ? 'done' : '';
      case 'session': return c.rpe || c.duration_min || c.power_w || c.hr_bpm || c.fuelled ? 'done' : '';
      case 'wrap': return c.notes ? 'done' : '';
      case 'workout':
        // Only use the Check-in page answer if no workout was answered here
        if (Object.keys(st).some((key) => key.startsWith('workout-'))) return '';
        return { yes: 'done', partly: 'half', no: 'no' }[c.done] || '';
      default: return '';
    }
  }

  // Save part of a day's check-in (keeps everything else)
  function updateCheckin(ds, patch) {
    const all = getCheckins();
    const c = Object.assign(obj(all[ds]), patch);
    Object.keys(c).forEach((key) => { if (c[key] === '' || c[key] == null) delete c[key]; });
    c.saved_at = new Date().toISOString();
    all[ds] = c;
    return lsSet(LS.checkins, all);
  }

  function answerStep(ds, step, status) {
    const c = obj(getCheckins()[ds]);
    const patch = { steps: Object.assign({}, obj(c.steps), { [step.id]: status }) };
    if (step.kind === 'meal') patch.meal_log = Object.assign({}, obj(c.meal_log), { [step.title]: status });
    updateCheckin(ds, patch);
    if (step.kind === 'workout') syncSessionDone(ds);
  }

  // Keep the check-in's "Session done?" in line with the workout answers
  function syncSessionDone(ds) {
    const c = obj(getCheckins()[ds]);
    const st = obj(c.steps);
    const wk = dayFlow(ds).filter((s) => s.kind === 'workout');
    const vals = wk.map((s) => st[s.id]).filter(Boolean);
    if (!vals.length) return;
    const patch = { done: vals.every((v) => v === 'done') ? 'yes' : vals.every((v) => v === 'no') ? 'no' : 'partly' };
    // Fill in "what" automatically, unless you typed something yourself
    if (!c.what || c.what === c.what_auto) {
      const names = wk.filter((s) => st[s.id] && st[s.id] !== 'no').map((s) => s.title).join(' + ');
      patch.what = names;
      patch.what_auto = names;
    }
    updateCheckin(ds, patch);
  }

  const SCORE = { done: 10, half: 5, no: 0 };
  function xpOf(c) {
    c = obj(c);
    const st = obj(c.steps);
    let xp = Object.values(st).reduce((t, v) => t + (SCORE[v] || 0), 0);
    if (!st.morning && (c.sleep_h || c.legs || c.stress)) xp += 10;
    if (!st.session && (c.rpe || c.duration_min)) xp += 10;
    if (!st.wrap && c.notes) xp += 10;
    return xp;
  }
  function levelOf(total) {
    const per = 250;
    return { level: Math.floor(total / per) + 1, into: total % per, per, toNext: per - (total % per) };
  }
  function streakDays() {
    const all = getCheckins();
    let d = new Date();
    if (!all[iso(d)]) d = addDays(d, -1);
    let n = 0;
    while (all[iso(d)] && n < 3650) { n++; d = addDays(d, -1); }
    return n;
  }

  function answerButtons(step, options) {
    return `<div class="answers answers-${options.length}">${options.map(([v, label]) =>
      `<button class="ans ans-${v}${step.status === v ? ' sel' : ''}" data-action="flow" data-step="${esc(step.id)}" data-value="${v}">${label}</button>`).join('')}</div>`;
  }

  function stepper(name, value, step, placeholder, unit) {
    return `<div class="stepper">
      <button type="button" class="btn icon" data-action="step-num" data-target="${name}" data-delta="-${step}" data-start="${placeholder}">−</button>
      <label class="stepper-val"><input type="number" inputmode="decimal" name="${name}" step="${step}" min="0" value="${esc(value || '')}" placeholder="${placeholder}"><span>${unit}</span></label>
      <button type="button" class="btn icon" data-action="step-num" data-target="${name}" data-delta="${step}" data-start="${placeholder}">+</button>
    </div>`;
  }

  function questCardBody(s, ds, c) {
    if (s.kind === 'meal') {
      const t = obj(dayTypes()[s.dayType]);
      const chip = s.dayType ? `<div class="chips"><span class="chip day-type dt-${esc(s.dayType)}">${esc(prettify(s.dayType))} day${isNum(t.carbs_g) && t.carbs_g > 0 ? ' · ' + esc(num(t.carbs_g)) + ' g carbs' : ''}</span></div>` : '';
      return `${s.sub && s.meal.label ? `<div class="q-text">${esc(s.sub)}</div>` : ''}${chip}
        ${answerButtons(s, [['done', '✓ Done'], ['half', '½ Half'], ['no', "✕ Didn't"]])}`;
    }
    if (s.kind === 'rest') {
      const w = s.x.w;
      return `${txt(w.purpose) ? `<div class="q-text">${esc(txt(w.purpose))}</div>` : ''}
        ${txt(w.cue) ? `<div class="cue" style="margin-top:12px">“${esc(txt(w.cue))}”</div>` : ''}
        ${answerButtons(s, [['done', 'Got it, resting']])}`;
    }
    if (s.kind === 'workout') {
      const w = s.x.w;
      const dur = durationLabel(w);
      const f = obj(w.fuel);
      const summary = arr(w.steps).map(obj).map((st) => {
        const t = stepTitle(st);
        return t ? `<li>${esc(t)} ${zoneChip(st.zone)}${restSec(st) && repCount(st) > 1 ? ` <span class="muted small">· ${esc(fmtDur(restSec(st)))} easy between</span>` : ''}</li>` : '';
      }).join('');
      const fuel = [
        txt(f.before) ? 'Before: ' + esc(txt(f.before)) : '',
        isNum(f.during_carbs_g_per_h) && f.during_carbs_g_per_h > 0 ? `During: <b>${esc(num(f.during_carbs_g_per_h))} g carbs/h</b>` : '',
      ].filter(Boolean).join('<br>');
      return `<div class="chips">${dur ? `<span class="chip">${ICON.clock} ${esc(dur)}</span>` : ''}${zoneChip(w.zone)}</div>
        ${txt(w.purpose) ? `<div class="q-text">${esc(txt(w.purpose))}</div>` : ''}
        ${summary ? `<ul class="q-steps">${summary}</ul>` : ''}
        ${fuel ? `<div class="q-fuel"><span class="q-fuel-ic">${ICON.bottle}</span><span>${fuel}</span></div>` : ''}
        <a class="btn" href="#workout/${s.x.i}" style="margin-top:14px">See full workout ›</a>
        ${answerButtons(s, [['done', '✓ Done'], ['half', '½ Partly'], ['no', "✕ Didn't"]])}`;
    }
    if (s.kind === 'morning') {
      return `<form data-flow-form="morning" autocomplete="off">
        <div class="field"><span class="lbl">How long did you sleep?</span>${stepper('sleep_h', c.sleep_h, 0.5, 7.5, 'hours')}</div>
        <div class="field"><span class="lbl">How do your legs feel?</span>${seg('legs', ['1', '2', '3', '4', '5'], c.legs)}
          <div class="seg-hint"><span>1 = dead</span><span>5 = fresh</span></div></div>
        <div class="field"><span class="lbl">Stress level?</span>${seg('stress', ['1', '2', '3', '4', '5'], c.stress)}
          <div class="seg-hint"><span>1 = relaxed</span><span>5 = very stressed</span></div></div>
        <button class="btn primary" type="submit">Save &amp; next ›</button>
      </form>`;
    }
    if (s.kind === 'session') {
      const planned = workoutsOn(ds).reduce((t, x) => t + (isNum(x.w.duration_min) ? x.w.duration_min : 0), 0);
      return `<form data-flow-form="session" autocomplete="off">
        <div class="field"><span class="lbl">Duration and averages <small>(optional)</small></span>
          <div class="row-3">
            <label><span class="mini">Minutes</span><input type="number" inputmode="numeric" name="duration_min" min="0" value="${esc(c.duration_min || '')}" placeholder="${planned || ''}"></label>
            <label><span class="mini">Avg power W</span><input type="number" inputmode="numeric" name="power_w" min="0" value="${esc(c.power_w || '')}"></label>
            <label><span class="mini">Avg HR bpm</span><input type="number" inputmode="numeric" name="hr_bpm" min="0" value="${esc(c.hr_bpm || '')}"></label>
          </div></div>
        <div class="field"><span class="lbl">How hard was it? <small>(RPE 1–10)</small></span>${seg('rpe', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'], c.rpe)}
          <div class="seg-hint"><span>1 = very easy</span><span>10 = max</span></div></div>
        <div class="field"><span class="lbl">Fuelled as planned?</span>${seg('fuelled', [['yes', 'Yes'], ['no', 'No']], c.fuelled)}</div>
        <button class="btn primary" type="submit">Save &amp; next ›</button>
      </form>`;
    }
    if (s.kind === 'wrap') {
      return `<form data-flow-form="wrap" autocomplete="off">
        <div class="field"><textarea name="notes" placeholder="Pain, illness, motivation, weather… or leave empty.">${esc(c.notes || '')}</textarea></div>
        <button class="btn primary" type="submit">${ICON.flag} Finish the day</button>
      </form>`;
    }
    return '';
  }

  // A workout with a matching activity (from Intervals.icu) ticks itself off in today's steps
  function autoMarkDone(ds) {
    const md = matchDay(ds, icuDay(icuWeek(mondayOf(parseDate(ds))), ds));
    const answered = obj(obj(getCheckins()[ds]).steps);
    md.rows.forEach((r) => {
      const id = 'workout-' + r.x.i;
      if (answered[id] || (r.status !== 'done' && r.status !== 'partly')) return;
      const step = dayFlow(ds).find((s) => s.id === id);
      if (step) answerStep(ds, step, r.status === 'done' ? 'done' : 'half');
    });
  }

  // The game bar that stays at the top of the Today page: level ring, today's steps, streak and XP
  function hudHTML(ds) {
    const steps = dayFlow(ds);
    const c = obj(getCheckins()[ds]);
    const answered = steps.filter((s) => s.status).length;
    const xp = xpOf(c);
    const total = Object.values(getCheckins()).reduce((t, x) => t + xpOf(x), 0);
    const lvl = levelOf(total);
    const streak = streakDays();
    const bump = state.hudXp != null && total > state.hudXp ? ' bump' : '';
    state.hudXp = total;
    const r = 20, circ = 2 * Math.PI * r, f = lvl.into / lvl.per;
    return `<div class="hud-wrap"><div class="hud${bump}${answered === steps.length ? ' all-done' : ''}">
      <div class="hud-lvl" title="Level ${lvl.level}: ${lvl.toNext} XP to level ${lvl.level + 1}">
        <svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="hudGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffd27a"/><stop offset="1" stop-color="#ff6a2b"/></linearGradient></defs>
          <circle class="hl-bg" cx="24" cy="24" r="${r}"/><circle class="hl-fg" cx="24" cy="24" r="${r}" stroke-dasharray="${(circ * f).toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 24 24)"/></svg>
        <span class="hl-num"><small>LVL</small><b>${lvl.level}</b></span>
      </div>
      <div class="hud-mid">
        <div class="hud-top"><b>Level ${lvl.level}</b><span>${lvl.into} / ${lvl.per} XP</span></div>
        <div class="hud-steps" aria-label="${answered} of ${steps.length} steps">${steps.map((s) => `<i class="hs-${s.status || 'open'}"></i>`).join('')}</div>
        <div class="hud-foot">${answered === steps.length ? 'All steps done today' : `${answered} of ${steps.length} steps today`}</div>
      </div>
      <div class="hud-stats">
        <span class="hud-pill hp-streak${streak ? ' lit' : ''}" title="Day streak">${ICON.flame}<b>${streak}</b><small>streak</small></span>
        <span class="hud-pill hp-xp" title="XP earned today">${ICON.bolt}<b>+${xp}</b><small>XP</small></span>
      </div>
    </div></div>`;
  }

  function questHTML(ds) {
    const steps = dayFlow(ds);
    const c = obj(getCheckins()[ds]);
    if (state.focusDate !== ds) { state.focus = ''; state.focusDate = ds; }
    const cur = steps.find((s) => s.id === state.focus) || steps.find((s) => !s.status) || null;
    const xp = xpOf(c);
    const streak = streakDays();

    let html = '';

    if (cur) {
      const n = steps.indexOf(cur) + 1;
      const openLeft = steps.filter((s) => !s.status && s !== cur).length;
      html += `<div class="quest-card" id="questCard">
        <div class="q-count">Step ${n} of ${steps.length}${cur.status ? ` · <span class="st-label st-${cur.status}">${{ done: 'done', half: 'half done', no: 'skipped' }[cur.status]}</span>` : ''}</div>
        <div class="q-head"><span class="q-icon">${cur.icon}</span><h3>${esc(cur.title)}</h3></div>
        ${cur.kind !== 'meal' || !cur.meal.label ? `<div class="q-sub">${esc(cur.sub)}</div>` : ''}
        ${questCardBody(cur, ds, c)}
        ${openLeft ? `<button class="btn later" data-action="flow-later" data-step="${esc(cur.id)}">Later ›</button>` : ''}
      </div>`;
    } else {
      html += `<div class="quest-card done-card" id="questCard">
        <div class="confetti" aria-hidden="true">${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<span style="--i:${i}"></span>`).join('')}</div>
        <div class="q-icon big">${ICON.medal}</div>
        <h3>Day complete!</h3>
        <div class="q-text">You earned <b>${xp} XP</b> today${streak > 1 ? ` and you're on a <b>${streak}-day streak</b>` : ''}. Nice work.</div>
        <button class="btn primary" data-action="copy-today" style="margin-top:16px">${ICON.copy} Copy today for my coach</button>
      </div>`;
    }

    const marks = { done: '✓', half: '½', no: '✕' };
    html += `<div class="section"><h3>Today's route</h3><div class="route">${steps.map((s, i) => `
      <button class="route-item st-${s.status || 'open'}${cur && s.id === cur.id ? ' current' : ''}" data-action="flow-focus" data-step="${esc(s.id)}">
        <span class="ri-mark">${marks[s.status] || i + 1}</span>
        <span class="ri-icon">${s.icon}</span>
        <span class="ri-text"><b>${esc(s.title)}</b>${s.sub ? `<small>${esc(s.sub)}</small>` : ''}</span>
      </button>`).join('')}</div></div>`;
    return html;
  }

  function nextOpenStep(ds, fromId) {
    const steps = dayFlow(ds);
    const i = steps.findIndex((s) => s.id === fromId);
    return steps.slice(i + 1).find((s) => !s.status) || steps.find((s) => !s.status && s.id !== fromId) || null;
  }

  function goToStep(id) {
    state.focus = id || '';
    render(true);
    const el = document.getElementById('questCard');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function afterAnswer(ds, fromId) {
    const next = nextOpenStep(ds, fromId);
    goToStep(next ? next.id : '');
    if (!next) toast('Day complete!');
  }

  function viewToday() {
    const t = today();
    const bs = blockStatus(t);
    if (state.plan) safe(() => { autoMarkDone(t); return ''; }, 'marking done sessions');
    let html = (state.plan ? safe(() => hudHTML(t), 'the game bar') : '') + `<div class="page-head">
      <div class="eyebrow">Today</div>
      <h2>${esc(fmtLong(t))}</h2>
      ${bs && bs.inBlock ? `<div class="chips"><span class="chip accent">${esc(txt(bs.b.name) || 'Block')} · week ${bs.week}${bs.weeks ? ' of ' + bs.weeks : ''}</span>${bs.light ? '<span class="chip light-badge">Light week</span>' : ''}</div>` : ''}
    </div>`;
    if (!state.plan) return html + noPlanHTML();

    html += safe(() => todaySessionsHTML(t), "today's session");
    html += safe(() => questHTML(t), "today's steps");

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

  /* ---------------- screen: Day overview (the classic Today page) ---------------- */

  function viewOverview() {
    const t = today();
    const bs = blockStatus(t);
    let html = `<div class="page-head">
      <div class="eyebrow">Day overview</div>
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

    return html;
  }

  /* ---------------- power model (planned watts per second, from plan.json steps) ---------------- */

  const POWER_SPORTS = ['easy', 'recovery', 'tempo', 'vo2_intervals', 'long_ride', 'long_ride_intervals', 'benchmark_test'];
  const isRideType = (t) => POWER_SPORTS.includes(txt(t)) || /ride/.test(txt(t));
  const ftp = () => (isNum(obj(P().athlete).ftp_w) ? obj(P().athlete).ftp_w : 0);

  // Watts for a step text + zone. Same rules as push-workouts.js, so the app and the Bolt agree.
  function stepWatts(text, zoneId) {
    const t = txt(text);
    let m;
    if ((m = /from\s+(\d{2,4})\s*(?:W\s*)?to\s+(\d{2,4})\s*W/i.exec(t))) return { w0: +m[1], w1: +m[2] };
    if ((m = /(\d{2,4})\s*[-–]\s*(\d{2,4})\s*W\b/i.exec(t))) { const v = (+m[1] + +m[2]) / 2; return { w0: v, w1: v }; }
    const under = /(under|below|max\.?|less than)\s+\d{2,4}\s*W/i.test(t);
    if (!under && (m = /(\d{2,4})\s*W\b/i.exec(t))) return { w0: +m[1], w1: +m[1] };
    const z = zones().find((x) => txt(x.id) === txt(zoneId));
    if (!z || !Array.isArray(z.power_w) || !isNum(z.power_w[0]) || !isNum(z.power_w[1])) return null;
    const wide = z.power_w[1] - z.power_w[0] > 150;
    const v = wide ? z.power_w[0] : Math.round((z.power_w[0] + z.power_w[1]) / 2);
    return { w0: v, w1: v };
  }

  // Flattens a workout into segments [{sec, w0, w1}], writing out repeats
  function powerSegments(w) {
    const out = [];
    const easy = () => stepWatts('', 'Z1') || { w0: 0, w1: 0 };
    const walk = (s, depth) => {
      s = obj(s);
      if (depth > 6) return;
      const n = repCount(s) || 1;
      if (Array.isArray(s.steps)) {
        for (let i = 0; i < n; i++) {
          s.steps.forEach((k) => walk(k, depth + 1));
          if (i < n - 1 && restSec(s)) out.push(Object.assign({ sec: restSec(s) }, easy()));
        }
      } else if (isOnOff(s)) {
        const on = stepWatts(s.on_target, null) || stepWatts('', s.zone) || { w0: 0, w1: 0 };
        const off = /half/i.test(txt(s.off_target)) ? { w0: on.w0 / 2, w1: on.w1 / 2 } : stepWatts(s.off_target, 'Z1') || easy();
        for (let i = 0; i < n; i++) {
          if (onSec(s)) out.push(Object.assign({ sec: onSec(s) }, on));
          if (offSec(s)) out.push(Object.assign({ sec: offSec(s) }, off));
        }
      } else {
        const p = stepWatts(s.target, s.zone) || { w0: 0, w1: 0 };
        for (let i = 0; i < n; i++) out.push(Object.assign({ sec: baseSec(s) }, p));
      }
    };
    arr(w.steps).forEach((s) => walk(s, 0));
    return out.filter((x) => x.sec > 0);
  }

  // Duration, load, intensity etc. the way Intervals.icu calculates them for a plan
  function workoutMetrics(w) {
    if (!isRideType(w.type)) return null;
    const segs = powerSegments(w);
    const F = ftp();
    const T = segs.reduce((t, s) => t + s.sec, 0);
    if (!T || !F) return null;
    let sum = 0, sum4 = 0;
    const zoneSec = {};
    segs.forEach((s) => {
      // ramps: sample 10 points
      for (let i = 0; i < 10; i++) {
        const p = s.w0 + ((s.w1 - s.w0) * (i + 0.5)) / 10, dt = s.sec / 10;
        sum += p * dt;
        sum4 += p ** 4 * dt;
        const z = zoneOfWatts(p);
        zoneSec[z] = (zoneSec[z] || 0) + dt;
      }
    });
    const avg = sum / T, np = (sum4 / T) ** 0.25, IF = np / F;
    return {
      segs, sec: T, avg, np, IF, vi: avg ? np / avg : 0,
      load: (T * np * IF) / (F * 3600) * 100,
      kj: (avg * T) / 1000,
      zones: zones().map((z) => ({ id: txt(z.id), sec: zoneSec[txt(z.id)] || 0 })),
    };
  }

  function zoneOfWatts(p) {
    const zs = zones();
    for (const z of zs) if (Array.isArray(z.power_w) && p <= z.power_w[1]) return txt(z.id);
    return zs.length ? txt(zs[zs.length - 1].id) : '';
  }
  function zoneColor(p) { return `var(--${zoneClass(zoneOfWatts(p))})`; }

  // Power profile as an SVG. Small version for cards, big version with axes for the workout page.
  function powerChartSVG(segs, big) {
    const T = segs.reduce((t, s) => t + s.sec, 0);
    if (!T) return '';
    const W = big ? 360 : 600, H = big ? 190 : 34, padL = big ? 30 : 0, padB = big ? 18 : 0;
    const maxW = Math.max(100, big ? ftp() : 0, ...segs.map((s) => Math.max(s.w0, s.w1)));
    const top = Math.ceil((maxW * 1.1) / 100) * 100;
    const x = (t) => padL + (t / T) * (W - padL);
    const padT = big ? 10 : 2;
    const y = (p) => (H - padB) - (p / top) * (H - padB - padT);
    let t = 0, shapes = '';
    segs.forEach((s) => {
      const x0 = x(t), x1 = x(t + s.sec);
      shapes += `<polygon points="${x0},${H - padB} ${x0},${y(s.w0)} ${x1},${y(s.w1)} ${x1},${H - padB}" fill="${zoneColor((s.w0 + s.w1) / 2)}"/>`;
      t += s.sec;
    });
    let axes = '';
    if (big) {
      for (let p = 100; p <= top; p += 100) axes += `<line x1="${padL}" x2="${W}" y1="${y(p)}" y2="${y(p)}" class="grid"/><text x="${padL - 4}" y="${y(p) + 4}" text-anchor="end">${p}</text>`;
      if (ftp()) axes += `<line x1="${padL}" x2="${W}" y1="${y(ftp())}" y2="${y(ftp())}" class="ftp"/>`;
      for (let i = 0; i <= 4; i++) {
        const tt = (T * i) / 4;
        axes += `<text x="${x(tt)}" y="${H - 4}" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}">${clock(tt)}</text>`;
      }
    }
    return `<svg class="pchart${big ? ' big' : ''}" viewBox="0 0 ${W} ${H}"${big ? '' : ' preserveAspectRatio="none"'} role="img" aria-label="Power profile">${axes}${shapes}</svg>`;
  }
  function clock(sec) {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  const hm = (sec) => { sec = Math.round(sec || 0); const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60); return h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`; };

  /* ---------------- Intervals.icu (live data: wellness, weather, done activities) ---------------- */
  // The API key is stored only on this device (localStorage), never in the website files.

  const LS_ICU = 'trainer.intervals';
  const icu = { cache: {}, loading: {}, error: '', weather: null, weatherAt: 0 };
  const icuCfg = () => { const c = obj(lsGet(LS_ICU, null)); return c.key ? c : null; };

  async function icuGet(url) {
    const c = icuCfg();
    if (!c) throw new Error('not connected');
    const res = await fetch(`https://intervals.icu/api/v1/athlete/${encodeURIComponent(c.athlete || '0')}${url}`, {
      headers: { Authorization: 'Basic ' + btoa('API_KEY:' + c.key) },
    });
    if (res.status === 401 || res.status === 403) throw new Error('Intervals.icu refused the API key');
    if (!res.ok) throw new Error('Intervals.icu answered ' + res.status);
    return res.json();
  }

  // Loads one week (Monday date) and redraws the screen when it arrives
  function icuWeek(mon) {
    const key = iso(mon);
    if (!icuCfg()) return null;
    const c = icu.cache[key];
    const fresh = c && Date.now() - c.at < 5 * 60 * 1000;
    if (!fresh && !icu.loading[key]) {
      icu.loading[key] = true;
      const sun = iso(addDays(mon, 6));
      Promise.all([
        icuGet(`/wellness?oldest=${key}&newest=${sun}`),
        icuGet(`/events?oldest=${key}&newest=${sun}`),
        icuGet(`/activities?oldest=${key}&newest=${sun}T23:59:59`),
        Date.now() - icu.weatherAt > 30 * 60 * 1000 ? icuGet('/weather-forecast').catch(() => null) : Promise.resolve(undefined),
      ]).then(([wellness, events, activities, weather]) => {
        icu.cache[key] = { at: Date.now(), wellness: arr(wellness), events: arr(events), activities: arr(activities) };
        if (weather !== undefined) { icu.weather = weather; icu.weatherAt = Date.now(); }
        icu.error = '';
      }).catch((e) => {
        icu.error = e.message || 'Could not reach Intervals.icu';
      }).finally(() => {
        icu.loading[key] = false;
        if (['agenda', 'day', 'workout', 'today', 'overview'].includes(state.route)) render(true);
      });
    }
    return c || null;
  }

  const icuDay = (wk, ds) => (wk ? {
    wellness: wk.wellness.find((x) => x.id === ds) || null,
    events: wk.events.filter((e) => txt(e.start_date_local).slice(0, 10) === ds),
    activities: wk.activities.filter((a) => txt(a.start_date_local).slice(0, 10) === ds),
  } : null);

  function weatherOn(ds) {
    const f = obj(arr(obj(icu.weather).forecasts)[0]);
    return arr(f.daily).find((d) => d.id === ds) || null;
  }

  // Same id as push-workouts.js, to find the Intervals.icu event of a plan workout
  function planSlug(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  }
  function icuEventFor(w, wk) {
    if (!wk) return null;
    const ds = normDate(w.date);
    const ext = `trainer:${ds}:${planSlug(w.title)}`;
    return wk.events.find((e) => e.external_id === ext) || null;
  }

  const SPORT_ICON = { Ride: ICON.bike, Run: ICON.run, Swim: ICON.swim, WeightTraining: ICON.kettlebell, Workout: ICON.kettlebell };
  const SPORT_LABEL = { Ride: 'Cycling', WeightTraining: 'Strength', Run: 'Running', Swim: 'Swimming', Other: 'Other' };
  function sportOfActivity(t) {
    t = txt(t);
    if (/Ride|Cyclocross|Velomobile|Handcycle/.test(t)) return 'Ride';
    if (/Run/.test(t)) return 'Run';
    if (/Swim/.test(t)) return 'Swim';
    if (/Weight|Workout|Crossfit/.test(t)) return 'WeightTraining';
    return 'Other';
  }
  const sportOfPlan = (t) => (t === 'run' ? 'Run' : t === 'swim' ? 'Swim' : t === 'strength' ? 'WeightTraining' : t === 'rest' ? '' : 'Ride');

  const WX_ICON = { '01': ['sun', 'wx-sun'], '02': ['cloudSun', 'wx-sun'], '03': ['cloudSun', 'wx-cloud'], '04': ['cloud', 'wx-cloud'], '09': ['rain', 'wx-rain'], '10': ['rain', 'wx-rain'], '11': ['storm', 'wx-rain'], '13': ['snow', 'wx-cloud'], '50': ['fog', 'wx-cloud'] };
  function weatherHTML(d) {
    if (!d) return '';
    const w = obj(arr(d.weather)[0]);
    const wi = WX_ICON[txt(w.icon).slice(0, 2)] || ['cloud', 'wx-cloud'];
    const icon = `<span class="wx-ic ${wi[1]}">${ICON[wi[0]]}</span>`;
    const t = obj(d.temp);
    const kmh = (v) => (isNum(v) ? Math.round(v * 3.6) : '');
    // wind_deg is where the wind comes FROM, the arrow shows where it blows TO
    const arrow = isNum(d.wind_deg) ? `<span class="wind-arrow" style="transform:rotate(${Math.round(d.wind_deg + 180)}deg)">↑</span>` : '';
    return `<span class="wx" title="${esc(txt(w.description))}">${icon} <b>${esc(num(t.min, 0))}°/${esc(num(t.max, 0))}°</b>
      ${arrow}<span>${kmh(d.wind_speed)}<small>/${kmh(d.wind_gust)} km/h</small></span>
      ${isNum(d.rain) && d.rain >= 0.5 ? `<span class="wx-rainmm">${ICON.drop}${esc(num(d.rain, 0))} mm</span>` : ''}</span>`;
  }

  function wellnessHTML(x) {
    if (!x) return '';
    const parts = [];
    if (isNum(x.sleepSecs)) parts.push(`<span title="Sleep"><i class="wl-ic wl-sleep">${ICON.moon}</i><b>${esc(hm(x.sleepSecs))}</b>${isNum(x.sleepScore) ? ` ${esc(num(x.sleepScore, 0))}` : ''}</span>`);
    if (isNum(x.restingHR)) parts.push(`<span title="Resting heart rate"><i class="wl-ic wl-heart">${ICON.heart}</i><b>${esc(num(x.restingHR, 0))}</b></span>`);
    if (isNum(x.hrv)) parts.push(`<span title="HRV (rMSSD)">HRV <b>${esc(num(x.hrv, 0))}</b> ms</span>`);
    if (isNum(x.respiration)) parts.push(`<span title="Breathing rate"><i class="wl-ic wl-breath">${ICON.breath}</i><b>${esc(num(x.respiration, 1))}</b></span>`);
    if (isNum(x.spO2)) parts.push(`<span title="Blood oxygen">SpO₂ <b>${esc(num(x.spO2, 0))}%</b></span>`);
    if (isNum(x.readiness)) parts.push(`<span title="Readiness">Ready <b>${esc(num(x.readiness, 0))}</b></span>`);
    return parts.length ? `<div class="wellness">${parts.join('')}</div>` : '';
  }

  function activityHTML(a) {
    const sp = sportOfActivity(a.type);
    const bits = [];
    if (isNum(a.moving_time)) bits.push(hm(a.moving_time));
    if (isNum(a.distance) && a.distance > 0) bits.push(`${num(a.distance / 1000, 1)} km`);
    if (isNum(a.icu_average_watts)) bits.push(`${num(a.icu_average_watts, 0)} W`);
    if (isNum(a.average_heartrate)) bits.push(`${num(a.average_heartrate, 0)} bpm`);
    if (isNum(a.icu_training_load)) bits.push(`load ${num(a.icu_training_load, 0)}`);
    return `<div class="act"><span class="act-ic">${SPORT_ICON[sp] || '✓'}</span><div><div class="act-name">✓ ${esc(txt(a.name) || sp)}</div><div class="act-meta">${esc(bits.join(' · '))}</div></div></div>`;
  }

  /* ---------------- planned vs done ---------------- */

  // Completed activities on a date: live from Intervals.icu (phone) plus activities.json (laptop), no doubles
  function doneOn(ds, live) {
    const seen = new Set(), out = [];
    (live ? live.activities : []).concat(arr(state.fileActs)).forEach((a) => {
      if (!a || txt(a.start_date_local).slice(0, 10) !== ds) return;
      const id = txt(a.id) || txt(a.start_date_local);
      if (seen.has(id)) return;
      seen.add(id);
      out.push(a);
    });
    return out;
  }
  function planSport(t) {
    t = txt(t);
    if (t === 'run') return 'Run';
    if (t === 'swim') return 'Swim';
    if (t === 'strength') return 'WeightTraining';
    return 'Ride';
  }
  const plannedSec = (w) => (isNum(w.duration_min) && w.duration_min > 0 ? w.duration_min * 60 : workoutTotalSec(w));
  const actSec = (a) => a.moving_time || a.elapsed_time || 0;
  const actMin = (a) => Math.round(actSec(a) / 60) * 60; // shown rounded to whole minutes

  // Pairs each planned workout with an activity of the same sport on the same date.
  // done = at least 80% of the planned time, partly = less, skipped = nothing recorded on a day that is over.
  const DONE_SHARE = 0.8;
  function matchDay(ds, live) {
    const acts = doneOn(ds, live);
    const used = new Set();
    const rows = workoutsOn(ds).filter((x) => txt(x.w.type) !== 'rest').map((x) => {
      const sp = planSport(x.w.type), want = plannedSec(x.w);
      let best = null;
      acts.forEach((a, i) => {
        if (used.has(i) || sportOfActivity(a.type) !== sp) return;
        const diff = Math.abs(actSec(a) - want);
        if (!best || diff < best.diff) best = { i, diff };
      });
      const a = best ? acts[best.i] : null;
      if (best) used.add(best.i);
      let status = '';
      if (a) status = want && actSec(a) < want * DONE_SHARE ? 'partly' : 'done';
      else if (ds < today()) status = 'skipped';
      else if (ds === today()) status = 'open';
      return Object.assign({ x, a, status, want }, a ? followScore(x.w, a, want) : {});
    });
    return { rows, extra: acts.filter((_, i) => !used.has(i)) };
  }

  // How closely you followed the plan, 0-100. Each part scores 100 when it matches the plan
  // and loses 1 point per % you were off (too short, too long, too easy or too hard).
  // Parts: duration always, average power for rides when both are known. Score = their average.
  function followScore(w, a, want) {
    const close = (done, plan) => Math.max(0, Math.round(100 - Math.abs(done / plan - 1) * 100));
    const parts = [];
    if (want > 0 && actSec(a) > 0) parts.push({ k: 'Time', v: close(actSec(a), want) });
    let m = null;
    try { m = workoutMetrics(w); } catch (e) { m = null; }
    if (m && m.avg > 0 && isNum(a.icu_average_watts) && a.icu_average_watts > 0) parts.push({ k: 'Power', v: close(a.icu_average_watts, m.avg) });
    if (!parts.length) return {};
    return { score: Math.round(parts.reduce((t, p) => t + p.v, 0) / parts.length), parts };
  }
  const scoreWord = (s) => (s >= 90 ? 'Spot on' : s >= 75 ? 'Close' : s >= 50 ? 'Off plan' : 'Way off');
  const scoreCls = (s) => (s >= 90 ? 'sc-top' : s >= 75 ? 'sc-good' : s >= 50 ? 'sc-mid' : 'sc-low');
  function scoreRing(s, size) {
    const r = 15, c = 2 * Math.PI * r;
    return `<span class="ring ${scoreCls(s)}" style="--sz:${size || 44}px" title="Follow score ${s}/100">
      <svg viewBox="0 0 36 36" aria-hidden="true"><circle class="ring-bg" cx="18" cy="18" r="${r}"/><circle class="ring-fg" cx="18" cy="18" r="${r}" stroke-dasharray="${(c * s) / 100} ${c}" transform="rotate(-90 18 18)"/></svg>
      <b>${s}</b></span>`;
  }

  // The "completed" footer of a session card: label, what you did and the follow score
  function doneStripHTML(r) {
    if (!r || !['done', 'partly', 'skipped'].includes(r.status)) return '';
    if (!r.a) return `<div class="done-strip st-skipped">${statusChip('skipped')}<span class="ds-txt">Nothing recorded</span></div>`;
    return `<div class="done-strip st-${r.status}">
      <div class="ds-main">${statusChip(r.status)}<span class="ds-txt">${esc(actBits(r.a).join(' · '))}</span>
        ${isNum(r.score) ? `<span class="ds-score">${esc(scoreWord(r.score))} · ${r.parts.map((p) => `${p.k} ${p.v}`).join(' · ')}</span>` : ''}</div>
      ${isNum(r.score) ? scoreRing(r.score) : ''}</div>`;
  }

  // Match result for one plan workout (only for today and earlier)
  function matchFor(x, wk) {
    const ds = normDate(x.w.date);
    if (!ds || ds > today()) return null;
    return matchDay(ds, icuDay(wk, ds)).rows.find((r) => r.x.i === x.i) || null;
  }

  const STATUS_LABEL = { done: 'Done', partly: 'Partly done', skipped: 'Skipped', open: 'Not yet' };
  const statusChip = (s) => (STATUS_LABEL[s] ? `<span class="st-chip st-${s}">${STATUS_LABEL[s]}</span>` : '');
  function actBits(a) {
    const bits = [fmtDur(actMin(a))].filter(Boolean);
    if (isNum(a.icu_average_watts)) bits.push(`${num(a.icu_average_watts, 0)} W`);
    if (isNum(a.average_heartrate)) bits.push(`${num(a.average_heartrate, 0)} bpm`);
    return bits;
  }

  // Planned next to done, on the day page
  function compareHTML(r) {
    const w = r.x.w, t = typeInfo(txt(w.type)), a = r.a;
    let m = null;
    try { m = workoutMetrics(w); } catch (e) { m = null; }
    const row = (label, p, d) => `<div class="cmp-row"><span>${label}</span><b>${p}</b><b class="cmp-done">${d}</b></div>`;
    return `<a class="card cmp ${t.cls}" href="#workout/${r.x.i}">
      <div class="sess-head"><span class="sess-ic">${t.icon}</span><span class="sess-title">${esc(txt(w.title) || t.label)}</span>${statusChip(r.status)}</div>
      <div class="cmp-grid">
        <div class="cmp-row cmp-h"><span></span><span>Planned</span><span>Done</span></div>
        ${row('Duration', r.want ? esc(fmtDur(r.want)) : '—', a && actMin(a) ? esc(fmtDur(actMin(a))) : '—')}
        ${row('Avg power', m ? `${Math.round(m.avg)} W` : '—', a && isNum(a.icu_average_watts) ? `${esc(num(a.icu_average_watts, 0))} W` : '—')}
        ${row('Avg heart rate', '—', a && isNum(a.average_heartrate) ? `${esc(num(a.average_heartrate, 0))} bpm` : '—')}
      </div>
      ${isNum(r.score) ? `<div class="cmp-score">${scoreRing(r.score, 52)}<div><b>${esc(scoreWord(r.score))}</b><div class="muted small">Follow score · ${r.parts.map((p) => `${p.k} ${p.v}`).join(' · ')}</div></div></div>` : ''}</a>`;
  }

  // Week summary like the "Wk 41" box in Intervals.icu
  function weekSummaryHTML(mon, wk) {
    const days = [...Array(7)].map((_, i) => iso(addDays(mon, i)));
    // planned: from Intervals.icu events when connected, else from plan.json
    const sports = {};
    const add = (sp, field, v) => { if (!sp) return; sports[sp] = sports[sp] || { pt: 0, pl: 0, dt: 0, dl: 0 }; sports[sp][field] += v || 0; };
    days.forEach((ds) => workoutsOn(ds).forEach((x) => {
      const sp = sportOfPlan(txt(x.w.type));
      if (!sp) return;
      const ev = icuEventFor(x.w, wk);
      const m = workoutMetrics(x.w);
      const sec = isNum(x.w.duration_min) ? x.w.duration_min * 60 : workoutTotalSec(x.w);
      add(sp, 'pt', sec);
      add(sp, 'pl', ev && isNum(ev.icu_training_load) ? ev.icu_training_load : m ? m.load : 0);
    }));
    let kcal = 0, climb = 0;
    // done: live activities plus activities.json, without doubles
    days.flatMap((ds) => doneOn(ds, icuDay(wk, ds))).forEach((a) => {
      const sp = sportOfActivity(a.type);
      add(sp, 'dt', a.moving_time);
      add(sp, 'dl', a.icu_training_load);
      kcal += isNum(a.calories) ? a.calories : 0;
      climb += isNum(a.total_elevation_gain) ? a.total_elevation_gain : 0;
    });
    const list = Object.entries(sports);
    const tot = list.reduce((t, [, s]) => ({ pt: t.pt + s.pt, pl: t.pl + s.pl, dt: t.dt + s.dt, dl: t.dl + s.dl }), { pt: 0, pl: 0, dt: 0, dl: 0 });
    if (!list.length && !wk) return '';

    // Fitness / fatigue / form at the end of the week (or the last day Intervals.icu has)
    let fit = '';
    if (wk && wk.wellness.length) {
      const last = wk.wellness.filter((x) => isNum(x.ctl)).sort((a, b) => (a.id < b.id ? -1 : 1)).pop();
      if (last) {
        const form = last.ctl - last.atl;
        fit = `<div class="wk-grid">
          <div><span>Fitness</span><b class="c-fit">${esc(num(last.ctl, 0))}</b></div>
          <div><span>Fatigue</span><b class="c-fat">${esc(num(last.atl, 0))}</b></div>
          <div><span>Form</span><b class="${form < -10 ? 'c-bad' : form > 5 ? 'c-good' : 'c-neutral'}">${esc(num(form, 0))}</b></div>
          <div><span>Ramp</span><b>${esc(num(last.rampRate, 1))}</b></div>
          ${kcal ? `<div><span>kCal</span><b>${esc(num(kcal, 0))}</b></div>` : ''}
          ${climb ? `<div><span>Climbing</span><b>${esc(num(climb, 0))} m</b></div>` : ''}
        </div>`;
      }
    }
    const bar = (done, plan, fmt) => {
      if (!(plan > 0)) return `<div class="pbar"><i style="width:100%"></i><em>${esc(fmt(done))} done</em></div><span class="pbar-p">extra</span>`;
      const pct = Math.round((done / plan) * 100);
      return `<div class="pbar"><i style="width:${Math.min(100, pct)}%"></i><em>${esc(fmt(done))} / ${esc(fmt(plan))}</em></div><span class="pbar-p">${pct}%</span>`;
    };
    // 1. load for the whole week, 2. time per sport in a fixed order
    const ORDER = ['Ride', 'WeightTraining', 'Run', 'Swim', 'Other'];
    const row = (icon, label, html) => `<div class="wk-sport"><span class="wk-sic">${icon}</span><span class="pbar-l">${label}</span>${html}</div>`;
    let rows = tot.pl || tot.dl ? row(ICON.load, 'Load', bar(tot.dl, tot.pl, (v) => num(v, 0))) : '';
    ORDER.filter((sp) => sports[sp]).forEach((sp) => {
      rows += row(SPORT_ICON[sp] || ICON.dot, SPORT_LABEL[sp], bar(sports[sp].dt, sports[sp].pt, hm));
    });
    return `<div class="card wk-sum">
      <div class="wk-top-row"><b>Week ${esc(isoWeek(mon))}</b>${icu.loading[iso(mon)] ? '<span class="muted small">updating…</span>' : ''}</div>
      <div class="wk-grid">
        <div><span>Done</span><b>${esc(hm(tot.dt))}</b></div>
        <div><span>Planned</span><b>${esc(hm(tot.pt))}</b></div>
        <div><span>Load</span><b>${esc(num(tot.dl, 0))}${tot.pl ? '/' + esc(num(tot.pl, 0)) : ''}</b></div>
      </div>
      ${fit}
      ${rows ? `<div class="wk-sports">${rows}</div>` : ''}
      ${wk ? '' : `<div class="muted small" style="margin-top:8px">${icuCfg() ? 'Loading from Intervals.icu…' : 'Connect Intervals.icu in <a href="#settings">Settings</a> to see sleep, fitness and done rides.'}</div>`}
      <details class="explain"><summary>What do these mean?</summary>
        <p><b>Load</b>: how hard the training is (an hour all-out ≈ 100). <b>Fitness</b>: your average load over 6 weeks. <b>Fatigue</b>: your average load over the last week. <b>Form</b> = fitness − fatigue: below −10 you're tired, above +5 you're fresh. <b>Ramp</b>: how fast fitness is rising per week.</p>
      </details>
    </div>`;
  }
  function isoWeek(d) {
    const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = x.getUTCDay() || 7;
    x.setUTCDate(x.getUTCDate() + 4 - day);
    return Math.ceil(((x - Date.UTC(x.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  }

  // Load + intensity line and mini chart for a planned workout
  function plannedMiniHTML(w, wk) {
    const m = workoutMetrics(w);
    if (!m) return '';
    const ev = icuEventFor(w, wk);
    const load = ev && isNum(ev.icu_training_load) ? ev.icu_training_load : m.load;
    const IF = ev && isNum(ev.icu_intensity) ? ev.icu_intensity / 100 : m.IF;
    return `<div class="mini"><div class="mini-meta"><span class="load-ic">${ICON.load}</span>Load <b>${esc(num(load, 0))}</b> · Intensity <b>${esc(num(IF * 100, 0))}%</b></div>${powerChartSVG(m.segs, false)}</div>`;
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
    let html = safe(() => {
      // Total planned training time for the week shown (rest days don't count)
      const mon = addDays(mondayOf(new Date()), state.weekOffset * 7);
      let sec = 0, sessions = 0;
      for (let i = 0; i < 7; i++) {
        workoutsOn(iso(addDays(mon, i))).forEach((x) => {
          if (txt(x.w.type) === 'rest') return;
          const s = isNum(x.w.duration_min) && x.w.duration_min > 0 ? x.w.duration_min * 60 : workoutTotalSec(x.w);
          if (s > 0) { sec += s; sessions++; }
        });
      }
      const total = sec ? `<div class="week-total"><div class="v">${ICON.clock} ${esc(fmtDur(sec))}</div><div class="l">${sessions} session${sessions === 1 ? '' : 's'} planned</div></div>` : '';
      return `<div class="page-head"><div class="eyebrow">Agenda</div><div class="head-row"><h2>Your week</h2>${total}</div></div>`;
    }, 'the week total');

    html += safe(() => {
      const mon = addDays(mondayOf(new Date()), state.weekOffset * 7);
      const sun = addDays(mon, 6);
      const wbs = blockStatus(iso(mon));
      const sub = state.weekOffset === 0 ? 'This week' : state.weekOffset === 1 ? 'Next week' : state.weekOffset === -1 ? 'Last week' : '';
      const blockTxt = wbs && wbs.inBlock ? `${txt(wbs.b.name) || 'Block'} · week ${wbs.week}${wbs.light ? ' (light)' : ''}` : '';
      const wk = icuWeek(mon);
      let rows = '';
      for (let i = 0; i < 7; i++) {
        const d = addDays(mon, i), ds = iso(d);
        const ws = workoutsOn(ds);
        const live = icuDay(wk, ds);
        const md = matchDay(ds, live);
        const items = ws.length
          ? ws.map((x) => sessionHTML(x.w, wk, md.rows.find((r) => r.x.i === x.i))).join('')
          : '<div class="item muted" style="font-weight:500">Nothing planned</div>';
        const acts = md.extra.map(activityHTML).join('');
        const top = ds <= today() ? wellnessHTML(live && live.wellness) : '';
        const wx = ds >= today() ? weatherHTML(weatherOn(ds)) : '';
        rows += `<a class="card day-row tap${ds === today() ? ' today' : ''}${ds < today() ? ' past' : ''}" href="#day/${ds}">
          <div class="date"><div class="w">${DOW[i]}</div><div class="d">${d.getDate()}</div></div>
          <div class="items">${top || wx ? `<div class="day-live">${top}${wx}</div>` : ''}${items}${acts}</div><span class="chev">›</span></a>`;
      }
      return `<div class="week-nav">
          <button class="btn icon" data-action="week" data-dir="-1" aria-label="Previous week">‹</button>
          <div class="label">${esc(fmtDate(mon, { day: 'numeric', month: 'short' }))} – ${esc(fmtDate(sun, { day: 'numeric', month: 'short' }))}<small>${esc([sub, blockTxt].filter(Boolean).join(' · ') || ' ')}</small></div>
          <button class="btn icon" data-action="week" data-dir="1" aria-label="Next week">›</button>
        </div>
        ${state.weekOffset !== 0 ? '<button class="btn small" data-action="week" data-dir="0" style="margin:0 auto 12px">Back to this week</button>' : ''}
        ${icu.error && icuCfg() ? `<div class="card warn small">Intervals.icu: ${esc(icu.error)}</div>` : ''}
        ${safe(() => weekSummaryHTML(mon, wk), 'the week summary')}
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
      const live = icuDay(icuWeek(mondayOf(parseDate(ds))), ds);
      const top = ds <= today() ? wellnessHTML(live && live.wellness) : '';
      const wx = ds >= today() ? weatherHTML(weatherOn(ds)) : '';
      const md = ds <= today() ? matchDay(ds, live) : { rows: [], extra: [] };
      const cmp = md.rows.length ? `<div class="section" style="margin-top:0"><h3>Planned vs done</h3>${md.rows.map(compareHTML).join('')}
        <div class="muted small cmp-note">Done = at least ${Math.round(DONE_SHARE * 100)}% of the planned time. The plan has no heart-rate targets.</div></div>` : '';
      const extra = md.extra.length ? `<div class="section"${cmp ? '' : ' style="margin-top:0"'}><h3>${md.rows.length ? 'Extra (not planned)' : 'Done'}</h3><div class="card">${md.extra.map(activityHTML).join('')}</div></div>` : '';
      return (top || wx ? `<div class="card day-live big">${top}${wx}</div>` : '') + cmp + extra;
    }, 'the Intervals.icu data');

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

  // The numbers from the Intervals.icu workout popup: duration, load, intensity, NP, average, VI, work, zones + chart
  function workoutStatsHTML(w, ds) {
    const m = workoutMetrics(w);
    if (!m) return '';
    const d = parseDate(ds);
    const wk = d ? icuWeek(mondayOf(d)) : null;
    const ev = icuEventFor(w, wk);
    const doc = obj(ev && ev.workout_doc);
    const pick = (a, b) => (isNum(a) ? a : b);
    const load = pick(ev && ev.icu_training_load, m.load);
    const IF = isNum(ev && ev.icu_intensity) ? ev.icu_intensity / 100 : m.IF;
    const np = pick(doc.normalized_power, m.np), avg = pick(doc.average_watts, m.avg);
    const vi = pick(doc.variability_index, m.vi);
    const ss = isNum(ev && ev.strain_score) ? ev.strain_score : null;
    const stat = (v, l) => `<div class="stat"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`;
    const zrows = m.zones.filter((z) => z.sec > 0).map((z) => {
      const pct = (z.sec / m.sec) * 100;
      return `<div class="zrow">${zoneChip(z.id)}<div class="zbar"><i class="${zoneClass(z.id)}" style="width:${pct}%"></i></div><span>${esc(hm(z.sec))}</span><span class="muted">${esc(num(pct, 1))}%</span></div>`;
    }).join('');
    return `<div class="section" style="margin-top:0"><h3>Planned numbers${ev ? ' <span class="muted" style="text-transform:none;letter-spacing:0">· from Intervals.icu</span>' : ''}</h3>
      <div class="card">
        <div class="stats">${stat(hm(m.sec), 'Duration')}${stat(num(load, 0), 'Load')}${stat(num(IF * 100, 0) + '%', 'Intensity')}</div>
        <div class="stats" style="margin-top:8px">${stat(num(np, 0) + ' W', 'Normalized')}${stat(num(avg, 0) + ' W', 'Average')}${stat(num(vi, 2), 'Variability')}</div>
        <div class="stats" style="margin-top:8px">${stat(num(m.kj, 0) + ' kJ', 'Work')}${ss != null ? stat(num(ss, 0), 'Strain score') : ''}${stat(num(ftp(), 0) + ' W', 'FTP used')}</div>
        <div class="pchart-wrap">${powerChartSVG(m.segs, true)}</div>
        ${zrows ? `<div class="zrows">${zrows}</div>` : ''}
        <details class="explain"><summary>What do these mean?</summary>
          <p><b>Load</b>: how hard the session is (an hour all-out ≈ 100). <b>Intensity</b>: normalized power as % of your FTP. <b>Normalized</b>: what the ride "feels like" in watts, with hard bits counting extra. <b>Variability</b>: normalized ÷ average; 1.00 is perfectly steady. <b>Work</b>: total energy you put into the pedals. The dashed line in the chart is your FTP.</p>
        </details>
      </div></div>`;
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
        ${ds ? `<a class="chip" href="#day/${ds}">${ICON.calendar} ${esc(fmtDate(ds))}${relDay(ds) ? ' · ' + relDay(ds) : ''}</a>` : ''}
        ${dur ? `<span class="chip">${ICON.clock} ${esc(dur)}</span>` : ''}
        ${zoneChip(w.zone)}
      </div>
    </div>`;

    html += safe(() => workoutStatsHTML(w, ds), 'the workout numbers');

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

  // When did we start working towards this goal? "start" in the plan,
  // otherwise the block start, otherwise the first day the app saw the goal.
  function goalStart(g) {
    const own = parseDate(g.start) || parseDate(g.start_date);
    if (own) return own;
    const bs = parseDate(obj(P().block).start);
    if (bs) return bs;
    const key = txt(g.id) || txt(g.title) || 'goal';
    const seen = obj(lsGet(LS.goalSeen, {}));
    if (!seen[key]) { seen[key] = today(); lsSet(LS.goalSeen, seen); }
    return parseDate(seen[key]);
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
          if (days === 0) cd = `<div class="countdown"><div class="n">${ICON.flag}</div><div class="u">Today!</div></div>`;
          else if (past) cd = `<div class="countdown past"><div class="n">${-days}</div><div class="u">days ago</div></div>`;
          else cd = `<div class="countdown"><div class="n">${days}</div><div class="u">${days === 1 ? 'day' : 'days'} to go</div></div>`;
        }
        const weeks = days > 13 ? ` · ${Math.floor(days / 7)} weeks ${days % 7 ? days % 7 + ' d' : ''}` : '';
        let bar = '';
        const start = date ? goalStart(g) : null;
        if (start) {
          const total = daysBetween(start, parseDate(date));
          const gone = daysBetween(start, new Date());
          const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((gone / total) * 100))) : 100;
          bar = `<div class="progress goal-bar"><span style="width:${Math.max(pct, 2)}%"></span></div>
            <div class="goal-prog"><span>${pct}% of the way</span><span>started ${esc(fmtDate(start, { day: 'numeric', month: 'short' }))}</span></div>`;
        }
        return `<div class="card goal">
          <div>
            <div class="title">${esc(txt(g.title) || 'Goal')}</div>
            ${txt(g.metric) ? `<div class="metric">${esc(txt(g.metric))}</div>` : ''}
            <div class="date">${date ? esc(fmtDate(date, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })) + esc(weeks) : 'No date set'}</div>
            ${status && status !== 'active' ? `<div class="chips"><span class="chip">${esc(prettify(status))}</span></div>` : ''}
          </div>
          ${cd}
          ${bar}
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
    if (txt(it)) return { name: txt(it), qty: '', cat: '', days: {} };
    const o = obj(it);
    const days = {};
    Object.entries(obj(o.days || o.per_day)).forEach(([d, v]) => { if (normDate(d) && txt(v)) days[normDate(d)] = txt(v); });
    return {
      name: txt(o.item) || txt(o.name) || txt(o.text),
      qty: txt(o.qty) || txt(o.quantity) || txt(o.amount) || txt(o.week),
      cat: txt(o.category) || txt(o.aisle),
      days,
    };
  }

  // Days that can be picked in the "Per day" shopping view
  function shopDays() {
    const set = new Set();
    arr(nutrition().meals).forEach((m) => { const d = normDate(obj(m).date); if (d) set.add(d); });
    arr(nutrition().shopping_list).map(shopItemParts).forEach((x) => Object.keys(x.days).forEach((d) => set.add(d)));
    if (!set.size) { const mon = mondayOf(new Date()); for (let i = 0; i < 7; i++) set.add(iso(addDays(mon, i))); }
    return [...set].sort();
  }

  function shoppingHTML() {
    const all = arr(nutrition().shopping_list).map(shopItemParts).filter((x) => x.name);
    if (!all.length) return '';
    const byDay = state.shopMode === 'day';
    const days = shopDays();
    if (!days.includes(state.shopDay)) state.shopDay = days.includes(today()) ? today() : days[0];
    const day = state.shopDay;
    const hasDaily = all.some((x) => Object.keys(x.days).length);

    const list = byDay
      ? all.filter((x) => x.days[day]).map((x) => Object.assign({}, x, { qty: x.days[day], key: day + '|' + x.name }))
      : all.map((x) => Object.assign({}, x, { key: x.name }));
    const ticks = shopTicks();
    const done = list.filter((x) => ticks[x.key]).length;
    const check = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

    const toggle = `<div class="toggle">
      <button class="${byDay ? '' : 'on'}" data-action="shop-mode" data-mode="week">This week</button>
      <button class="${byDay ? 'on' : ''}" data-action="shop-mode" data-mode="day">Per day</button>
    </div>`;
    const dayChips = byDay ? `<div class="day-chips">${days.map((d) => `<button class="${d === day ? 'on' : ''}${d === today() ? ' is-today' : ''}" data-action="shop-day" data-date="${d}">
        <small>${esc(fmtDate(d, { weekday: 'short' }))}</small>${parseDate(d).getDate()}</button>`).join('')}</div>` : '';

    let body;
    if (!list.length) {
      body = `<div class="muted small center" style="padding:14px 4px">${hasDaily
        ? 'Nothing to buy for this day.'
        : 'Your coach hasn\'t added daily amounts yet. Ask them to add "days" to the shopping list items.'}</div>`;
    } else {
      const groups = {};
      list.forEach((x) => { (groups[x.cat] = groups[x.cat] || []).push(x); });
      body = Object.keys(groups).map((cat) => `
        ${cat ? `<div class="shop-cat">${esc(cat)}</div>` : ''}
        <ul class="shop">${groups[cat].map((x) => `<li><label>
          <input type="checkbox" data-shop="${esc(x.key)}"${ticks[x.key] ? ' checked' : ''}>
          <span class="box">${check}</span><span class="txt">${esc(x.name)}</span>${x.qty ? `<span class="qty">${esc(x.qty)}</span>` : ''}
        </label></li>`).join('')}</ul>`).join('');
    }
    return `<div class="section"><h3><span>Shopping list · ${done}/${list.length}</span>${done ? '<button class="btn small" data-action="shop-clear">Untick all</button>' : ''}</h3>
      ${toggle}${dayChips}
      <div class="card">${byDay && list.length ? `<div class="muted small" style="margin-bottom:4px">Amounts for ${esc(fmtLong(day))}</div>` : ''}${body}</div></div>`;
  }

  function viewFood() {
    let html = `<div class="page-head"><div class="eyebrow">Nutrition</div><h2>Food</h2></div>`;
    if (!state.plan) return html + noPlanHTML();
    const t = today();
    const todayType = txt(obj(mealsOn(t)[0]).day_type);

    html += safe(() => {
      const meals = arr(nutrition().meals).map(obj).filter((m) => Object.keys(m).length)
        .sort((a, b) => (normDate(a.date) < normDate(b.date) ? -1 : 1));
      if (!meals.length) return '';
      return `<div class="section" style="margin-top:0"><h3>Meal plan</h3>${meals.map((m) => {
        const ds = normDate(m.date);
        const dt = txt(m.day_type);
        const items = arr(m.items).map(mealItemHTML).filter(Boolean).join('');
        return `<details class="card${ds === t ? ' today' : ''}"${ds === t ? ' open' : ''}>
          <summary><span>${esc(ds ? fmtDate(ds) : txt(m.date) || 'Day')}${ds === t ? ' · Today' : ''}</span>${dt ? `<span class="chip day-type dt-${esc(dt)}">${esc(prettify(dt))}</span>` : ''}</summary>
          <div class="inner">${dt ? targetStats(dt) : ''}${items ? `<ul class="meal-list">${items}</ul>` : '<div class="muted small">No meals listed.</div>'}</div>
        </details>`;
      }).join('')}</div>`;
    }, 'the meal plan');

    html += safe(() => {
      const dts = Object.keys(dayTypes()).filter((k) => Object.keys(obj(dayTypes()[k])).length);
      if (!dts.length) return '';
      const cell = (v) => `<div class="n">${isNum(v) && v > 0 ? esc(num(v)) : '–'}</div>`;
      return `<div class="section"><h3>Daily targets</h3><div class="targets-grid">
        <div class="target-row head"><div>Day type</div><div class="n">Carbs g</div><div class="n">Protein g</div><div class="n">kcal</div></div>
        ${dts.map((k) => {
          const d = obj(dayTypes()[k]);
          return `<div class="target-row${k === todayType ? ' hl' : ''}"><div class="dt">${esc(prettify(k))}</div>${cell(d.carbs_g)}${cell(d.protein_g)}${cell(d.kcal)}</div>`;
        }).join('')}
      </div>${todayType ? `<div class="muted small" style="margin:8px 2px 0">Today's day type: <b>${esc(prettify(todayType))}</b> (highlighted).</div>` : ''}</div>`;
    }, 'the daily targets');

    html += safe(shoppingHTML, 'the shopping list');
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
    const meals = Object.entries(obj(c.meal_log));
    if (meals.length) {
      const words = { done: 'done', half: 'half', no: 'skipped' };
      lines.push('Meals: ' + meals.map(([k, v]) => `${k} ${words[v] || v}`).join(', '));
    }
    if (c.notes) lines.push(`Notes: ${c.notes}`);
    return lines;
  }

  function checkinsText(onlyDate) {
    const all = getCheckins();
    const dates = onlyDate ? [onlyDate].filter((d) => all[d]) : Object.keys(all).sort();
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
        <button class="btn primary" data-action="copy-checkins"${dates.length ? '' : ' disabled style="opacity:.5"'}>${ICON.copy} Copy all for my coach</button>
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
    // keep the answers given on the Today screen (meals, workout steps)
    const old = obj(all[ds]);
    if (old.steps) c.steps = old.steps;
    if (old.meal_log) c.meal_log = old.meal_log;
    if (old.what_auto && c.what === old.what_auto) c.what_auto = old.what_auto;
    all[ds] = c;
    if (!lsSet(LS.checkins, all)) { toast('Could not save on this phone'); return; }
    toast('Check-in saved');
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

    html += icuSettingsHTML();

    html += `<p class="center muted small" style="margin-top:28px">Trainer v${APP_VERSION} · your check-ins stay on this phone</p>`;
    return html;
  }

  function icuSettingsHTML() {
    const c = icuCfg();
    return `<div class="section"><h3>Intervals.icu</h3><div class="card">
      ${c ? `<dl class="kv"><dt>Status</dt><dd>${icu.error ? '⚠ ' + esc(icu.error) : '✓ Connected'}</dd><dt>Athlete id</dt><dd>${esc(c.athlete || '0')}</dd><dt>API key</dt><dd>saved on this device</dd></dl>
        <div class="btn-row" style="margin-top:12px"><button class="btn" data-action="icu-test">Test connection</button><button class="btn danger" data-action="icu-forget">Disconnect</button></div>`
      : `<p class="small muted" style="margin-top:0">Shows your sleep, HRV, fitness, weather and done rides in the Agenda. In Intervals.icu go to <b>Settings → Developer Settings</b> and copy your athlete id and API key. The key is saved only on this device, never on the website.</p>
        <form id="icuForm" autocomplete="off">
          <div class="field"><label class="lbl" for="icuAthlete">Athlete id <small>(looks like i123456)</small></label><input type="text" id="icuAthlete" name="athlete" placeholder="i123456" autocapitalize="off" spellcheck="false"></div>
          <div class="field"><label class="lbl" for="icuKey">API key</label><input type="password" id="icuKey" name="key" autocapitalize="off" spellcheck="false" style="width:100%"></div>
          <button class="btn primary" type="submit">Connect</button>
        </form>`}
    </div></div>`;
  }

  async function icuConnect(form) {
    const athlete = form.athlete.value.trim(), key = form.key.value.trim();
    if (!key) { toast('Paste your API key first'); return; }
    lsSet(LS_ICU, { athlete: athlete || '0', key });
    icu.cache = {}; icu.weatherAt = 0;
    try {
      const a = await icuGet('');
      icu.error = '';
      toast(`Connected as ${txt(a.name) || 'you'} ✓`);
    } catch (e) {
      icu.error = e.message;
      toast(e.message);
    }
    render(true);
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
    // activities.json is made on the laptop by fetch-activities.js. It is not on the
    // public website, so there this simply finds nothing and the live data is used.
    try {
      const res = await fetch('activities.json', { cache: 'no-store' });
      state.fileActs = res.ok ? arr(obj(await res.json()).activities) : [];
    } catch (e) {
      state.fileActs = [];
    }
  }

  /* ---------------- navigation ---------------- */

  const TITLES = { today: 'Today', agenda: 'Agenda', goals: 'Goals', food: 'Food', checkin: 'Check-in', settings: 'Settings', day: 'Day', workout: 'Workout', overview: 'Day overview' };
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
        case 'overview': html = viewOverview(); break;
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
    $('#overviewBtn').hidden = r.name !== 'today';
    $('#gearBtn').classList.toggle('active', r.name === 'settings');
    const activeTab = { day: 'agenda', workout: 'agenda', overview: 'today' }[r.name] || r.name;
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
    } else if (action === 'flow') {
      const ds = today();
      const step = dayFlow(ds).find((s) => s.id === el.dataset.step);
      if (!step) return;
      answerStep(ds, step, el.dataset.value);
      afterAnswer(ds, step.id);
    } else if (action === 'flow-focus') {
      goToStep(el.dataset.step);
    } else if (action === 'flow-later') {
      const next = nextOpenStep(today(), el.dataset.step);
      goToStep(next ? next.id : '');
    } else if (action === 'step-num') {
      const input = el.closest('form').querySelector(`input[name="${el.dataset.target}"]`);
      const cur = parseFloat(input.value);
      const v = isNaN(cur) ? parseFloat(el.dataset.start) : cur + parseFloat(el.dataset.delta);
      input.value = String(Math.max(0, Math.min(24, v)));
    } else if (action === 'copy-today') {
      const ok = await copyText(checkinsText(today()));
      toast(ok ? 'Copied! Paste it into your coach chat.' : "Couldn't copy. Try again.");
    } else if (action === 'shop-mode') {
      state.shopMode = el.dataset.mode;
      render(true);
    } else if (action === 'shop-day') {
      state.shopDay = el.dataset.date;
      render(true);
    } else if (action === 'week') {
      const dir = +el.dataset.dir;
      state.weekOffset = dir === 0 ? 0 : state.weekOffset + dir;
      render(true);
    } else if (action === 'shop-clear') {
      // only untick the list you are looking at (the week, or the chosen day)
      const ticks = shopTicks();
      Object.keys(ticks).forEach((k) => {
        const isDay = k.indexOf('|') === 10;
        if (state.shopMode === 'day' ? k.startsWith(state.shopDay + '|') : !isDay) delete ticks[k];
      });
      lsSet(LS.shop, { plan: shopKey(), ticked: ticks });
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
    } else if (action === 'icu-test') {
      el.textContent = 'Testing…';
      try {
        const a = await icuGet('');
        icu.error = '';
        icu.cache = {}; icu.weatherAt = 0;
        toast(`Connected as ${txt(a.name) || 'you'} ✓`);
      } catch (err) {
        icu.error = err.message;
        toast(err.message);
      }
      render(true);
    } else if (action === 'icu-forget') {
      lsSet(LS_ICU, null);
      icu.cache = {}; icu.weather = null; icu.error = '';
      toast('Intervals.icu disconnected on this device');
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
    } else if (e.target.id === 'icuForm') {
      e.preventDefault();
      icuConnect(e.target);
    } else if (e.target.dataset.flowForm) {
      // a form step on the Today screen (morning / session / wrap-up)
      e.preventDefault();
      const kind = e.target.dataset.flowForm;
      const fd = new FormData(e.target);
      const fields = { morning: ['sleep_h', 'legs', 'stress'], session: ['duration_min', 'power_w', 'hr_bpm', 'rpe', 'fuelled'], wrap: ['notes'] }[kind] || [];
      const patch = {};
      fields.forEach((f) => { patch[f] = String(fd.get(f) || '').trim(); });
      const ds = today();
      updateCheckin(ds, patch);
      const step = dayFlow(ds).find((s) => s.id === kind);
      if (step) answerStep(ds, step, 'done');
      if (document.activeElement) document.activeElement.blur();
      afterAnswer(ds, kind);
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
