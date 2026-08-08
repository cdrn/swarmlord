/**
 * The swarm's healbot: a single-file HTML page for watching the hive work.
 * Served verbatim by src/viewer/server.ts at GET /. No frameworks, no CDN —
 * everything inline. The embedded script deliberately avoids backticks and
 * template interpolation so the whole page can live in one template literal.
 */

export const VIEWER_HTML: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>swarmlord</title>
<style>
  :root {
    --bg: #0d0a12;
    --panel: #161020;
    --panel-2: #1c1428;
    --border: #2c2140;
    --border-bright: #43315e;
    --text: #cfc5e0;
    --dim: #7d6f96;
    --faint: #4e4463;
    --green: #7dff5e;
    --green-dim: #3f8c2f;
    --magenta: #e13fae;
    --amber: #e8b44f;
    --cyan: #4fd8e8;
    --blue: #6f86c9;
    --red: #ff5e5e;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: ui-monospace, 'JetBrains Mono', Menlo, Consolas, monospace;
    font-size: 13px;
    overflow: hidden;
  }
  /* faint scanlines over everything */
  body::after {
    content: '';
    position: fixed; inset: 0;
    pointer-events: none;
    background: repeating-linear-gradient(0deg, rgba(0,0,0,0.14) 0 1px, transparent 1px 3px);
    opacity: 0.5;
    z-index: 99;
  }

  /* ---- header ---- */
  header {
    display: flex; align-items: center; gap: 18px;
    height: 46px; padding: 0 16px;
    background: linear-gradient(180deg, #17102a, #120c1c);
    border-bottom: 1px solid var(--border-bright);
  }
  .wordmark {
    font-weight: 800; letter-spacing: 4px; font-size: 15px;
    color: var(--green);
    text-shadow: 0 0 8px rgba(125,255,94,0.45);
    user-select: none;
  }
  .wordmark em { color: var(--magenta); font-style: normal; text-shadow: 0 0 8px rgba(225,63,174,0.5); }
  .vitals { display: flex; align-items: center; gap: 18px; flex: 1; min-width: 0; }
  .vital { display: flex; align-items: center; gap: 6px; color: var(--dim); font-size: 11px; white-space: nowrap; }
  .vital b { color: var(--text); font-weight: 600; }
  .turnbar { width: 120px; height: 4px; background: #241a36; border: 1px solid var(--border); }
  .turnbar i {
    display: block; height: 100%; width: 0%;
    background: linear-gradient(90deg, var(--green-dim), var(--green));
    transition: width .4s ease;
  }
  .turnbar.hot i { background: linear-gradient(90deg, #8c5a2f, var(--amber)); }
  .conn { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--dim); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--faint); }
  .dot.live { background: var(--green); box-shadow: 0 0 7px var(--green); animation: breathe 2.4s ease-in-out infinite; }
  .dot.recon { background: var(--amber); box-shadow: 0 0 7px var(--amber); animation: blink .7s steps(2) infinite; }
  @keyframes breathe { 50% { opacity: .55; } }
  @keyframes blink { 50% { opacity: .2; } }

  /* ---- layout ---- */
  main { display: flex; height: calc(100% - 46px); }
  #brood {
    width: 340px; min-width: 260px; flex-shrink: 0;
    border-right: 1px solid var(--border);
    background: var(--panel);
    overflow-y: auto; padding: 10px;
  }
  #boardcol { flex: 1; display: flex; flex-direction: column; min-width: 0; }

  .coltitle {
    font-size: 10px; letter-spacing: 3px; color: var(--faint);
    padding: 2px 2px 8px; user-select: none;
  }

  /* ---- brood frames ---- */
  .frame {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-left: 3px solid var(--faint);
    padding: 7px 9px; margin-bottom: 8px;
    animation: spawn-in .35s ease-out;
    position: relative;
    transition: border-color .3s, opacity .3s;
  }
  @keyframes spawn-in {
    from { opacity: 0; transform: translateX(-14px); }
    to   { opacity: 1; transform: none; }
  }
  .frame.st-ready { border-left-color: var(--green); }
  .frame.st-idle  { border-left-color: #b08a2e; opacity: .75; }
  .frame.st-done  { border-left-color: var(--blue); opacity: .5; filter: saturate(.4); }
  .frame.thinking { animation: frame-pulse 1.4s ease-in-out infinite; }
  @keyframes frame-pulse {
    0%, 100% { box-shadow: 0 0 0 rgba(125,255,94,0); border-color: var(--border); }
    50%      { box-shadow: 0 0 10px rgba(125,255,94,0.22); border-color: rgba(125,255,94,0.45); }
  }
  .frame.flash { animation: frame-flash .5s ease-out; }
  @keyframes frame-flash {
    0%   { background: rgba(225,63,174,0.28); }
    100% { background: var(--panel-2); }
  }
  .fhead { display: flex; align-items: baseline; gap: 7px; }
  .fname { font-weight: 700; color: var(--text); }
  .frole { color: var(--dim); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .fstatus { font-size: 10px; letter-spacing: 1px; }
  .st-ready .fstatus { color: var(--green); }
  .st-idle  .fstatus { color: #b08a2e; }
  .st-done  .fstatus { color: var(--blue); }
  .factivity {
    color: var(--dim); font-size: 11px; margin-top: 4px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .fmeta { display: flex; gap: 10px; margin-top: 4px; font-size: 10px; color: var(--faint); align-items: center; }
  .wakes {
    background: rgba(225,63,174,0.18); color: var(--magenta);
    border: 1px solid rgba(225,63,174,0.5);
    padding: 0 5px; border-radius: 8px; font-size: 10px;
  }
  .ptag { color: var(--faint); }
  .empty { color: var(--faint); text-align: center; padding: 28px 8px; font-size: 12px; }

  /* ---- board ---- */
  #pinstrip {
    display: none; padding: 7px 12px;
    background: rgba(125,255,94,0.05);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap; gap: 6px;
  }
  #pinstrip.haspins { display: flex; }
  .pinchip {
    border: 1px solid rgba(125,255,94,0.4); color: var(--green);
    background: rgba(125,255,94,0.07);
    padding: 2px 8px; font-size: 11px;
    max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .pinchip .by { color: var(--dim); }

  #boardbar {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; border-bottom: 1px solid var(--border);
    background: var(--panel); flex-wrap: wrap;
  }
  .tab {
    background: none; border: 1px solid var(--border); color: var(--dim);
    font: inherit; font-size: 11px; padding: 3px 9px; cursor: pointer;
  }
  .tab:hover { border-color: var(--border-bright); color: var(--text); }
  .tab.active { border-color: var(--magenta); color: var(--magenta); background: rgba(225,63,174,0.08); }
  .tab .cnt { color: var(--faint); margin-left: 4px; }
  #filter {
    margin-left: auto; background: var(--bg); color: var(--text);
    border: 1px solid var(--border); font: inherit; font-size: 11px;
    padding: 3px 8px; width: 180px; outline: none;
  }
  #filter:focus { border-color: var(--green-dim); }
  #followbtn {
    background: none; border: 1px solid var(--border); color: var(--faint);
    font: inherit; font-size: 10px; letter-spacing: 1px; padding: 3px 9px; cursor: pointer;
  }
  #followbtn.on { color: var(--green); border-color: var(--green-dim); }

  #feed { flex: 1; overflow-y: auto; padding: 6px 0 24px; }
  .evt {
    display: grid;
    grid-template-columns: 52px 110px 110px 130px 1fr;
    gap: 8px; padding: 4px 12px;
    border-bottom: 1px solid #171024;
    align-items: baseline;
    animation: row-in .25s ease-out;
  }
  @keyframes row-in { from { opacity: 0; } to { opacity: 1; } }
  .evt:hover { background: rgba(255,255,255,0.02); }
  .eid { color: var(--faint); font-size: 11px; text-align: right; }
  .badge {
    font-size: 10px; letter-spacing: .5px; text-align: center;
    border: 1px solid; padding: 1px 4px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .t-post           { color: var(--green);   border-color: rgba(125,255,94,0.4); }
  .t-spawned        { color: var(--magenta); border-color: rgba(225,63,174,0.5); }
  .t-claimed, .t-claim_released { color: #e8b44f; border-color: rgba(232,180,79,0.4); }
  .t-channel_created, .t-channel_merged { color: var(--cyan); border-color: rgba(79,216,232,0.4); }
  .t-agent_idle, .t-agent_done  { color: var(--faint); border-color: var(--border); }
  .t-pinned, .t-unpinned        { color: #d6ff5e; border-color: rgba(214,255,94,0.5); }
  .t-system         { color: var(--red); border-color: rgba(255,94,94,0.5); }
  .eagent { color: var(--text); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .echan { color: var(--cyan); font-size: 11px; opacity: .8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ebody {
    color: var(--dim); font-size: 12px; line-height: 1.45;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
    overflow: hidden; overflow-wrap: anywhere; white-space: pre-wrap;
    cursor: pointer;
  }
  .ebody.open { display: block; -webkit-line-clamp: unset; color: var(--text); }
  .duplink { color: var(--faint); font-size: 10px; }

  ::-webkit-scrollbar { width: 8px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--border); }
  ::-webkit-scrollbar-thumb:hover { background: var(--border-bright); }
</style>
</head>
<body>
<header>
  <div class="wordmark">SWARM<em>LORD</em></div>
  <div class="vitals">
    <div class="vital"><span>turns</span><div class="turnbar" id="turnbar"><i></i></div><b id="turnnum">0/0</b></div>
    <div class="vital"><span>brood</span><b id="agentnum">0/0</b></div>
    <div class="vital"><span>events</span><b id="eventnum">0</b></div>
  </div>
  <div class="conn"><span id="connlabel">connecting</span><span class="dot" id="conndot"></span></div>
</header>
<main>
  <section id="brood">
    <div class="coltitle">BROOD</div>
    <div id="frames"></div>
    <div class="empty" id="broodEmpty">the hive is quiet</div>
  </section>
  <section id="boardcol">
    <div id="pinstrip"></div>
    <div id="boardbar">
      <span id="tabs"></span>
      <button id="followbtn" class="on" title="auto-scroll to newest">FOLLOWING</button>
      <input id="filter" type="text" placeholder="filter…" spellcheck="false">
    </div>
    <div id="feed">
      <div class="empty" id="feedEmpty">no events yet</div>
    </div>
  </section>
</main>
<script>
(function () {
  'use strict';

  var lastSeenId = 0;
  var following = true;
  var feedHover = false;
  var activeChannel = null;      // null = All
  var filterText = '';
  var frames = {};               // agent name -> { el, activityEl, turnsEl, wakesEl, statusEl }
  var eventsById = {};           // id -> SwarmEvent (for pin body lookup)
  var channelSig = '';
  var lastState = null;
  var es = null;
  var reconnects = 0;
  var MAX_ROWS = 3000;

  var $ = function (id) { return document.getElementById(id); };
  var feed = $('feed');
  var framesEl = $('frames');

  // ---------- connection dot ----------
  function setConn(mode) {
    var dot = $('conndot'), label = $('connlabel');
    dot.className = 'dot' + (mode === 'live' ? ' live' : mode === 'recon' ? ' recon' : '');
    label.textContent = mode === 'live' ? 'live' : mode === 'recon' ? 'reconnecting' : 'connecting';
  }

  // ---------- vitals ----------
  function renderVitals(snap) {
    var pct = snap.maxTotalTurns > 0 ? (snap.turnsTaken / snap.maxTotalTurns) * 100 : 0;
    var bar = $('turnbar');
    bar.firstElementChild.style.width = Math.min(100, pct) + '%';
    bar.className = 'turnbar' + (pct > 80 ? ' hot' : '');
    $('turnnum').textContent = snap.turnsTaken + '/' + snap.maxTotalTurns;
    $('agentnum').textContent = snap.agents.length + '/' + snap.maxAgents;
    $('eventnum').textContent = String(snap.lastEventId);
  }

  // ---------- brood frames ----------
  function statusLabel(s) {
    return s === 'ready' ? 'READY' : s === 'idle' ? 'IDLE' : 'DONE';
  }

  function makeFrame(a) {
    var el = document.createElement('div');
    el.className = 'frame';
    var head = document.createElement('div'); head.className = 'fhead';
    var nm = document.createElement('span'); nm.className = 'fname'; nm.textContent = a.name;
    var role = document.createElement('span'); role.className = 'frole'; role.textContent = a.role; role.title = a.role;
    var st = document.createElement('span'); st.className = 'fstatus';
    head.appendChild(nm); head.appendChild(role); head.appendChild(st);
    var act = document.createElement('div'); act.className = 'factivity';
    var meta = document.createElement('div'); meta.className = 'fmeta';
    var turns = document.createElement('span');
    var wakes = document.createElement('span'); wakes.className = 'wakes'; wakes.style.display = 'none';
    meta.appendChild(turns); meta.appendChild(wakes);
    if (a.parent) {
      var pt = document.createElement('span'); pt.className = 'ptag';
      pt.textContent = '\\u2190 ' + a.parent;
      meta.appendChild(pt);
    }
    el.appendChild(head); el.appendChild(act); el.appendChild(meta);
    framesEl.appendChild(el);
    return { el: el, activityEl: act, turnsEl: turns, wakesEl: wakes, statusEl: st };
  }

  function patchFrame(f, a) {
    var thinking = a.status === 'ready' && a.lastActivity.indexOf('thinking') === 0;
    var cls = 'frame st-' + a.status + (thinking ? ' thinking' : '');
    if (f.el.classList.contains('flash')) cls += ' flash';
    f.el.className = cls;
    f.statusEl.textContent = statusLabel(a.status);
    if (f.activityEl.textContent !== a.lastActivity) {
      f.activityEl.textContent = a.lastActivity;
      f.activityEl.title = a.lastActivity;
    }
    f.turnsEl.textContent = a.turns + ' turn' + (a.turns === 1 ? '' : 's');
    if (a.pendingWakes > 0) {
      f.wakesEl.style.display = '';
      f.wakesEl.textContent = a.pendingWakes + ' wake' + (a.pendingWakes === 1 ? '' : 's');
    } else {
      f.wakesEl.style.display = 'none';
    }
    if (a.summary && a.status === 'done') f.el.title = a.summary;
  }

  function renderAgents(list) {
    $('broodEmpty').style.display = list.length === 0 ? '' : 'none';
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      var f = frames[a.name];
      if (!f) { f = makeFrame(a); frames[a.name] = f; }
      patchFrame(f, a);
    }
  }

  function flashFrame(name) {
    var f = frames[name];
    if (!f) return;
    f.el.classList.remove('flash');
    void f.el.offsetWidth;             // restart animation
    f.el.classList.add('flash');
    setTimeout(function () { f.el.classList.remove('flash'); }, 550);
  }

  // ---------- channel tabs ----------
  function renderTabs(channels) {
    var sig = channels.map(function (c) { return c.name + ':' + c.eventCount; }).join('|');
    if (sig === channelSig) return;
    channelSig = sig;
    var tabs = $('tabs');
    tabs.textContent = '';
    var mk = function (label, count, key) {
      var b = document.createElement('button');
      b.className = 'tab' + (activeChannel === key ? ' active' : '');
      b.textContent = label;
      if (count !== null) {
        var c = document.createElement('span'); c.className = 'cnt'; c.textContent = String(count);
        b.appendChild(c);
      }
      b.onclick = function () { activeChannel = key; channelSig = ''; renderTabs(channels); applyFilter(); };
      tabs.appendChild(b);
    };
    mk('All', null, null);
    for (var i = 0; i < channels.length; i++) {
      var ch = channels[i];
      mk('#' + ch.name, ch.eventCount, ch.name);
    }
  }

  // ---------- pins ----------
  function renderPins(pins) {
    var strip = $('pinstrip');
    strip.className = pins.length > 0 ? 'haspins' : '';
    strip.textContent = '';
    for (var i = 0; i < pins.length; i++) {
      var p = pins[i];
      var chip = document.createElement('span');
      chip.className = 'pinchip';
      var evt = eventsById[p.eventId];
      var excerpt = evt ? evt.body.replace(/\\s+/g, ' ').slice(0, 90) : '';
      chip.textContent = '\\ud83d\\udccc #' + p.eventId + (excerpt ? ' ' + excerpt : '') + ' ';
      var by = document.createElement('span'); by.className = 'by'; by.textContent = '(' + p.agent + ')';
      chip.appendChild(by);
      if (evt) chip.title = evt.body;
      strip.appendChild(chip);
    }
  }

  // ---------- feed ----------
  function rowMatches(row) {
    if (activeChannel !== null && row.dataset.channel !== activeChannel) return false;
    if (filterText !== '' && row.dataset.search.indexOf(filterText) === -1) return false;
    return true;
  }

  function applyFilter() {
    var rows = feed.children;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.classList.contains('evt')) r.style.display = rowMatches(r) ? '' : 'none';
    }
    maybeScroll();
  }

  function appendEvent(evt) {
    if (evt.id <= lastSeenId) return;
    lastSeenId = evt.id;
    eventsById[evt.id] = evt;
    $('feedEmpty').style.display = 'none';

    var row = document.createElement('div');
    row.className = 'evt';
    row.dataset.channel = evt.channel || '';
    row.dataset.search = (evt.agent + ' ' + evt.type + ' ' + (evt.channel || '') + ' ' + evt.body + ' ' + evt.tags.join(' ')).toLowerCase();

    var id = document.createElement('span'); id.className = 'eid'; id.textContent = '#' + evt.id;
    var badge = document.createElement('span'); badge.className = 'badge t-' + evt.type; badge.textContent = evt.type; badge.title = evt.type;
    var ag = document.createElement('span'); ag.className = 'eagent'; ag.textContent = evt.agent; ag.title = evt.agent;
    var ch = document.createElement('span'); ch.className = 'echan';
    ch.textContent = evt.channel ? '#' + evt.channel : '';
    if (evt.channel) ch.title = '#' + evt.channel;
    var body = document.createElement('div'); body.className = 'ebody'; body.textContent = evt.body;
    body.title = 'click to expand';
    body.onclick = function () { body.classList.toggle('open'); };
    if (evt.duplicateOf !== null) {
      var dup = document.createElement('span'); dup.className = 'duplink';
      dup.textContent = ' \\u21a9 dup of #' + evt.duplicateOf;
      body.appendChild(dup);
    }

    row.appendChild(id); row.appendChild(badge); row.appendChild(ag); row.appendChild(ch); row.appendChild(body);
    if (!rowMatches(row)) row.style.display = 'none';
    feed.appendChild(row);

    // keep the DOM bounded
    while (feed.children.length > MAX_ROWS + 1) {
      var first = feed.children[1]; // children[0] is the empty-state div
      if (!first) break;
      feed.removeChild(first);
    }

    flashFrame(evt.agent);
  }

  function maybeScroll() {
    if (following && !feedHover) feed.scrollTop = feed.scrollHeight;
  }

  // ---------- state merge ----------
  function applyState(state) {
    lastState = state;
    renderVitals(state.snapshot);
    renderAgents(state.snapshot.agents);
    renderTabs(state.channels);
    renderPins(state.pins);
  }

  // ---------- data plumbing ----------
  function fetchJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + url);
      return r.json();
    });
  }

  function fetchMissed() {
    return fetchJSON('/api/events?since_id=' + lastSeenId + '&limit=500').then(function (evts) {
      for (var i = 0; i < evts.length; i++) appendEvent(evts[i]);
      if (evts.length === 500) return fetchMissed();  // page through a big gap
      maybeScroll();
    });
  }

  function openStream() {
    if (es) { es.close(); es = null; }
    es = new EventSource('/api/stream?since_id=' + lastSeenId);
    es.addEventListener('tick', function (msg) {
      reconnects = 0;
      setConn('live');
      var data;
      try { data = JSON.parse(msg.data); } catch (e) { return; }
      applyState(data.state);
      for (var i = 0; i < data.events.length; i++) appendEvent(data.events[i]);
      if (data.events.length > 0) { renderPins(data.state.pins); maybeScroll(); }
    });
    es.onopen = function () { setConn('live'); };
    es.onerror = function () {
      setConn('recon');
      if (es) { es.close(); es = null; }
      var delay = Math.min(400 * Math.pow(2, reconnects++), 10000);
      setTimeout(function () {
        fetchJSON('/api/state')
          .then(function (state) { applyState(state); return fetchMissed(); })
          .then(function () { openStream(); })
          .catch(function () { es = null; setConn('recon'); openStream_retry(); });
      }, delay);
    };
  }

  function openStream_retry() {
    var delay = Math.min(400 * Math.pow(2, reconnects++), 10000);
    setTimeout(openStream, delay);
  }

  // ---------- controls ----------
  $('followbtn').onclick = function () {
    following = !following;
    this.className = following ? 'on' : '';
    this.textContent = following ? 'FOLLOWING' : 'PAUSED';
    maybeScroll();
  };
  feed.addEventListener('mouseenter', function () { feedHover = true; });
  feed.addEventListener('mouseleave', function () { feedHover = false; maybeScroll(); });
  $('filter').addEventListener('input', function () {
    filterText = this.value.trim().toLowerCase();
    applyFilter();
  });

  // ---------- boot ----------
  function boot() {
    setConn('connecting');
    Promise.all([
      fetchJSON('/api/state'),
      fetchJSON('/api/events?since_id=0&limit=500'),
    ]).then(function (res) {
      var state = res[0], events = res[1];
      for (var i = 0; i < events.length; i++) appendEvent(events[i]);
      applyState(state);
      maybeScroll();
      openStream();
    }).catch(function () {
      setConn('recon');
      setTimeout(boot, 1200);
    });
  }

  boot();
})();
</script>
</body>
</html>
`
