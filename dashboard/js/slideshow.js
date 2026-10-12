// Photo slideshow used by the Photos view, ambient mode and the home tile.
(function () {
  'use strict';
  var D = window.DATA;

  // Photos are proxied by the Worker (/api/photo/…) so they load from the dashboard's own origin.
  function src(p) { return p.url; }
  App.photoSrc = src;

  // ISO timestamp from iCloud → local calendar date on the frame
  function parseDate(p) { var d = new Date(p.date); return isNaN(d) ? App.now() : new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  App.photoMeta = function (p) {
    var d = parseDate(p), now = App.now();
    var years = now.getFullYear() - d.getFullYear();
    var onThisDay = d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    var kicker = onThisDay ? years + (years === 1 ? ' year' : ' years') + ' ago today' : (years > 0 ? years + (years === 1 ? ' year ago' : ' years ago') : 'This year');
    return {
      date: App.fmt.month(d) + ' ' + d.getDate() + ', ' + d.getFullYear(),
      monthYear: App.fmt.month(d) + ' ' + d.getFullYear(),
      kicker: kicker, onThisDay: onThisDay, place: p.place, from: App.person(p.from)
    };
  };

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  function caption(ps, size) {
    var m = App.photoMeta(ps[0]);
    return '<div class="cap cap--' + (size || 'l') + '">' +
      '<div class="cap-kicker">' + (m.onThisDay ? '<b>On this day</b> · ' : '') + m.kicker + ' · ' + App.esc(m.place) + '</div>' +
      '<div class="cap-date display">' + (ps.length > 1 ? m.monthYear : m.date) + '</div>' +
      '</div>';
  }
  function kb(p, still) {
    var dx = (Math.random() > 0.5 ? 1 : -1) * (1 + Math.random() * 2.5) + '%';
    var dy = (Math.random() > 0.5 ? 1 : -1) * (0.5 + Math.random() * 1.5) + '%';
    return '<div class="kb' + (still ? ' kb--still' : '') + '" style="--dx:' + dx + ';--dy:' + dy + '"><img src="' + src(p, true) + '" alt=""></div>';
  }

  var BUILD = {
    cover: function (ps, o) {
      var p = ps[0];
      if (p.o === 'p') {
        return '<div class="slide slide--fit"><img class="blurfill" src="' + src(p) + '" alt=""><img class="fitimg" src="' + src(p, true) + '" alt="">' + (o.captions ? caption(ps) : '') + '</div>';
      }
      return '<div class="slide slide--cover">' + kb(p) + (o.captions ? caption(ps) : '') + '</div>';
    },
    pair: function (ps, o) {
      return '<div class="slide slide--pair"><div class="pane">' + kb(ps[0], true) + '</div><div class="pane">' + kb(ps[1], true) + '</div>' + (o.captions ? caption(ps, 'm') : '') + '</div>';
    },
    collage: function (ps, o) {
      return '<div class="slide slide--collage"><div class="pane pane--a">' + kb(ps[0], true) + '</div><div class="pane pane--b">' + kb(ps[1], true) + '</div><div class="pane pane--c">' + kb(ps[2], true) + '</div>' + (o.captions ? caption(ps, 'm') : '') + '</div>';
    },
    polaroid: function (ps) {
      var p = ps[0], m = App.photoMeta(p), rot = (Math.random() * 5 - 2.5).toFixed(1);
      return '<div class="slide slide--polaroid"><img class="blurfill" src="' + src(p) + '" alt="">' +
        '<figure class="polaroid polaroid--' + p.o + '" style="transform:rotate(' + rot + 'deg)"><div class="polaroid-img"><img src="' + src(p, true) + '" alt=""></div>' +
        '<figcaption class="display"><i>' + App.esc(m.place) + ', ' + m.monthYear + '</i></figcaption></figure></div>';
    }
  };

  // Seconds per photo come from Settings → Display (App.display.slideSeconds).
  App.Slideshow = function (el, opts) {
    this.el = el;
    this.o = Object.assign({ layout: 'auto', captions: true, emptyText: true }, opts || {});
    this.queue = [];
    this.history = [];
    this.count = 0;
    this.timer = null;
    this.current = null;
    var self = this;
    // Photos arrive after boot (and refresh every 30 min): start showing them right away.
    App.on('photos', function () { if (self.timer && !self.current) self.next(); });
    // A new interval applies to running slideshows straight away.
    App.on('config', function () { if (self.timer) self.restart(); });
  };
  var S = App.Slideshow.prototype;

  S.refill = function () {
    var q = [];
    D.photos.forEach(function (p) { q.push(p); if (p.fav) q.push(p); });
    // On-this-day photos always come first in a fresh cycle
    shuffle(q).sort(function (a, b) { return (App.photoMeta(b).onThisDay ? 1 : 0) - (App.photoMeta(a).onThisDay ? 1 : 0); });
    this.queue = q;
  };
  S.take = function (pred) {
    if (!this.queue.length) this.refill();
    for (var i = 0; i < this.queue.length; i++) if (!pred || pred(this.queue[i])) return this.queue.splice(i, 1)[0];
    return null;
  };
  S.pick = function () {
    var layout = this.o.layout, n = this.count++;
    var first = this.take();
    if (!first) return null;
    var self = this;
    function sibling(pred) {
      return self.take(pred) || D.photos.filter(function (x) { return x !== first && pred(x); })[0];
    }
    if (layout === 'auto') {
      if (first.o === 'p') layout = D.photos.some(function (x) { return x !== first && x.tag === first.tag; }) ? 'pair' : 'polaroid';
      else layout = n % 5 === 3 ? 'collage' : n % 5 === 4 ? 'polaroid' : 'cover';
    }
    // Cover with pairPortraits: a portrait shares the screen with a second portrait (same batch if possible).
    if (layout === 'cover' && first.o === 'p' && this.o.pairPortraits) layout = 'pair';
    var ps = [first];
    if (layout === 'pair') {
      if (first.o !== 'p') { var portrait = sibling(function (x) { return x.o === 'p'; }); if (portrait) { first = portrait; ps = [first]; } }
      ps.push(sibling(function (x) { return x !== first && x.o === 'p' && x.tag === first.tag; }) || sibling(function (x) { return x !== first && x.o === 'p'; }));
    }
    if (layout === 'collage') {
      ps.push(sibling(function (x) { return x !== first; }));
      ps.push(sibling(function (x) { return ps.indexOf(x) < 0; }));
    }
    ps = ps.filter(Boolean);
    if ((layout === 'pair' && ps.length < 2) || (layout === 'collage' && ps.length < 3)) { layout = 'cover'; ps = ps.slice(0, 1); }
    return { layout: layout, photos: ps };
  };

  S.render = function (slide) {
    var self = this;
    this.current = slide;
    var wrap = document.createElement('div');
    wrap.innerHTML = BUILD[slide.layout](slide.photos, this.o);
    var node = wrap.firstChild;
    node.style.opacity = '0';
    // Fallback look if images can't load (offline)
    Array.prototype.forEach.call(node.querySelectorAll('img'), function (im) {
      im.addEventListener('error', function () { im.classList.add('is-broken'); });
    });
    var old = Array.prototype.slice.call(this.el.children);
    this.el.appendChild(node);
    var first = node.querySelector('img:not(.blurfill)');
    var shown = false;
    function show() {
      if (shown) return; shown = true;
      node.classList.add('is-in');
      node.style.opacity = '';
      old.forEach(function (o) { o.remove(); });
    }
    if (first && !first.complete) { first.addEventListener('load', show); first.addEventListener('error', show); setTimeout(show, 2500); }
    else show();
    if (this.o.onChange) this.o.onChange(slide);
  };

  S.next = function () {
    var s = this.pick();
    if (!s) {
      this.current = null;
      if (this.o.emptyText) {
        var st = D.status.photos;
        this.el.innerHTML = '<div class="ph-empty"><div><b class="display">' + (st.state === 'loading' ? 'Loading photos…' : App.esc(st.message || 'No photos yet')) + '</b>' +
          (st.state === 'empty' && !D.config.albums ? '<span>Add an iCloud shared album in <i>Settings</i></span>' : '') + '</div></div>';
      }
      this.restart();
      return;
    }
    if (this.current) this.history.push(this.current);
    this.render(s);
    this.restart();
  };
  S.prev = function () {
    if (!this.history.length) return;
    this.render(this.history.pop());
    this.restart();
  };
  S.setLayout = function (l) { this.o.layout = l; this.next(); };
  S.restart = function () {
    var self = this;
    clearInterval(this.timer);
    this.timer = setInterval(function () { self.next(); }, Math.max(5, App.display.slideSeconds || 15) * 1000);
  };
  S.start = function () { if (!this.current) this.next(); else this.restart(); };
  S.stop = function () { clearInterval(this.timer); this.timer = null; };
})();
