// Home / Today: the glanceable overview. Never scrolls.
(function () {
  'use strict';
  var D = window.DATA, V = {};

  function clock() {
    var n = App.now();
    return '<div class="h-time num">' + App.fmt.time(n, false) + '<span class="h-ampm">' + App.fmt.ampm(n) + '</span></div>' +
      '<div class="h-date"><b>' + App.fmt.day(n) + '</b> ' + App.fmt.month(n) + ' ' + n.getDate() + '</div>';
  }

  // ---- Outside: weather now + hourly on top, air quality and pollen side by side below
  var AQI_COLORS = ['#2E9E5B', '#E3B505', '#F28C28', '#D93B30', '#8F3F97', '#7E0023'];
  var POLLEN_COLORS = ['#2E9E5B', '#9BBF2A', '#E3B505', '#F28C28', '#D93B30'];
  function outside() {
    var w = App.weatherNow(), hours = App.hourly(6);
    var tmin = Math.min.apply(null, hours.map(function (h) { return h.t; }));
    var tmax = Math.max.apply(null, hours.map(function (h) { return h.t; }));
    return '<div class="o-wx">' +
      '<div class="o-now">' +
      '  <span class="o-icon">' + App.icon(w.cond, 48) + '</span>' +
      '  <span class="o-temp num">' + w.temp + '°</span>' +
      '  <span class="o-meta"><b>' + w.label + '</b><span class="num">H ' + w.hi + '°  L ' + w.lo + '°</span><em>' + w.summary + '. ' + w.advice + '.</em></span>' +
      '</div>' +
      '<div class="o-hours">' + hours.map(function (h) {
        var lift = tmax === tmin ? 0 : Math.round((h.t - tmin) / (tmax - tmin) * 6);
        return '<div class="o-hr' + (h.p >= 50 ? ' is-wet' : '') + '"><span class="o-hr-l">' + h.label + '</span>' +
          '<span class="o-hr-i" style="transform:translateY(' + -lift + 'px)">' + App.icon(h.c, 22) + '</span><b class="num">' + h.t + '°</b></div>';
      }).join('') + '</div>' +
      '</div>' +
      '<div class="o-air">' + airPart() + pollenPart() + '</div>';
  }
  function airPart() {
    var A = D.air, a = A && A.air;
    if (!a) return '<div class="o-part"><span class="o-txt"><span class="label">Air quality</span><small class="o-none">' + App.esc((A && A.airError) || (D.status.air.state === 'loading' ? 'Loading…' : 'Unavailable')) + '</small></span></div>';
    var peak = a.today && a.today.aqi > a.now.aqi ? 'Peak ' + a.today.aqi + ' today' : a.tomorrow ? 'Tomorrow ' + a.tomorrow.aqi : '';
    return '<div class="o-part">' +
      '<span class="o-big num" style="color:' + AQI_COLORS[a.now.level] + '">' + a.now.aqi + '</span>' +
      '<span class="o-txt"><span class="label">Air quality</span><b>' + App.esc(a.now.label) + '</b>' +
      '<small>' + [a.now.main ? App.esc(a.now.main.replace(/^.*\((.*)\)$/, '$1')) : '', peak].filter(Boolean).join(' · ') + '</small></span>' +
      '</div>';
  }
  function pollenPart() {
    var A = D.air, p = A && A.pollen;
    if (!p) return '<div class="o-part"><span class="o-txt"><span class="label">Pollen</span><small class="o-none">' + App.esc((A && A.pollenError) || (D.status.air.state === 'loading' ? 'Loading…' : 'Unavailable')) + '</small></span></div>';
    var extra = [['Asthma', p.asthma && p.asthma.today], ['Cold', p.cold && p.cold.today]].filter(function (x) { return x[1]; })
      .map(function (x) { return x[0] + ' ' + x[1].index.toFixed(1); }).join(' · ');
    return '<div class="o-part">' +
      '<span class="o-big num" style="color:' + POLLEN_COLORS[p.today.level] + '">' + p.today.index.toFixed(1) + '</span>' +
      '<span class="o-txt"><span class="label">Pollen</span><b>' + App.esc(p.today.label) + '</b>' +
      '<small>' + App.esc(p.today.triggers.map(function (t) { return t.name; }).join(', ') || 'No main allergens') + '</small>' +
      (extra ? '<small>' + extra + '</small>' : '') + '</span>' +
      (p.days.length > 1 ? '<span class="o-days">' + p.days.map(function (d, i) {
        return '<span><i class="o-bar"><i style="height:' + Math.max(10, Math.round(d.index / 12 * 100)) + '%;background:' + POLLEN_COLORS[d.level] + '"></i></i>' +
          '<small>' + (i === 0 ? 'Now' : App.fmt.dayShort(new Date(d.date + 'T12:00:00')).slice(0, 2)) + '</small></span>';
      }).join('') + '</span>' : '') +
      '</div>';
  }

  // Presence comes from Home Assistant person.* entities; unknown (null) shows just the name.
  function presence() {
    return D.people.map(function (p) {
      var sub = p.home == null ? '' : p.home ? 'Home' : (p.eta ? '<b>ETA ' + p.eta + ' min</b>' : App.esc(p.status || 'Away'));
      return '<div class="h-who' + (p.home ? ' is-home' : '') + '" style="' + App.pstyle(p) + '">' +
        App.avatar(p, 36, p.home === false ? 'avatar--away' : '') +
        '<span><b>' + App.esc(p.name) + '</b><small>' + sub + '</small></span></div>';
    }).join('');
  }

  function hero() {
    var e = App.nextEvent(), now = App.now();
    if (!e) {
      var cal = D.status.calendar;
      if (cal.state !== 'ok') {
        return '<div class="h-hero h-hero--empty" data-go="calendar">' +
          '<div class="label label--light">Calendar</div>' +
          '<div class="h-hero-title display">' + (cal.state === 'loading' ? 'Loading the calendar…' : App.esc(cal.message || 'Calendar unavailable') + '.') +
          (cal.state === 'empty' ? ' <i>Add one in Settings.</i>' : '') + '</div></div>';
      }
      var tomorrow = App.timedOn(App.addDays(now, 1))[0];
      return '<div class="h-hero h-hero--empty" data-go="calendar">' +
        '<div class="label label--light">Rest of today</div>' +
        '<div class="h-hero-title display">Nothing else scheduled. <i>Enjoy the quiet.</i></div>' +
        (tomorrow ? '<div class="h-hero-meta">Tomorrow starts with <b>' + App.esc(tomorrow.title) + '</b> at ' + App.fmt.time(tomorrow.start) + '</div>' : '') +
        '</div>';
    }
    var p = App.evColor(e);
    var mins = (e.start - now) / 60000;
    var leave = (App.leaveBy(e) - now) / 60000;
    var who = e.people.map(function (id) { return App.person(id).name; });
    var whoText = App.isFamily(e) ? 'Everyone' : who.join(' + ');
    var big = mins < 100
      ? '<div class="h-hero-count num">' + Math.round(mins) + '<small>min</small></div>'
      : '<div class="h-hero-count num">' + App.fmt.time(e.start, false) + '<small>' + App.fmt.ampm(e.start) + '</small></div>';
    var leavePill = '';
    if (e.travel) {
      leavePill = leave <= 0
        ? '<span class="pill pill--alert"><i class="pulse"></i>Leave now</span>'
        : '<span class="pill' + (leave <= 15 ? ' pill--soon' : '') + '">' + App.icon('car', 20) + 'Leave in ' + App.fmt.mins(leave) + '</span>';
    }
    return '<button class="h-hero" style="' + App.pstyle(p) + '" data-ev="' + e.id + '">' +
      '<div class="h-hero-main">' +
      '  <div class="label label--on">Next up · ' + App.esc(whoText) + '</div>' +
      '  <div class="h-hero-title display">' + App.esc(e.title) + '</div>' +
      '  <div class="h-hero-meta">' + App.fmt.range(e.start, e.end) + (e.loc ? ' · ' + App.esc(e.loc) : '') + '</div>' +
      '</div>' + leavePill + big + '</button>';
  }

  function lanes() {
    var now = App.now();
    if (!D.people.length) return '<div class="h-free display"><i>Add your family</i> in Settings</div>';
    return D.people.map(function (p) {
      var list = App.timedOn(now, p.id).filter(function (e) { return e.end > now; });
      var shown = list.slice(0, 3), more = list.length - shown.length;
      return '<div class="h-lane" style="' + App.pstyle(p) + '">' +
        '<div class="h-lane-head">' + App.avatar(p, 30) + '<b>' + p.name + '</b></div>' +
        (list.length ? shown.map(function (e) {
          var cur = e.start <= now;
          return '<button class="h-ev' + (cur ? ' is-now' : '') + '" data-ev="' + e.id + '">' +
            '<span class="h-ev-t">' + (cur ? 'Now' : App.fmt.time(e.start, false)) + '</span>' +
            '<span class="h-ev-n">' + App.esc(e.title) + '</span></button>';
        }).join('') : '<div class="h-free display"><i>Free</i> the rest of the day</div>') +
        (more > 0 ? '<button class="h-more" data-go="calendar">+' + more + ' more</button>' : '') +
        '</div>';
    }).join('');
  }

  function ring(done, total, size) {
    var r = size / 2 - 5, c = 2 * Math.PI * r, f = total ? done / total : 0;
    return '<svg class="ring" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
      '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" class="ring-bg"/>' +
      '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" class="ring-fg" stroke-dasharray="' + (c * f) + ' ' + c + '" transform="rotate(-90 ' + size / 2 + ' ' + size / 2 + ')"/></svg>';
  }
  App.ring = ring;

  // Shopping and Home as one-line strips under the lanes
  function shopping() {
    var open = D.groceries.filter(function (g) { return !g.done; });
    var recent = open.slice(-3).reverse().map(function (g) { return App.esc(g.name); }).join(', ');
    return App.icon('cart', 24) + '<b class="num">' + open.length + '</b><span>' + (open.length === 1 ? 'item' : 'items') + ' to get' +
      (recent ? '<em> · ' + recent + '</em>' : '') + '</span>';
  }

  function status() {
    if (D.status.ha.state !== 'ok') {
      return App.icon('sliders', 24) + '<span>' + (D.status.ha.state === 'connecting' ? 'Connecting to Home Assistant…' : 'Home Assistant not connected') + '</span>';
    }
    var lights = D.devices.filter(function (d) { return d.type === 'light' && d.on; }).length;
    var unlocked = D.devices.filter(function (d) { return d.type === 'lock' && !d.locked; });
    var garage = D.devices.filter(function (d) { return d.type === 'garage' && d.state !== 'closed'; })[0];
    var secure = !unlocked.length && !garage;
    var secText = secure ? 'All locked' : (garage ? garage.name + ' ' + garage.state : unlocked[0].name + ' unlocked');
    return App.icon('bulb', 24) + '<b class="num">' + lights + '</b><span>on</span>' +
      '<span class="h-st-sep' + (secure ? '' : ' is-warn') + '">' + App.icon(secure ? 'lock' : 'unlock', 22) + App.esc(secText) + '</span>' +
      (D.climate && D.climate.current != null ? '<span class="h-st-sep">' + App.icon('thermo', 22) + D.climate.current + '°</span>' : '');
  }

  function paint() {
    var el = V.el;
    el.querySelector('.h-clock').innerHTML = clock();
    el.querySelector('.h-outside').innerHTML = outside();
    el.querySelector('.h-presence').innerHTML = presence();
    el.querySelector('.h-hero-slot').innerHTML = hero();
    el.querySelector('.h-lanes').innerHTML = lanes();
    el.querySelector('.h-shop').innerHTML = shopping();
    el.querySelector('.h-status').innerHTML = status();
  }

  function photoCaption(s) {
    var m = App.photoMeta(s.photos[0]);
    V.el.querySelector('.h-photo-cap').innerHTML = '<b>' + (m.onThisDay ? 'On this day · ' : '') + m.kicker + '</b><span>' + App.esc(m.place) + '</span>';
  }

  App.register('home', {
    show: function (el) {
      V.el = el;
      if (!el.firstChild) {
        el.innerHTML = '<div class="home">' +
          '<div class="h-clock" data-go="calendar"></div>' +
          '<div class="h-presence"></div>' +
          '<div class="h-main"><div class="h-hero-slot"></div><div class="h-outside card"></div><div class="h-lanes"></div>' +
          '  <div class="h-duo"><button class="h-shop card" data-go="shopping"></button><button class="h-status card" data-go="control"></button></div>' +
          '</div>' +
          '<button class="h-photo" data-go="photos"><div class="h-photo-stage"></div><div class="h-photo-cap"></div></button>' +
          '</div>';
        el.addEventListener('click', function (e) {
          var ev = e.target.closest('[data-ev]');
          if (ev) { App.eventSheet(App.findEvent(ev.dataset.ev)); return; }
          var g = e.target.closest('[data-go]');
          if (g) App.go(g.dataset.go);
        });
        V.slides = new App.Slideshow(el.querySelector('.h-photo-stage'), { layout: 'cover', captions: false, onChange: photoCaption });
      }
      paint();
      V.slides.start();
    },
    resume: function () { V.slides.start(); },
    hide: function () { if (V.slides) V.slides.stop(); }
  });
  // Every minute: just the clock and next-up countdown (cheap, even while hidden). Outside on the hour.
  App.on('minute', function (n) {
    if (!V.el || !V.el.firstChild) return;
    V.el.querySelector('.h-clock').innerHTML = clock();
    V.el.querySelector('.h-hero-slot').innerHTML = hero();
    if (n.getMinutes() === 0) { V.el.querySelector('.h-outside').innerHTML = outside(); V.el.querySelector('.h-lanes').innerHTML = lanes(); }
  });
  App.on('data', function () { if (App.current === 'home') paint(); });
  // Home Assistant updates (devices, presence) repaint only the parts that use them.
  App.on('ha', function () {
    if (!V.el || !V.el.firstChild) return;
    V.el.querySelector('.h-status').innerHTML = status();
    V.el.querySelector('.h-presence').innerHTML = presence();
  });
})();
