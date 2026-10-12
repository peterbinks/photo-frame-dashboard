// Home / Today: the glanceable overview. Never scrolls.
(function () {
  'use strict';
  var D = window.DATA, V = {};

  function clock() {
    var n = App.now();
    return '<div class="h-time num">' + App.fmt.time(n, false) + '<span class="h-ampm">' + App.fmt.ampm(n) + '</span></div>' +
      '<div class="h-date"><b>' + App.fmt.day(n) + '</b> ' + App.fmt.month(n) + ' ' + n.getDate() + '</div>';
  }

  function weather() {
    var w = App.weatherNow();
    var hours = App.hourly(7);
    var tmin = Math.min.apply(null, hours.map(function (h) { return h.t; }));
    var tmax = Math.max.apply(null, hours.map(function (h) { return h.t; }));
    return '<div class="h-wx-top">' +
      '<span class="h-wx-icon">' + App.icon(w.cond, 60) + '</span>' +
      '<span class="h-wx-temp num">' + w.temp + '°</span>' +
      '<span class="h-wx-meta"><b>' + w.label + '</b><span>H ' + w.hi + '°  L ' + w.lo + '°</span></span>' +
      airPill() +
      '</div>' +
      '<div class="h-wx-say"><b>' + w.summary + '.</b> ' + w.advice + '.</div>' +
      '<div class="h-wx-hours">' + hours.map(function (h) {
        var lift = tmax === tmin ? 0 : Math.round((h.t - tmin) / (tmax - tmin) * 8);
        return '<div class="h-hr' + (h.p >= 50 ? ' is-wet' : '') + '"><span class="h-hr-l">' + h.label + '</span>' +
          '<span class="h-hr-i" style="transform:translateY(' + -lift + 'px)">' + App.icon(h.c, 22) + '</span><b>' + h.t + '°</b></div>';
      }).join('') + '</div>';
  }

  // ---- air quality + pollen: a compact pill in the weather block, details in a sheet
  var AQI_COLORS = ['#2E9E5B', '#E3B505', '#F28C28', '#D93B30', '#8F3F97', '#7E0023'];
  var POLLEN_COLORS = ['#2E9E5B', '#9BBF2A', '#E3B505', '#F28C28', '#D93B30'];
  function dot(color) { return '<i class="h-air-dot" style="background:' + color + '"></i>'; }
  function airPill() {
    var A = D.air, a = A && A.air && A.air.now, p = A && A.pollen && A.pollen.today;
    if (!a && !p) return '';
    return '<button class="h-air" data-air>' +
      (a ? '<span>' + dot(AQI_COLORS[a.level]) + '<b>AQI</b> <span class="num">' + a.aqi + '</span></span>' : '') +
      (p ? '<span>' + dot(POLLEN_COLORS[p.level]) + '<b>Pollen</b> <span class="num">' + p.index.toFixed(1) + '</span></span>' : '') +
      '</button>';
  }
  function airSheet() {
    var A = D.air || {}, air = A.air, pol = A.pollen, esc = App.esc;
    var aCard = air
      ? '<div class="air-big"><span class="num" style="color:' + AQI_COLORS[air.now.level] + '">' + air.now.aqi + '</span><span><b>' + esc(air.now.label) + '</b>' +
        (air.now.main ? '<small>Mostly ' + esc(air.now.main.charAt(0).toLowerCase() + air.now.main.slice(1)) + '</small>' : '') + '</span></div>' +
        '<div class="air-rows">' + [['Today’s peak', air.today], ['Tomorrow’s peak', air.tomorrow]].filter(function (r) { return r[1]; }).map(function (r) {
          return '<div>' + dot(AQI_COLORS[r[1].level]) + '<span>' + r[0] + '</span><b class="num">' + r[1].aqi + '</b><small>' + esc(r[1].label) + '</small></div>';
        }).join('') + '</div>'
      : '<p class="air-err">' + esc(A.airError || 'Air quality unavailable') + '</p>';
    var pCard = pol
      ? '<div class="air-big"><span class="num" style="color:' + POLLEN_COLORS[pol.today.level] + '">' + pol.today.index.toFixed(1) + '</span><span><b>' + esc(pol.today.label) + '</b>' +
        (pol.today.triggers.length ? '<small>' + esc(pol.today.triggers.map(function (t) { return t.name; }).join(', ')) + '</small>' : '') + '</span></div>' +
        '<div class="air-days">' + pol.days.map(function (d, i) {
          var dt = new Date(d.date + 'T12:00:00');
          return '<div><span class="air-bar"><i style="height:' + Math.max(6, Math.round(d.index / 12 * 100)) + '%;background:' + POLLEN_COLORS[d.level] + '"></i></span>' +
            '<b class="num">' + d.index.toFixed(1) + '</b><small>' + (i === 0 ? 'Today' : App.fmt.dayShort(dt)) + '</small></div>';
        }).join('') + '</div>' +
        '<div class="air-rows">' + [['Asthma', pol.asthma && pol.asthma.today], ['Cold & flu', pol.cold && pol.cold.today]].filter(function (r) { return r[1]; }).map(function (r) {
          return '<div>' + dot(POLLEN_COLORS[r[1].level]) + '<span>' + r[0] + '</span><b class="num">' + r[1].index.toFixed(1) + '</b><small>' + esc(r[1].label) + '</small></div>';
        }).join('') + '</div>'
      : '<p class="air-err">' + esc(A.pollenError || 'Pollen forecast unavailable') + '</p>';
    App.sheet('<div class="sheet-pad air-sheet"><div class="label">Outside today</div>' +
      '<h2 class="display sheet-h">' + (air ? esc(air.now.label) + ' air' : 'Air') + (pol ? '<i>, ' + esc(pol.today.label.toLowerCase()) + ' pollen</i>' : '') + '</h2>' +
      '<div class="air-cols"><section class="card"><div class="label">Air quality · US AQI 0–500</div>' + aCard + '</section>' +
      '<section class="card"><div class="label">Pollen · 0–12</div>' + pCard + '</section></div>' +
      '<p class="air-src">Air quality: Open-Meteo forecast model. Pollen, asthma and cold & flu: pollen.com' + (pol ? ' for ' + esc(pol.zip) : '') + '.</p>' +
      '<div class="sheet-actions"><button class="btn btn--solid" data-close>Done</button></div></div>', { cls: 'sheet--wide' });
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
          (cal.state === 'empty' ? '<br><i>Add one in Settings.</i>' : '') + '</div></div>';
      }
      var tomorrow = App.timedOn(App.addDays(now, 1))[0];
      return '<div class="h-hero h-hero--empty" data-go="calendar">' +
        '<div class="label label--light">Rest of today</div>' +
        '<div class="h-hero-title display">Nothing else scheduled.<br><i>Enjoy the quiet.</i></div>' +
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
      '  <div class="h-hero-foot">' + (e.people.length > 1 ? App.dots(e.people, 22) : '') + leavePill + '</div>' +
      '</div>' + big + '</button>';
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

  function shopping() {
    var open = D.groceries.filter(function (g) { return !g.done; });
    var recent = open.slice(-3).reverse();
    return '<div class="label">Shopping</div>' +
      '<div class="h-stat"><span class="num">' + open.length + '</span><small>items to get</small></div>' +
      '<ul class="h-recent">' + recent.map(function (g) {
        return '<li><i></i>' + App.esc(g.name) + '</li>';
      }).join('') + '</ul>';
  }

  function status() {
    if (D.status.ha.state !== 'ok') {
      return '<div class="label">Home</div>' +
        '<div class="h-st-row">' + App.icon('sliders', 24) + '<span>' + (D.status.ha.state === 'connecting' ? 'Connecting…' : 'Home Assistant not connected') + '</span></div>';
    }
    var lights = D.devices.filter(function (d) { return d.type === 'light' && d.on; }).length;
    var unlocked = D.devices.filter(function (d) { return d.type === 'lock' && !d.locked; });
    var garage = D.devices.filter(function (d) { return d.type === 'garage' && d.state !== 'closed'; })[0];
    var secure = !unlocked.length && !garage;
    var secText = secure ? 'All locked' : (garage ? garage.name + ' ' + garage.state : unlocked[0].name + ' unlocked');
    return '<div class="label">Home</div>' +
      '<div class="h-st-row">' + App.icon('bulb', 24) + '<b class="num">' + lights + '</b><span>lights on</span></div>' +
      '<div class="h-st-row' + (secure ? '' : ' is-warn') + '">' + App.icon(secure ? 'lock' : 'unlock', 24) + '<span>' + App.esc(secText) + '</span></div>' +
      (D.climate && D.climate.current != null ? '<div class="h-st-row">' + App.icon('thermo', 24) + '<b class="num">' + D.climate.current + '°</b><span>inside</span></div>' : '');
  }

  function paint() {
    var el = V.el;
    el.querySelector('.h-clock').innerHTML = clock();
    el.querySelector('.h-weather').innerHTML = weather();
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
          '<div class="h-weather"></div>' +
          '<div class="h-presence"></div>' +
          '<div class="h-main"><div class="h-hero-slot"></div><div class="h-lanes"></div>' +
          '  <div class="h-duo"><button class="h-shop card" data-go="shopping"></button><button class="h-status card" data-go="control"></button></div>' +
          '</div>' +
          '<button class="h-photo" data-go="photos"><div class="h-photo-stage"></div><div class="h-photo-cap"></div></button>' +
          '</div>';
        el.addEventListener('click', function (e) {
          var ev = e.target.closest('[data-ev]');
          if (ev) { App.eventSheet(App.findEvent(ev.dataset.ev)); return; }
          if (e.target.closest('[data-air]')) { airSheet(); return; }
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
  // Every minute: just the clock and next-up countdown (cheap, even while hidden). Weather on the hour.
  App.on('minute', function (n) {
    if (!V.el || !V.el.firstChild) return;
    V.el.querySelector('.h-clock').innerHTML = clock();
    V.el.querySelector('.h-hero-slot').innerHTML = hero();
    if (n.getMinutes() === 0) { V.el.querySelector('.h-weather').innerHTML = weather(); V.el.querySelector('.h-lanes').innerHTML = lanes(); }
  });
  App.on('data', function () { if (App.current === 'home') paint(); });
  // Home Assistant updates (devices, presence) repaint only the parts that use them.
  App.on('ha', function () {
    if (!V.el || !V.el.firstChild) return;
    V.el.querySelector('.h-status').innerHTML = status();
    V.el.querySelector('.h-presence').innerHTML = presence();
  });
})();
