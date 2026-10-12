// Ambient (idle photo frame) and Night (dim red clock) overlays.
(function () {
  'use strict';
  var D = window.DATA, $ = App.$;
  var amb = { show: null }, shiftTimer = null;

  // Clock top-left; weather + next event bottom-right.
  function ambientInfo() {
    var n = App.now(), w = App.weatherNow(), next = App.nextEvent();
    return '<div class="amb-clock"><div class="amb-time num">' + App.fmt.time(n, false) + '</div>' +
      '<div class="amb-date">' + App.fmt.day(n) + ', ' + App.fmt.month(n) + ' ' + n.getDate() + '</div></div>' +
      '<div class="amb-right">' +
      '<div class="amb-wx">' + App.icon(w.cond, 44) + '<span class="num">' + w.temp + '°</span><small>' + w.summary + '</small></div>' +
      (next ? '<div class="amb-next" style="' + App.pstyle(App.evColor(next)) + '"><i></i>' + App.esc(next.title) + ' · ' + App.fmt.time(next.start) + '</div>' : '') +
      '</div>';
  }
  function nightInfo() {
    var n = App.now(), tomorrow = App.addDays(n, n.getHours() < 6 ? 0 : 1);
    var first = App.timedOn(tomorrow)[0], w = App.weatherNow();
    return '<div class="nt-time num">' + App.fmt.time(n, false) + '</div>' +
      '<div class="nt-line">' + App.icon(w.cond, 26) + ' ' + w.temp + '° · ' + (first ? 'First up ' + App.fmt.rel(first.start).toLowerCase() + ': <b>' + App.esc(first.title) + '</b> ' + App.fmt.time(first.start) + ' · ' + App.esc(App.person(first.people[0]).name) : 'Nothing early tomorrow') + '</div>' +
      locks();
  }
  // Only when Home Assistant reports locks
  function locks() {
    var list = D.devices.filter(function (d) { return d.type === 'lock'; });
    if (D.status.ha.state !== 'ok' || !list.length) return '';
    var open = list.filter(function (d) { return !d.locked; });
    return '<div class="nt-lock">' + App.icon(open.length ? 'unlock' : 'lock', 20) + ' ' + (open.length ? App.esc(open.map(function (d) { return d.name; }).join(', ')) + ' unlocked' : 'All doors locked') + '</div>';
  }

  function paint() {
    if (App.mode === 'ambient') $('#ambient .amb-info').innerHTML = ambientInfo();
    if (App.mode === 'night') $('#night .nt-inner').innerHTML = nightInfo();
  }

  // Nudge static content a few px every minute so nothing sits still for hours (image retention)
  function pixelShift() {
    var x = Math.round(Math.random() * 8 - 4), y = Math.round(Math.random() * 8 - 4);
    App.$$('.amb-info, .nt-inner').forEach(function (el) { el.style.transform = 'translate(' + x + 'px,' + y + 'px)'; });
  }

  App.on('ready', function () {
    $('#ambient').innerHTML = '<div class="amb-stage"></div><div class="amb-scrim"></div><div class="amb-info"></div>';
    $('#night').innerHTML = '<div class="nt-inner"></div>';
    amb.show = new App.Slideshow($('#ambient .amb-stage'), { layout: 'cover', captions: false });
    $('#ambient').addEventListener('click', function () { App.setMode('day'); App.go('home'); });
    $('#night').addEventListener('click', function () { App.setMode('nightdash'); });
  });

  App.on('mode', function (m) {
    clearInterval(shiftTimer);
    if (m === 'ambient') { amb.show.start(); paint(); shiftTimer = setInterval(pixelShift, 60000); }
    else amb.show.stop();
    if (m === 'night') { paint(); shiftTimer = setInterval(pixelShift, 60000); }
    App.resetIdle();
  });
  App.on('minute', paint);
})();
