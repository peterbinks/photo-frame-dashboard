// Live data container. Views read window.DATA; js/sync.js fills it from the Worker (/api/*) and
// keeps it fresh. Objects are mutated in place so modules can hold on to `D`.
window.DATA = (function () {
  function rid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  return {
    config: null,
    // family (from /api/config); presence comes from Home Assistant person.* entities when connected
    people: [], ALL: [],
    family: { id: 'family', name: 'Family', color: '#111111', rgb: '17 17 17', ink: '#FFFFFF' },
    // calendar: Google Calendar events + events added on the dashboard (localEvents, synced)
    events: [], localEvents: [],
    // shared household state (synced through /api/state)
    routines: [], chores: [], stars: {}, week: {},
    stores: [], catOrder: { all: [] }, groceries: [], catalog: [], usuals: [], favs: [],
    // Home Assistant (js/ha.js)
    rooms: [], devices: [], climate: null, media: null, cameras: [], scenes: [],
    weather: null,
    // air quality (Open-Meteo US AQI) + pollen (pollen.com): { air, airError, pollen, pollenError }
    air: null,
    photos: [],
    // per-source load state: loading | ok | empty | error (+ message)
    status: { calendar: { state: 'loading' }, weather: { state: 'loading' }, air: { state: 'loading' }, photos: { state: 'loading' }, ha: { state: 'off' } },
    _gid: function () { return rid('g'); },
    _eid: function () { return rid('e'); },
    _cid: function () { return rid('c'); }
  };
})();
