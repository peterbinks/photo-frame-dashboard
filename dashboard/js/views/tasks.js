// Tasks / chores: one lane per person + "Anyone", scoped to the current time-of-day routine.
(function () {
  'use strict';
  var D = window.DATA;
  var V = { el: null, routine: null, pending: {}, held: 0 };
  // Kids (Settings → Family) earn stars; a person switched off as a kid keeps their count for later.
  function isKid(id) { var p = App.person(id); return p.id === id && !!p.kid && D.stars[id] != null; }
  function lanes() { return D.people.map(function (p) { return p.id; }).concat(['any']); }

  function routine() { return V.routine ? D.routines.filter(function (r) { return r.id === V.routine; })[0] : App.currentRoutine(); }
  function listFor(who, r) {
    return D.chores.filter(function (c) { return c.r === r.id && c.who === who; })
      .sort(function (a, b) { return (a.done - b.done) || ((b.overdue ? 1 : 0) - (a.overdue ? 1 : 0)); });
  }

  function row(c, p) {
    var pend = V.pending[c.id];
    return '<button class="ch' + (c.done ? ' is-done' : '') + (pend ? ' is-checking' : '') + (c.overdue && !c.done ? ' is-overdue' : '') + '" data-ch="' + c.id + '">' +
      '<span class="ch-emoji">' + c.emoji + '<span class="ch-check"><svg viewBox="0 0 24 24" width="30" height="30"><path d="M5 12.5l4.5 4.5L19 7"/></svg></span></span>' +
      '<span class="ch-text"><b>' + App.esc(c.title) + '</b>' +
      (c.overdue && !c.done ? '<small class="ch-late">Overdue</small>' : c.stars ? '<small>' + App.icon('star', 14, 'i--fill') + c.stars + (c.doneBy ? ' · ' + App.person(c.doneBy).name : '') + '</small>' : (c.doneBy ? '<small>by ' + App.person(c.doneBy).name + '</small>' : '')) +
      '</span>' +
      '</button>';
  }

  function weekGrid(id) {
    var w = D.week[id];
    if (!w || !isKid(id)) return '';
    var today = (App.now().getDay() + 6) % 7;
    return '<div class="ch-week"><div class="label">This week</div><div class="ch-week-row">' + ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(function (d, i) {
      var cls = i > today ? 'is-future' : i === today ? 'is-today' : (w[i] ? 'is-hit' : 'is-miss');
      return '<span class="' + cls + '"><i></i>' + d + '</span>';
    }).join('') + '</div></div>';
  }

  function lane(who, r) {
    var p = App.person(who), list = listFor(who, r);
    var done = list.filter(function (c) { return c.done; }).length;
    var all = list.length && done === list.length;
    var kid = isKid(who);
    return '<section class="ch-lane' + (all ? ' is-complete' : '') + '" data-lane="' + who + '" style="' + App.pstyle(p) + '">' +
      '<header class="ch-head">' + App.avatar(p, 42) +
      '<div><b>' + (who === 'any' ? 'Anyone' : App.esc(p.name)) + '</b>' +
      (kid ? '<span class="ch-stars">' + App.icon('star', 18, 'i--fill') + '<span class="num">' + D.stars[who] + '</span></span>' : '<span class="ch-sub">' + (who === 'any' ? 'Up for grabs' : (list.length ? done + ' of ' + list.length : 'Nothing')) + '</span>') + '</div>' +
      '<div class="ch-ring">' + App.ring(done, list.length || 1, 46) + '<span class="num">' + (all ? '✓' : list.length ? done + '/' + list.length : '–') + '</span></div>' +
      '</header>' +
      '<div class="ch-list">' + (list.length ? list.map(function (c) { return row(c, p); }).join('') : '<div class="ch-none serif"><i>Nothing this ' + (r.id === 'evening' ? 'evening' : r.id === 'morning' ? 'morning' : 'afternoon') + '</i></div>') +
      (all ? '<div class="ch-alldone serif">All done<i>!</i></div>' : '') + '</div>' +
      weekGrid(who) +
      '</section>';
  }

  function render() {
    var r = routine(), auto = App.currentRoutine();
    var inR = D.chores.filter(function (c) { return c.r === r.id; });
    var done = inR.filter(function (c) { return c.done; }).length;
    V.el.innerHTML = '<div class="tasks">' +
      '<header class="t-head">' +
      '<div class="t-title"><div class="label">' + (r.id === auto.id ? 'Right now · ' : '') + r.range + '</div><h1 class="serif">' + r.name + '</h1></div>' +
      '<div class="seg">' + D.routines.map(function (x) { return '<button class="' + (x.id === r.id ? 'is-on' : '') + '" data-r="' + x.id + '">' + x.name + '</button>'; }).join('') + '</div>' +
      '<div class="t-progress"><span class="num">' + done + '<small>/' + inR.length + '</small></span><div class="t-bar"><i style="width:' + (inR.length ? done / inR.length * 100 : 0) + '%"></i></div><span class="label">done</span></div>' +
      '<button class="fab" data-add aria-label="Add a chore">' + App.icon('plus', 26) + '</button>' +
      '</header>' +
      '<div class="ch-lanes">' + lanes().map(function (w) { return lane(w, r); }).join('') + '</div>' +
      '</div>';
    // Press and hold a chore to remove it
    App.$$('[data-ch]', V.el).forEach(function (b) {
      App.hold(b, 800, { done: function () { V.held = Date.now(); removeSheet(b.dataset.ch); } });
    });
  }

  // Unicode ≤ 8 only: the frame's Android 6 emoji font has no newer glyphs.
  var EMOJI = ['🛏️', '😁', '👕', '🎒', '📚', '📖', '🎹', '🏠', '🍴', '🍽️', '👖', '🗑️', '♻️', '🐶', '🌱', '✨', '🚿', '🛁'];
  function addSheet() {
    var r = routine();
    var st = { who: 'any', r: r.id, emoji: EMOJI[0], stars: 1 };
    function chips(key, items) {
      return '<div class="chips">' + items.map(function (it) {
        return '<button class="chip' + (String(st[key]) === String(it[0]) ? ' is-on' : '') + '" data-' + key + '="' + it[0] + '">' + it[1] + '</button>';
      }).join('') + '</div>';
    }
    App.sheet(
      '<div class="sheet-pad add">' +
      '<div class="label">New chore</div>' +
      '<input class="big-input serif" placeholder="What needs doing?" data-f="title">' +
      '<div class="label">Icon</div>' + chips('emoji', EMOJI.map(function (e) { return [e, e]; })) +
      '<div class="label">Who</div><div class="add-who">' + D.people.map(function (p) {
        return '<button class="who-btn" data-who="' + p.id + '" style="' + App.pstyle(p) + '">' + App.avatar(p, 56) + '<span>' + App.esc(p.name) + '</span></button>';
      }).join('') + '<button class="who-btn is-on" data-who="any" style="' + App.pstyle(D.family) + '">' + App.avatar(D.family, 56) + '<span>Anyone</span></button></div>' +
      '<div class="add-row"><div><div class="label">When</div>' + chips('r', D.routines.map(function (x) { return [x.id, x.name]; })) + '</div>' +
      '<div><div class="label">Stars</div>' + chips('stars', [[0, 'None'], [1, '1 ★'], [2, '2 ★'], [3, '3 ★']]) + '</div></div>' +
      '<div class="sheet-actions"><button class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--solid" data-save>Add chore</button></div>' +
      '</div>', {
      cls: 'sheet--wide',
      onMount: function (s, close) {
        var input = s.querySelector('[data-f=title]');
        s.addEventListener('click', function (ev) {
          var t = ev.target.closest('button');
          if (!t) return;
          ['emoji', 'r', 'stars', 'who'].forEach(function (k) {
            if (t.dataset[k] == null) return;
            st[k] = k === 'stars' ? +t.dataset[k] : t.dataset[k];
            App.$$('[data-' + k + ']', s).forEach(function (b) { b.classList.toggle('is-on', b === t); });
          });
          if (t.hasAttribute('data-save')) {
            var title = input.value.trim();
            if (!title) { input.focus(); return; }
            D.chores.push({ id: D._cid(), r: st.r, who: st.who, title: title, emoji: st.emoji, stars: st.stars, done: false });
            close();
            V.routine = st.r === App.currentRoutine().id ? null : st.r;
            render();
            App.emit('data');
            App.toast('Added <b>' + App.esc(title) + '</b>', { icon: 'check', ms: 2500 });
          }
        });
      }
    });
  }

  function removeSheet(id) {
    var c = D.chores.filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    App.sheet('<div class="sheet-pad"><div class="label">' + c.emoji + ' ' + (c.who === 'any' ? 'Anyone' : App.esc(App.person(c.who).name)) + '</div>' +
      '<h2 class="serif sheet-h">Remove “' + App.esc(c.title) + '”?</h2>' +
      '<div class="sheet-actions"><button class="btn btn--ghost" data-close>Keep it</button><button class="btn btn--solid" data-remove>Remove chore</button></div></div>', {
      onMount: function (s, close) {
        s.querySelector('[data-remove]').onclick = function () {
          var at = D.chores.indexOf(c);
          D.chores = D.chores.filter(function (x) { return x !== c; });
          close();
          render();
          App.emit('data');
          App.toast('Removed <b>' + App.esc(c.title) + '</b>', {
            icon: 'check', undo: function () { D.chores.splice(Math.min(at, D.chores.length), 0, c); render(); App.emit('data'); }
          });
        };
      }
    });
  }

  function complete(c, btn, by) {
    var r = routine();
    V.pending[c.id] = true;
    btn.classList.add('is-checking');
    setTimeout(function () {
      delete V.pending[c.id];
      c.done = true;
      if (by) c.doneBy = by;
      var earner = isKid(c.who) ? c.who : (by && isKid(by) ? by : null);
      if (earner && c.stars) D.stars[earner] += c.stars;
      render();
      App.emit('data');
      var laneList = listFor(c.who, r);
      var laneDone = laneList.every(function (x) { return x.done; });
      var allDone = D.chores.filter(function (x) { return x.r === r.id; }).every(function (x) { return x.done; });
      if (allDone) {
        App.toast('<b>' + r.name + ' routine complete!</b> Everyone crushed it.', { icon: 'star', ms: 5000 });
        return;
      }
      App.toast('<b>' + App.esc(c.title) + '</b> done' + (earner && c.stars ? ' · +' + c.stars + '★ ' + App.person(earner).name : ''), {
        icon: 'check',
        undo: function () {
          c.done = false;
          delete c.doneBy;
          if (earner && c.stars) D.stars[earner] -= c.stars;
          render();
          App.emit('data');
        }
      });
    }, 350);
  }

  // "Anyone" chores ask who did it, so stars go to the right kid
  function whoDidIt(c, btn) {
    App.sheet('<div class="sheet-pad"><div class="label">' + c.emoji + ' ' + App.esc(c.title) + '</div><h2 class="serif sheet-h">Who did it?</h2>' +
      '<div class="add-who add-who--big">' + D.people.map(function (p) {
        return '<button class="who-btn" data-by="' + p.id + '" style="' + App.pstyle(p) + '">' + App.avatar(p, 88) + '<span>' + App.esc(p.name) + '</span></button>';
      }).join('') + '</div></div>', {
      onMount: function (s, close) {
        s.addEventListener('click', function (e) {
          var b = e.target.closest('[data-by]');
          if (!b) return;
          close();
          var fresh = V.el.querySelector('[data-ch="' + c.id + '"]');
          complete(c, fresh || btn, b.dataset.by);
        });
      }
    });
  }

  function onClick(e) {
    var t;
    if ((t = e.target.closest('[data-r]'))) { V.routine = t.dataset.r === App.currentRoutine().id ? null : t.dataset.r; return render(); }
    if ((t = e.target.closest('[data-add]'))) return addSheet();
    if ((t = e.target.closest('[data-ch]'))) {
      if (Date.now() - V.held < 800) return;
      var c = D.chores.filter(function (x) { return x.id === t.dataset.ch; })[0];
      if (!c || V.pending[c.id]) return;
      if (c.done) {
        c.done = false;
        var earner = isKid(c.who) ? c.who : (c.doneBy && isKid(c.doneBy) ? c.doneBy : null);
        if (earner && c.stars) D.stars[earner] -= c.stars;
        delete c.doneBy;
        render();
        App.emit('data');
        return;
      }
      if (c.who === 'any') return whoDidIt(c, t);
      complete(c, t);
    }
  }

  App.register('tasks', {
    show: function (el) {
      if (!V.el) { V.el = el; el.addEventListener('click', onClick); }
      render();
    }
  });
  App.on('time', function () { V.routine = null; });
})();
