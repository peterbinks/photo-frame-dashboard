// Alerts (full-screen takeovers, banners) + keyboard shortcuts.
(function () {
  'use strict';
  var $ = App.$;

  // ------------------------------------------------------------ full-screen takeovers
  App.takeover = function (html, cls) {
    var el = $('#takeover');
    el.className = 'takeover ' + (cls || '');
    el.innerHTML = html;
    el.classList.add('is-open');
    App.closeSheet();
    if (App.mode !== 'day') App.setMode('day');
    return el;
  };
  App.closeTakeover = function () {
    var el = $('#takeover');
    el.classList.remove('is-open');
    el.innerHTML = '';
  };

  // ------------------------------------------------------------ banners (amber, actionable)
  App.banner = function (opts) {
    var box = $('#banners');
    var b = document.createElement('div');
    b.className = 'banner banner--' + (opts.tone || 'amber');
    b.innerHTML = App.icon(opts.icon || 'bell', 30) + '<div class="banner-text"><b>' + opts.title + '</b><span>' + (opts.sub || '') + '</span></div>' +
      (opts.action ? '<button class="banner-btn banner-btn--solid" data-act>' + opts.action + '</button>' : '') +
      '<button class="banner-btn" data-x>' + (opts.dismiss || 'Dismiss') + '</button>';
    box.appendChild(b);
    b.classList.add('is-in');
    function kill() { b.remove(); }
    b.querySelector('[data-x]').onclick = kill;
    if (opts.action) b.querySelector('[data-act]').onclick = function () { kill(); opts.onAction(); };
    if (opts.ms) setTimeout(kill, opts.ms);
    return kill;
  };

  // ------------------------------------------------------------ keyboard (desktop preview)
  App.on('ready', function () {
    document.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT') return;
      var k = e.key.toLowerCase();
      if (k === 'a') App.setMode('ambient');
      if (k === 'n') App.setMode('night');
      if (k === 'escape') App.closeSheet();
      var views = ['home', 'calendar', 'tasks', 'shopping', 'photos', 'control', 'settings'];
      if (k >= '1' && k <= '7') App.go(views[+k - 1]);
    });
  });
})();
