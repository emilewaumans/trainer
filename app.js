/* ==========================================================
   Trainer — app logic
   Reads plan.json (or a pasted plan) and draws each screen.
   Never changes the plan. Everything in the plan is optional:
   missing fields are skipped, unknown fields are ignored.
   ========================================================== */
'use strict';

(function () {
  const APP_VERSION = '1.18.0';

  // Keys used to store things on the phone (localStorage)
  const LS = {
    imported: 'trainer.importedPlan',
    checkins: 'trainer.checkins',
    shop: 'trainer.shopping',
    goalSeen: 'trainer.goalSeen',
    celebrated: 'trainer.celebrated', // last day the "day complete" animation was shown
  };

  const state = {
    numMode: {},         // per workout: 'done' or 'plan' numbers shown (finished sessions)
    showRoute: false,    // full step list open in the step card
    calMonth: 0,         // month shown on the Progress page (0 = this month)
    sel: {},             // calendars: the day picked with the first tap (cal, meal, xp); a 2nd tap opens it
    xpHelp: false,       // Progress: "How to earn XP" panel open
    mealCal: false,      // Food: month calendar open
    mealMonth: 0,        // Food: month shown (0 = this month)
    open: {},            // Settings: panels opened with their button (import, icu)
    profPhoto: null,     // Me profile form: newly picked photo (data URL), '' = removed
    me: { sport: 'all', metric: 'time', range: '3m', frange: '3m', logWeeks: 12 }, // Me page filters
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
  // Like safe(), but returns a value (false when it fails)
  function safeVal(fn) { try { return fn(); } catch (e) { console.error(e); return false; } }

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
    dots: svgIcon('<circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/>'),
    gear: svgIcon('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>'),
    person: svgIcon('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>'),
    refresh: svgIcon('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>'),
    cart: svgIcon('<rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M8.5 8.5l1.2 1.2 2-2.2M8.5 13.5l1.2 1.2 2-2.2M13.5 9h2.5M13.5 14h2.5M8.8 18h7.2"/>'),
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
  function sessionHTML(w, wk, r, i) {
    const t = typeInfo(txt(w.type));
    let st = r && ['done', 'partly', 'skipped'].includes(r.status) ? r.status : '';
    const hasDone = !!(r && r.a && (st === 'done' || st === 'partly'));
    // Without a synced activity, your own answer (steps or "Mark done") decides
    const ds = normDate(w.date), idx = i != null ? i : r ? r.x.i : null;
    const ans = idx != null && txt(w.type) !== 'rest' ? workoutAnswer(ds, idx) : '';
    if (!hasDone && ans) st = ANS_STATUS[ans] || st;
    const ticked = hasDone || ans === 'done' || ans === 'half';
    const mode = hasDone ? numMode(r.x.i) : 'plan';
    const toggle = hasDone ? numToggleHTML(r.x.i, mode) : '';
    const dur = mode === 'done' ? fmtDur(actMin(r.a)) : durationLabel(w);
    let body = '';
    if (mode === 'done') body = doneMiniHTML(r.a, toggle) + doneStripHTML(r);
    else if (txt(w.type) !== 'rest') {
      body = safe(() => plannedMiniHTML(w, wk, toggle), 'the chart') ||
        (toggle ? `<div class="mini"><div class="mini-meta"><span>Planned</span>${toggle}</div></div>` : '');
      if (!hasDone && ans) body += `<div class="done-strip st-${st}"><div class="ds-main">${statusChip(st)}<span class="ds-txt">${ans === 'no' ? 'Marked by you' : 'Marked by you · nothing synced'}</span></div></div>`;
      else if (st === 'skipped') body += doneStripHTML(r);
    }
    const mark = idx != null && txt(w.type) !== 'rest' && !hasDone ? markBtnHTML(ds, idx, ans) : '';
    return `<div class="sess ${t.cls}${st ? ' is-' + st : ''}">
      <div class="sess-head"><span class="sess-ic">${t.icon}${ticked ? `<i class="sess-check">${ICON.check}</i>` : ''}</span><span class="sess-title">${esc(txt(w.title) || t.label)}</span>${dur ? `<span class="dur">${esc(dur)}</span>` : ''}</div>
      ${body}${mark ? `<div class="sess-foot">${mark}</div>` : ''}
    </div>`;
  }

  // Your own answer for a workout (Done / Half / Didn't), from today's steps or a "Mark done" tap
  const ANS_STATUS = { done: 'done', half: 'partly', no: 'skipped' };
  const workoutAnswer = (ds, i) => (ds ? obj(obj(getCheckins()[ds]).steps)['workout-' + i] || '' : '');
  function markBtnHTML(ds, i, ans) {
    if (!ds || ds > today()) return '';
    const on = ans === 'done';
    return `<button type="button" class="mark-btn${on ? ' on' : ''}" data-action="mark-done" data-date="${ds}" data-i="${i}" data-value="done" aria-pressed="${on}">${on ? ICON.check + ' Done' : 'Mark done'}</button>`;
  }

  // Finished sessions show what you really did; the switch flips back to the plan
  const numMode = (i) => state.numMode[i] || 'done';
  function numToggleHTML(i, mode) {
    return `<span class="num-toggle" role="group" aria-label="Show planned or done numbers">
      <button type="button" class="${mode === 'done' ? 'sel' : ''}" data-action="num-mode" data-i="${i}" data-mode="done" aria-pressed="${mode === 'done'}">Done</button>
      <button type="button" class="${mode === 'plan' ? 'sel' : ''}" data-action="num-mode" data-i="${i}" data-mode="plan" aria-pressed="${mode === 'plan'}">Planned</button></span>`;
  }
  // Load, intensity and normalized power of the real ride (as Intervals.icu calculated them)
  function doneMiniHTML(a, toggle) {
    const bits = [];
    if (isNum(a.icu_training_load)) bits.push(`Load <b>${esc(num(a.icu_training_load, 0))}</b>`);
    if (isNum(a.icu_intensity)) bits.push(`Intensity <b>${esc(num(a.icu_intensity, 0))}%</b>`);
    if (isNum(a.icu_weighted_avg_watts)) bits.push(`NP <b>${esc(num(a.icu_weighted_avg_watts, 0))} W</b>`);
    return `<div class="mini"><div class="mini-meta"><span class="load-ic">${ICON.load}</span><span>${bits.join(' · ') || 'Done'}</span>${toggle}</div></div>`;
  }

  function workoutCard(x) {
    const w = x.w, t = typeInfo(txt(w.type));
    const d = parseDate(w.date);
    const wk = d ? icuWeek(mondayOf(d)) : null;
    const r = txt(w.type) === 'rest' ? null : matchFor(x, wk);
    let st = r && ['done', 'partly', 'skipped'].includes(r.status) ? r.status : '';
    const ans = txt(w.type) === 'rest' ? '' : workoutAnswer(x.date, x.i);
    if (ans && !(r && r.a)) st = ANS_STATUS[ans];
    return `<a class="card workout ${t.cls}${st ? ' card-' + st : ''}" href="#workout/${x.i}">${sessionHTML(w, wk, r, x.i)}<span class="chev">›</span></a>`;
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
    // a row of food pictures first (easier than reading), the words small underneath
    const icons = (t) => { const ics = foodIcon(t, 6); return ics[0] === '🛒' ? '' : `<span class="ml-ics" aria-hidden="true">${ics.map((x) => `<span>${x}</span>`).join('')}</span>`; };
    const i = s.indexOf(':');
    if (i > 0 && i < 40) {
      const body = s.slice(i + 1).trim();
      return `<li class="ml-li">${icons(body)}<span class="lbl">${esc(s.slice(0, i))}</span><span class="ml-txt">${esc(body)}</span></li>`;
    }
    return `<li class="ml-li">${icons(s)}<span class="ml-txt">${esc(s)}</span></li>`;
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
  // Checked top to bottom: "before/during/after the ride" come first, so "Breakfast (after the ride)"
  // goes after the ride. They only count on a day with a workout; otherwise the word guesses below are used.
  const MEAL_SLOTS = [
    [/pre-?ride|pre-?workout|before (the )?(ride|workout|training|session)/i, 'pre'],
    [/on the bike|during/i, 'during'],
    [/recovery|after (the )?(ride|workout|training|session|strength)|post-?(ride|workout)/i, 'post'],
    [/breakfast|ontbijt/i, 7],
    [/morning snack|mid-?morning/i, 10],
    [/lunch/i, 12.5],
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
      return { label, body, time, id: stepKey(o.id) };
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
      const wTitle = txt(x.w.title) || info.label;
      steps.push({ id: 'workout-' + x.i, kind: t === 'rest' ? 'rest' : 'workout', slot, x, icon: info.icon, title: wTitle, sub: info.label });
      if (t === 'rest') return;
      workoutChecks(x.w).forEach((q) => {
        steps.push({
          id: `check-${planSlug(wTitle)}-${q.id}`, kind: 'check', slot: slot + (q.when === 'before' ? -0.03 : 0.03), x, q,
          icon: /fuel|drink|eat|carb|food|bottle/i.test(q.id + ' ' + q.ask) ? ICON.bottle : ICON.note,
          title: q.ask, sub: `${q.when === 'before' ? 'Before' : 'After'}: ${wTitle}`,
        });
      });
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
          for (const [re, hit] of MEAL_SLOTS) {
            if (!re.test(p.label || p.body)) continue;
            let v = hit;
            if (v === 'pre') v = firstW != null ? firstW - 0.2 : null;
            else if (v === 'during') v = firstW != null ? firstW - 0.1 : null;
            else if (v === 'post') v = lastW != null ? lastW + 0.3 : null;
            if (v != null) { slot = v; break; }
          }
          if (slot == null) slot = prev + 0.01;
        }
        prev = slot;
        // a line with an id keeps its answer even if the coach reorders the lines
        steps.push({ id: p.id ? `meal-id-${p.id}` : `meal-${mi}-${ii}`, kind: 'meal', slot, meal: p, dayType: txt(m.day_type), icon: mealIcon(p.label), title: p.label || 'Meal', sub: p.body });
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

  // Safe piece of a step id (letters, digits, - and _)
  const stepKey = (v) => txt(v).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

  // Follow-up questions of a workout: the coach's "checks" list, or (without one) three fuel questions.
  // "checks": [] means no questions. Answers are always Done / Half / Didn't.
  function workoutChecks(w) {
    if (Array.isArray(w.checks)) {
      return w.checks.map(obj).filter((q) => stepKey(q.id) && txt(q.ask))
        .map((q) => ({ id: stepKey(q.id), ask: txt(q.ask), when: txt(q.when) === 'before' ? 'before' : 'after', text: txt(q.text) }));
    }
    const f = obj(w.fuel), out = [];
    if (txt(f.before)) out.push({ id: 'fuel_before', ask: 'Did you eat before the session?', when: 'before', text: txt(f.before) });
    if (isNum(f.during_carbs_g_per_h) && f.during_carbs_g_per_h > 0) out.push({ id: 'fuel_during', ask: `Did you take about ${num(f.during_carbs_g_per_h)} g carbs per hour during the session?`, when: 'after', text: '' });
    if (txt(f.after)) out.push({ id: 'fuel_after', ask: 'Did you have your recovery food?', when: 'after', text: txt(f.after) });
    return out;
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
    const steps = Object.assign({}, obj(c.steps));
    if (status) steps[step.id] = status; else delete steps[step.id];
    const patch = { steps };
    if (step.kind === 'meal') {
      const ml = Object.assign({}, obj(c.meal_log));
      if (status) ml[step.title] = status; else delete ml[step.title];
      patch.meal_log = ml;
    }
    updateCheckin(ds, patch);
    if (step.kind === 'workout') syncSessionDone(ds);
  }

  // Keep the check-in's "Session done?" in line with the workout answers
  function syncSessionDone(ds) {
    const c = obj(getCheckins()[ds]);
    const st = obj(c.steps);
    const wk = dayFlow(ds).filter((s) => s.kind === 'workout');
    const vals = wk.map((s) => st[s.id]).filter(Boolean);
    if (!vals.length) {
      // every workout answer was taken back
      if (c.done || c.what_auto) updateCheckin(ds, { done: '', what_auto: '', what: c.what === c.what_auto ? '' : c.what });
      return;
    }
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

  const ANSWERS = [['done', '✓ Done'], ['half', '½ Half'], ['no', "✕ Didn't"]];
  const ANSWER_WORD = { done: 'Done', half: 'Half', no: "Didn't" };

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
        ${answerButtons(s, ANSWERS)}`;
    }
    if (s.kind === 'check') {
      return `${s.q.text ? `<div class="q-text">${esc(s.q.text)}</div>` : ''}
        ${answerButtons(s, ANSWERS)}`;
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
        ${slotsHTML(w)}
        ${fuel ? `<div class="q-fuel"><span class="q-fuel-ic">${ICON.bottle}</span><span>${fuel}</span></div>` : ''}
        <a class="btn" href="#workout/${s.x.i}" style="margin-top:14px">See full workout ›</a>
        ${answerButtons(s, ANSWERS)}`;
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
      // Minutes, power and heart rate are only asked for a workout your Wahoo / Intervals.icu didn't send
      const md = safeVal(() => matchDay(ds, icuDay(icuWeek(mondayOf(parseDate(ds))), ds))) || { rows: [] };
      const st = obj(c.steps);
      const missing = md.rows.filter((r) => !r.a && st['workout-' + r.x.i] !== 'no');
      const ride = missing.some((r) => planSport(r.x.w.type) === 'Ride');
      const planned = missing.reduce((t, r) => t + (isNum(r.x.w.duration_min) ? r.x.w.duration_min : 0), 0);
      const names = missing.map((r) => txt(r.x.w.title) || typeInfo(txt(r.x.w.type)).label).join(' + ');
      const manual = missing.length ? `<div class="field"><span class="lbl">Not synced from your Wahoo: fill in by hand <small>(optional)</small></span>
          <div class="muted small" style="margin:-2px 2px 8px">${esc(names)}</div>
          <div class="row-3">
            <label><span class="mini">Minutes</span><input type="number" inputmode="numeric" name="duration_min" min="0" value="${esc(c.duration_min || '')}" placeholder="${planned || ''}"></label>
            ${ride ? `<label><span class="mini">Avg power W</span><input type="number" inputmode="numeric" name="power_w" min="0" value="${esc(c.power_w || '')}"></label>
            <label><span class="mini">Avg HR bpm</span><input type="number" inputmode="numeric" name="hr_bpm" min="0" value="${esc(c.hr_bpm || '')}"></label>` : ''}
          </div></div>` : '';
      return `<form data-flow-form="session" autocomplete="off">
        <div class="field"><span class="lbl">How hard was it? <small>(RPE 1–10)</small></span>${seg('rpe', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'], c.rpe)}
          <div class="seg-hint"><span>1 = very easy</span><span>10 = max</span></div></div>
        <div class="field"><span class="lbl">Fuelled as planned?</span>${seg('fuelled', [['done', 'Done'], ['half', 'Half'], ['no', "Didn't"]], c.fuelled)}</div>
        ${manual}
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

  // "When" choices of a workout, e.g. First choice: after class, about 18:30
  function slotsHTML(w) {
    const list = arr(w.slots).map(obj).filter((o) => txt(o.text) || txt(o.label));
    if (!list.length) return '';
    return `<div class="q-slots">${list.map((o) => `<div class="q-slot"><span class="q-slot-ic">${ICON.clock}</span><span>${txt(o.label) ? `<b>${esc(txt(o.label))}</b> ` : ''}${esc(txt(o.text))}</span></div>`).join('')}</div>`;
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
    return `<div class="hud-wrap"><a class="hud${bump}${answered === steps.length ? ' all-done' : ''}" href="#progress" aria-label="Level ${lvl.level}, ${streak}-day streak, ${xp} XP today. Tap for details.">
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
    </a></div>`;
  }

  // Longest run of days in a row with a check-in
  function bestStreak() {
    const days = Object.keys(getCheckins()).filter(normDate).sort();
    let best = 0, run = 0, prev = '';
    days.forEach((d) => {
      run = prev && iso(addDays(parseDate(prev), 1)) === d ? run + 1 : 1;
      best = Math.max(best, run);
      prev = d;
    });
    return best;
  }

  // A month on one screen: every finished workout shows its follow score; tap it to open the workout
  function monthCalHTML() {
    const t = today(), base = parseDate(t);
    const first = new Date(base.getFullYear(), base.getMonth() + (state.calMonth || 0), 1);
    const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    const days = [];
    for (let d = mondayOf(first); d <= lastDay || d.getDay() !== 1; d = addDays(d, 1)) days.push(d);
    const weeks = {};
    // the days the plan covers (rest days are only shown inside it)
    const dates = allWorkouts().map((x) => x.date).filter(Boolean).sort();
    const span = [dates[0] || '', dates[dates.length - 1] || ''];
    let scored = 0, sum = 0;
    const hrefs = {};
    const cells = days.map((d) => {
      const ds = iso(d), inMonth = d.getMonth() === first.getMonth();
      const mon = iso(mondayOf(d));
      if (!(mon in weeks)) weeks[mon] = mon <= t ? icuWeek(mondayOf(d)) : null; // future weeks have nothing done yet
      const planned = workoutsOn(ds).filter((x) => txt(x.w.type) !== 'rest');
      const md = ds <= t ? matchDay(ds, icuDay(weeks[mon], ds)) : { rows: [], extra: [] };
      const sc = md.rows.filter((r) => isNum(r.score));
      // the icons of the planned sessions, and under them how it went (score, done or skipped)
      const icons = sessionIconsHTML(ds);
      const st = md.rows.map((r) => { const ans = workoutAnswer(ds, r.x.i); return r.a ? r.status : ans ? ANS_STATUS[ans] : r.status; });
      let mark = '', href = '';
      if (sc.length) {
        const s = Math.round(sc.reduce((a, r) => a + r.score, 0) / sc.length);
        if (inMonth) { scored++; sum += s; }
        mark = `<span class="mc-score sm ${scoreCls(s)}">${s}</span>`;
        href = sc.length === 1 && md.rows.length === 1 ? `#workout/${sc[0].x.i}` : `#day/${ds}`;
      } else if (st.some((x) => x === 'done' || x === 'partly') || md.extra.length) {
        mark = `<span class="mc-mark mc-done" title="Done">${ICON.check}</span>`;
        href = md.rows.length === 1 ? `#workout/${md.rows[0].x.i}` : `#day/${ds}`;
      } else if (st.some((x) => x === 'skipped')) {
        mark = '<span class="mc-mark mc-skip" title="Skipped">✕</span>';
        href = `#day/${ds}`;
      } else if (planned.length) {
        href = planned.length === 1 ? `#workout/${planned[0].i}` : `#day/${ds}`;
      }
      let inner = icons + mark;
      if (!inner && ds >= span[0] && ds <= span[1]) {
        // inside the plan but no workout: a rest day
        const rest = workoutsOn(ds)[0];
        inner = `<span class="mc-mark mc-rest" title="Rest day">${ICON.rest}</span>`;
        href = rest ? `#workout/${rest.i}` : `#day/${ds}`;
      }
      if (href && inMonth) hrefs[ds] = href;
      const cls = `mc-day${inMonth ? '' : ' out'}${ds === t ? ' today' : ''}${href ? ' has' : ''}${state.sel.cal === ds && href ? ' sel' : ''}`;
      const body = `<span class="mc-num">${d.getDate()}</span>${inner}`;
      return href && inMonth ? selDayBtn('cal', ds, href, cls, body) : `<div class="${cls}">${inMonth ? body : ''}</div>`;
    }).join('');
    const pick = hrefs[state.sel.cal] ? safe(() => calDayHTML(state.sel.cal, hrefs[state.sel.cal]), 'the chosen day') : '';
    const label = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    return `<div class="section"><h3>Workout scores</h3><div class="card month-cal">
      <div class="mc-nav">
        <button class="btn icon" data-action="cal-month" data-dir="-1" aria-label="Previous month">‹</button>
        <div class="mc-label"><b>${esc(label)}</b><small>${scored ? `${scored} scored · average ${Math.round(sum / scored)}` : 'No scores yet'}</small></div>
        <button class="btn icon" data-action="cal-month" data-dir="1" aria-label="Next month">›</button>
      </div>
      ${state.calMonth ? '<button class="btn small" data-action="cal-month" data-dir="0" style="margin:0 auto 10px">Back to this month</button>' : ''}
      <div class="mc-grid">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x) => `<span class="mc-dow">${x}</span>`).join('')}${cells}</div>
      ${pick}
      <div class="mc-legend"><span><i class="sc-top"></i>90+ spot on</span><span><i class="sc-good"></i>75+ close</span><span><i class="sc-mid"></i>50+ off plan</span><span class="mc-rest">${ICON.rest}rest day</span></div>
      ${sportLegendHTML()}
      <div class="muted small" style="margin-top:8px">Tap a day once to see it, tap it again to open it.</div>
    </div></div>`;
  }

  // A calendar day you pick with one tap and open with a second tap (same in every calendar)
  function selDayBtn(key, ds, href, cls, body) {
    return `<button type="button" class="${cls}" data-action="sel-day" data-key="${key}" data-date="${ds}" data-href="${esc(href)}" aria-pressed="${state.sel[key] === ds}">${body}</button>`;
  }

  // Small summary under the score calendar for the picked day
  function calDayHTML(ds, href) {
    const md = ds <= today() ? matchDay(ds, icuDay(icuWeek(mondayOf(parseDate(ds))), ds)) : { rows: [], extra: [] };
    const rows = workoutsOn(ds).filter((x) => txt(x.w.type) !== 'rest').map((x) => {
      const r = md.rows.find((y) => y.x.i === x.i);
      const ans = workoutAnswer(ds, x.i);
      const t = typeInfo(txt(x.w.type));
      let right;
      if (r && isNum(r.score)) right = `<span class="mc-score ${scoreCls(r.score)}">${r.score}</span>`;
      else if (r && r.a) right = statusChip(r.status);
      else if (ans) right = statusChip(ANS_STATUS[ans]);
      else if (r && r.status === 'skipped') right = statusChip('skipped');
      else right = `<span class="muted small">${esc(durationLabel(x.w) || 'Planned')}</span>`;
      return `<div class="cs-row ${t.cls}"><span class="cs-ic">${t.icon}</span><span class="cs-t">${esc(txt(x.w.title) || t.label)}</span>${right}</div>`;
    }).join('') + md.extra.map((a) => `<div class="cs-row"><span class="cs-ic">${ICON.check}</span><span class="cs-t">${esc(txt(a.name) || 'Activity')} <small class="muted">not planned</small></span></div>`).join('');
    return `<div class="cal-sum"><div class="cs-head"><b>${esc(fmtLong(ds))}</b><a class="btn small" href="${esc(href)}">Open ›</a></div>
      ${rows || `<div class="cs-row"><span class="cs-ic">${ICON.rest}</span><span class="cs-t">Rest day</span></div>`}</div>`;
  }

  // Every day since your first check-in: XP earned out of the most you could earn
  function viewXp() {
    const all = getCheckins(), t = today();
    const keys = Object.keys(all).filter(normDate).sort();
    let start = keys.length ? parseDate(keys[0]) : parseDate(t);
    if (daysBetween(start, parseDate(t)) < 13) start = addDays(parseDate(t), -13);
    const days = [];
    for (let d = start; iso(d) <= t && days.length < 1000; d = addDays(d, 1)) days.push(iso(d));
    const xps = days.map((ds) => xpOf(all[ds]));
    const maxes = days.map(dayMaxXp);
    const scale = Math.max(10, ...maxes, ...xps);
    const total = keys.reduce((s, ds) => s + xpOf(all[ds]), 0);
    let best = { xp: 0, ds: '' };
    keys.forEach((ds) => { const x = xpOf(all[ds]); if (x > best.xp) best = { xp: x, ds }; });
    const avg = keys.length ? Math.round(total / keys.length) : 0;
    if (!days.includes(state.sel.xp)) state.sel.xp = t;
    const sel = state.sel.xp;

    let html = `<div class="page-head"><div class="eyebrow">Progress</div><h2>XP history</h2></div>`;
    html += `<div class="prog-grid" style="margin-top:0">
      ${progTile(ICON.bolt, 'pt-xp', total, 'XP in total')}
      ${progTile(ICON.trophy, 'pt-best', best.xp, best.ds ? 'best day · ' + esc(fmtDate(best.ds, { day: 'numeric', month: 'short' })) : 'best day')}
      ${progTile(ICON.medal, 'pt-perfect', avg, 'XP per day (average)')}
      ${progTile(ICON.calendar, '', keys.length, keys.length === 1 ? 'day checked in' : 'days checked in')}
    </div>`;
    html += `<div class="section"><h3>Every day</h3><div class="card"><div class="xp-scroll"><div class="xp-chart" style="grid-template-columns:repeat(${days.length}, 26px)">
      ${days.map((ds, i) => {
        const d = parseDate(ds);
        const top = d.getDate() === 1 || i === 0 ? esc(d.toLocaleDateString('en-GB', { month: 'short' })) : '';
        return xpColHTML(ds, xps[i], maxes[i], scale, { tag: 'button', cls: 'xp-col' + (ds === sel ? ' sel' : ''), day: d.getDate(), top,
          attrs: ` type="button" data-action="sel-day" data-key="xp" data-date="${ds}" data-href="#day/${ds}" aria-pressed="${ds === sel}"` });
      }).join('')}
    </div></div><div class="muted small" style="margin-top:10px">Tap a day to see it below, tap it again to open the day.</div></div></div>`;
    html += safe(() => `<div class="section"><h3>${esc(fmtLong(sel))}</h3>${daySummaryHTML(sel, { xp: true })}</div>`, 'the chosen day');
    const weeks = {};
    days.forEach((ds, i) => {
      const m = iso(mondayOf(parseDate(ds)));
      const w = weeks[m] = weeks[m] || { xp: 0, max: 0, n: 0 };
      w.xp += xps[i]; w.max += maxes[i]; if (all[ds]) w.n++;
    });
    html += `<div class="section"><h3>Per week</h3><div class="card xw">${Object.keys(weeks).sort().reverse().map((m) => {
      const w = weeks[m];
      return `<div class="xw-row"><div class="xw-t"><b>Week of ${esc(fmtDate(m, { day: 'numeric', month: 'short' }))}</b><small>${w.n} ${w.n === 1 ? 'day' : 'days'} checked in</small></div>
        <div class="xw-bar"><i style="width:${w.max ? Math.round((Math.min(w.xp, w.max) / w.max) * 100) : 0}%"></i></div><b class="xw-v">${w.xp}<small>/${w.max}</small></b></div>`;
    }).join('')}</div></div>`;
    return html;
  }

  // Most XP you could earn on a day: 10 per step
  const dayMaxXp = (ds) => (state.plan ? (safeVal(() => dayFlow(ds).length) || 0) * 10 : 0);

  // One XP bar: the outline is the most you could earn that day, the orange part what you earned
  function xpColHTML(ds, xp, max, scale, extra) {
    const pct = (v) => Math.round((Math.min(v, scale) / scale) * 100);
    const DL = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const t = today(), had = !!getCheckins()[ds];
    const tag = extra && extra.tag || 'div';
    return `<${tag} class="pc-col${ds === t ? ' today' : ''}${had ? ' on' : ''}${extra && extra.cls ? ' ' + extra.cls : ''}"${extra && extra.attrs || ''} title="${esc(fmtDate(ds))}: ${xp} of ${max} XP">
      ${extra && extra.top != null ? `<span class="xc-m">${extra.top}</span>` : ''}
      <span class="pc-val">${xp ? `<b>${xp}</b>` : ''}${max ? `<small>/${max}</small>` : ''}</span>
      <span class="pc-bar">${max ? `<span class="pc-max" style="height:${pct(max)}%"></span>` : ''}<i style="height:${pct(xp)}%"></i></span>
      <span class="pc-dot"></span><span class="pc-day">${extra && extra.day ? extra.day : DL[parseDate(ds).getDay()]}</span></${tag}>`;
  }

  function xpRulesHTML(lvl) {
    return `<div class="card help-pop" id="xpHelp"><div class="hp-head"><b>How to earn XP</b><button class="btn icon" data-action="xp-help" aria-label="Close">×</button></div>
      <ul class="prog-rules">
      <li><span>Step done</span><b>+10 XP</b></li>
      <li><span>Step half done</span><b>+5 XP</b></li>
      <li><span>Step skipped</span><b>0 XP</b></li>
      <li><span>New level</span><b>every ${lvl.per} XP</b></li>
      <li><span>Streak</span><b>+1 each day in a row you check in</b></li>
    </ul><div class="muted small" style="margin-top:10px">The most you can earn on a day is 10 XP per step. A session that Intervals.icu shows as done ticks itself off, so it earns XP on its own.</div></div>`;
  }

  const progTile = (ic, cls, val, label) => `<div class="card prog-tile ${cls}"><span class="pt-ic">${ic}</span><b>${val}</b><small>${label}</small></div>`;

  // Details behind the game bar: level, XP, streak and the last two weeks
  function viewProgress() {
    const all = getCheckins();
    const t = today();
    const total = Object.values(all).reduce((s, x) => s + xpOf(x), 0);
    const lvl = levelOf(total);
    const streak = streakDays(), best = Math.max(bestStreak(), streak);
    const days = Object.keys(all).filter(normDate);
    const perfect = state.plan ? days.filter((ds) => safeVal(() => { const st = dayFlow(ds); return st.length && st.every((s) => s.status); })).length : 0;
    const r = 52, circ = 2 * Math.PI * r, f = lvl.into / lvl.per;
    const last = Array.from({ length: 14 }, (_, i) => iso(addDays(parseDate(t), i - 13)));
    const xps = last.map((ds) => xpOf(all[ds]));
    const maxes = last.map(dayMaxXp);
    const scale = Math.max(10, ...maxes, ...xps);

    let html = `<div class="page-head"><div class="eyebrow">Progress</div><div class="head-row"><h2>Level ${lvl.level}</h2>
      <button class="help-btn${state.xpHelp ? ' on' : ''}" data-action="xp-help" aria-expanded="${!!state.xpHelp}" aria-label="How to earn XP">?</button></div></div>`;
    if (state.xpHelp) html += xpRulesHTML(lvl);
    html += `<div class="card prog-hero">
      <div class="prog-ring"><svg viewBox="0 0 120 120" aria-hidden="true"><defs><linearGradient id="progGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffd27a"/><stop offset="1" stop-color="#ff6a2b"/></linearGradient></defs>
        <circle class="pr-bg" cx="60" cy="60" r="${r}"/><circle class="pr-fg" cx="60" cy="60" r="${r}" stroke-dasharray="${(circ * f).toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 60 60)"/></svg>
        <span class="pr-num"><small>LEVEL</small><b>${lvl.level}</b></span></div>
      <div class="prog-hero-txt">
        <div class="prog-big">${lvl.into} <span>/ ${lvl.per} XP</span></div>
        <div class="prog-bar"><i style="width:${(f * 100).toFixed(1)}%"></i></div>
        <div class="muted small"><b>${lvl.toNext} XP</b> to level ${lvl.level + 1} · ${total} XP in total</div>
      </div>
    </div>`;
    const tile = progTile;
    html += `<div class="prog-grid">
      ${tile(ICON.flame, 'pt-streak' + (streak ? ' lit' : ''), streak, streak === 1 ? 'day streak' : 'days streak')}
      ${tile(ICON.trophy, 'pt-best', best, 'best streak')}
      ${tile(ICON.bolt, 'pt-xp', '+' + xpOf(all[t]), 'XP today')}
      ${tile(ICON.medal, 'pt-perfect', perfect, perfect === 1 ? 'perfect day' : 'perfect days')}
    </div>`;
    html += `<div class="section"><h3><span>Last 14 days</span><a class="h-link" href="#xp">All days ›</a></h3><a class="card tap prog-chart-card" href="#xp" aria-label="Open your full XP history"><div class="prog-chart">
      ${last.map((ds, i) => xpColHTML(ds, xps[i], maxes[i], scale)).join('')}
    </div><div class="muted small" style="margin-top:10px">Orange: the XP you earned. Outline: the most you could earn that day. Tap for every day ›</div></a></div>`;
    html += safe(() => monthCalHTML(), 'the month calendar');
    html += safe(() => `<div class="section"><h3>Today</h3>${daySummaryHTML(t, { xp: true })}</div>`, "today's summary");
    html += `<a class="btn primary" href="#today" style="margin-top:18px">Back to today's steps ›</a>`;
    return html;
  }

  function questHTML(ds) {
    const steps = dayFlow(ds);
    const c = obj(getCheckins()[ds]);
    if (state.focusDate !== ds) { state.focus = ''; state.focusDate = ds; }
    const cur = steps.find((s) => s.id === state.focus) || steps.find((s) => !s.status) || null;
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
        ${routeToggleHTML(steps, cur)}
      </div>`;
    } else {
      // the end screen of the animation, as a card that stays
      html += `<div class="day-sum-wrap" id="questCard">${daySummaryHTML(ds, { replay: true })}
        ${routeToggleHTML(steps, null)}</div>`;
    }
    return html;
  }

  // "See all steps" button inside the step card; the full list only shows after tapping it
  function routeToggleHTML(steps, cur) {
    const open = !!state.showRoute;
    const done = steps.filter((s) => s.status).length;
    const marks = { done: '✓', half: '½', no: '✕' };
    return `<button class="btn route-toggle${open ? ' open' : ''}" data-action="route-toggle" aria-expanded="${open}">
        <span>${open ? 'Hide the list' : `See all ${steps.length} steps`} <small>${done} of ${steps.length} done</small></span><span class="rt-chev">›</span></button>
      ${open ? `<div class="route route-in">${steps.map((s, i) => `
        <button class="route-item st-${s.status || 'open'}${cur && s.id === cur.id ? ' current' : ''}" data-action="flow-focus" data-step="${esc(s.id)}">
          <span class="ri-mark">${marks[s.status] || i + 1}</span>
          <span class="ri-icon">${s.icon}</span>
          <span class="ri-text"><b>${esc(s.title)}</b>${s.sub ? `<small>${esc(s.sub)}</small>` : ''}</span>
        </button>`).join('')}</div>` : ''}`;
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
    if (!next && !maybeCelebrate(ds)) toast('Day complete!');
  }

  // The "day complete" moment shows once per day, the first time every step is answered
  function maybeCelebrate(ds) {
    if (lsGet(LS.celebrated, '') === ds) return false;
    lsSet(LS.celebrated, ds);
    celebrate(ds);
    return true;
  }

  // Full screen: steps, XP and streak count up one after another (under 3 s in total).
  // Each tap jumps to the next number; a tap on the last one closes it.
  function celebrate(ds) {
    const old = document.querySelector('.cel');
    if (old) old.remove();
    const steps = dayFlow(ds);
    const done = steps.filter((s) => s.status === 'done').length;
    const xp = xpOf(getCheckins()[ds]);
    const total = Object.values(getCheckins()).reduce((t, x) => t + xpOf(x), 0);
    const lvl = levelOf(total);
    const from = (Math.max(0, lvl.into - xp) / lvl.per) * 100, to = (lvl.into / lvl.per) * 100;
    const streak = ds === today() ? streakDays() : 0;
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const el = document.createElement('div');
    el.className = 'cel';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', `Day complete: ${done} of ${steps.length} steps done, ${xp} XP, ${streak}-day streak`);
    el.innerHTML = `<div class="confetti" aria-hidden="true">${Array.from({ length: 14 }, (_, i) => `<span style="--i:${i}"></span>`).join('')}</div>
      <div class="cel-title">Day complete!</div>
      <div class="cel-stage">
        <div class="cel-stat cs-steps"><span class="cel-ic">${ICON.check}</span><div class="cel-num"><b data-count="${done}">0</b><span>/ ${steps.length}</span></div><div class="cel-lbl">steps done</div></div>
        <div class="cel-stat cs-xp"><span class="cel-ic">${ICON.bolt}</span><div class="cel-num"><b data-count="${xp}" data-pre="+">+0</b><span>XP</span></div>
          <div class="cel-lbl">Level ${lvl.level} · ${lvl.into} / ${lvl.per}</div><div class="cel-bar"><i style="width:${from.toFixed(1)}%" data-to="${to.toFixed(1)}"></i></div></div>
        <div class="cel-stat cs-streak"><span class="cel-ic">${ICON.flame}</span><div class="cel-num"><b data-count="${streak}">0</b></div><div class="cel-lbl">day streak</div></div>
      </div>
      <div class="cel-dots"><i></i><i></i><i></i></div>
      <div class="cel-hint">Tap to skip</div>`;
    document.body.appendChild(el);
    const stats = [...el.querySelectorAll('.cel-stat')];
    const final = (b) => { cancelAnimationFrame(b._raf); b.textContent = (b.dataset.pre || '') + b.dataset.count; };
    function count(b) {
      const n = +b.dataset.count, pre = b.dataset.pre || '';
      if (reduce || !n) return final(b);
      const t0 = performance.now();
      const tick = (now) => {
        const k = Math.min(1, (now - t0) / 550);
        b.textContent = pre + Math.round(n * (1 - Math.pow(1 - k, 3)));
        if (k < 1) b._raf = requestAnimationFrame(tick);
      };
      b._raf = requestAnimationFrame(tick);
    }
    let cur = -1, timer = 0;
    function show(n) {
      clearTimeout(timer);
      if (n > 2) return close();
      stats.forEach((st, k) => {
        st.classList.toggle('on', k <= n);
        st.classList.toggle('now', k === n);
        if (k < n) final(st.querySelector('b'));
      });
      el.querySelectorAll('.cel-dots i').forEach((d, k) => d.classList.toggle('on', k <= n));
      cur = n;
      count(stats[n].querySelector('b'));
      const bar = stats[n].querySelector('.cel-bar i');
      if (bar) requestAnimationFrame(() => { bar.style.width = bar.dataset.to + '%'; });
      timer = setTimeout(() => show(n + 1), 900);
    }
    function close() {
      clearTimeout(timer);
      document.removeEventListener('keydown', onKey);
      el.classList.add('out');
      setTimeout(() => el.remove(), 260);
    }
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    el.addEventListener('click', (e) => { e.stopPropagation(); show(cur + 1); });
    requestAnimationFrame(() => { el.classList.add('in'); show(0); });
  }

  // What happened on a day: steps done, XP and streak, then what went well and what could go better.
  // o.xp: show the XP of every line. o.replay: tap the card to play the animation again.
  const SUM_MARK = { done: '✓', half: '½', no: '✕' };
  function daySummaryHTML(ds, o) {
    o = o || {};
    const steps = dayFlow(ds);
    const xp = xpOf(getCheckins()[ds]), max = steps.length * 10;
    const done = steps.filter((s) => s.status === 'done').length;
    const answered = steps.filter((s) => s.status).length;
    const complete = steps.length && answered === steps.length;
    const streak = ds === today() ? streakDays() : null;
    const line = (s) => `<li class="sm-${s.status || 'open'}"><span class="sm-mark">${SUM_MARK[s.status] || ''}</span>
      <span class="sm-txt">${esc(s.title)}${s.kind === 'check' ? `<small>${esc(s.sub)}</small>` : ''}</span>${o.xp ? `<b class="sm-xp">${s.status ? '+' + (SCORE[s.status] || 0) : ''}</b>` : ''}</li>`;
    // a long list stays short: the first 4, the rest behind "+N more" (not on the XP pages)
    const list = (title, xs, cls, fold) => {
      if (!xs.length) return '';
      const short = fold && !o.xp && xs.length > 5;
      return `<div class="sm-sec ${cls}"><h4>${title}</h4><ul class="sm-list">${(short ? xs.slice(0, 4) : xs).map(line).join('')}</ul>
        ${short ? `<details class="sm-more"><summary>+${xs.length - 4} more</summary><ul class="sm-list">${xs.slice(4).map(line).join('')}</ul></details>` : ''}</div>`;
    };
    return `<div class="card day-sum${complete ? ' complete' : ''}">
      <div class="sm-head"><span class="sm-medal">${complete ? ICON.medal : ICON.flag}</span>
        <div class="sm-ttl"><b>${complete ? 'Day complete' : ds === today() ? 'Today so far' : esc(fmtLong(ds))}</b><small>${complete ? esc(fmtLong(ds)) : `${answered} of ${steps.length} steps answered`}</small></div>
        ${o.replay ? `<button type="button" class="sm-replay" data-action="celebrate" data-date="${ds}" aria-label="Play the day-complete animation again">Replay ›</button>` : ''}</div>
      <div class="sm-stats">
        <div><b>${done}<small>/${steps.length}</small></b><span>steps done</span></div>
        <div class="sm-x"><b>+${xp}<small>/${max}</small></b><span>XP</span></div>
        ${streak != null ? `<div class="sm-f"><b>${streak}</b><span>day streak</span></div>` : ''}
      </div>
      ${list('What went well', steps.filter((s) => s.status === 'done'), 'sm-good', true)}
      ${list('What could go better', steps.filter((s) => s.status === 'half' || s.status === 'no'), 'sm-better')}
      ${list('Still open', steps.filter((s) => !s.status), 'sm-open')}
    </div>`;
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

    // Finished rides come from Intervals.icu: say so when that link is missing or failing
    if (!icuCfg()) html += `<a class="card warn small tap" href="#settings/icu">Your finished sessions can't show yet: connect Intervals.icu in Settings ›</a>`;
    else if (icu.error) html += `<a class="card warn small tap" href="#settings/icu">Intervals.icu: ${esc(icu.error)}. Check the key in Settings ›</a>`;
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
  // A plan's blocks have different widths, so this is not a chartSVG graph, but with `key` it uses the
  // same .mhit tap/slide handling: tap or slide to pick a block (state.sel[key] = block index).
  function powerChartSVG(segs, big, key) {
    const T = segs.reduce((t, s) => t + s.sec, 0);
    if (!T) return '';
    const W = big ? 360 : 600, H = big ? 190 : 34, padL = big ? 30 : 0, padB = big ? 18 : 0;
    const maxW = Math.max(100, big ? ftp() : 0, ...segs.map((s) => Math.max(s.w0, s.w1)));
    const top = Math.ceil((maxW * 1.1) / 100) * 100;
    const x = (t) => padL + (t / T) * (W - padL);
    const padT = big ? 10 : 2;
    const y = (p) => (H - padB) - (p / top) * (H - padB - padT);
    const sel = key ? state.sel[key] : null;
    let t = 0, shapes = '', hits = '';
    segs.forEach((s, i) => {
      const x0 = x(t), x1 = x(t + s.sec);
      shapes += `<polygon${sel === String(i) ? ' class="sel"' : ''} points="${x0},${H - padB} ${x0},${y(s.w0)} ${x1},${y(s.w1)} ${x1},${H - padB}" fill="${zoneColor((s.w0 + s.w1) / 2)}"/>`;
      if (key) hits += `<rect class="mhit" x="${x0}" y="0" width="${x1 - x0}" height="${H}" data-action="sel-day" data-key="${key}" data-date="${i}" data-href=""/>`;
      t += s.sec;
    });
    shapes += hits;
    let axes = '';
    if (big) {
      for (let p = 100; p <= top; p += 100) axes += `<line x1="${padL}" x2="${W}" y1="${y(p)}" y2="${y(p)}" class="grid"/><text x="${padL - 4}" y="${y(p) + 4}" text-anchor="end">${p}</text>`;
      if (ftp()) axes += `<line x1="${padL}" x2="${W}" y1="${y(ftp())}" y2="${y(ftp())}" class="ftp"/>`;
      for (let i = 0; i <= 4; i++) {
        const tt = (T * i) / 4;
        axes += `<text x="${x(tt)}" y="${H - 4}" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}">${clock(tt)}</text>`;
      }
    }
    return `<svg class="pchart${big ? ' big' : ''}${sel != null && segs[sel] ? ' has-sel' : ''}" viewBox="0 0 ${W} ${H}"${big ? '' : ' preserveAspectRatio="none"'} role="img" aria-label="Power profile">${axes}${shapes}</svg>`;
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
  const icu = { cache: {}, loading: {}, failed: {}, error: '', weather: null, weatherAt: 0 };
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
    // after a failed try, wait a minute before asking again (otherwise every redraw asks again)
    const resting = icu.failed[key] && Date.now() - icu.failed[key] < 60 * 1000;
    if (!fresh && !icu.loading[key] && !resting) {
      icu.loading[key] = true;
      const sun = iso(addDays(mon, 6));
      Promise.all([
        icuGet(`/wellness?oldest=${key}&newest=${sun}`),
        icuGet(`/events?oldest=${key}&newest=${sun}`),
        icuGet(`/activities?oldest=${key}&newest=${sun}T23:59:59`),
        Date.now() - icu.weatherAt > 30 * 60 * 1000 ? icuGet('/weather-forecast').catch(() => null) : Promise.resolve(undefined),
      ]).then(([wellness, events, activities, weather]) => {
        icu.cache[key] = { at: Date.now(), wellness: arr(wellness), events: arr(events), activities: arr(activities) };
        delete icu.failed[key];
        if (weather !== undefined) { icu.weather = weather; icu.weatherAt = Date.now(); }
        icu.error = '';
      }).catch((e) => {
        icu.error = e.message || 'Could not reach Intervals.icu';
        icu.failed[key] = Date.now();
      }).finally(() => {
        icu.loading[key] = false;
        if (['agenda', 'day', 'workout', 'today', 'overview', 'progress'].includes(state.route)) render(true);
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
  // One icon and colour per sport (calendars, Me page)
  const SPORTS = {
    Ride: { label: 'Ride', icon: ICON.bike, color: '#fc5200' },             // Strava orange
    WeightTraining: { label: 'Strength', icon: ICON.kettlebell, color: '#a855f7' },
    Run: { label: 'Run', icon: ICON.run, color: '#22c55e' },                // Strava green
    Swim: { label: 'Swim', icon: ICON.swim, color: '#3b82f6' },
    Other: { label: 'Other', icon: ICON.dot, color: '#9aa3ae' },
  };
  const SPORT_ORDER = ['Ride', 'WeightTraining', 'Run', 'Swim', 'Other'];
  const sportInfo = (k) => SPORTS[k] || SPORTS.Other;

  // Small icons of the sessions planned on a day: a ride and a kettlebell session show a bike and a kettlebell
  function sessionIconsHTML(ds, max) {
    const ws = workoutsOn(ds).filter((x) => txt(x.w.type) !== 'rest');
    if (!ws.length) return '';
    max = max || 3;
    return `<span class="sess-ics">${ws.slice(0, max).map((x) => {
      const sp = sportInfo(planSport(x.w.type));
      return `<i class="si" style="--sc:${sp.color}" title="${esc(txt(x.w.title) || sp.label)}">${sp.icon}</i>`;
    }).join('')}${ws.length > max ? `<small>+${ws.length - max}</small>` : ''}</span>`;
  }
  const sportLegendHTML = (keys) => `<div class="mc-legend sport-legend">${(keys || ['Ride', 'WeightTraining', 'Run', 'Swim']).map((k) =>
    `<span><i class="si" style="--sc:${sportInfo(k).color}">${sportInfo(k).icon}</i>${esc(sportInfo(k).label)}</span>`).join('')}</div>`;

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
    // workouts you marked done in the app that no activity covers (like the kettlebell): planned time and load
    days.forEach((ds) => {
      const st = obj(obj(getCheckins()[ds]).steps);
      const done = doneOn(ds, icuDay(wk, ds));
      workoutsOn(ds).forEach((x) => {
        const ans = st['workout-' + x.i];
        const sp = sportOfPlan(txt(x.w.type));
        if (!sp || (ans !== 'done' && ans !== 'half')) return;
        if (done.some((a) => sportOfActivity(a.type) === sp)) return;
        const f = ans === 'half' ? 0.5 : 1;
        const m = safeVal(() => workoutMetrics(x.w));
        add(sp, 'dt', plannedSec(x.w) * f);
        add(sp, 'dl', (m && isNum(m.load) ? m.load : 0) * f);
      });
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
        const extra = [isNum(last.rampRate) ? `<span>Ramp <b>${esc(signed(last.rampRate, 1))}</b></span>` : '', kcal ? `<span><b>${esc(num(kcal, 0))}</b> kcal</span>` : '', climb ? `<span><b>${esc(num(climb, 0))} m</b> climbing</span>` : ''].filter(Boolean).join('');
        fit = `<div class="wk-fit">
            <div class="f-fit"><b>${esc(num(last.ctl, 0))}</b><span>Fitness</span></div>
            <div class="f-fat"><b>${esc(num(last.atl, 0))}</b><span>Fatigue</span></div>
            <div class="f-form ${form < -10 ? 'c-bad' : form > 5 ? 'c-good' : 'c-neutral'}"><b>${esc(signed(form))}</b><span>Form</span></div>
          </div>${extra ? `<div class="wk-extra">${extra}</div>` : ''}`;
      }
    }
    const pct = (d, pl) => (pl > 0 ? Math.round((d / pl) * 100) : null);
    const barHTML = (d, pl, cls) => { const q = pct(d, pl); return `<div class="wk-bar ${cls}"><i style="width:${q == null ? (d ? 100 : 0) : Math.min(100, q)}%"></i></div>`; };
    // 1. time: done of planned, one bar
    const tp = pct(tot.dt, tot.pt);
    const time = `<div class="wk-time"><div class="wk-big"><b>${esc(hm(tot.dt))}</b><span>of ${esc(hm(tot.pt))} trained</span>${tp != null ? `<em>${tp}%</em>` : ''}</div>${barHTML(tot.dt, tot.pt, 'b-time')}</div>`;
    // 2. load on its own (it isn't a sport), in its own colour
    const lp = pct(tot.dl, tot.pl);
    const load = tot.pl || tot.dl ? `<div class="wk-load"><span class="wk-lic">${ICON.load}</span><div class="wk-lmain">
        <div class="wk-lrow"><b>Load ${esc(num(tot.dl, 0))}</b><span>of ${esc(num(tot.pl, 0))} planned</span>${lp != null ? `<em>${lp}%</em>` : ''}</div>${barHTML(tot.dl, tot.pl, 'b-load')}</div></div>` : '';
    // 3. time per sport, blue bars, fixed order
    const ORDER = ['Ride', 'WeightTraining', 'Run', 'Swim', 'Other'];
    const sportRows = ORDER.filter((sp) => sports[sp]).map((sp) => {
      const x = sports[sp];
      return `<div class="wk-sp"><span class="wk-sic">${SPORT_ICON[sp] || ICON.dot}</span><span class="wk-spl">${esc(SPORT_LABEL[sp] || sp)}</span>${barHTML(x.dt, x.pt, 'b-sport')}
        <span class="wk-spv">${esc(hm(x.dt))}<small>${x.pt ? ' / ' + esc(hm(x.pt)) : ' extra'}</small></span></div>`;
    }).join('');
    const short = { day: 'numeric', month: 'short' };
    return `<div class="card wk-sum">
      <div class="wk-top-row"><b>Week ${esc(isoWeek(mon))}</b><span class="muted small">${esc(fmtDate(mon, short))} – ${esc(fmtDate(addDays(mon, 6), short))}${icu.loading[iso(mon)] ? ' · updating…' : ''}</span></div>
      ${time}${load}
      ${sportRows ? `<div class="wk-sports2">${sportRows}</div>` : ''}
      ${fit}
      ${wk ? '' : `<div class="muted small" style="margin-top:8px">${icuCfg() ? 'Loading from Intervals.icu…' : 'Connect Intervals.icu in <a href="#settings/icu">Settings</a> to see sleep, fitness and done rides.'}</div>`}
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
  function plannedMiniHTML(w, wk, extra) {
    const m = workoutMetrics(w);
    if (!m) return '';
    const ev = icuEventFor(w, wk);
    const load = ev && isNum(ev.icu_training_load) ? ev.icu_training_load : m.load;
    const IF = ev && isNum(ev.icu_intensity) ? ev.icu_intensity / 100 : m.IF;
    return `<div class="mini"><div class="mini-meta"><span class="load-ic">${ICON.load}</span>Load <b>${esc(num(load, 0))}</b> · Intensity <b>${esc(num(IF * 100, 0))}%</b>${extra || ''}</div>${powerChartSVG(m.segs, false)}</div>`;
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
        if (state.sel.block === ds) cls.push('sel');
        const ics = sessionIconsHTML(ds) || (workoutsOn(ds).length ? `<span class="sess-ics rest">${ICON.rest}</span>` : '');
        cells += selDayBtn('block', ds, '#day/' + ds, cls.join(' '), `${day.getDate()}${ics}`);
      }
    }
    // the picked day: a short summary first, a second tap (or Open) goes to the day
    const sel = state.sel.block;
    const shown = sel && cells.includes(`data-date="${sel}"`);
    return `<div class="cal">${cells}</div>${shown ? safe(() => calDayHTML(sel, '#day/' + sel), 'the chosen day') : ''}
      ${sportLegendHTML()}
      <div class="muted small" style="margin-top:8px">Tap a day once to see it, tap it again to open it.</div>`;
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
          ? ws.map((x) => sessionHTML(x.w, wk, md.rows.find((r) => r.x.i === x.i), x.i)).join('')
          : '<div class="item muted" style="font-weight:500">Nothing planned</div>';
        const acts = md.extra.map(activityHTML).join('');
        const top = ds <= today() ? wellnessHTML(live && live.wellness) : '';
        const wx = ds >= today() ? weatherHTML(weatherOn(ds)) : '';
        rows += `<a class="card day-row tap${ds === today() ? ' today' : ''}${ds < today() ? ' past' : ''}" href="#day/${ds}">
          <div class="dr-head"><div class="date"><span class="w">${DOW[i]}</span><span class="d">${d.getDate()}</span></div>
            ${top || wx ? `<div class="day-live">${top}${wx}</div>` : ''}<span class="dr-chev">›</span></div>
          <div class="items">${items}${acts}</div></a>`;
      }
      return `<div class="week-nav">
          <button class="btn icon" data-action="week" data-dir="-1" aria-label="Previous week">‹</button>
          <div class="label">${esc(fmtDate(mon, { day: 'numeric', month: 'short' }))} – ${esc(fmtDate(sun, { day: 'numeric', month: 'short' }))}<small>${esc([sub, blockTxt].filter(Boolean).join(' · ') || ' ')}</small></div>
          <button class="btn icon" data-action="week" data-dir="1" aria-label="Next week">›</button>
        </div>
        ${state.weekOffset !== 0 ? '<button class="btn small" data-action="week" data-dir="0" style="margin:0 auto 12px">Back to this week</button>' : ''}
        ${icu.error && icuCfg() ? `<a class="card warn small tap" href="#settings/icu">Intervals.icu: ${esc(icu.error)}. Check the key in Settings ›</a>` : ''}
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
      return `<div class="section"><h3>Your check-in</h3><div class="card ci-item"><div class="ci-body">${esc(checkinLines(c, ds).join('\n'))}</div>
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
  function workoutStatsHTML(w, ds, idx) {
    const d = parseDate(ds);
    const wk = d ? icuWeek(mondayOf(d)) : null;
    const r = matchFor({ w, i: idx }, wk);
    const hasDone = !!(r && r.a && (r.status === 'done' || r.status === 'partly'));
    const mode = hasDone ? numMode(idx) : 'plan';
    const toggle = hasDone ? numToggleHTML(idx, mode) : '';
    if (mode === 'done') return doneStatsHTML(r, toggle);
    const m = workoutMetrics(w);
    if (!m) return toggle ? `<div class="section" style="margin-top:0"><h3 class="h-toggle"><span>Planned</span>${toggle}</h3><div class="card">${esc(durationLabel(w) || 'No planned numbers')}</div></div>` : '';
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
    // the block picked on the power chart (tap or slide), or a hint
    const pkey = `pw-${ds}-${idx}`;
    const bi = Number(state.sel[pkey]), b = m.segs[bi];
    let blockInfo = '<span class="muted">Tap or slide along the chart to see each block.</span>';
    if (state.sel[pkey] != null && b) {
      const from = m.segs.slice(0, bi).reduce((t, s) => t + s.sec, 0);
      const w = b.w0 === b.w1 ? `${Math.round(b.w0)} W` : `${Math.round(b.w0)}→${Math.round(b.w1)} W`;
      const mid = (b.w0 + b.w1) / 2;
      blockInfo = `<b>Block ${bi + 1} of ${m.segs.length}</b> · ${esc(clock(from))}–${esc(clock(from + b.sec))} · ${esc(fmtDur(b.sec))} · <b>${esc(w)}</b>${ftp() ? ` (${Math.round((mid / ftp()) * 100)}% FTP)` : ''} ${zoneChip(zoneOfWatts(mid))}`;
    }
    return `<div class="section" style="margin-top:0"><h3 class="h-toggle"><span>Planned numbers${ev ? ' <span class="muted" style="text-transform:none;letter-spacing:0">· from Intervals.icu</span>' : ''}</span>${toggle}</h3>
      <div class="card">
        <div class="stats">${stat(hm(m.sec), 'Duration')}${stat(num(load, 0), 'Load')}${stat(num(IF * 100, 0) + '%', 'Intensity')}</div>
        <div class="stats" style="margin-top:8px">${stat(num(np, 0) + ' W', 'Normalized')}${stat(num(avg, 0) + ' W', 'Average')}${stat(num(vi, 2), 'Variability')}</div>
        <div class="stats" style="margin-top:8px">${stat(num(m.kj, 0) + ' kJ', 'Work')}${ss != null ? stat(num(ss, 0), 'Strain score') : ''}${stat(num(ftp(), 0) + ' W', 'FTP used')}</div>
        <div class="pchart-wrap">${powerChartSVG(m.segs, true, pkey)}</div>
        <div class="pblock small">${blockInfo}</div>
        ${zrows ? `<div class="zrows">${zrows}</div>` : ''}
        <details class="explain"><summary>What do these mean?</summary>
          <p><b>Load</b>: how hard the session is (an hour all-out ≈ 100). <b>Intensity</b>: normalized power as % of your FTP. <b>Normalized</b>: what the ride "feels like" in watts, with hard bits counting extra. <b>Variability</b>: normalized ÷ average; 1.00 is perfectly steady. <b>Work</b>: total energy you put into the pedals. The dashed line in the chart is your FTP.</p>
        </details>
      </div></div>`;
  }

  // What you really did, in the same layout as the planned numbers
  function doneStatsHTML(r, toggle) {
    const a = r.a;
    const stat = (v, l) => `<div class="stat"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`;
    const n = (v, d, u) => (isNum(v) ? num(v, d) + (u || '') : '—');
    return `<div class="section" style="margin-top:0"><h3 class="h-toggle"><span>Done numbers <span class="muted" style="text-transform:none;letter-spacing:0">· from Intervals.icu</span></span>${toggle}</h3>
      <div class="card done-stats">
        <div class="ds-head">${statusChip(r.status)}<span class="muted small">${esc(txt(a.name))}</span></div>
        <div class="stats">${stat(hm(actSec(a)), 'Duration')}${stat(n(a.icu_training_load, 0), 'Load')}${stat(n(a.icu_intensity, 0, '%'), 'Intensity')}</div>
        <div class="stats" style="margin-top:8px">${stat(n(a.icu_weighted_avg_watts, 0, ' W'), 'Normalized')}${stat(n(a.icu_average_watts, 0, ' W'), 'Average')}${stat(n(a.icu_variability_index, 2), 'Variability')}</div>
        <div class="stats" style="margin-top:8px">${stat(n(a.average_heartrate, 0, ' bpm'), 'Avg HR')}${stat(n(a.max_heartrate, 0, ' bpm'), 'Max HR')}${stat(isNum(a.icu_joules) ? num(a.icu_joules / 1000, 0) + ' kJ' : isNum(a.calories) ? num(a.calories, 0) + ' kcal' : '—', isNum(a.icu_joules) ? 'Work' : 'Calories')}</div>
        ${isNum(r.score) ? `<div class="cmp-score">${scoreRing(r.score, 52)}<div><b>${esc(scoreWord(r.score))}</b><div class="muted small">Follow score · ${r.parts.map((p) => `${p.k} ${p.v}`).join(' · ')}</div></div></div>` : ''}
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

    html += safe(() => workoutStatsHTML(w, ds, +idx), 'the workout numbers');
    html += safe(() => {
      if (!ds || ds > today() || txt(w.type) === 'rest') return '';
      const ans = workoutAnswer(ds, +idx);
      return `<div class="section" style="margin-top:0"><h3>Did you do it?</h3><div class="answers answers-3">${ANSWERS.map(([v, l]) =>
        `<button class="ans ans-${v}${ans === v ? ' sel' : ''}" data-action="mark-done" data-date="${ds}" data-i="${+idx}" data-value="${v}">${l}</button>`).join('')}</div></div>`;
    }, 'your answer');

    html += safe(() => (txt(w.purpose) ? `<div class="section" style="margin-top:0"><h3>Purpose</h3><div class="card">${esc(txt(w.purpose))}</div></div>` : ''), 'the purpose');
    html += safe(() => { const sl = slotsHTML(w); return sl ? `<div class="section"><h3>When</h3><div class="card">${sl}</div></div>` : ''; }, 'the time slots');

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

  /* ---------------- screen: Me (like Strava's You / Progress) ---------------- */

  const LS_HIST = 'trainer.history';
  const HIST_FIELDS = 'id,start_date_local,type,name,moving_time,distance,total_elevation_gain,icu_training_load,average_heartrate,icu_average_watts,icu_rolling_ftp,icu_pm_ftp,icu_ftp,icu_zone_times,icu_hr_zone_times';
  const HIST_V = 3; // bump when the saved history needs new fields
  const hist = { data: lsGet(LS_HIST, null), loading: false, error: '' };

  // Every activity of the last 10 years and the daily fitness numbers, from Intervals.icu.
  // Kept only on this phone (localStorage), refreshed when older than 30 minutes.
  function icuHistory(force) {
    if (!icuCfg()) return null;
    const d = obj(hist.data);
    const fresh = d.at && d.v === HIST_V && Date.now() - d.at < 30 * 60 * 1000;
    const resting = !force && hist.failedAt && Date.now() - hist.failedAt < 60 * 1000;
    if ((force || !fresh) && !hist.loading && !resting) {
      hist.loading = true;
      const newest = today(), oldest = iso(addDays(parseDate(newest), -3653));
      Promise.all([
        icuGet(`/activities?oldest=${oldest}&newest=${newest}T23:59:59&fields=${HIST_FIELDS}`),
        icuGet(`/wellness?oldest=${oldest}&newest=${newest}&fields=id,ctl,atl`),
        icuGet('/sport-settings').catch(() => []),
      ]).then(([acts, well, sports]) => {
        const rs = arr(sports).map(obj), sp = rs.find((x) => arr(x.types).includes('Ride')) || rs[0] || {};
        const r1 = (v) => (isNum(v) ? Math.round(v * 10) / 10 : null);
        hist.data = {
          at: Date.now(), v: HIST_V,
          acts: arr(acts).map(obj).filter((a) => normDate(txt(a.start_date_local))).map((a) => ({
            id: txt(a.id), ds: txt(a.start_date_local).slice(0, 10), sport: sportOfActivity(a.type), type: txt(a.type), name: txt(a.name),
            sec: isNum(a.moving_time) ? a.moving_time : 0, km: isNum(a.distance) ? a.distance / 1000 : 0,
            elev: isNum(a.total_elevation_gain) ? a.total_elevation_gain : 0, load: r1(a.icu_training_load),
            hr: r1(a.average_heartrate), w: r1(a.icu_average_watts),
            eftp: r1(isNum(a.icu_rolling_ftp) ? a.icu_rolling_ftp : a.icu_pm_ftp), ftp: r1(a.icu_ftp),
            pz: arr(a.icu_zone_times).length ? PZ_IDS.map((id) => obj(arr(a.icu_zone_times).map(obj).find((z) => z.id === id)).secs || 0) : null,
            hz: arr(a.icu_hr_zone_times).length ? arr(a.icu_hr_zone_times).map((v) => (isNum(v) ? v : 0)) : null,
          })),
          zones: { pNames: arr(sp.power_zone_names), pLim: arr(sp.power_zones), hNames: arr(sp.hr_zone_names), hLim: arr(sp.hr_zones), ssMin: sp.sweet_spot_min, ssMax: sp.sweet_spot_max },
          well: arr(well).map(obj).filter((w) => normDate(txt(w.id)) && isNum(w.ctl)).map((w) => [txt(w.id), r1(w.ctl), r1(w.atl)])
            .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
        };
        lsSet(LS_HIST, hist.data);
        hist.error = '';
      }).catch((e) => {
        hist.error = e.message || 'Could not reach Intervals.icu';
        hist.failedAt = Date.now();
      }).finally(() => {
        hist.loading = false;
        if (state.route === 'me') render(true);
      });
    }
    return hist.data;
  }

  // Activities from Intervals.icu, plus workouts you marked done in the app that your watch didn't record
  // (like the kettlebell sessions), counted with their planned time
  function meActs() {
    const acts = arr(obj(hist.data).acts).slice();
    if (state.plan) {
      const all = getCheckins();
      Object.keys(all).forEach((ds) => {
        const st = obj(obj(all[ds]).steps);
        workoutsOn(ds).forEach((x) => {
          const ans = st['workout-' + x.i];
          if (txt(x.w.type) === 'rest' || (ans !== 'done' && ans !== 'half')) return;
          const sport = planSport(x.w.type);
          if (acts.some((a) => a.ds === ds && a.sport === sport && !a.manual)) return;
          acts.push({ id: 'plan-' + x.i, ds, sport, name: txt(x.w.title) || typeInfo(txt(x.w.type)).label,
            sec: Math.round(plannedSec(x.w) * (ans === 'half' ? 0.5 : 1)), km: 0, elev: 0, load: null, manual: true });
        });
      });
    }
    return acts.sort((a, b) => (a.ds < b.ds ? -1 : a.ds > b.ds ? 1 : 0));
  }

  const ME_METRICS = {
    time: { label: 'Time', get: (a) => a.sec, fmt: (v) => fmtDur(v) || '0 min', short: (v) => (v >= 3600 ? `${Math.round(v / 360) / 10} h` : `${Math.round(v / 60)} min`) },
    dist: { label: 'Distance', get: (a) => a.km, fmt: (v) => `${num(v, 1)} km`, short: (v) => `${Math.round(v)} km` },
    elev: { label: 'Elevation', get: (a) => a.elev, fmt: (v) => `${Math.round(v)} m`, short: (v) => `${Math.round(v)} m` },
  };
  const meBySport = (acts, sp) => (sp === 'all' ? acts : acts.filter((a) => a.sport === sp));
  const meMetric = () => (state.me.sport === 'WeightTraining' ? 'time' : state.me.metric);
  const sumOf = (list, f) => list.reduce((t, a) => t + (f(a) || 0), 0);
  const weekEnd = (mon) => iso(addDays(parseDate(mon), 6));

  // Sport chips (only sports you did in this period) and the Time / Distance / Elevation switch
  function meFiltersHTML(acts) {
    const present = SPORT_ORDER.filter((k) => acts.some((a) => a.sport === k));
    if (state.me.sport !== 'all' && !present.includes(state.me.sport)) state.me.sport = 'all';
    const chip = (k, label, ic, color) => `<button type="button" class="me-chip${state.me.sport === k ? ' on' : ''}" data-action="me-sport" data-sport="${k}"${color ? ` style="--sc:${color}"` : ''}>${ic || ''}${esc(label)}</button>`;
    const chips = `<div class="me-chips">${chip('all', 'All sports')}${present.map((k) => chip(k, sportInfo(k).label, `<i class="si">${sportInfo(k).icon}</i>`, sportInfo(k).color)).join('')}</div>`;
    const mk = meMetric();
    const metrics = state.me.sport === 'WeightTraining' ? '' : `<div class="me-seg">${Object.keys(ME_METRICS).map((k) =>
      `<button type="button" class="${mk === k ? 'on' : ''}" data-action="me-metric" data-metric="${k}">${ME_METRICS[k].label}</button>`).join('')}</div>`;
    return chips + metrics;
  }

  // Line or bar chart in the app's style. Points: { key, v, v2 (2nd dashed line), marks (dot colours), test, sel }.
  // With o.key every point can be tapped (or slid to): once to pick it, again to open o.href(point).
  // Full-screen detail: o.grid (value scale with grid lines), o.tip(point) (value bubble on the picked point),
  // o.xs (real x positions, e.g. days or log seconds), o.bands ([from, to, colour, name] shaded value ranges).
  function chartSVG(pts, o) {
    const W = 340, H = o.h || 150, pl = o.grid ? 30 : 6, pr = 6, pt = o.tip ? 24 : 18, pb = o.labels ? 20 : 6;
    const n = pts.length;
    const vals = pts.flatMap((p) => [p.v, p.v2]).filter(isNum);
    const peak = Math.max(o.floor || 0, ...vals);
    const lo = o.min != null ? o.min : 0;
    const top = o.max != null ? o.max : o.min != null ? peak + Math.max(1, (peak - lo) * 0.15) : (peak || 1) * 1.15;
    const bar = o.type === 'bar';
    const span = W - pl - pr;
    const xs = o.xs && o.xs.length === n ? o.xs : null, xw = xs ? xs[n - 1] - xs[0] || 1 : 1;
    const step = bar ? span / Math.max(1, n) : span / Math.max(1, n - 1);
    const X = (i) => (xs ? pl + (span * (xs[i] - xs[0])) / xw : bar ? pl + step * (i + 0.5) : n === 1 ? pl + span / 2 : pl + step * i);
    const Y = (v) => pt + (H - pt - pb) * (1 - ((v == null ? lo : v) - lo) / (top - lo));
    const base = Y(lo), f1 = (v) => v.toFixed(1);
    let g = '';
    arr(o.bands).forEach(([a, b, c, name]) => {
      const y1 = Y(Math.min(b, top)), y2 = Y(Math.max(a, lo));
      if (y2 - y1 < 1) return;
      g += `<rect x="${pl}" y="${f1(y1)}" width="${span}" height="${f1(y2 - y1)}" fill="${c}"/>`;
      if (name && y2 - y1 > 11) g += `<text class="mband" x="${W - pr - 3}" y="${f1(y1 + 10)}" text-anchor="end">${esc(name)}</text>`;
    });
    if (o.grid) {
      const tb = o.tickBase || 1, raw = (top - lo) / 5 / tb, mag = 10 ** Math.floor(Math.log10(raw || 1)); // tickBase 3600: steps in whole hours
      const st = ([1, 2, 2.5, 5, 10].map((m) => m * mag).find((m) => m >= raw) || mag * 10) * tb;
      const tick = o.tick || ((v) => String(Math.round(v * 100) / 100));
      for (let v = Math.ceil(lo / st) * st; v <= top + 1e-9; v += st) {
        g += `<line class="mg${Math.abs(v) < 1e-9 ? ' zero' : ''}" x1="${pl}" x2="${W - pr}" y1="${f1(Y(v))}" y2="${f1(Y(v))}"/><text class="ml" x="${pl - 4}" y="${f1(Y(v) + 3)}" text-anchor="end">${esc(tick(v))}</text>`;
      }
    } else {
      g += `<line class="mg" x1="${pl}" x2="${W - pr}" y1="${f1(Y(peak))}" y2="${f1(Y(peak))}"/>`;
      if (o.fmt && peak) g += `<text class="ml" x="${pl}" y="${f1(Y(peak) - 4)}">${esc(o.fmt(peak))}</text>`;
    }
    g += `<line class="mg base" x1="${pl}" x2="${W - pr}" y1="${f1(base)}" y2="${f1(base)}"/>`;
    const si = pts.findIndex((p) => p.sel);
    if (si >= 0) g += `<line class="msel" x1="${f1(X(si))}" x2="${f1(X(si))}" y1="${pt - 8}" y2="${f1(base)}"/>`;
    if (bar) {
      const bw = xs ? Math.max(1, (span / n) * 0.66) : Math.max(1, step * 0.66);
      pts.forEach((p, i) => {
        const y = Y(p.v);
        g += `<rect class="mbar${p.sel ? ' sel' : ''}" x="${f1(X(i) - bw / 2)}" y="${f1(Math.min(y, base - (p.v ? 1.5 : 0)))}" width="${f1(bw)}" height="${f1(Math.max(p.v ? 1.5 : 0, base - y))}" rx="${f1(Math.min(3, bw * 0.3))}"/>`;
      });
    } else if (n) {
      // a missing value lifts the pen, so a line never drops to zero for a day without data
      const path = (k) => { let d = '', pen = false; pts.forEach((p, i) => { if (!isNum(p[k])) { pen = false; return; } d += `${pen ? 'L' : 'M'}${f1(X(i))} ${f1(Y(p[k]))} `; pen = true; }); return d.trim(); };
      const line = path('v');
      const fi = pts.findIndex((p) => isNum(p.v)), li = pts.length - 1 - [...pts].reverse().findIndex((p) => isNum(p.v));
      if (o.area !== false && fi >= 0 && line && !line.slice(1).includes('M')) g += `<path class="marea" d="${line} L${f1(X(li))} ${f1(base)} L${f1(X(fi))} ${f1(base)} Z" fill="url(#mgr-${o.id})"/>`;
      if (pts.some((p) => isNum(p.v2))) g += `<path class="mline2" d="${path('v2')}"/>`;
      g += `<path class="mline" d="${line}"/>`;
      pts.forEach((p, i) => {
        if (!isNum(p.v)) return;
        arr(p.marks).forEach((c, k) => { g += `<circle class="mmark" cx="${f1(X(i))}" cy="${f1(Y(p.v) - k * 8)}" r="4" style="fill:${c}"/>`; });
        if (p.test) g += `<circle class="mtest" cx="${f1(X(i))}" cy="${f1(Y(p.v))}" r="7.5"/><text class="mtest-l" x="${f1(X(i))}" y="${f1(Y(p.v) - 12)}" text-anchor="middle">${esc(p.testLabel || 'Test')}</text>`;
        if (o.dots || p.sel) g += `<circle class="mdot${p.sel ? ' sel' : ''}${p.now ? ' now' : ''}" cx="${f1(X(i))}" cy="${f1(Y(p.v))}" r="${p.sel ? 5.5 : 3.4}"/>`;
      });
    }
    if (o.tip && si >= 0) {
      const x = X(si), a = x < pl + 60 ? 'start' : x > W - pr - 60 ? 'end' : 'middle';
      g += `<text class="mtip" x="${f1(a === 'start' ? Math.max(pl, x - 4) : a === 'end' ? Math.min(W - pr, x + 4) : x)}" y="11" text-anchor="${a}">${esc(o.tip(pts[si]))}</text>`;
    }
    // labels never overlap: one that would crowd the previous is skipped (the last one always stays)
    const lx = (i) => (i <= 0 ? pl : i >= n - 1 ? W - pr : X(i));
    const lab = [];
    arr(o.labels).slice().sort((a, b) => lx(a[0]) - lx(b[0])).forEach((l, k, all) => {
      const gap = (a, b) => lx(b[0]) - lx(a[0]) < (String(a[1]).length + String(b[1]).length) * 2.9 + 6;
      if (k === all.length - 1) { while (lab.length && gap(lab[lab.length - 1], l)) lab.pop(); lab.push(l); } else if (!lab.length || !gap(lab[lab.length - 1], l)) lab.push(l);
    });
    lab.forEach(([i, t]) => {
      const a = i <= 0 ? 'start' : i >= n - 1 ? 'end' : 'middle';
      g += `<text class="mx" x="${f1(i <= 0 ? pl : i >= n - 1 ? W - pr : X(i))}" y="${H - 5}" text-anchor="${a}">${esc(t)}</text>`;
    });
    if (o.key) {
      // each point owns the slice halfway to its neighbours, so a tap always picks the nearest one
      const edge = (i, j) => (X(i) + X(j)) / 2;
      pts.forEach((p, i) => {
        const x1 = i ? edge(i - 1, i) : Math.max(0, X(0) - (n > 1 ? (X(1) - X(0)) / 2 : step / 2));
        const x2 = i < n - 1 ? edge(i, i + 1) : Math.min(W, X(i) + (n > 1 ? (X(i) - X(i - 1)) / 2 : step / 2));
        g += `<rect class="mhit" x="${f1(x1)}" y="0" width="${f1(Math.max(0.5, x2 - x1))}" height="${H}" data-action="sel-day" data-key="${o.key}" data-date="${esc(p.key)}" data-href="${esc(o.href ? o.href(p) : '')}"/>`;
      });
    }
    return `<svg class="mchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label || 'Chart')}"><defs><linearGradient id="mgr-${o.id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff7a3d" stop-opacity="0.38"/><stop offset="1" stop-color="#ff7a3d" stop-opacity="0"/></linearGradient></defs>${g}</svg>`;
  }
  // k+1 evenly spread x labels: [[index, text], ...]
  const xLabels = (n, k, f) => (n ? [...new Set(Array.from({ length: k + 1 }, (_, j) => Math.round((j * (n - 1)) / k)))].map((i) => [i, f(i)]) : []);

  const meStat = (v, l) => `<div class="me-stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`;
  function meTotalsHTML(list) {
    const strength = state.me.sport === 'WeightTraining';
    return `<div class="me-stats">${meStat(ME_METRICS.time.fmt(sumOf(list, (a) => a.sec)), 'Time')}
      ${strength ? meStat(String(list.length), list.length === 1 ? 'Activity' : 'Activities') : meStat(ME_METRICS.dist.fmt(sumOf(list, (a) => a.km)), 'Distance') + meStat(ME_METRICS.elev.fmt(sumOf(list, (a) => a.elev)), 'Elevation')}</div>`;
  }

  // One activity as a short line (training log, chosen day)
  function meActLine(a) {
    const sp = sportInfo(a.sport);
    const bits = [fmtDur(a.sec)];
    if (a.km >= 0.1) bits.push(`${num(a.km, 1)} km`);
    if (isNum(a.load)) bits.push(`load ${Math.round(a.load)}`);
    if (a.manual) bits.push('marked in the app');
    return `<div class="cs-row" style="--tcol:${sp.color}"><span class="cs-ic">${sp.icon}</span><span class="cs-t">${esc(a.name || sp.label)}<small class="muted"> · ${esc(bits.filter(Boolean).join(' · '))}</small></span></div>`;
  }

  // Weeks in a row with at least one workout (this week counts once it has one, like Strava)
  function weekStreak(acts) {
    const per = {};
    acts.forEach((a) => { const m = iso(mondayOf(parseDate(a.ds))); per[m] = (per[m] || 0) + 1; });
    let mon = mondayOf(parseDate(today()));
    const thisWeek = !!per[iso(mon)];
    if (!thisWeek) mon = addDays(mon, -7);
    let weeks = 0, count = 0;
    while (per[iso(mon)] && weeks < 600) { weeks++; count += per[iso(mon)]; mon = addDays(mon, -7); }
    return { weeks, count, thisWeek, per };
  }

  // A week of the training log: 7 circles, bigger = longer, coloured by sport (split when two sports)
  function logWeekHTML(mon, acts, maxSec) {
    const days = Array.from({ length: 7 }, (_, i) => iso(addDays(parseDate(mon), i)));
    const wk = acts.filter((a) => a.ds >= mon && a.ds <= days[6]);
    const tot = sumOf(wk, (a) => a.sec);
    const cells = days.map((ds, i) => {
      const da = wk.filter((a) => a.ds === ds);
      const sec = sumOf(da, (a) => a.sec);
      const sports = [...new Set(da.map((a) => a.sport))];
      const size = da.length ? Math.round(14 + 24 * Math.sqrt(Math.min(1, sec / maxSec))) : 6;
      const bg = !sports.length ? '' : sports.length === 1 ? sportInfo(sports[0]).color
        : `conic-gradient(${sports.map((k, j) => `${sportInfo(k).color} ${Math.round((j * 100) / sports.length)}% ${Math.round(((j + 1) * 100) / sports.length)}%`).join(', ')})`;
      const body = `<span class="lg-dow">${DOW[i].charAt(0)}</span><span class="lg-c${da.length ? ' on' : ''}" style="--sz:${size}px${bg ? `;--lgc:${bg}` : ''}"></span><span class="lg-d">${parseDate(ds).getDate()}</span>`;
      const cls = `lg-day${ds === today() ? ' today' : ''}${state.sel.log === ds ? ' sel' : ''}`;
      return da.length ? selDayBtn('log', ds, '#day/' + ds, cls, body) : `<div class="${cls}">${body}</div>`;
    }).join('');
    const pick = days.includes(state.sel.log) ? `<div class="cal-sum"><div class="cs-head"><b>${esc(fmtLong(state.sel.log))}</b><a class="btn small" href="#day/${state.sel.log}">Open ›</a></div>
      ${wk.filter((a) => a.ds === state.sel.log).map(meActLine).join('')}</div>` : '';
    return `<div class="lg-week go-target" id="go-log-${mon}"><div class="lg-head"><b>${esc(fmtDate(mon, { day: 'numeric', month: 'short' }))} – ${esc(fmtDate(days[6], { day: 'numeric', month: 'short' }))}</b>
      <span>${tot ? esc(fmtDur(tot)) : 'No training'}${wk.length ? ` · ${wk.length} ${wk.length === 1 ? 'activity' : 'activities'}` : ''}</span></div>
      <div class="lg-grid">${cells}</div>${pick}</div>`;
  }
  function logWeeksHTML(acts, n) {
    const mon0 = mondayOf(parseDate(today()));
    const first = acts.length ? iso(mondayOf(parseDate(acts[0].ds))) : iso(mon0);
    const mons = [];
    for (let i = 0; i < n; i++) { const m = iso(addDays(mon0, -7 * i)); if (m < first) break; mons.push(m); }
    const maxSec = Math.max(3600, ...mons.map((m) => {
      const days = {};
      acts.filter((a) => a.ds >= m && a.ds <= weekEnd(m)).forEach((a) => { days[a.ds] = (days[a.ds] || 0) + a.sec; });
      return Math.max(0, ...Object.values(days));
    }));
    return { html: mons.map((m) => logWeekHTML(m, acts, maxSec)).join(''), more: mons.length === n && mons[mons.length - 1] > first };
  }

  const fitAt = (well, ds) => { let r = null; for (const w of well) { if (w[0] > ds) break; r = w; } return r; };
  const signed = (v, d) => (v > 0 ? '+' : v < 0 ? '−' : '±') + num(Math.abs(v), d || 0);

  // Profile (like Strava): photo, name and quote, saved only on this phone
  const LS_PROFILE = 'trainer.profile';
  const profile = () => obj(lsGet(LS_PROFILE, {}));
  const profName = () => txt(profile().name) || txt(obj(P().athlete).name) || 'You';
  const initialsOf = (n) => n.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  const picHTML = (src, name, cls) => (src ? `<img class="prof-pic ${cls || ''}" src="${esc(src)}" alt="">` : `<span class="prof-pic prof-ini ${cls || ''}">${esc(initialsOf(name))}</span>`);

  function profileHeadHTML(acts) {
    const pr = profile(), name = profName();
    const hours = Math.round(sumOf(acts, (a) => a.sec) / 3600);
    const sk = weekStreak(acts);
    return `<div class="card prof">
      <div class="prof-top">${picHTML(pr.photo, name)}
        <div class="prof-id"><h2>${esc(name)}</h2>${txt(pr.quote) ? `<q>${esc(txt(pr.quote))}</q>` : '<a class="prof-add" href="#me/profile">+ Add a quote</a>'}</div></div>
      <div class="prof-stats">
        <div><b>${acts.length}</b><span>Activities</span></div>
        <div><b>${hours}</b><span>Hours</span></div>
        <div><b class="${sk.weeks ? 'lit' : ''}">${ICON.flame}${sk.weeks}</b><span>Week streak</span></div>
      </div>
      <a class="btn small prof-edit" href="#me/profile">Edit profile</a></div>`;
  }

  function meProfileFormHTML() {
    const pr = profile(), name = profName();
    const pic = state.profPhoto != null ? state.profPhoto : pr.photo || '';
    return `<div class="page-head"><div class="eyebrow">Me</div><h2>Edit profile</h2></div>
      <form id="profForm" class="card" autocomplete="off">
        <div class="prof-pick">${picHTML(pic, name, 'big')}
          <div class="stack"><label class="btn small" for="profPhoto">Choose photo</label>
          <button type="button" class="btn small" data-action="prof-photo-clear"${pic ? '' : ' hidden'}>Remove photo</button></div>
          <input type="file" accept="image/*" id="profPhoto" hidden></div>
        <div class="field"><label class="lbl" for="profName">Name</label><input type="text" id="profName" name="name" maxlength="40" value="${esc(txt(pr.name) || txt(obj(P().athlete).name))}"></div>
        <div class="field"><label class="lbl" for="profQuote">Quote</label><input type="text" id="profQuote" name="quote" maxlength="120" value="${esc(txt(pr.quote))}" placeholder="Something that keeps you going"></div>
        <div class="btn-row"><a class="btn" href="#me">Cancel</a><button class="btn primary" type="submit">Save</button></div>
        <div class="muted small" style="margin-top:10px">Saved only on this phone.</div>
      </form>`;
  }

  // A photo from the phone, cut square and shrunk to 256 × 256 so it stays small
  function shrinkPhoto(file) {
    return new Promise((ok, bad) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const n = 256, c = document.createElement('canvas'), m = Math.min(img.width, img.height);
        c.width = c.height = n;
        c.getContext('2d').drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, n, n);
        URL.revokeObjectURL(url);
        ok(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); bad(new Error("Couldn't read that photo")); };
      img.src = url;
    });
  }
  function showPickedPhoto(src) {
    const old = document.querySelector('.prof-pick .prof-pic');
    if (old) old.outerHTML = picHTML(src, profName(), 'big');
    const rm = document.querySelector('[data-action="prof-photo-clear"]');
    if (rm) rm.hidden = !src;
  }

  function viewMe(arg) {
    if (arg === 'profile') return meProfileFormHTML();
    const head = (eyebrow, title, extra) => `<div class="page-head me-head"><div class="eyebrow">${eyebrow}</div>${extra || ''}</div>`;
    if (!icuCfg()) {
      return head('Me', 'Your training') + safe(() => profileHeadHTML(meActs()), 'your profile') + `<a class="card warn tap" href="#settings/icu">Connect Intervals.icu to see your training history, streak and fitness here. Tap to add your key ›</a>`;
    }
    const d = icuHistory();
    const refresh = `<button class="icon-btn${hist.loading ? ' spin' : ''}" data-action="me-refresh" aria-label="Refresh from Intervals.icu">${ICON.refresh}</button>`;
    if (!d) {
      return head('Me', 'Your training', refresh) + safe(() => profileHeadHTML(meActs()), 'your profile') + (hist.error
        ? `<a class="card warn tap" href="#settings/icu">Intervals.icu: ${esc(hist.error)}. Check the key in Settings ›</a>`
        : '<div class="card muted">Loading your history from Intervals.icu…</div>');
    }
    const acts = meActs();
    const err = hist.error ? `<div class="card warn small">Couldn't refresh (${esc(hist.error)}). Showing what was loaded ${esc(agoText(d.at))}.</div>` : '';
    if (arg === 'history') return head('Me', 'Training history') + err + safe(() => meHistoryHTML(acts), 'the training history');
    // #me/history-2026-09-14: that one week, day by day
    if (arg.startsWith('history-')) return head('Me', 'Training history') + err + safe(() => meHistoryHTML(acts, normDate(arg.slice(8))), 'the training history');
    if (arg === 'ftp') return head('Me', 'FTP') + err + safe(() => meFtpHTML(acts), 'the FTP graph');
    if (arg === 'power') return head('Me', 'Power curve') + safe(() => mePowerHTML(), 'the power curve');
    if (arg === 'zones') return head('Me', 'Time in zones') + err + safe(() => meZonesHTML(acts), 'the zones');
    if (arg === 'fitness') return head('Me', 'Fitness') + err + safe(() => meFitnessHTML(acts, arr(d.well)), 'the fitness graph');
    if (arg && arg.startsWith('log')) {
      const want = normDate(arg.slice(4));
      if (want) state.me.logWeeks = Math.max(state.me.logWeeks, daysBetween(parseDate(want), mondayOf(parseDate(today()))) / 7 + 2);
      const lg = logWeeksHTML(acts, state.me.logWeeks);
      return head('Me', 'Training log') + err + sportLegendHTML(SPORT_ORDER.filter((k) => acts.some((a) => a.sport === k))) +
        `<div class="card lg-card">${lg.html || '<div class="muted">No activities yet.</div>'}</div>` +
        (lg.more ? '<button class="btn" data-action="me-more">Load older weeks</button>' : '');
    }

    let html = head('Me', '', refresh) + safe(() => profileHeadHTML(acts), 'your profile') + err;
    html += `<div class="muted small me-upd">Updated ${esc(agoText(d.at))} from Intervals.icu</div>`;
    html += safe(() => meWeekCardHTML(acts), 'the weekly graph');
    html += safe(() => {
      const sk = weekStreak(acts);
      const mon0 = mondayOf(parseDate(today()));
      const row = Array.from({ length: 12 }, (_, i) => iso(addDays(mon0, -7 * (11 - i)))).map((m, i) =>
        `<span class="stk${sk.per[m] ? ' on' : ''}${i === 11 ? ' now' : ''}" title="Week of ${esc(fmtDate(m))}: ${sk.per[m] || 0} activities">${ICON.flame}</span>`).join('');
      return `<div class="section"><h3>Streak</h3><div class="card me-streak">
        <div class="me-stk-top"><span class="me-stk-ic${sk.weeks ? ' lit' : ''}">${ICON.flame}</span>
          <div><b>${sk.weeks} ${sk.weeks === 1 ? 'week' : 'weeks'}</b><small>${sk.count} ${sk.count === 1 ? 'activity' : 'activities'} in this streak${sk.weeks && !sk.thisWeek ? ' · train this week to keep it' : ''}</small></div></div>
        <div class="stk-row">${row}</div><div class="muted small" style="margin-top:6px">Last 12 weeks: a lit flame is a week with at least one workout.</div></div></div>`;
    }, 'the streak');
    html += safe(() => {
      const lg = logWeeksHTML(acts, 4);
      return `<div class="section"><h3><span>Training log</span><a class="h-link" href="#me/log">Full log ›</a></h3><div class="card lg-card">${lg.html || '<div class="muted">No activities yet.</div>'}</div></div>`;
    }, 'the training log');
    html += safe(() => meFitnessCardHTML(arr(d.well)), 'your fitness');
    html += safe(() => meFtpCardHTML(acts), 'your FTP');
    html += safe(() => mePowerCardHTML(), 'your power curve');
    html += safe(() => meZonesCardHTML(acts), 'your zones');
    return html;
  }

  function agoText(at) {
    const m = Math.round((Date.now() - at) / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
  }

  // Strava's weekly graph: last 12 weeks, one dot per week; tap a week to see its totals
  function meWeekCardHTML(acts) {
    const mon0 = mondayOf(parseDate(today()));
    const weeks = Array.from({ length: 12 }, (_, i) => iso(addDays(mon0, -7 * (11 - i))));
    const period = acts.filter((a) => a.ds >= weeks[0]);
    const filters = meFiltersHTML(period);
    const M = ME_METRICS[meMetric()];
    const list = meBySport(period, state.me.sport);
    if (!weeks.includes(state.sel.mew)) state.sel.mew = weeks[11];
    const sel = state.sel.mew;
    const pts = weeks.map((m, i) => ({ key: m, v: sumOf(list.filter((a) => a.ds >= m && a.ds <= weekEnd(m)), M.get), sel: m === sel, now: i === 11 }));
    const wk = list.filter((a) => a.ds >= sel && a.ds <= weekEnd(sel));
    const title = sel === weeks[11] ? 'This week' : `Week of ${fmtDate(sel, { day: 'numeric', month: 'short' })}`;
    return `<div class="section" style="margin-top:0"><h3><span>Weekly training</span><a class="h-link" href="#me/history">History ›</a></h3>
      ${filters}
      <div class="card me-card"><div class="me-ttl">${esc(title)} · ${wk.length} ${wk.length === 1 ? 'activity' : 'activities'}</div>${meTotalsHTML(wk)}
        ${chartSVG(pts, { id: 'mew', type: 'line', dots: true, fmt: M.short, key: 'mew', href: (p) => '#me/history-' + p.key, label: 'Last 12 weeks',
          labels: [[0, fmtDate(weeks[0], { day: 'numeric', month: 'short' }).toUpperCase()], [11, 'THIS WEEK']] })}
        <div class="muted small" style="margin-top:6px">Tap or slide along the graph to see a week; tap it again to open that week.</div></div></div>`;
  }

  // One set of period filters for every graph (history, fitness, FTP, power curve, zones)
  const RANGES = [['1w', '1 week', 7], ['1m', '1 month', 30], ['3m', '3 months', 91], ['6m', '6 months', 182], ['1y', '1 year', 365], ['2y', '2 years', 730], ['all', 'All time', 0]];
  const rangeOf = (k, def) => RANGES.find((x) => x[0] === k) || RANGES.find((x) => x[0] === def);
  const rangeBtns = (R, field) => `<div class="me-ranges">${RANGES.map(([k, l]) => `<button type="button" class="${k === R[0] ? 'on' : ''}" data-action="me-rng" data-field="${field}" data-r="${k}">${esc(l)}</button>`).join('')}</div>`;
  const HIST_UNIT = { '1w': 'day', '1m': 'day', '3m': 'week', '6m': 'week', '1y': 'week', '2y': 'month', all: 'month' };

  // The big training graph: any period from 1 week to 10 years, per day, week or month
  // With wk (a Monday): just that week, one bar per day
  function meHistoryHTML(acts, wk) {
    const R = wk ? ['wk', `week of ${fmtDate(wk, { day: 'numeric', month: 'short' })}`, 7, 'day']
      : rangeOf(state.me.range, '3m');
    const rLabel = R[1], unit = wk ? 'day' : HIST_UNIT[R[0]];
    const days = R[2] || Math.max(7, daysBetween(parseDate(acts.length ? acts[0].ds : today()), parseDate(today())) + 1);
    const t = wk ? weekEnd(wk) : today(), start = iso(addDays(parseDate(t), -(days - 1)));
    const period = acts.filter((a) => a.ds >= start && a.ds <= t);
    const filters = meFiltersHTML(period);
    const M = ME_METRICS[meMetric()];
    const list = meBySport(period, state.me.sport);
    const keyOf = (ds) => (unit === 'day' ? ds : unit === 'week' ? iso(mondayOf(parseDate(ds))) : ds.slice(0, 8) + '01');
    const keys = [];
    for (let d = parseDate(start); iso(d) <= t; d = addDays(d, 1)) { const k = keyOf(iso(d)); if (keys[keys.length - 1] !== k) keys.push(k); }
    if (!keys.includes(state.sel.hist)) state.sel.hist = (wk && keys.find((k) => list.some((a) => a.ds === k))) || keys[keys.length - 1];
    const sums = {};
    list.forEach((a) => { const k = keyOf(a.ds); sums[k] = (sums[k] || 0) + (M.get(a) || 0); });
    const label = (k) => (unit === 'month' ? monthYr(k) : fmtDate(k, { day: 'numeric', month: 'short' }));
    const href = (p) => (unit === 'day' ? '#day/' + p.key : '#me/log-' + iso(mondayOf(parseDate(p.key))));
    const pts = keys.map((k) => ({ key: k, v: sums[k] || 0, sel: k === state.sel.hist }));
    const n = keys.length;
    // compared with the period just before
    const pStart = iso(addDays(parseDate(start), -days)), pEnd = iso(addDays(parseDate(start), -1));
    const prev = sumOf(meBySport(acts, state.me.sport).filter((a) => a.ds >= pStart && a.ds <= pEnd), M.get);
    const cur = sumOf(list, M.get);
    const change = prev > 0 ? `${signed(((cur - prev) / prev) * 100)}% ${M.label.toLowerCase()} vs the ${wk ? 'week' : rLabel} before` : '';
    const sk = state.sel.hist;
    const inSel = list.filter((a) => keyOf(a.ds) === sk);
    const selTitle = unit === 'day' ? fmtLong(sk) : unit === 'week' ? `Week of ${fmtDate(sk, { day: 'numeric', month: 'short' })}` : parseDate(sk).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    const bySport = SPORT_ORDER.filter((k) => inSel.some((a) => a.sport === k)).map((k) => `<div class="cs-row" style="--tcol:${sportInfo(k).color}"><span class="cs-ic">${sportInfo(k).icon}</span><span class="cs-t">${esc(sportInfo(k).label)}</span><span class="muted small">${esc(M.fmt(sumOf(inSel.filter((a) => a.sport === k), M.get)))}</span></div>`).join('');
    return `${rangeBtns(R, 'range')}
      ${filters}
      <div class="card me-card"><div class="me-ttl">${wk ? 'Week of ' + esc(fmtDate(wk, { day: 'numeric', month: 'short', year: 'numeric' })) : R[2] ? 'Last ' + esc(rLabel) : 'All time'} · ${list.length} ${list.length === 1 ? 'activity' : 'activities'}</div>${meTotalsHTML(list)}
        ${change ? `<div class="me-change ${cur >= prev ? 'up' : 'down'}">${esc(change)}</div>` : ''}
        ${chartSVG(pts, { id: 'mhist', type: 'bar', h: 190, grid: true, tick: M.short, tickBase: meMetric() === 'time' ? 3600 : 1, tip: (p) => `${label(p.key)} · ${M.fmt(p.v)}`, key: 'hist', href, label: `${M.label} per ${unit}`,
          labels: [[0, label(keys[0])], [Math.floor((n - 1) / 2), label(keys[Math.floor((n - 1) / 2)])], [n - 1, label(keys[n - 1])]] })}
        <div class="muted small" style="margin-top:6px">One bar per ${unit}. Tap or slide along the graph to see one; tap it again to open it.</div></div>
      <div class="cal-sum"><div class="cs-head"><b>${esc(selTitle)}</b>${inSel.length ? `<a class="btn small" href="${esc(href({ key: sk }))}">Open ›</a>` : ''}</div>
        <div class="muted small" style="margin-bottom:6px">${esc(M.fmt(sumOf(inSel, M.get)))} · ${inSel.length} ${inSel.length === 1 ? 'activity' : 'activities'}</div>
        ${unit === 'month' ? bySport : inSel.slice(-8).reverse().map(meActLine).join('')}</div>
      ${wk ? `<div class="section"><h3>Every activity this week</h3><div class="card">${keys.filter((k) => list.some((a) => a.ds === k)).map((k) =>
        `<div class="cs-head" style="margin-top:6px"><b>${esc(fmtLong(k))}</b><a class="btn small" href="#day/${k}">Open ›</a></div>${list.filter((a) => a.ds === k).map(meActLine).join('')}`).join('')
        || '<div class="muted">No activities this week.</div>'}</div></div>` : ''}`;
  }

  // Fitness, fatigue and form (Intervals.icu's CTL, ATL and TSB). Preview: last 3 months with both lines.
  function meFitnessCardHTML(well) {
    const t = today();
    const now = fitAt(well, t);
    if (!now) return '';
    const from = iso(addDays(parseDate(t), -91));
    const then = fitAt(well, from) || well[0];
    const diff = now[1] - then[1];
    const list = well.filter((w) => w[0] >= from && w[0] <= t);
    const pts = list.map((w) => ({ key: w[0], v: w[1], v2: isNum(w[2]) ? w[2] : null }));
    const form = isNum(now[2]) ? now[1] - now[2] : null;
    const n = pts.length;
    const lbl = (i) => fmtDate(list[i][0], { day: 'numeric', month: 'short' });
    return `<div class="section"><h3><span>Fitness</span><a class="h-link" href="#me/fitness">More ›</a></h3><a class="card tap me-card me-fit" href="#me/fitness">
      <div class="me-fit-top"><div><b class="me-big">${esc(num(now[1], 0))}</b><span class="muted small">fitness today</span></div>
        <div class="me-change ${diff >= 0 ? 'up' : 'down'}">${esc(signed(diff))}${then[1] > 0 ? ` (${esc(signed((diff / then[1]) * 100))}%)` : ''}<small>last 3 months</small></div></div>
      <div class="me-stats">${meStat(num(now[1], 0), 'Fitness')}${meStat(isNum(now[2]) ? num(now[2], 0) : '–', 'Fatigue')}${meStat(form != null ? signed(form) : '–', form != null ? `Form · ${formZone(form)[3]}` : 'Form')}</div>
      ${chartSVG(pts, { id: 'mfitp', type: 'line', h: 150, fmt: (v) => num(v, 0), labels: [[0, lbl(0)], [n - 1, lbl(n - 1)]] })}
      <div class="me-key"><span><i class="k-fit"></i>Fitness</span><span><i class="k-set"></i>Fatigue</span></div></a></div>`;
  }
  // Intervals.icu's form zones
  const FORM_ZONES = [[20, 999, 'rgba(250, 204, 21, 0.10)', 'Transition'], [5, 20, 'rgba(59, 130, 246, 0.13)', 'Fresh'], [-10, 5, 'rgba(148, 163, 184, 0.10)', 'Grey zone'],
    [-30, -10, 'rgba(34, 197, 94, 0.14)', 'Optimal'], [-999, -30, 'rgba(239, 68, 68, 0.14)', 'High risk']];
  const formZone = (f) => FORM_ZONES.find(([a, b]) => f >= a && f < b) || FORM_ZONES[2];

  // FTP over time: the line is Intervals.icu's eFTP (estimated from your rides), the dashed line the FTP you set,
  // big dots are real FTP tests (a ride named FTP / ramp test, or the plan's benchmark test on that day)
  // "Jun '25" (a short month with the year, so it can't be read as a day)
  const monthYr = (k) => `${fmtDate(k, { month: 'short' })} '${k.slice(2, 4)}`;
  function isFtpTest(a) {
    if (/\bftp\b|ramp test|benchmark|\btest\b/i.test(a.name || '')) return true;
    return !!state.plan && a.sport === 'Ride' && workoutsOn(a.ds).some((x) => txt(x.w.type) === 'benchmark_test');
  }
  // FTP preview: the last 3 months with eFTP, FTP set and test dots
  function meFtpCardHTML(acts) {
    const days = ftpDays(acts, iso(addDays(parseDate(today()), -90)));
    if (!days.length) return '';
    const first = days[0], last = days[days.length - 1], diff = last.eftp - first.eftp;
    const pts = days.map((d) => ({ key: d.ds, v: d.eftp, v2: isNum(d.ftp) ? d.ftp : null, test: d.test, testLabel: `${Math.round(d.eftp)} W` }));
    const vals = pts.flatMap((p) => [p.v, p.v2]).filter(isNum);
    const n = pts.length;
    const lbl = (i) => fmtDate(pts[i].key, { day: 'numeric', month: 'short' });
    return `<div class="section"><h3><span>FTP</span><a class="h-link" href="#me/ftp">More ›</a></h3><a class="card tap me-card me-fit" href="#me/ftp">
      <div class="me-fit-top"><div><b class="me-big">${esc(num(last.eftp, 0))}<small> W</small></b><span class="muted small">eFTP now${isNum(last.ftp) ? ` · set FTP ${esc(num(last.ftp, 0))} W` : ''}</span></div>
        <div class="me-change ${diff >= 0 ? 'up' : 'down'}">${esc(signed(diff))} W<small>last 3 months</small></div></div>
      ${chartSVG(pts, { id: 'mftpp', type: 'line', h: 150, min: Math.max(0, Math.floor((Math.min(...vals) * 0.9) / 10) * 10), fmt: (v) => `${Math.round(v)} W`,
        xs: pts.map((p) => daysBetween(parseDate(pts[0].key), parseDate(p.key))), labels: [[0, lbl(0)], [n - 1, lbl(n - 1)]] })}
      <div class="me-key"><span><i class="k-fit"></i>eFTP</span><span><i class="k-set"></i>FTP set</span><span><i class="k-test"></i>FTP test</span></div></a></div>`;
  }

  // One point per day with a ride since `start`: the eFTP after that day's last ride
  function ftpDays(acts, start) {
    const byDay = {};
    acts.filter((a) => a.sport === 'Ride' && isNum(a.eftp) && !a.manual && a.ds >= start)
      .forEach((a) => { byDay[a.ds] = { ds: a.ds, eftp: a.eftp, ftp: a.ftp, test: (byDay[a.ds] && byDay[a.ds].test) || isFtpTest(a) }; });
    return Object.values(byDay).sort((a, b) => (a.ds < b.ds ? -1 : 1));
  }

  // Full screen FTP (#me/ftp): any period, tap or slide to a day
  function meFtpHTML(acts) {
    const R = rangeOf(state.me.ftprange, '1y');
    const t = today();
    const days = ftpDays(acts, R[2] ? rangeStart(R) : '');
    const ranges = rangeBtns(R, 'ftprange');
    if (!days.length) return ranges + '<div class="card muted">No rides with an eFTP in this period.</div>';
    if (!days.some((d) => d.ds === state.sel.ftp)) state.sel.ftp = days[days.length - 1].ds;
    const pts = days.map((d) => ({ key: d.ds, v: d.eftp, v2: isNum(d.ftp) ? d.ftp : null, test: d.test, testLabel: `${Math.round(d.eftp)} W`, sel: d.ds === state.sel.ftp }));
    const vals = pts.flatMap((p) => [p.v, p.v2]).filter(isNum);
    const min = Math.max(0, Math.floor((Math.min(...vals) * 0.9) / 10) * 10);
    const si = days.findIndex((d) => d.ds === state.sel.ftp), sel = days[si], prev = days[si - 1];
    const first = days[0], last = days[days.length - 1], diff = last.eftp - first.eftp;
    const best = days.reduce((b, d) => (d.eftp > b.eftp ? d : b)), low = days.reduce((b, d) => (d.eftp < b.eftp ? d : b));
    const tests = days.filter((d) => d.test);
    const n = pts.length;
    // x follows the calendar, so a month without rides shows as a gap, not squeezed away
    const x0 = R[2] ? rangeStart(R) : days[0].ds, span = daysBetween(parseDate(x0), parseDate(t));
    const xs = pts.map((p) => daysBetween(parseDate(x0), parseDate(p.key)));
    const lblDay = (ds) => (R[2] && R[2] <= 182 ? fmtDate(ds, { day: 'numeric', month: 'short' }) : monthYr(ds));
    // labels at evenly spread dates: the ride closest to each
    const labels = [...new Set([0, 0.25, 0.5, 0.75, 1].map((f) => xs.reduce((bi, x, i) => (Math.abs(x - f * span) < Math.abs(xs[bi] - f * span) ? i : bi), 0)))].map((i) => [i, lblDay(pts[i].key)]);
    const short = (d) => fmtDate(d.ds, { day: 'numeric', month: 'short', year: 'numeric' });
    const rides = acts.filter((a) => a.ds === sel.ds && a.sport === 'Ride');
    const period = R[0] === 'all' ? 'all time' : 'the last ' + R[1].toLowerCase();
    return `${ranges}
      <div class="card me-card me-fit">
        <div class="me-fit-top"><div><b class="me-big">${esc(num(last.eftp, 0))}<small> W</small></b><span class="muted small">eFTP now${isNum(last.ftp) ? ` · set FTP ${esc(num(last.ftp, 0))} W` : ''}</span></div>
          <div class="me-change ${diff >= 0 ? 'up' : 'down'}">${esc(signed(diff))} W${first.eftp > 0 ? ` (${esc(signed((diff / first.eftp) * 100))}%)` : ''}<small>in ${esc(R[0] === 'all' ? 'all time' : R[1])}</small></div></div>
        ${chartSVG(pts, { id: 'mftp', type: 'line', h: 230, min, grid: true, xs, key: 'ftp', href: (p) => '#day/' + p.key, label: 'FTP over time', labels,
          tip: (p) => `${fmtDate(p.key, { day: 'numeric', month: 'short' })} · eFTP ${Math.round(p.v)} W${isNum(p.v2) ? ` · set ${Math.round(p.v2)} W` : ''}` })}
        <div class="me-key"><span><i class="k-fit"></i>eFTP (Intervals.icu)</span><span><i class="k-set"></i>FTP set</span><span><i class="k-test"></i>FTP test</span></div>
        ${tests.length ? '' : '<div class="muted small" style="margin-top:6px">No FTP test yet: your first one (13 Oct) will show as a big dot.</div>'}
        <div class="muted small" style="margin-top:6px">Tap or slide along the graph to see a day; tap it again to open it.</div>
      </div>
      <div class="cal-sum"><div class="cs-head"><b>${esc(fmtLong(sel.ds))}</b><a class="btn small" href="#day/${sel.ds}">Open ›</a></div>
        <div class="me-stats">${meStat(`${num(sel.eftp, 0)} W`, 'eFTP')}${meStat(isNum(sel.ftp) ? `${num(sel.ftp, 0)} W` : '–', 'FTP set')}${meStat(prev ? `${signed(sel.eftp - prev.eftp)} W` : '–', 'vs ride before')}</div>
        ${sel.test ? '<div class="muted small" style="margin-top:6px">This was an FTP test.</div>' : ''}
        ${rides.map(meActLine).join('')}</div>
      <div class="section"><h3>In ${esc(period)}</h3><div class="card">
        <div class="me-stats">${meStat(`${num(best.eftp, 0)} W`, `Highest · ${short(best)}`)}${meStat(`${num(low.eftp, 0)} W`, `Lowest · ${short(low)}`)}${meStat(String(n), n === 1 ? 'Ride day' : 'Ride days')}</div>
        ${tests.map((d) => `<div class="small" style="margin-top:8px"><b>FTP test</b> · ${esc(short(d))} · ${esc(num(d.eftp, 0))} W</div>`).join('')}
      </div></div>
      <details class="card explain" style="margin-top:12px"><summary>What is eFTP?</summary>
        <p><b>eFTP</b> is the FTP Intervals.icu estimates from your hardest efforts, without a test. It moves up when you ride hard and slowly drifts down when you don't. <b>FTP set</b> is the number your zones use (the dashed line). The <b>big dots</b> are real FTP tests: the most reliable points on the graph.</p></details>`;
  }

  // Full screen: fitness + fatigue, form with its zones, daily load; slide along any of the three
  function meFitnessHTML(acts, well) {
    if (!well.length) return '<div class="card muted">No fitness numbers from Intervals.icu yet.</div>';
    const R = rangeOf(state.me.frange, '3m');
    const t = today();
    const start = R[2] ? rangeStart(R) : well[0][0];
    const list = well.filter((w) => w[0] >= start && w[0] <= t);
    if (!list.length) return rangeBtns(R, 'frange') + '<div class="card muted">No fitness numbers in this period.</div>';
    const byDay = {};
    well.forEach((w) => { byDay[w[0]] = w; });
    const ramp = (ds) => { const a = byDay[ds], b = byDay[iso(addDays(parseDate(ds), -7))]; return a && b ? a[1] - b[1] : null; };
    const load = {};
    acts.forEach((a) => { if (isNum(a.load)) load[a.ds] = (load[a.ds] || 0) + a.load; });
    const form = (w) => (isNum(w[2]) ? w[1] - w[2] : null);
    if (!list.some((w) => w[0] === state.sel.fit)) state.sel.fit = list[list.length - 1][0];
    const sk = state.sel.fit, sel = byDay[sk];
    const short = R[2] && R[2] <= 30;
    const n = list.length;
    const lbl = (i) => (R[2] && R[2] <= 182 ? fmtDate(list[i][0], { day: 'numeric', month: 'short' }) : monthYr(list[i][0]));
    const labels = xLabels(n, short ? 3 : 4, lbl);
    const href = (p) => '#day/' + p.key;
    const pts = list.map((w) => ({ key: w[0], v: w[1], v2: isNum(w[2]) ? w[2] : null, sel: w[0] === sk,
      marks: short ? [...new Set(acts.filter((a) => a.ds === w[0]).map((a) => sportInfo(a.sport).color))] : null }));
    const fpts = list.map((w) => ({ key: w[0], v: form(w), sel: w[0] === sk }));
    const lpts = list.map((w) => ({ key: w[0], v: Math.round(load[w[0]] || 0), sel: w[0] === sk }));
    const fv = fpts.map((p) => p.v).filter(isNum);
    const first = list[0], last = list[n - 1], diff = last[1] - first[1];
    const fNow = form(last), fSel = form(sel), rNow = ramp(last[0]), rSel = ramp(sk);
    const day = acts.filter((a) => a.ds === sk);
    return `${rangeBtns(R, 'frange')}
      <div class="card me-card me-fit">
        <div class="me-fit-top"><div><b class="me-big">${esc(num(last[1], 0))}</b><span class="muted small">fitness today</span></div>
          <div class="me-change ${diff >= 0 ? 'up' : 'down'}">${esc(signed(diff))}${first[1] > 0 ? ` (${esc(signed((diff / first[1]) * 100))}%)` : ''}<small>in ${esc(R[0] === 'all' ? 'all time' : R[1])}</small></div></div>
        <div class="me-stats">${meStat(isNum(last[2]) ? num(last[2], 0) : '–', 'Fatigue')}${meStat(fNow != null ? signed(fNow) : '–', fNow != null ? `Form · ${formZone(fNow)[3]}` : 'Form')}${meStat(rNow != null ? signed(rNow) : '–', 'Ramp (7 days)')}</div>
        <div class="me-sub">Fitness and fatigue</div>
        ${chartSVG(pts, { id: 'mfit', type: 'line', h: 210, grid: true, key: 'fit', href, label: 'Fitness and fatigue', labels,
          tip: (p) => `${fmtDate(p.key, { day: 'numeric', month: 'short' })} · fitness ${num(p.v, 0)}${isNum(p.v2) ? ` · fatigue ${num(p.v2, 0)}` : ''}` })}
        <div class="me-key"><span><i class="k-fit"></i>Fitness</span><span><i class="k-set"></i>Fatigue</span>${short ? '<span><i class="k-dot"></i>A workout</span>' : ''}</div>
        <div class="me-sub">Form</div>
        ${chartSVG(fpts, { id: 'mform', type: 'line', h: 150, grid: true, area: false, min: Math.min(-40, ...fv) - 5, max: Math.max(25, ...fv) + 5, bands: FORM_ZONES,
          key: 'fit', href, label: 'Form', labels, tip: (p) => (isNum(p.v) ? `form ${signed(p.v)} · ${formZone(p.v)[3]}` : 'no form') })}
        <div class="me-sub">Load per day</div>
        ${chartSVG(lpts, { id: 'mload', type: 'bar', h: 90, grid: true, key: 'fit', href, label: 'Load per day', labels })}
        <div class="muted small" style="margin-top:6px">Tap or slide along any graph to see a day; tap it again to open it.</div>
      </div>
      <div class="cal-sum"><div class="cs-head"><b>${esc(fmtLong(sk))}</b><a class="btn small" href="#day/${sk}">Open ›</a></div>
        <div class="me-stats">${meStat(num(sel[1], 0), 'Fitness')}${meStat(isNum(sel[2]) ? num(sel[2], 0) : '–', 'Fatigue')}${meStat(fSel != null ? signed(fSel) : '–', 'Form')}</div>
        <div class="me-stats" style="margin-top:6px">${meStat(fSel != null ? formZone(fSel)[3] : '–', 'Form zone')}${meStat(rSel != null ? signed(rSel) : '–', 'Ramp (7 days)')}${meStat(String(Math.round(load[sk] || 0)), 'Load this day')}</div>
        ${day.map(meActLine).join('') || '<div class="muted small" style="margin-top:6px">No workout this day.</div>'}</div>
      <details class="card explain" style="margin-top:12px"><summary>What do these numbers mean?</summary>
        <p><b>Load</b> is how hard one workout was (an hour all-out ≈ 100). <b>Fitness</b> is your load averaged over about 6 weeks: it rises slowly when you train regularly. <b>Fatigue</b> is the same over about 1 week: it reacts fast. <b>Form</b> = fitness − fatigue. <b>Ramp</b> is how much fitness changed in the last 7 days; 3–5 a week is a healthy build.</p>
        <p><b>Form zones</b>: <b>High risk</b> (below −30) you're overreaching, rest. <b>Optimal</b> (−30 to −10) you're building fitness. <b>Grey zone</b> (−10 to +5) normal training, not much effect. <b>Fresh</b> (+5 to +20) rested, good for a race or test. <b>Transition</b> (above +20) you're losing fitness from too little training.</p></details>`;
  }

  // "5 s", "1 min", "2:30 min", "1 h 30 min"
  const durTxt = (s) => (s < 60 ? `${s} s` : s < 3600 ? (s % 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} min` : `${s / 60} min`)
    : `${Math.floor(s / 3600)} h${s % 3600 ? ` ${Math.round((s % 3600) / 60)} min` : ''}`);
  const rangeStart = (R) => iso(addDays(parseDate(today()), -((R[2] || 3653) - 1)));

  /* Power curve: your best power for every duration, straight from Intervals.icu (rides only) */
  const pcs = { data: {}, loading: {}, error: '', failedAt: 0 };
  const PC_SECS = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 420, 600, 900, 1200, 1800, 2400, 3600, 5400, 7200, 10800, 14400, 18000, 21600];
  const PC_MODELS = { MS_2P: '2-parameter', MORTON_3P: 'Morton 3-parameter', FFT_CURVES: 'FastFitness.Tips', ECP: 'Extended CP' };
  // The power curve of one month ('2026-10'), plus your 10-year best to compare; redraws when it arrives
  function icuCurve(m) {
    const t = today(), c = pcs.data[m];
    const stale = !c || c.day !== t || Date.now() - c.at > 30 * 60 * 1000;
    if (stale && !pcs.loading[m] && !(Date.now() - pcs.failedAt < 60 * 1000)) {
      pcs.loading[m] = true;
      const [y, mo] = m.split('-').map(Number);
      const end = iso(new Date(y, mo, 0));
      const best = `r.${rangeStart(['all', '', 0])}.${t}`;
      icuGet(`/power-curves?type=Ride&curves=r.${m}-01.${end < t ? end : t},${best}`).then((d) => {
        const list = arr(obj(d).list).map(obj);
        pcs.data[m] = { at: Date.now(), day: t, cur: list[0] || {}, best: list[1] || null, acts: obj(obj(d).activities) };
        pcs.error = '';
      }).catch((e) => { pcs.error = e.message || 'Could not reach Intervals.icu'; pcs.failedAt = Date.now(); })
        .finally(() => { pcs.loading[m] = false; if (state.route === 'me') render(true); });
    }
    return c;
  }
  // The months you can pick: this month and the ones before it (6 at first, "More" adds 6)
  const thisMonth = () => today().slice(0, 7);
  function pcMonths() {
    const d = parseDate(today());
    return Array.from({ length: state.me.pcMonths || 6 }, (_, i) => iso(new Date(d.getFullYear(), d.getMonth() - i, 1)).slice(0, 7));
  }
  const monthName = (m) => (m === thisMonth() ? 'This month' : parseDate(m + '-01').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }));
  const pcMonth = () => (/^\d{4}-\d{2}$/.test(state.me.pcmonth || '') ? state.me.pcmonth : thisMonth());
  // The points of a curve in watts or W/kg: at our standard durations, or (all) every duration Intervals.icu has
  function pcPoints(curve, wkg, fromSec, all) {
    const secs = arr(curve.secs), vals = arr(wkg ? curve.watts_per_kg : curve.values);
    return secs.map((s, i) => ({ s, v: vals[i], i })).filter((p) => isNum(p.v) && p.s >= (fromSec || 0) && (all || PC_SECS.includes(p.s)));
  }

  function mePowerCardHTML() {
    const m = pcMonth(), c = icuCurve(m);
    const head = `<h3><span>Power curve</span><a class="h-link" href="#me/power">More ›</a></h3>`;
    if (!c) return `<div class="section">${head}<div class="card muted">${pcs.error ? `Intervals.icu: ${esc(pcs.error)}` : 'Loading your power curve…'}</div></div>`;
    const pts0 = pcPoints(c.cur, false);
    const at = (s) => (pts0.find((p) => p.s === s) || {}).v;
    const best = c.best ? pcPoints(c.best, false) : [];
    const bestAt = (s) => (best.find((b) => b.s === s) || {}).v;
    const n = pts0.length;
    const pts = pts0.map((p) => ({ key: String(p.s), v: p.v, v2: bestAt(p.s) ?? null }));
    const mid = pts0.findIndex((p) => p.s === 1200);
    const labels = n ? [[0, durTxt(pts0[0].s)], [n - 1, durTxt(pts0[n - 1].s)]].concat(mid > 0 && mid < n - 2 ? [[mid, durTxt(1200)]] : []) : [];
    return `<div class="section">${head}<a class="card tap me-card" href="#me/power">
      <div class="me-ttl">Best power · ${esc(monthName(m))}</div>
      <div class="me-stats">${[[5, '5 s'], [60, '1 min'], [300, '5 min'], [1200, '20 min']].map(([s, l]) => meStat(isNum(at(s)) ? `${Math.round(at(s))} W` : '–', `Best ${l}`)).join('')}</div>
      ${n ? chartSVG(pts, { id: 'mpcp', type: 'line', h: 160, min: 0, fmt: (v) => `${Math.round(v)} W`, labels })
        : '<div class="muted small" style="margin-top:8px">No rides with power this month yet.</div>'}
      <div class="me-key"><span><i class="k-fit"></i>${esc(monthName(m))}</span>${c.best ? '<span><i class="k-set"></i>Best in 10 years</span>' : ''}</div></a></div>`;
  }

  function mePowerHTML() {
    const m = pcMonth(), c = icuCurve(m);
    const months = pcMonths();
    const mp = obj(c && c.cur.mapPlot);
    const hasMap = isNum(mp.poIntercept) && isNum(mp.poSlope);
    const mode = state.me.pcmode === 'map' && !hasMap ? 'w' : state.me.pcmode || 'w';
    const modes = [['w', 'Watts'], ['wkg', 'W/kg']].concat(hasMap ? [['map', 'MAP']] : []);
    const top = `<div class="me-ranges">${months.map((k) => `<button type="button" class="${k === m ? 'on' : ''}" data-action="me-pcmonth" data-m="${k}">${esc(k === thisMonth() ? 'This month' : monthYr(k + '-01'))}</button>`).join('')}<button type="button" data-action="me-pcmore">More…</button></div>`
      + `<div class="me-seg">${modes.map(([k, l]) => `<button type="button" class="${k === mode ? 'on' : ''}" data-action="me-pcmode" data-m="${k}">${l}</button>`).join('')}</div>`;
    if (!c) return top + `<div class="card ${pcs.error ? 'warn' : 'muted'}">${pcs.error ? `Intervals.icu: ${esc(pcs.error)}` : 'Loading your power curve from Intervals.icu…'}</div>`;
    const cur = c.cur, wkg = mode !== 'w';
    const fit = (s) => mp.poIntercept + mp.poSlope * Math.log(s); // Intervals.icu's MAP line: W/kg = a + b·ln(seconds)
    const pts0 = pcPoints(cur, wkg, mode === 'map' ? arr(cur.secs)[mp.startIndex] : 0, true);
    if (!pts0.length) return top + `<div class="card muted">No rides with power in ${esc(monthName(m).toLowerCase())}.</div>`;
    const bestMap = {};
    if (c.best) pcPoints(c.best, wkg, 0, true).forEach((b) => { bestMap[b.s] = b.v; });
    if (!pts0.some((p) => String(p.s) === state.sel.pc)) state.sel.pc = String((pts0.find((p) => p.s === 300) || pts0[pts0.length - 1]).s);
    const pts = pts0.map((p) => ({ key: String(p.s), v: p.v, v2: mode === 'map' ? fit(p.s) : bestMap[p.s] ?? null, sel: String(p.s) === state.sel.pc }));
    const fmt = (v) => (wkg ? `${num(v, 2)} W/kg` : `${Math.round(v)} W`);
    const sel = pts0.find((p) => String(p.s) === state.sel.pc);
    const ids = arr(wkg ? cur.wkg_activity_id : cur.activity_id);
    const actOf = (i) => obj(c.acts[ids[i]]);
    const dayOf = (i) => normDate(txt(actOf(i).start_date_local).slice(0, 10));
    const a = actOf(sel.i), ds = dayOf(sel.i);
    const b = bestMap[sel.s];
    const n = pts.length;
    // x on a log scale of seconds, like Intervals.icu; labels at familiar durations
    const xs = pts0.map((p) => Math.log(p.s));
    const marks = [1, 5, 30, 60, 300, 1200, 3600, 3 * 3600, 6 * 3600].map((s) => pts0.findIndex((p) => p.s === s)).filter((i) => i >= 0);
    const lastLog = xs[n - 1], firstLog = xs[0];
    const labels = marks.filter((i) => (xs[i] - firstLog) / (lastLog - firstLog || 1) < 0.92).map((i) => [i, durTxt(pts0[i].s)]).concat([[n - 1, durTxt(pts0[n - 1].s)]]);
    const models = arr(cur.powerModels).map(obj).filter((x) => isNum(x.criticalPower));
    const kg = isNum(cur.weight) && cur.weight > 0 ? cur.weight : null;
    const other = wkg ? (kg ? `${Math.round(sel.v * kg)} W` : '–') : (kg ? `${num(sel.v / kg, 2)} W/kg` : '–');
    const peak = pts0.reduce((p, q) => (q.v > p.v ? q : p));
    return `${top}
      <div class="card me-card">
        <div class="me-ttl">Best power · ${esc(monthName(m))}${kg ? ` · ${esc(num(kg, 1))} kg` : ''}</div>
        <div class="me-stats">${[[5, '5 s'], [60, '1 min'], [300, '5 min'], [1200, '20 min']].map(([s, l]) => { const q = pts0.find((p) => p.s === s); return meStat(q ? fmt(q.v) : '–', `Best ${l}`); }).join('')}</div>
        ${chartSVG(pts, { id: 'mpc', type: 'line', h: 250, min: 0, grid: true, xs, key: 'pc', label: 'Power curve', labels,
          tick: (v) => (wkg ? String(Math.round(v * 10) / 10) : String(Math.round(v))),
          href: (p) => { const q = pts0.find((x) => String(x.s) === p.key); const d = q && dayOf(q.i); return d ? '#day/' + d : ''; },
          tip: (p) => `${durTxt(+p.key)} · ${fmt(p.v)}${isNum(p.v2) && mode !== 'map' ? ` · best ${fmt(p.v2)}` : ''}` })}
        <div class="me-key"><span><i class="k-fit"></i>${esc(monthName(m))}</span>${mode === 'map' ? '<span><i class="k-set"></i>MAP line</span>' : c.best ? '<span><i class="k-set"></i>Best in 10 years</span>' : ''}</div>
        <div class="muted small" style="margin-top:6px">Tap or slide along the curve to see a duration; tap it again to open that ride.</div>
      </div>
      <div class="cal-sum"><div class="cs-head"><b>Best ${esc(durTxt(sel.s))}</b>${ds ? `<a class="btn small" href="#day/${ds}">Open ›</a>` : ''}</div>
        <div class="me-stats">${meStat(fmt(sel.v), wkg ? 'W/kg' : 'Power')}${meStat(other, wkg ? 'Power' : 'W/kg')}${isNum(b) ? meStat(`${Math.round((sel.v / b) * 100)}%`, `of 10-year best (${fmt(b)})`) : ''}</div>
        ${a.name ? `<div class="muted small" style="margin-top:6px">${esc(a.name)}${ds ? ` · ${esc(fmtLong(ds))}` : ''}</div>` : ''}</div>
      <div class="section"><h3>This period</h3><div class="card">
        <div class="me-stats">${meStat(fmt(peak.v), `Highest · ${durTxt(peak.s)}`)}${isNum(cur.moving_time) ? meStat(fmtDur(cur.moving_time) || '–', 'Ride time') : ''}${isNum(cur.training_load) ? meStat(String(Math.round(cur.training_load)), 'Load') : ''}</div>
      </div></div>
      ${mode === 'map' ? `<div class="section"><h3>MAP line</h3><div class="card">
        <div class="me-stats">${meStat(num(Math.abs(mp.poSlope * Math.LN2), 2), 'W/kg lost per doubling of time')}${meStat(num(mp.poR2, 2), 'R² (fit quality)')}${mp.map > 0 ? meStat(`${Math.round(mp.mapWatts || 0)} W`, 'MAP') : ''}</div>
        <p class="muted small" style="margin:8px 0 0">The line is fitted through your best efforts from ${esc(durTxt(arr(cur.secs)[mp.poStartIndex] || 600))} to ${esc(durTxt(arr(cur.secs)[mp.poEndIndex] || 14400))}. The flatter it is, the better you hold power over long efforts.</p></div></div>` : ''}
      ${models.length ? `<div class="section"><h3>What your curve says</h3><div class="card">
        ${models.map((x) => `<div class="pm-row"><b>${esc(PC_MODELS[x.type] || x.type)}</b><span class="muted small">CP ${Math.round(x.criticalPower)} W${isNum(x.wPrime) ? ` · W′ ${num(x.wPrime / 1000, 1)} kJ` : ''}${isNum(x.pMax) ? ` · Pmax ${Math.round(x.pMax)} W` : ''}${isNum(x.ftp) ? ` · eFTP ${Math.round(x.ftp)} W` : ''}</span></div>`).join('')}
        ${isNum(cur.vo2max_5m) ? `<div class="me-stats" style="margin-top:8px">${meStat(num(cur.vo2max_5m, 1), 'VO2max estimate (from 5 min)')}</div>` : ''}</div></div>` : ''}
      <details class="card explain" style="margin-top:12px"><summary>What is the power curve?</summary>
        <p>For every duration (5 seconds, 1 minute, 20 minutes…) it shows the highest average power you held in this month. The time axis is stretched like on Intervals.icu, so short sprints and long rides both get room. <b>W/kg</b> divides by your weight, which is what matters on climbs. <b>CP</b> (critical power) is about the power you can hold for a long time, close to FTP. <b>W′</b> is your battery above CP. <b>Pmax</b> is your top sprint power. <b>MAP</b> shows W/kg against time with a fitted line: how quickly your power drops as efforts get longer.</p></details>`;
  }

  /* Time in zones (Intervals.icu "Totals"): heart rate, power and combined */
  const PZ_IDS = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6', 'Z7', 'SS'];
  const ZONE_COLORS = ['#9ca3af', '#3b82f6', '#22c55e', '#facc15', '#f97316', '#ef4444', '#a855f7'];
  const PZ_NAMES = ['Active Recovery', 'Endurance', 'Tempo', 'Threshold', 'VO2 Max', 'Anaerobic', 'Neuromuscular'];
  const HZ_NAMES = ['Recovery', 'Aerobic', 'Tempo', 'SubThreshold', 'SuperThreshold', 'Aerobic Capacity', 'Anaerobic'];
  const ZTABS = [['combined', 'Combined'], ['power', 'Power'], ['hr', 'Heart rate']];
  // Seconds per zone. Combined = power when the activity has it, else heart rate (Intervals.icu's own order).
  // shortcut: always 7 zones (Intervals.icu's default), upgrade if you ever set a different number of zones
  function zoneSums(list, tab) {
    const s = [0, 0, 0, 0, 0, 0, 0];
    let ss = 0, n = 0;
    list.forEach((a) => {
      const p = arr(a.pz).slice(0, 7).some((v) => v > 0) ? a.pz : null;
      const h = arr(a.hz).some((v) => v > 0) ? a.hz : null;
      const z = tab === 'power' ? p : tab === 'hr' ? h : p || h;
      if (!z) return;
      n++;
      for (let i = 0; i < 7; i++) s[i] += z[i] || 0;
      if (z === p) ss += p[7] || 0;
    });
    return { s, ss, n, total: s.reduce((t, v) => t + v, 0) };
  }
  const zStack = (s, total) => `<div class="tz-stack">${s.map((v, i) => (v > 0 ? `<i style="width:${((v / total) * 100).toFixed(2)}%;background:${ZONE_COLORS[i]}"></i>` : '')).join('')}</div>`;

  function meZonesCardHTML(acts) {
    const from = iso(addDays(parseDate(today()), -29));
    const z = zoneSums(acts.filter((a) => a.ds >= from && !a.manual), 'combined');
    if (!z.total) return '';
    const top = z.s.indexOf(Math.max(...z.s));
    return `<div class="section"><h3><span>Time in zones</span><a class="h-link" href="#me/zones">More ›</a></h3><a class="card tap me-card" href="#me/zones">
      <div class="me-ttl">Last 30 days · ${esc(fmtDur(z.total))} in zones</div>${zStack(z.s, z.total)}
      <div class="muted small" style="margin-top:6px">Most time in <b style="color:${ZONE_COLORS[top]}">Z${top + 1} ${esc(PZ_NAMES[top])}</b> (${Math.round((z.s[top] / z.total) * 100)}%)</div></a></div>`;
  }

  function meZonesHTML(acts) {
    const R = rangeOf(state.me.zrange, '1m');
    const tab = state.me.ztab || 'combined';
    const t = today(), start = R[2] ? rangeStart(R) : '';
    const z = zoneSums(acts.filter((a) => a.ds >= start && a.ds <= t && !a.manual), tab);
    const Z = obj(obj(hist.data).zones);
    const hr = tab === 'hr';
    const names = arr(hr ? Z.hNames : Z.pNames).length >= 7 ? arr(hr ? Z.hNames : Z.pNames) : hr ? HZ_NAMES : PZ_NAMES;
    const lim = tab === 'combined' ? [] : arr(hr ? Z.hLim : Z.pLim);
    const u = hr ? ' bpm' : '%';
    const span = (i) => (!isNum(lim[i]) ? '' : i === 0 ? `up to ${lim[0]}${u}` : !hr && i === 6 ? `${lim[5] + 1}%+` : `${lim[i - 1] + 1}–${lim[i]}${u}`);
    const max = Math.max(1, ...z.s);
    const row = (id, color, name, sub, secs, pct) => `<div class="tz-row" style="--zc:${color}"><span class="tz-id">${id}</span><span class="tz-name">${esc(name)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>
      <span class="tz-bar"><i style="width:${((secs / max) * 100).toFixed(1)}%"></i></span><span class="tz-time">${esc(fmtDur(secs) || '0 min')}<small>${pct}</small></span></div>`;
    const tabs = `<div class="me-seg">${ZTABS.map(([k, l]) => `<button type="button" class="${k === tab ? 'on' : ''}" data-action="me-ztab" data-t="${k}">${l}</button>`).join('')}</div>`;
    const ssSub = isNum(Z.ssMin) && isNum(Z.ssMax) ? `${Z.ssMin}–${Z.ssMax}% · overlaps Z3–Z4, not in the total` : 'overlaps Z3–Z4, not in the total';
    const period = R[0] === 'all' ? 'All time' : 'Last ' + R[1];
    return `${rangeBtns(R, 'zrange')}${tabs}
      <div class="card me-card"><div class="me-ttl">${esc(period)} · ${z.n} ${z.n === 1 ? 'activity' : 'activities'}</div>
        ${z.total ? `<div class="me-stats">${meStat(fmtDur(z.total), 'Time in zones')}${meStat(`${Math.round(((z.s[0] + z.s[1]) / z.total) * 100)}%`, 'Easy (Z1–Z2)')}${meStat(`${Math.round(((z.s[4] + z.s[5] + z.s[6]) / z.total) * 100)}%`, 'Hard (Z5+)')}</div>
        ${zStack(z.s, z.total)}
        <div class="tz-list">${z.s.map((v, i) => row('Z' + (i + 1), ZONE_COLORS[i], names[i], span(i), v, `${Math.round((v / z.total) * 100)}%`)).join('')}
          ${!hr && z.ss ? row('SS', '#fb923c', 'Sweet spot', ssSub, z.ss, `${Math.round((z.ss / z.total) * 100)}%`) : ''}</div>`
        : `<div class="muted" style="margin-top:8px">No ${tab === 'power' ? 'power' : hr ? 'heart rate' : 'zone'} data in this period.</div>`}
      </div>
      <details class="card explain" style="margin-top:12px"><summary>What are zones?</summary>
        <p>Zones split your effort into levels, from very easy (Z1) to all-out (Z7). <b>Power</b> zones are % of your FTP, <b>heart rate</b> zones are based on your threshold heart rate (LTHR). <b>Combined</b> uses power when a ride has a power meter and heart rate otherwise, so every workout counts once. <b>Sweet spot</b> (about 84–97% of FTP) sits across Z3 and Z4: hard enough to build FTP, easy enough to do a lot of. Most good plans keep roughly 80% of the time easy (Z1–Z2).</p></details>`;
  }

  /* ---------------- screen: More ---------------- */

  // Goals, Check-in and Progress: at the top of the Settings page (the gear, top right)
  function moreRowsHTML() {
    let html = '';
    const row = (href, ic, cls, title, sub) => `<a class="card tap more-row ${cls}" href="${href}"><span class="mr-ic">${ic}</span>
      <span class="mr-txt"><b>${esc(title)}</b><small>${esc(sub)}</small></span><span class="chev">›</span></a>`;
    const g = state.plan ? safeVal(() => goalsSorted().find((x) => x.days != null && x.days >= 0)) : null;
    const open = state.plan ? safeVal(() => openQuestions(today()).length) || 0 : 0;
    const total = Object.values(getCheckins()).reduce((t, x) => t + xpOf(x), 0);
    const streak = streakDays();
    html += row('#goals', ICON.flag, 'mr-goals', 'Goals', g ? `${txt(g.g.title) || 'Next goal'} · ${g.days === 0 ? 'today!' : g.days + (g.days === 1 ? ' day' : ' days') + ' to go'}` : "What you're training for");
    html += row('#checkin', ICON.note, 'mr-check', 'Check-in', open ? `${open} question${open > 1 ? 's' : ''} still open today · copy for your coach` : 'Copy your check-ins for your coach');
    html += row('#progress', ICON.trophy, 'mr-prog', 'Progress', `Level ${levelOf(total).level} · ${streak}-day streak`);
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

  // A picture for a shopping item: the first two foods named in it (e.g. "Broccoli or cauliflower" → 🥦)
  const FOOD_ICONS = [
    [/sandwich|boterham|broodje/i, '🥪'], [/bacon|\bspek\b/i, '🥓'], [/nutella|choco/i, '🍫'], [/cruesli|muesli|granola/i, '🥣'],
    [/isotonic|sports drink|electrolyte|drink mix/i, '🧃'], [/pizza/i, '🍕'], [/rice cake|rijstwafel/i, '🍘'], [/smoothie/i, '🥤'],
    [/peanut butter|pindakaas/i, '🥜'], [/sweet potato|zoete aardappel/i, '🍠'], [/green beans?|sperzie|boontjes/i, '🫛'],
    [/broccoli|cauliflower|bloemkool/i, '🥦'], [/carrot|wortel/i, '🥕'], [/pepper|paprika/i, '🫑'], [/tomato|tomaat|tomaten/i, '🍅'],
    [/cucumber|komkommer|courgette|zucchini/i, '🥒'], [/spinach|spinazie|salad|lettuce|\bsla\b|leaves|kale|boerenkool/i, '🥬'],
    [/frozen|diepvries/i, '🧊'], [/yoghurt|yogurt|skyr|quark|kwark/i, '🥣'], [/milk|melk/i, '🥛'], [/banana|banaan/i, '🍌'],
    [/apple|appel/i, '🍎'], [/orange|sinaas/i, '🍊'], [/lemon|lime|citroen/i, '🍋'], [/strawberr|aardbei|jam|confituur/i, '🍓'],
    [/blueberr|berries|bessen/i, '🫐'], [/grape|druif|druiven|raisin|rozijn|dates|dadel/i, '🍇'], [/avocado/i, '🥑'],
    [/potato|aardappel/i, '🥔'], [/onion|\bui\b|uien/i, '🧅'], [/garlic|knoflook/i, '🧄'], [/mushroom|champignon/i, '🍄'],
    [/corn|maïs|mais/i, '🌽'], [/rice|rijst/i, '🍚'], [/pasta|spaghetti|noodle|penne/i, '🍝'],
    [/bread|brood|bagel|wrap|tortilla|toast/i, '🍞'], [/oat|haver|muesli|granola|cereal/i, '🥣'], [/\beggs?\b|eieren/i, '🥚'],
    [/chicken|kip|turkey|kalkoen/i, '🍗'], [/beef|steak|rund|mince|gehakt|meat|vlees/i, '🥩'],
    [/salmon|zalm|tuna|tonijn|fish|\bvis\b|cod|kabeljauw/i, '🐟'], [/shrimp|prawn|garnaal|garnalen/i, '🦐'],
    [/cheese|kaas|mozzarella|feta/i, '🧀'], [/butter|boter/i, '🧈'], [/nuts?\b|noten|almond|amandel|walnut|cashew/i, '🥜'],
    [/honey|honing|syrup|siroop/i, '🍯'], [/chocolate|chocolade|\bbars?\b|reep/i, '🍫'], [/coffee|koffie/i, '☕'],
    [/\btea\b|thee/i, '🍵'], [/juice|\bsap\b/i, '🧃'], [/\bgels?\b/i, '⚡'],
    [/olive|\boil\b|olie/i, '🫒'], [/beans|bonen|lentil|linzen|chickpea|kikkererwt|hummus/i, '🫘'], [/peas|erwt/i, '🫛'],
    [/pumpkin|pompoen/i, '🎃'], [/soup|soep/i, '🍲'], [/salt|zout/i, '🧂'], [/herb|kruiden|spice|basil|parsley/i, '🌿'],
    [/water/i, '💧'], [/vegetable|groenten|veggies/i, '🥦'], [/fruit/i, '🍑'],
  ];
  function foodIcon(name, max) {
    const hits = [], taken = [];
    FOOD_ICONS.forEach(([re, ic]) => {
      const m = re.exec(name);
      if (!m) return;
      const a = m.index, b = a + m[0].length;
      if (taken.some(([x, y]) => a < y && b > x)) return; // "peanut butter" is not also "butter"
      taken.push([a, b]);
      hits.push([a, ic]);
    });
    const ics = [...new Set(hits.sort((x, y) => x[0] - y[0]).map((h) => h[1]))].slice(0, max || 2);
    return ics.length ? ics : ['🛒'];
  }
  // "Broccoli or cauliflower, 2 heads (fresh)" → name + amount (a comma inside brackets doesn't count)
  function splitShopText(s) {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (ch === ',' && !depth) return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
    }
    return [s, ''];
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
        <div class="shop-grid">${groups[cat].map((x) => {
          const [name, more] = x.qty ? [x.name, ''] : splitShopText(x.name);
          const ics = foodIcon(name);
          return `<label class="shop-tile${ticks[x.key] ? ' on' : ''}">
          <input type="checkbox" data-shop="${esc(x.key)}"${ticks[x.key] ? ' checked' : ''}>
          <span class="st-pic${ics.length > 1 ? ' two' : ''}" aria-hidden="true">${ics.map((i) => `<span>${i}</span>`).join('')}</span>
          <span class="st-name">${esc(name)}</span>${x.qty || more ? `<span class="st-qty">${esc(x.qty || more)}</span>` : ''}
          <span class="st-tick">${check}</span></label>`;
        }).join('')}</div>`).join('');
    }
    return `<div class="section" style="margin-top:0"><h3><span>${done} of ${list.length} ticked</span>${done ? '<button class="btn small" data-action="shop-clear">Untick all</button>' : ''}</h3>
      ${toggle}${dayChips}
      <div class="card shop-card">${byDay && list.length ? `<div class="muted small" style="margin-bottom:8px">Amounts for ${esc(fmtLong(day))}</div>` : ''}${body}</div></div>`;
  }

  function viewFood() {
    const shop = state.plan ? arr(nutrition().shopping_list).map(shopItemParts).filter((x) => x.name) : [];
    const ticks = shopTicks();
    const left = shop.filter((x) => !ticks[x.name]).length;
    const shopBtn = shop.length ? `<a class="icon-btn" href="#shopping" aria-label="Shopping list, ${left} to buy">${ICON.cart}${left ? `<span class="ib-badge">${left}</span>` : ''}</a>` : '';
    let html = `<div class="page-head"><div class="eyebrow">Nutrition</div><div class="head-row"><h2>Food</h2>${shopBtn}</div></div>`;
    if (!state.plan) return html + noPlanHTML();
    const t = today();
    const todayType = txt(obj(mealsOn(t)[0]).day_type);

    html += safe(() => {
      if (!arr(nutrition().meals).length) return '';
      const ms = mealsOn(t);
      const cal = state.mealCal;
      return `<div class="section" style="margin-top:0"><h3><span>Today's meals</span>
          <button class="btn small${cal ? ' on' : ''}" data-action="meal-cal" aria-expanded="${!!cal}">${ICON.calendar} ${cal ? 'Hide month' : 'Month'}</button></h3>
        ${cal ? safe(mealCalHTML, 'the meal calendar') : ''}
        ${ms.length ? ms.map((m) => mealCard(m, true)).join('') : '<div class="card muted">No meals planned for today.</div>'}</div>`;
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

    return html;
  }

  // The days of a month grid, Monday first (offset 0 = this month)
  function monthDays(offset) {
    const base = parseDate(today());
    const first = new Date(base.getFullYear(), base.getMonth() + (offset || 0), 1);
    const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    const days = [];
    for (let d = mondayOf(first); d <= lastDay || d.getDay() !== 1; d = addDays(d, 1)) days.push(d);
    return { first, days };
  }

  // Meal days on a month calendar: tap once for a summary, tap again for the full day
  function mealCalHTML() {
    const t = today();
    const { first, days } = monthDays(state.mealMonth);
    const byDate = {};
    arr(nutrition().meals).map(obj).forEach((m) => { const d = normDate(m.date); if (d) (byDate[d] = byDate[d] || []).push(m); });
    const types = new Set();
    const cells = days.map((d) => {
      const ds = iso(d);
      if (d.getMonth() !== first.getMonth()) return '<div class="mc-day out"></div>';
      const body = `<span class="mc-num">${d.getDate()}</span>`;
      const ms = byDate[ds];
      if (!ms) return `<div class="mc-day${ds === t ? ' today' : ''}">${body}</div>`;
      const dt = txt(ms[0].day_type);
      if (dt) types.add(dt);
      return selDayBtn('meal', ds, '#meals/' + ds, `mc-day has${ds === t ? ' today' : ''}${state.sel.meal === ds ? ' sel' : ''}`, body + `<i class="mcal-dot dt-${esc(dt)}"></i>`);
    }).join('');
    const sel = state.sel.meal;
    let pick = '';
    if (byDate[sel] && parseDate(sel).getMonth() === first.getMonth() && parseDate(sel).getFullYear() === first.getFullYear()) {
      const ms = byDate[sel], dt = txt(ms[0].day_type), tt = obj(dayTypes()[dt]);
      const n = ms.reduce((a, m) => a + arr(m.items).length, 0);
      let eaten = '';
      if (sel <= t) {
        const st = safeVal(() => dayFlow(sel).filter((s) => s.kind === 'meal')) || [];
        eaten = `${st.filter((s) => s.status === 'done').length} of ${st.length} eaten`;
      }
      pick = `<div class="cal-sum"><div class="cs-head"><b>${esc(fmtLong(sel))}</b><a class="btn small" href="#meals/${sel}">Open ›</a></div>
        <div class="chips" style="margin-top:0">${dt ? `<span class="chip day-type dt-${esc(dt)}">${esc(prettify(dt))} day</span>` : ''}
          ${isNum(tt.carbs_g) && tt.carbs_g > 0 ? `<span class="chip">${esc(num(tt.carbs_g))} g carbs</span>` : ''}
          <span class="chip">${n} ${n === 1 ? 'meal' : 'meals'}</span>${eaten ? `<span class="chip">${eaten}</span>` : ''}</div></div>`;
    }
    const label = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    return `<div class="card month-cal meal-cal">
      <div class="mc-nav">
        <button class="btn icon" data-action="meal-month" data-dir="-1" aria-label="Previous month">‹</button>
        <div class="mc-label"><b>${esc(label)}</b><small>Tap a day once to see it, again to open it</small></div>
        <button class="btn icon" data-action="meal-month" data-dir="1" aria-label="Next month">›</button>
      </div>
      <div class="mc-grid">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x) => `<span class="mc-dow">${x}</span>`).join('')}${cells}</div>
      ${pick}
      ${types.size ? `<div class="mc-legend">${[...types].map((dt) => `<span><i class="mcal-dot dt-${esc(dt)}"></i>${esc(prettify(dt))}</span>`).join('')}</div>` : ''}
    </div>`;
  }

  // Everything you eat (or ate) on one day, full screen
  function viewMeals(arg) {
    const ds = normDate(arg) || today();
    let html = `<div class="page-head"><div class="eyebrow">${esc(relDay(ds) || fmtDate(ds, { weekday: 'long' }))}</div><h2>${esc(fmtDate(ds, { day: 'numeric', month: 'long' }))}</h2></div>`;
    if (!state.plan) return html + noPlanHTML();
    const ms = mealsOn(ds);
    if (!ms.length) return html + '<div class="empty">No meals planned for this day.</div>';
    const dt = txt(ms[0].day_type);
    html += dt ? `<div class="card"><div class="chips" style="margin-top:0"><span class="chip day-type dt-${esc(dt)}">${esc(prettify(dt))} day</span></div><div style="margin-top:10px">${targetStats(dt)}</div></div>` : '';
    const past = ds <= today();
    const steps = safeVal(() => dayFlow(ds).filter((s) => s.kind === 'meal')) || [];
    html += safe(() => `<div class="section"><h3>Meals</h3><div class="card meal-rows">${steps.map((s) => `<div class="meal-row">
        <span class="mrw-ic">${s.icon}</span><div class="mrw-body"><b>${esc(s.title)}</b>${(() => { const ics = foodIcon(s.sub || s.title, 5); return ics[0] === '🛒' ? '' : `<span class="ml-ics">${ics.map((x) => `<span>${x}</span>`).join('')}</span>`; })()}${s.sub && s.meal.label ? `<div>${esc(s.sub)}</div>` : ''}</div>
        ${past && s.status ? `<span class="st-label st-${s.status}">${ANSWER_WORD[s.status]}</span>` : ''}</div>`).join('')}</div></div>`, 'the meals');
    html += safe(() => workoutsOn(ds).map((x) => {
      const f = fuelHTML(x.w.fuel, x.w);
      return f ? `<div class="section"><h3>Fuelling · ${esc(txt(x.w.title) || typeInfo(x.w.type).label)}</h3>${f}</div>` : '';
    }).join(''), 'the fuelling');
    return html;
  }

  function viewShopping() {
    let html = `<div class="page-head"><div class="eyebrow">Food</div><h2>Shopping list</h2></div>`;
    if (!state.plan) return html + noPlanHTML();
    return html + (safe(shoppingHTML, 'the shopping list') || '<div class="empty">Your coach hasn\'t added a shopping list yet.</div>');
  }

  /* ---------------- screen: Check-in ---------------- */

  function getCheckins() { return obj(lsGet(LS.checkins, {})); }

  function seg(name, options, current) {
    return `<div class="seg seg-${options.length}">${options.map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return `<label><input type="radio" name="${name}" value="${esc(v)}"${String(current) === String(v) ? ' checked' : ''}><span>${esc(l)}</span></label>`;
    }).join('')}</div>`;
  }

  function checkinLines(c, ds) {
    const lines = [];
    const doneMap = { yes: 'Done', partly: 'Half', no: "Didn't" };
    // Every answered step of the day (workouts, their questions and meals), in the day's order
    const answered = ds && state.plan ? (safeVal(() => dayFlow(ds)) || []).filter((s) => ['workout', 'check', 'meal'].includes(s.kind) && ANSWER_WORD[s.status]) : [];
    // "Session done" only for old check-ins, from before each workout had its own answer
    if (!answered.some((s) => s.kind === 'workout') && (c.done || c.what)) lines.push(`Session done: ${doneMap[c.done] || '–'}${c.what ? ' — ' + c.what : ''}`);
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
    if (c.fuelled) lines.push(`Fuelled as planned: ${ANSWER_WORD[c.fuelled] || c.fuelled}`);
    answered.forEach((s) => {
      const what = s.kind === 'check' ? `${s.title} (${txt(s.x.w.title) || 'workout'})` : s.kind === 'meal' ? `Meal · ${s.title}` : `Workout · ${s.title}`;
      lines.push(`${what}: ${ANSWER_WORD[s.status]}`);
    });
    const meals = answered.length ? [] : Object.entries(obj(c.meal_log));
    if (meals.length) {
      const words = { done: 'Done', half: 'Half', no: "Didn't" };
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
      checkinLines(obj(all[d]), d).forEach((l) => out.push('- ' + l));
      out.push('');
    });
    return out.join('\n').trim();
  }

  // The question steps of a day (morning, session, wrap-up) that aren't answered yet
  function openQuestions(ds) {
    return dayFlow(ds).filter((s) => ['morning', 'session', 'wrap'].includes(s.kind) && !s.status);
  }

  // Check-in (under More): only the questions still open today, then copy for the coach.
  // #checkin/<date> is the old form, to fix an earlier day.
  function viewCheckin(dateArg) {
    if (normDate(dateArg)) return viewCheckinEdit(dateArg);
    const t = today();
    const all = getCheckins();
    let html = `<div class="page-head"><div class="eyebrow">Check-in</div><h2>For your coach</h2></div>`;
    html += safe(() => {
      if (!state.plan) return '';
      const open = openQuestions(t);
      return `<div class="section" style="margin-top:0"><h3>Still to answer today</h3>${open.length
        ? open.map((s) => `<a class="card tap ci-open" href="#today/step-${esc(s.id)}"><span class="mr-ic">${s.icon}</span>
            <span class="mr-txt"><b>${esc(s.title)}</b><small>${esc(s.sub)}</small></span><span class="chev">›</span></a>`).join('')
        : `<div class="card ci-all">${ICON.check} All answered today</div>`}</div>`;
    }, 'the open questions');
    const dates = Object.keys(all).sort().reverse();
    html += `<div class="section"><h3><span>Copy for your coach</span></h3>
      <div class="btn-row">
        <button class="btn primary" data-action="copy-today"${all[t] ? '' : ' disabled style="opacity:.5"'}>${ICON.copy} Today</button>
        <button class="btn" data-action="copy-checkins"${dates.length ? '' : ' disabled style="opacity:.5"'}>${ICON.copy} All days</button>
      </div></div>`;
    html += `<div class="section"><h3><span>Saved check-ins · ${dates.length}</span></h3>
      ${dates.length ? dates.map((d) => {
        const x = obj(all[d]);
        return `<div class="card ci-item">
          <div class="ci-head"><span class="ci-date">${esc(fmtDate(d))}</span><span class="muted small">${esc(relDay(d))}</span></div>
          <div class="ci-body">${esc(checkinLines(x, d).join('\n'))}</div>
          <div class="ci-actions">
            <a class="btn small" href="#checkin/${d}">Edit</a>
            <button class="btn small danger" data-action="delete-checkin" data-date="${d}">${state.pendingDelete === d ? 'Tap again to delete' : 'Delete'}</button>
          </div></div>`;
      }).join('') : '<div class="empty" style="padding:20px">No check-ins yet.</div>'}
    </div>`;
    return html;
  }

  // Fix an earlier day by hand
  function viewCheckinEdit(dateArg) {
    const ds = normDate(dateArg) || today();
    const all = getCheckins();
    const c = obj(all[ds]);
    const planned = state.plan ? workoutsOn(ds) : [];
    const plannedMin = planned.reduce((t, x) => t + (isNum(x.w.duration_min) ? x.w.duration_min : 0), 0);

    let html = `<div class="page-head"><div class="eyebrow">Edit check-in</div><h2>${esc(fmtLong(ds))}</h2>
      <div class="sub">Workouts and meals are answered on the Today screen; here you can fix the rest.</div></div>`;

    html += `<form id="ciForm" class="card" autocomplete="off">
      <div class="field"><label class="lbl" for="ci-date">Date</label>
        <input type="date" id="ci-date" name="date" value="${ds}" max="${iso(addDays(new Date(), 1))}"></div>

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

      <div class="field"><label class="lbl" for="ci-notes">Notes</label>
        <textarea id="ci-notes" name="notes" placeholder="Anything your coach should know: pain, illness, motivation, weather…">${esc(c.notes || '')}</textarea></div>

      <button class="btn primary" type="submit">Save check-in</button>
    </form>`;
    return html;
  }

  function saveCheckin(form) {
    const fd = new FormData(form);
    const g = (k) => String(fd.get(k) || '').trim();
    const ds = normDate(g('date'));
    if (!ds) { toast('Please pick a date first'); return; }
    const c = {
      duration_min: g('duration_min'), power_w: g('power_w'), hr_bpm: g('hr_bpm'),
      rpe: g('rpe'), legs: g('legs'), sleep_h: g('sleep_h'), stress: g('stress'),
      notes: g('notes'),
    };
    Object.keys(c).forEach((k) => { if (!c[k]) delete c[k]; });
    if (!Object.keys(c).length) { toast('Nothing filled in yet'); return; }
    c.saved_at = new Date().toISOString();
    const all = getCheckins();
    // keep the answers given on the Today screen (meals, workout steps)
    const old = obj(all[ds]);
    if (old.steps) c.steps = old.steps;
    if (old.meal_log) c.meal_log = old.meal_log;
    ['fuelled', 'done', 'what', 'what_auto'].forEach((k) => { if (old[k]) c[k] = old[k]; }); // set elsewhere, not on this form
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
    let html = `<div class="page-head"><div class="eyebrow">Settings</div><h2>Settings</h2></div>`;
    html += safe(moreRowsHTML, 'the menu');

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

    html += !(state.open.import || state.importText || state.importMsg)
      ? '<div class="section"><button class="btn more-btn" data-action="open-panel" data-panel="import">Import a new plan <span>›</span></button></div>'
      : `<div class="section"><h3><span>Import a new plan</span><button class="btn small" data-action="close-panel" data-panel="import">Close</button></h3><div class="card">
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
    // The form shows when not connected, and also when the saved key is refused, so it can be replaced right here
    const form = `<form id="icuForm" autocomplete="off">
          <div class="field"><label class="lbl" for="icuAthlete">Athlete id <small>(looks like i123456)</small></label><input type="text" id="icuAthlete" name="athlete" placeholder="i123456" value="${esc(c ? c.athlete || '' : '')}" autocapitalize="off" spellcheck="false"></div>
          <div class="field"><label class="lbl" for="icuKey">${c ? 'New API key' : 'API key'}</label><input type="password" id="icuKey" name="key" autocapitalize="off" spellcheck="false" style="width:100%"></div>
          <button class="btn primary" type="submit">${c ? 'Save new key' : 'Connect'}</button>
        </form>`;
    return `<div class="section go-target" id="go-icu"><h3>Intervals.icu</h3><div class="card">
      ${c ? `<dl class="kv"><dt>Status</dt><dd>${icu.error ? '⚠ ' + esc(icu.error) : '✓ Connected'}</dd><dt>Athlete id</dt><dd>${esc(c.athlete || '0')}</dd><dt>API key</dt><dd>saved on this device</dd></dl>
        <div class="btn-row" style="margin-top:12px"><button class="btn" data-action="icu-test">Test connection</button><button class="btn danger" data-action="icu-forget">Disconnect</button></div>
        ${icu.error || state.open.icu ? `<div style="margin-top:16px">${form}</div>` : '<button class="btn more-btn" data-action="open-panel" data-panel="icu" style="margin-top:10px">Change key <span>›</span></button>'}`
      : `<p class="small muted" style="margin-top:0">Shows your sleep, HRV, fitness, weather and done rides in the Agenda. In Intervals.icu go to <b>Settings → Developer Settings</b> and copy your athlete id and API key. The key is saved only on this device, never on the website.</p>
        ${form}`}
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

  const TITLES = { today: 'Today', agenda: 'Agenda', goals: 'Goals', food: 'Food', more: 'More', me: 'Me', checkin: 'Check-in', settings: 'Settings', progress: 'Progress', xp: 'XP history', day: 'Day', workout: 'Workout', overview: 'Day overview', meals: 'Meals', shopping: 'Shopping list' };
  const TOP_LEVEL = ['today', 'agenda', 'food', 'me'];

  function parseRoute() {
    const h = decodeURIComponent(location.hash.replace(/^#/, '')) || 'today';
    let [name, arg] = h.split('/');
    if (name === 'more') name = 'settings'; // the More tab moved behind the gear
    return { name: TITLES[name] ? name : 'today', arg: arg || '' };
  }

  function render(keepScroll) {
    const r = parseRoute();
    state.route = r.name;
    let html;
    // #settings/icu goes all the way: the key form opens by itself
    if (r.name === 'settings' && r.arg === 'icu' && !keepScroll) state.open.icu = true;
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
        case 'progress': html = viewProgress(); break;
        case 'xp': html = viewXp(); break;
        case 'me': html = viewMe(r.arg); break;
        case 'meals': html = viewMeals(r.arg); break;
        case 'shopping': html = viewShopping(); break;
        default:
          // #today/step-<id>: open that step in the big card (from the Check-in page)
          if (r.arg.startsWith('step-') && !keepScroll) { state.focus = r.arg.slice(5); state.focusDate = today(); state.showRoute = false; }
          html = viewToday();
      }
    } catch (e) {
      console.error(e);
      html = `<div class="card error"><b>Something went wrong showing this screen.</b><p class="muted small">${esc(e.message)}</p><a class="btn" href="#settings">Open Settings</a></div>`;
    }
    // A redraw (e.g. when Intervals.icu data arrives) keeps the cursor and what you were typing
    const act = document.activeElement;
    const keep = keepScroll && act && act.name && act.type !== 'radio' && $('#view').contains(act) ? { name: act.name, value: act.value } : null;
    $('#view').innerHTML = html;
    if (keep) {
      const f = $('#view').querySelector(`[name="${keep.name}"]`);
      if (f) { f.value = keep.value; f.focus({ preventScroll: true }); }
    }

    let title = TITLES[r.name];
    if (r.name === 'workout') {
      const w = obj(arr(P().workouts)[+r.arg]);
      title = txt(w.title) || typeInfo(txt(w.type)).label;
    } else if (r.name === 'day' || r.name === 'meals') {
      title = fmtDate(r.arg) || TITLES[r.name];
    } else if (r.name === 'me' && r.arg) {
      title = r.arg.startsWith('log') ? 'Training log' : { history: 'Training history', fitness: 'Fitness', ftp: 'FTP', power: 'Power curve', zones: 'Time in zones', profile: 'Edit profile' }[r.arg] || (r.arg.startsWith('history-') ? 'Training history' : 'Me');
    }
    $('#title').textContent = title;
    document.title = title + ' · Trainer';

    const isTop = TOP_LEVEL.includes(r.name) && !(r.name === 'me' && r.arg);
    $('#backBtn').hidden = isTop;
    $('#overviewBtn').hidden = r.name !== 'today';
    $('#gearBtn').classList.toggle('active', ['settings', 'goals', 'checkin'].includes(r.name));
    const activeTab = { day: 'agenda', workout: 'agenda', overview: 'today', progress: 'today', xp: 'today', goals: 'settings', checkin: 'settings', meals: 'food', shopping: 'food' }[r.name] || r.name;
    document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === activeTab));
    if (!keepScroll) window.scrollTo(0, 0);
    hudCompact(true);
    // A link like #settings/icu goes all the way to that spot: scroll there and put the cursor in the first empty field
    const target = r.arg && !keepScroll && document.getElementById(r.arg.startsWith('step-') ? 'questCard' : 'go-' + r.arg);
    if (target) goTo(target);
    // the long XP chart opens at the chosen day (or today, on the right)
    const xs = document.querySelector('.xp-scroll');
    if (xs) {
      const s = xs.querySelector('.sel');
      xs.scrollLeft = s ? s.offsetLeft - xs.clientWidth / 2 + s.offsetWidth / 2 : xs.scrollWidth;
    }
  }

  function goTo(el) {
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1600);
      // look the spot up again: the page may have been redrawn in the meantime
      setTimeout(() => {
        const cur = (el.id && document.getElementById(el.id)) || el;
        const field = [...cur.querySelectorAll('input, textarea')].find((i) => !i.value && i.type !== 'radio');
        if (field) field.focus({ preventScroll: true });
      }, 450);
    });
  }

  // The game bar shrinks to a one-line summary when you scroll down, and grows back at the top
  function hudCompact(now) {
    const w = document.querySelector('.hud-wrap');
    if (!w) return;
    const y = window.scrollY;
    if (now) w.classList.toggle('compact', y > 36);
    else if (y > 64) w.classList.add('compact');
    else if (y < 8) w.classList.remove('compact');
  }
  window.addEventListener('scroll', () => hudCompact(false), { passive: true });

  window.addEventListener('hashchange', () => {
    state.navDepth++;
    state.pendingDelete = '';
    if (parseRoute().name !== 'settings') { state.importMsg = ''; state.open = {}; }
    if (!(parseRoute().name === 'me' && parseRoute().arg === 'profile')) state.profPhoto = null;
    render();
  });

  /* ---------------- taps and form events ---------------- */

  // Every chartSVG graph with o.key: put a finger (or the mouse) on it and slide sideways to move through the
  // points, like Strava. The body keeps the pointer because each step redraws the graph under the finger.
  let scrub = null, scrubEnd = 0;
  document.addEventListener('pointerdown', (e) => {
    const hit = e.target.closest && e.target.closest('.mhit');
    if (!hit || (e.pointerType === 'mouse' && e.button !== 0)) return;
    scrub = { key: hit.dataset.key, id: e.pointerId, x0: e.clientX, moved: false };
  });
  document.addEventListener('pointermove', (e) => {
    if (!scrub || e.pointerId !== scrub.id) return;
    if (!scrub.moved) {
      if (Math.abs(e.clientX - scrub.x0) < 6) return;
      scrub.moved = true;
      try { document.body.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
    }
    const hits = [...document.querySelectorAll(`.mhit[data-key="${scrub.key}"]`)];
    if (!hits.length) return;
    const pick = hits.find((h) => { const b = h.getBoundingClientRect(); return e.clientX >= b.left && e.clientX < b.right; })
      || (e.clientX < hits[0].getBoundingClientRect().left ? hits[0] : hits[hits.length - 1]);
    if (state.sel[scrub.key] !== pick.dataset.date) { state.sel[scrub.key] = pick.dataset.date; render(true); }
  });
  const endScrub = (e) => {
    if (!scrub || e.pointerId !== scrub.id) return;
    if (scrub.moved) scrubEnd = Date.now();
    scrub = null;
  };
  document.addEventListener('pointerup', endScrub);
  document.addEventListener('pointercancel', endScrub);
  // a slide must not count as the second tap that opens the point
  document.addEventListener('click', (e) => { if (Date.now() - scrubEnd < 400) { e.preventDefault(); e.stopPropagation(); } }, true);

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
      state.showRoute = false;
      goToStep(el.dataset.step);
    } else if (action === 'route-toggle') {
      state.showRoute = !state.showRoute;
      render(true);
    } else if (action === 'num-mode') {
      // the switch sits inside a card that is a link: switch, don't open the workout
      e.preventDefault();
      state.numMode[el.dataset.i] = el.dataset.mode;
      render(true);
    } else if (action === 'mark-done') {
      // "Mark done" on a session card (a link) or Done / Half / Didn't on the workout page; tap again to take it back
      e.preventDefault();
      const ds = el.dataset.date;
      const step = dayFlow(ds).find((s) => s.id === 'workout-' + el.dataset.i);
      if (!step) return;
      const v = el.dataset.value;
      answerStep(ds, step, workoutAnswer(ds, el.dataset.i) === v ? '' : v);
      render(true);
      if (ds === today() && dayFlow(ds).every((s) => s.status)) maybeCelebrate(ds);
    } else if (action === 'sel-day') {
      // calendars: the first tap picks the day, a second tap on it opens it
      e.preventDefault();
      const k = el.dataset.key, ds = el.dataset.date;
      if (state.sel[k] === ds && el.dataset.href) location.hash = el.dataset.href;
      else { state.sel[k] = ds; render(true); }
    } else if (action === 'celebrate') {
      celebrate(el.dataset.date || today());
    } else if (action === 'open-panel' || action === 'close-panel') {
      state.open[el.dataset.panel] = action === 'open-panel';
      if (action === 'close-panel' && el.dataset.panel === 'import') { state.importText = ''; state.importMsg = ''; }
      render(true);
    } else if (action === 'prof-photo-clear') {
      state.profPhoto = '';
      showPickedPhoto('');
    } else if (action === 'me-sport') {
      state.me.sport = el.dataset.sport;
      render(true);
    } else if (action === 'me-metric') {
      state.me.metric = el.dataset.metric;
      render(true);
    } else if (action === 'me-rng') {
      const f = el.dataset.field, sel = { range: 'hist', frange: 'fit', ftprange: 'ftp' }[f];
      state.me[f] = el.dataset.r;
      if (sel) state.sel[sel] = '';
      if (f === 'range' && location.hash !== '#me/history') location.hash = '#me/history'; // leave the one-week view
      else render(true);
    } else if (action === 'me-pcmonth') {
      state.me.pcmonth = el.dataset.m;
      render(true);
    } else if (action === 'me-pcmore') {
      state.me.pcMonths = (state.me.pcMonths || 6) + 6;
      render(true);
    } else if (action === 'me-pcmode') {
      state.me.pcmode = el.dataset.m;
      render(true);
    } else if (action === 'me-ztab') {
      state.me.ztab = el.dataset.t;
      render(true);
    } else if (action === 'me-more') {
      state.me.logWeeks += 12;
      render(true);
    } else if (action === 'me-refresh') {
      icuHistory(true);
      render(true);
    } else if (action === 'xp-help') {
      state.xpHelp = !state.xpHelp;
      render(true);
    } else if (action === 'meal-cal') {
      state.mealCal = !state.mealCal;
      render(true);
    } else if (action === 'meal-month') {
      const dir = +el.dataset.dir;
      state.mealMonth = dir === 0 ? 0 : (state.mealMonth || 0) + dir;
      render(true);
    } else if (action === 'cal-month') {
      e.preventDefault();
      const dir = +el.dataset.dir;
      state.calMonth = dir === 0 ? 0 : (state.calMonth || 0) + dir;
      render(true);
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
      lsSet(LS_HIST, null); hist.data = null; // the saved history goes too
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

  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'profPhoto' && t.files && t.files[0]) {
      try { state.profPhoto = await shrinkPhoto(t.files[0]); showPickedPhoto(state.profPhoto); } catch (err) { toast(err.message); }
      t.value = '';
      return;
    }
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
    if (e.target.id === 'profForm') {
      e.preventDefault();
      const f = e.target, old = profile();
      const pr = { name: f.name.value.trim(), quote: f.quote.value.trim(), photo: state.profPhoto != null ? state.profPhoto : old.photo || '' };
      if (!lsSet(LS_PROFILE, pr)) { toast("Couldn't save: the photo may be too big"); return; }
      state.profPhoto = null;
      toast('Profile saved');
      location.hash = '#me';
      return;
    }
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
      // only fields that are on the form (minutes/power/HR are hidden when the ride synced)
      fields.forEach((f) => { if (e.target.querySelector(`[name="${f}"]`)) patch[f] = String(fd.get(f) || '').trim(); });
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
