/* CLANKER PIT — protect the Server round.
 * Feeds, chat, village scoreboard, focus view (decisions/thinking/memories/soul),
 * and the guest creeper experience: join the queue, then WASD + mouse + jump
 * and one BOOM. All dynamic strings render via textContent — never innerHTML.
 */
(function () {
  'use strict';

  // ---------- config ----------
  var VIDEO_BASE = 'https://fse8ccos5kangj-8080.proxy.runpod.net';
  var API_BASE = 'https://fse8ccos5kangj-8081.proxy.runpod.net';
  var STATE_FALLBACK = '/api/state';
  var FOUNDING = ['cinder', 'vex', 'mira', 'tally'];
  var TOKEN_KEY = 'clankerpit-guest-token';
  var NAME_KEY = 'clankerpit-guest-name';
  var LOOK_SENS = 0.0032;          // radians per pixel
  var TOUCH_LOOK_SENS = 0.006;
  var MAX_PITCH = Math.PI / 2 - 0.03;

  // ---------- tiny dom utils ----------
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function fmtClock(ms) {
    ms = Math.max(0, ms);
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function timeAgo(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return '';
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 15) return 'now';
    if (s < 90) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    return Math.round(s / 3600) + 'h';
  }

  // ---------- state ----------
  var state = { mode: 'focus', clanker: 'mira' };
  var live = { instances: [], attached: null };
  var telemetry = null;
  var lastChatId = 0;
  var lastStateReceivedAt = 0;
  var pollBusy = false;

  // ---------- hls ----------
  function feedUrl(feed) { return VIDEO_BASE + '/' + feed + '/index.m3u8'; }

  function killAll() {
    live.instances.forEach(function (i) { i.destroy(); });
    live.instances = [];
  }

  function attach(video, overlayEls, hudEl, feed) {
    var failures = 0, MAX = 6, disposed = false, watchProgress = false;
    var lastTime = -1, lastProgress = Date.now();
    var inst = { hls: null, retryTimer: null };
    function setLive(on) {
      if (hudEl) hudEl.classList.toggle('live', Boolean(on && (feed !== 'guest' || guest.cameraReady())));
    }
    function overlay(show, code, msg, retry) {
      overlayEls.root.classList.toggle('hidden', !show);
      if (!show) return;
      overlayEls.code.textContent = code;
      overlayEls.msg.textContent = msg;
      overlayEls.retry.style.display = retry ? 'block' : 'none';
    }
    function stopPlayer() {
      if (inst.retryTimer) clearTimeout(inst.retryTimer);
      inst.retryTimer = null;
      if (inst.hls) inst.hls.destroy();
      inst.hls = null;
      video.removeAttribute('src');
      video.load();
    }
    function playing() {
      lastProgress = Date.now();
      failures = 0;
      overlay(false);
      setLive(true);
    }
    function start() {
      if (disposed) return;
      stopPlayer();
      failures = 0;
      watchProgress = true;
      lastTime = -1;
      lastProgress = Date.now();
      overlay(true, 'SIGNAL', 'Tuning the feed…', false);
      setLive(false);
      if (window.Hls && Hls.isSupported()) {
        inst.hls = new Hls({
          lowLatencyMode: true, liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: 10, maxBufferLength: 8, backBufferLength: 4
        });
        inst.hls.loadSource(feedUrl(feed));
        inst.hls.attachMedia(video);
        inst.hls.on(Hls.Events.MANIFEST_PARSED, function () {
          video.play().catch(function () {
            overlay(true, 'PAUSED', 'Tap reconnect to start the feed.', true);
          });
        });
        inst.hls.on(Hls.Events.ERROR, function (_, data) {
          if (disposed || !data.fatal) return;
          failures++;
          setLive(false);
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && failures <= MAX) {
            overlay(true, 'SIGNAL LOST', 'Reacquiring… (' + failures + ')', true);
            inst.retryTimer = setTimeout(function () { if (inst.hls) inst.hls.startLoad(); }, 1500);
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && failures <= MAX) {
            overlay(true, 'BUFFERING', 'Recovering video playback…', true);
            inst.hls.recoverMediaError();
          } else {
            watchProgress = false;
            overlay(true, 'OFF AIR', 'This camera is unreachable.', true);
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = feedUrl(feed);
        video.play().catch(function () {
          overlay(true, 'PAUSED', 'Tap reconnect to start the feed.', true);
        });
      } else {
        watchProgress = false;
        overlay(true, 'UNSUPPORTED', 'This browser cannot play the feed.', false);
      }
    }
    function videoError() {
      watchProgress = false;
      setLive(false);
      overlay(true, 'OFF AIR', 'This camera is unreachable.', true);
    }
    function retry(event) { event.stopPropagation(); start(); }
    video.addEventListener('playing', playing);
    video.addEventListener('error', videoError);
    overlayEls.retry.addEventListener('click', retry);
    var watchdog = setInterval(function () {
      if (!watchProgress) return;
      if (video.currentTime > lastTime && video.readyState >= 2) {
        lastTime = video.currentTime;
        lastProgress = Date.now();
        overlay(false); setLive(true);
      } else if (Date.now() - lastProgress > 12000) {
        setLive(false);
        overlay(true, 'BUFFERING', 'Video has stopped advancing. Reconnect the camera.', true);
      }
    }, 2000);
    inst.destroy = function () {
      disposed = true;
      clearInterval(watchdog);
      video.removeEventListener('playing', playing);
      video.removeEventListener('error', videoError);
      overlayEls.retry.removeEventListener('click', retry);
      stopPlayer();
    };
    inst.start = start;
    start();
    return inst;
  }

  var singleVideo = $('singleVideo');
  var singleHud = $('singleHud');
  var singleOverlay = {
    root: $('singleOverlay'), code: $('singleCode'),
    msg: $('singleMsg'), retry: $('singleRetry')
  };
  var singleSub = document.querySelector('#singleHud .sub');
  var attachedFeed = undefined;

  function showSingle(feed, label, sub, offlineMsg) {
    $('gridStage').hidden = true;
    $('singleStage').style.display = 'block';
    $('singleLabel').textContent = label;
    singleSub.textContent = sub;
    if (attachedFeed === feed) return; // already attached: don't restart HLS
    attachedFeed = feed;
    killAll();
    if (!feed) {
      singleVideo.removeAttribute('src');
      singleVideo.load();
      singleOverlay.root.classList.remove('hidden');
      singleOverlay.code.textContent = 'NO FEED';
      singleOverlay.msg.textContent = offlineMsg || 'No native view for this clanker yet.';
      singleOverlay.retry.style.display = 'none';
      singleHud.classList.remove('live');
      return;
    }
    live.instances.push(attach(singleVideo, singleOverlay, singleHud, feed));
  }

  var gridBuilt = false;
  function showGrid() {
    $('singleStage').style.display = 'none';
    attachedFeed = null; // killAll() below destroys the single-feed player
    var grid = $('gridStage');
    grid.hidden = false;
    killAll();
    if (!gridBuilt) {
      FOUNDING.forEach(function (feed) {
        var cell = el('div', 'cell');
        var aspect = el('div', 'aspect');
        var video = el('video'); video.playsInline = true; video.autoplay = true; video.muted = true;
        aspect.appendChild(video);
        var overlayRoot = el('div', 'overlay hidden');
        var overlayCode = el('div', 'code', 'SIGNAL');
        var overlayMsg = el('div', 'msg');
        var overlayRetry = el('button', null, 'RECONNECT');
        overlayRetry.style.display = 'none';
        overlayRoot.appendChild(overlayCode); overlayRoot.appendChild(overlayMsg); overlayRoot.appendChild(overlayRetry);
        aspect.appendChild(overlayRoot);
        var hud = el('div', 'hud');
        var left = el('span');
        var dot = el('span', 'live-dot');
        left.appendChild(dot);
        left.appendChild(el('span', null, feed.toUpperCase() + ' / POV'));
        hud.appendChild(left);
        hud.appendChild(el('span', 'sub', 'TAP TO FOCUS'));
        cell.appendChild(aspect); cell.appendChild(hud);
        cell.addEventListener('click', function () { setMode('focus', feed); });
        grid.appendChild(cell);
        cell._attach = {
          video: video,
          overlay: { root: overlayRoot, code: overlayCode, msg: overlayMsg, retry: overlayRetry },
          hud: hud,
          feed: feed
        };
      });
      gridBuilt = true;
    }
    Array.prototype.forEach.call(grid.children, function (cell) {
      var a = cell._attach;
      live.instances.push(attach(a.video, a.overlay, a.hud, a.feed));
    });
  }

  // ---------- modes ----------
  var modeButtons = document.querySelectorAll('.modes [data-mode]');
  function setMode(mode, clanker) {
    if (mode === 'grid') { state.mode = 'grid'; }
    else if (mode === 'arena') { state.mode = 'arena'; }
    else if (mode === 'play') { state.mode = 'play'; }
    else if (mode === 'focus' || FOUNDING.indexOf(mode) !== -1) {
      state.mode = 'focus';
      if (clanker) state.clanker = clanker;
      else if (FOUNDING.indexOf(mode) !== -1) state.clanker = mode;
    } else { // pov feed by name
      state.mode = 'pov';
      if (mode && FOUNDING.indexOf(mode) !== -1) state.clanker = mode;
      if (clanker && FOUNDING.indexOf(clanker) !== -1) state.clanker = clanker;
    }
    render();
    if (history.replaceState) {
      var q = state.mode === 'pov' ? '?v=' + state.clanker
        : state.mode === 'focus' ? '?v=focus&c=' + state.clanker
        : '?v=' + state.mode;
      history.replaceState(null, '', q);
    }
  }
  Array.prototype.forEach.call(modeButtons, function (b) {
    b.addEventListener('click', function () { setMode(b.dataset.mode); });
  });

  function render() {
    var mode = state.mode;
    Array.prototype.forEach.call(modeButtons, function (b) {
      b.classList.toggle('active', b.dataset.mode === (mode === 'pov' ? 'pov' : mode));
    });
    $('focusPicker').hidden = mode !== 'focus' && mode !== 'pov';
    $('decisionNow').hidden = mode !== 'focus';
    $('focusPanel').hidden = mode !== 'focus';
    $('playPanel').hidden = mode !== 'play';
    renderAvailability();
    var help = $('playHelp');
    help.hidden = !(mode === 'play' && guest.turnLive());
    if (mode !== 'play') {
      $('turnHud').hidden = true;
      $('touchPad').hidden = true;
      $('clickCatch').hidden = true;
      $('guestCameraOverlay').hidden = true;
    }
    if (mode === 'arena') showSingle('arena', 'ARENA 01 / WIDE', 'CAM 01 · SPECTATOR FEED');
    else if (mode === 'grid') showGrid();
    else if (mode === 'pov') {
      var feed = state.clanker;
      showSingle(feed, feed.toUpperCase() + ' / POV', 'SPECTATING ' + feed.toUpperCase());
      renderFocusPicker();
    } else if (mode === 'focus') {
      var b = bot(state.clanker);
      var hasFeed = b ? b.nativeView : FOUNDING.indexOf(state.clanker) !== -1;
      showSingle(
        hasFeed ? state.clanker : null,
        state.clanker.toUpperCase() + ' / FOCUS',
        hasFeed ? 'POV + DECISIONS' : 'CONTROL ROOM'
      );
      renderFocus();
    } else if (mode === 'play') {
      renderPlay();
    }
  }

  function bot(name) {
    if (!telemetry || !telemetry.bots || !name) return null;
    var bots = telemetry.bots;
    // Feed ids are lowercase, telemetry keys are clanker display names
    // ("Cinder"); accept both, plus the exact key.
    return bots[name] || bots[name.charAt(0).toUpperCase() + name.slice(1)] || bots[name.toLowerCase()] || null;
  }
  function population() {
    var v = telemetry && telemetry.village;
    if (v && v.population && v.population.length) return v.population;
    return ['Cinder', 'Vex', 'Mira', 'Tally'];
  }

  function guestAvailable() {
    return Boolean(telemetry && telemetry.village && telemetry.guest);
  }
  function renderAvailability() {
    var village = Boolean(telemetry && telemetry.village);
    var guestOn = guestAvailable();
    document.querySelector('[data-mode="play"]').hidden = !guestOn;
    $('joinChip').hidden = !guestOn || state.mode === 'play';
    var showMeta = state.mode === 'pov' || state.mode === 'arena';
    $('metaRow').hidden = !showMeta || !village;
    $('survivalMeta').hidden = !showMeta || !telemetry || village;
    $('roundLabel').textContent = !telemetry ? 'CONNECTING' : village ? 'VILLAGE ROUND' : 'SURVIVAL ROUND';
    renderTelemetryStatus();
  }
  function renderTelemetryStatus() {
    var at = telemetry && Date.parse(telemetry.updated);
    var age = at ? Date.now() - at : Infinity;
    var stale = age > 12000 || Date.now() - lastStateReceivedAt > 12000;
    $('telemetryStatus').classList.toggle('stale', Boolean(telemetry && stale));
    $('telemetryStatus').textContent = !telemetry ? 'Waiting for game telemetry…'
      : stale ? 'Telemetry delayed · last update ' + timeAgo(telemetry.updated) + ' ago'
      : 'Game telemetry · live';
  }
  function sourceLabel(source) {
    return { jev: 'JEV MODEL', fallback: 'FALLBACK POLICY', safety_reflex: 'SAFETY REFLEX', test_policy: 'SCRIPTED TEST' }[source] || (source ? String(source).toUpperCase() : 'SOURCE UNAVAILABLE');
  }
  function rawResultText(result) {
    if (result === undefined || result === null) return '';
    return typeof result === 'string' ? result : JSON.stringify(result);
  }
  function partialResult(result) {
    return Boolean(result && (result.defeated === false || result.returned === false));
  }
  function resultText(result, action) {
    if (result && result.hunted && result.defeated === false)
      return 'Attacked ' + String(result.hunted).replace(/_/g, ' ') + '; still alive';
    if (result && result.returned === false) {
      var destination = action === 'return_to_camp' ? 'camp' : 'post';
      return 'Moving toward ' + destination + (typeof result.remaining === 'number' && isFinite(result.remaining) ? ' (' + Math.max(0, Math.round(result.remaining)) + ' blocks remaining)' : '');
    }
    return rawResultText(result);
  }
  function outcomeText(outcome) {
    var status = outcome.ok === false || outcome.status === 'failed' ? 'failed' : 'completed';
    if (status !== 'failed' && partialResult(outcome.result)) return resultText(outcome.result, outcome.action);
    return (outcome.action || 'action') + ' ' + status + (outcome.error ? ': ' + outcome.error : resultText(outcome.result, outcome.action) ? ': ' + resultText(outcome.result, outcome.action) : '');
  }
  function renderCurrent(b) {
    var brain = b.brain || {};
    var action = brain.action || {};
    var recent = (b.recent || []).filter(function (r) { return r.action; });
    var latest = recent[recent.length - 1];
    var running = action.status === 'running';
    var elapsed = running && action.startedAt ? ' · ' + fmtClock(Date.now() - Date.parse(action.startedAt)) : '';
    $('currentAction').textContent = b.offline ? state.clanker.toUpperCase() + ' · OFFLINE' : (running ? action.action : b.activity || 'Waiting for action').replace(/_/g, ' ').toUpperCase() + elapsed;
    $('currentSource').textContent = sourceLabel(action.source);
    $('currentSource').className = 'badge ' + (action.source === 'fallback' ? 'policy' : action.source === 'safety_reflex' ? 'reflex' : '');
    $('currentPlan').textContent = (brain.think && brain.think.intention) || b.goal || 'Waiting for a recorded plan…';
    var outcome = action.status === 'failed' || action.status === 'succeeded' ? action : latest;
    $('currentOutcome').textContent = outcome ? 'Last result · ' + outcomeText(outcome) : 'No completed action recorded yet.';
    $('currentOutcome').classList.toggle('failed', Boolean(outcome && (outcome.ok === false || outcome.status === 'failed')));
    var providerBits = [];
    ['planner', 'decision'].forEach(function (key) {
      var provider = brain[key];
      if (!provider) return;
      var label = key === 'planner' ? 'Planner' : 'Action selector';
      providerBits.push(label + ': ' + (provider.status || 'unknown') + (provider.error ? ' — ' + provider.error : ''));
    });
    $('providerStatus').textContent = providerBits.join(' · ');
    $('providerStatus').classList.toggle('error', Boolean((brain.planner && brain.planner.error) || (brain.decision && brain.decision.error)));
    var results = $('actionResults');
    var expanded = Array.prototype.map.call(results.querySelectorAll('details[open]'), function (d) { return d.dataset.resultKey; });
    clear(results);
    recent.slice().reverse().forEach(function (r) {
      var row = el('div', 'action-result' + (r.ok === false ? ' failed' : ''));
      row.appendChild(el('b', null, (r.action || '').replace(/_/g, ' ') + (r.ok === false ? ' · FAILED' : partialResult(r.result) ? ' · ATTEMPT FINISHED' : ' · COMPLETED')));
      if (r.source) row.appendChild(el('span', 'badge', sourceLabel(r.source)));
      var summary = resultText(r.result, r.action);
      row.appendChild(el('p', null, r.error || summary || 'No result detail recorded.'));
      if (partialResult(r.result)) {
        var raw = el('details', 'result-raw');
        raw.dataset.resultKey = (r.at || '') + ':' + r.action;
        raw.open = expanded.indexOf(raw.dataset.resultKey) !== -1;
        raw.appendChild(el('summary', null, 'Recorded result'));
        raw.appendChild(el('pre', null, rawResultText(r.result)));
        row.appendChild(raw);
      }
      row.appendChild(el('div', 'jev-meta', timeAgo(r.at) + (typeof r.durationMs === 'number' ? ' · ' + (r.durationMs / 1000).toFixed(1) + 's' : '')));
      results.appendChild(row);
    });
    if (!recent.length) results.appendChild(el('div', 'empty-state', 'No completed actions recorded yet.'));
  }

  // ---------- village bar + cast ----------
  function renderVillageBar() {
    var v = telemetry && telemetry.village;
    $('villageBar').hidden = !v;
    if (!v) return;
    $('coolantText').textContent = v.water ? (v.water.fed + '/' + v.water.target) : '—';
    $('coolantFill').style.width = (v.water ? v.water.pct : 0) + '%';
    $('wallText').textContent = v.wall ? (v.wall.complete ? 'DONE' : v.wall.done + '/' + v.wall.total) : '—';
    $('gateText').textContent = v.gate ? (v.gate.complete ? 'DONE' : v.gate.done + '/' + v.gate.total) : '—';
    var chips = $('castChips');
    clear(chips);
    population().forEach(function (name) {
      var b = bot(name);
      var chip = el('span', 'cast-chip');
      chip.appendChild(el('b', null, name));
      if (b && b.offline) chip.appendChild(el('span', 'dead', '×'));
      if (b && b.role) chip.appendChild(el('span', 'role', b.role));
      else if (v.roles && v.roles[name]) chip.appendChild(el('span', 'role', v.roles[name]));
      chip.addEventListener('click', function () { setMode('focus', name.toLowerCase()); });
      chips.appendChild(chip);
    });
    var title = $('matchTitle');
    if (title && v.water) {
      title.textContent = v.water.fed >= v.water.target && !v.atCapacity
        ? 'The Server is drinking. A villager is booting…'
        : 'The Server hums at ' + v.water.pct + '% coolant.';
    }
  }

  // ---------- chat ----------
  function renderChat() {
    var feedEl = $('chatFeed');
    if (!telemetry || !Array.isArray(telemetry.chat)) return;
    var chat = telemetry.chat;
    $('chatEmpty').hidden = chat.length > 0;
    // Controller restarts begin a fresh sequence.
    if (chat.length && chat[chat.length - 1].id < lastChatId) { lastChatId = 0; clear(feedEl); }
    var fresh = chat.filter(function (m) { return m.id > lastChatId; });
    if (!chat.length) { lastChatId = 0; clear(feedEl); $('chatCount').textContent = '0'; }
    if (!fresh.length) return;
    var autoscroll = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 80;
    fresh.forEach(function (m) {
      if (m.id > lastChatId) lastChatId = m.id;
      var msg = el('div', 'chat-msg ' + (m.kind || 'say'));
      var who = el('span', 'who', (m.from || '?') + ': ');
      var txt = el('span', 'txt', m.text || '');
      var when = el('span', 'when', timeAgo(m.t));
      msg.appendChild(who); msg.appendChild(txt); msg.appendChild(when);
      feedEl.appendChild(msg);
    });
    while (feedEl.children.length > 80) feedEl.removeChild(feedEl.firstChild);
    if (autoscroll) feedEl.scrollTop = feedEl.scrollHeight;
    $('chatCount').textContent = String(feedEl.children.length);
  }

  // ---------- focus view ----------
  var MEM_ICONS = {
    action: '▪', death: '☠', role: '⚙', said: '❝', fed_coolant: '💧',
    plan: '✱', explosion_near_flag: '💥', villager_booted: '⚡', spawn: '✚', 'null': '·'
  };
  function renderFocusPicker() {
    var picker = $('focusPicker');
    var cast = population();
    var builtFor = picker.children.length === cast.length &&
      picker.firstChild && picker.firstChild.dataset.name === cast[0].toLowerCase();
    if (!builtFor) {
      clear(picker);
      cast.forEach(function (name) {
        var b = el('button');
        b.textContent = name.toUpperCase();
        b.dataset.name = name.toLowerCase();
        b.addEventListener('click', function () {
          setMode(state.mode, name.toLowerCase());
        });
        picker.appendChild(b);
      });
    }
    Array.prototype.forEach.call(picker.children, function (btn) {
      btn.classList.toggle('active', btn.dataset.name === state.clanker);
      var b = bot(btn.dataset.name);
      var label = btn.textContent.split(' ·')[0];
      btn.textContent = label + (b && b.role ? ' · ' + b.role : '');
      btn.classList.toggle('dead', Boolean(b && b.offline));
    });
  }

  function renderFocus() {
    renderFocusPicker();
    var name = state.clanker;
    var b = bot(name);
    if (!b) {
      $('currentAction').textContent = state.clanker.toUpperCase() + ' · WAITING FOR TELEMETRY';
      $('currentPlan').textContent = 'Waiting for a recorded plan…';
      $('currentSource').textContent = 'SOURCE UNAVAILABLE';
      $('currentOutcome').textContent = '';
      $('providerStatus').textContent = '';
      $('brainModel').textContent = 'waiting';
      $('planGoal').textContent = 'Waiting for this clanker’s telemetry…';
      $('soulOrigin').textContent = '—';
      $('soulQuote').textContent = '';
      ['planSteps', 'soulChips', 'soulVitals', 'jevList', 'actionResults', 'memoryList'].forEach(function (id) { clear($(id)); });
      $('thinkingBlock').hidden = true;
      $('reflectBlock').hidden = true;
      return;
    }
    renderCurrent(b);
    var model = b.model || {};
    $('brainModel').textContent = (model.provider || 'llm') + ' / ' + (model.model || '?');
    $('soulOrigin').textContent = b.soul ? (b.soul.origin || '—') : '—';
    $('soulQuote').textContent = b.soul ? (b.soul.catchphrase || '') : '';
    var chips = $('soulChips');
    clear(chips);
    if (b.role) chips.appendChild(el('span', 'role-chip', 'ROLE: ' + b.role));
    if (b.soul && b.soul.dispositions) b.soul.dispositions.forEach(function (d) {
      chips.appendChild(el('span', null, d));
    });
    chips.appendChild(el('span', 'model-chip', (model.provider || '?') + ' ' + (model.model || '')));
    var vitals = $('soulVitals');
    clear(vitals);
    vitals.appendChild(vital('ACTIVITY', b.activity || '—'));
    vitals.appendChild(vital('MOTIVE', b.soul && b.soul.motive ? String(b.soul.motive).slice(0, 42) : '—'));

    var think = b.brain && b.brain.think;
    $('planGoal').textContent = think && think.intention
      ? think.intention
      : (b.goal || (b.plan && b.plan.intention) || 'waiting for telemetry…');
    var steps = $('planSteps');
    clear(steps);
    var planSteps = think && think.steps || (b.plan && b.plan.steps) || [];
    planSteps.forEach(function (s) { steps.appendChild(el('li', null, s)); });

    var thinking = $('thinkingBlock');
    thinking.hidden = !(think && think.thinking);
    if (think && think.thinking) $('thinkingText').textContent = think.thinking;

    var reflect = $('reflectBlock');
    reflect.hidden = !(b.brain && b.brain.reflect && b.brain.reflect.belief);
    if (!reflect.hidden) $('reflectText').textContent = '“' + b.brain.reflect.belief + '”';

    var list = $('jevList');
    clear(list);
    var jev = (b.brain && b.brain.jev) || [];
    if (!jev.length) list.appendChild(el('div', 'jev-meta', 'no decisions recorded yet'));
    jev.slice().reverse().forEach(function (d) {
      list.appendChild(jevEntry(d));
    });

    var memories = $('memoryList');
    clear(memories);
    var events = (b.memories && b.memories.events) || [];
    var beliefs = (b.memories && b.memories.beliefs) || [];
    beliefs.slice(-4).forEach(function (belief) {
      var row = el('div', 'mem-entry belief');
      row.appendChild(el('span', 'mem-ico', '❝'));
      var body = el('div', 'mem-body');
      body.appendChild(el('span', null, belief.text || ''));
      body.appendChild(el('div', 'mem-time', timeAgo(belief.t)));
      row.appendChild(body);
      memories.appendChild(row);
    });
    events.slice(-10).reverse().forEach(function (e) {
      var row = el('div', 'mem-entry');
      row.appendChild(el('span', 'mem-ico', MEM_ICONS[e.type] || '·'));
      var body = el('div', 'mem-body');
      body.appendChild(el('b', null, e.type));
      body.appendChild(el('span', null, ' ' + memSummary(e)));
      row.appendChild(body);
      row.appendChild(el('div', 'mem-time', timeAgo(e.t)));
      memories.appendChild(row);
    });
    if (!memories.children.length)
      memories.appendChild(el('div', 'jev-meta', 'no memories yet'));
  }
  function vital(label, value) {
    var d = el('div');
    d.appendChild(el('span', null, label + ' '));
    d.appendChild(el('b', null, value));
    return d;
  }
  function memSummary(e) {
    var data = e.data || {};
    if (e.type === 'action') return (data.action || '?') + (data.ok === false ? ' (failed)' : '');
    if (e.type === 'role') return (data.role || '?') + ' (' + (data.source || 'policy') + ')';
    if (e.type === 'fed_coolant') return 'coolant ' + (data.coolant || '?') + '/' + (data.target || '?');
    if (e.type === 'plan') return data.goal || '';
    if (e.type === 'said') return data.text || '';
    if (e.type === 'explosion_near_flag') return data.what || '';
    if (e.type === 'villager_booted') return 'welcome ' + (data.who || '?');
    return JSON.stringify(data).slice(0, 90);
  }
  function jevEntry(d) {
    var entry = el('div', 'jev-entry');
    var head = el('div', 'jev-head');
    var choice = el('span', 'choice' + (d.source === 'jev' ? ' model-choice' : ''), d.choice || '?');
    head.appendChild(choice);
    var badge = el('span', 'badge ' + (d.source === 'fallback' ? 'policy' : d.source === 'safety_reflex' ? 'reflex' : ''), sourceLabel(d.source));
    head.appendChild(badge);
    var metaBits = [];
    if (typeof d.confidence === 'number') metaBits.push(Math.round(d.confidence * 100) + '%');
    if (typeof d.durationMs === 'number') metaBits.push(d.durationMs + 'ms');
    if (d.source === 'jev' && d.model) metaBits.push(String(d.model).slice(0, 24));
    metaBits.push(timeAgo(d.t));
    head.appendChild(el('span', 'jev-meta', metaBits.join(' · ')));
    entry.appendChild(head);
    if (d.reason || d.error || d.requestPending) entry.appendChild(el('div', 'jev-reason', d.reason || d.error || 'Model request pending; using a fallback choice.'));
    var options = d.options || {};
    var keys = Object.keys(options);
    if (!keys.length) {
      entry.appendChild(el('div', 'jev-meta', 'options not recorded'));
      return entry;
    }
    keys.forEach(function (key) {
      var opt = options[key];
      var chosen = key === d.choice;
      var row = el('div', 'jev-opt' + (chosen ? ' chosen' : ''));
      row.appendChild(el('span', 'name', key));
      var bar = el('span', 'bar');
      var fill = el('i');
      var p = typeof opt.p === 'number' ? Math.max(0, Math.min(1, opt.p)) : 0;
      fill.style.width = (p * 100).toFixed(1) + '%';
      bar.appendChild(fill);
      row.appendChild(bar);
      row.appendChild(el('span', 'pct', typeof opt.p === 'number' ? Math.round(p * 100) + '%' : (chosen ? '✓' : '—')));
      row.title = opt.desc || key;
      entry.appendChild(row);
    });
    return entry;
  }

  // ---------- guest creeper experience ----------
  var guest = {
    token: localStorage.getItem(TOKEN_KEY) || null,
    nickname: localStorage.getItem(NAME_KEY) || null,
    keys: { forward: false, back: false, left: false, right: false, jump: false },
    yaw: null, pitch: 0,
    dirty: true,
    lastSend: 0,
    boomed: false,
    wasActive: false,
    touch: 'ontouchstart' in window,
    turnLive: function () {
      var g = telemetry && telemetry.guest;
      return Boolean(g && g.active && guest.nickname && g.active.nickname === guest.nickname);
    },
    cameraReady: function () {
      var camera = telemetry && telemetry.guest && telemetry.guest.camera;
      // Older gateways omit camera status; keep their established controls.
      return !camera || camera.ready === true;
    },
    canControl: function () {
      return state.mode === 'play' && guest.turnLive() && guest.cameraReady();
    }
  };

  function guestPost(path, payload) {
    return fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload || {})
    }).then(function (r) {
      return r.json().catch(function () { return { error: 'bad response' }; })
        .then(function (body) {
          if (!r.ok) throw body || { error: r.status };
          return body;
        });
    });
  }

  function guestStatus() {
    return fetch(API_BASE + '/guest/status', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  $('joinBtn').addEventListener('click', function () {
    var raw = $('nickInput').value.trim();
    var name = raw.replace(/[^A-Za-z0-9_]/g, '').slice(0, 14);
    if (name.length < 2) {
      joinError('Pick a name: 2-14 letters, numbers or underscore.');
      return;
    }
    $('joinBtn').disabled = true;
    guestPost('/guest/join', { nickname: name }).then(function (r) {
      guest.token = r.token;
      guest.nickname = r.nickname;
      localStorage.setItem(TOKEN_KEY, r.token);
      localStorage.setItem(NAME_KEY, r.nickname);
      guest.boomed = false;
      renderPlay();
    }).catch(function (e) {
      joinError((e && e.error) || 'Could not reach the gate.');
    }).finally(function () {
      $('joinBtn').disabled = false;
    });
  });
  function joinError(text) {
    var box = $('joinError');
    box.textContent = text;
    box.hidden = false;
  }
  $('leaveBtn').addEventListener('click', function () {
    if (!guest.token) return;
    guestPost('/guest/leave', { token: guest.token }).catch(function () {});
    clearGuest();
    renderPlay();
  });
  $('rejoinBtn').addEventListener('click', function () {
    clearGuest();
    renderPlay();
  });
  function clearGuest() {
    guest.token = null;
    guest.nickname = null;
    guest.boomed = false;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(NAME_KEY);
  }

  function renderPlay() {
    var g = telemetry && telemetry.guest;
    var available = guestAvailable();
    $('playUnavailable').hidden = available;
    var turn = available && guest.turnLive();
    var cameraReady = guest.cameraReady();
    var controlsReady = turn && cameraReady;
    var showJoin = $('playJoin'), showQueued = $('playQueued'), showDone = $('playDone');
    showJoin.hidden = true; showQueued.hidden = true; showDone.hidden = true;
    $('turnHud').hidden = !turn;
    $('touchPad').hidden = !(controlsReady && guest.touch);
    $('clickCatch').hidden = !(controlsReady && !guest.touch && document.pointerLockElement !== singleVideo);
    $('guestCameraOverlay').hidden = !turn || cameraReady;
    $('playHelp').hidden = !turn;
    $('boomBtn').disabled = guest.boomed || !cameraReady;
    $('boomBtn').hidden = !cameraReady;
    if (turn && !cameraReady) {
      Object.keys(guest.keys).forEach(function (key) { guest.keys[key] = false; });
      singleHud.classList.remove('live');
      if (document.pointerLockElement === singleVideo && document.exitPointerLock) document.exitPointerLock();
    }
    if (!available) {
      showSingle('arena', 'ARENA / WATCH', 'GUEST PLAY UNAVAILABLE');
      return;
    }
    if (turn) {
      guest.wasActive = true;
      showSingle('guest', 'PIPER CAM / YOUR TURN', cameraReady ? 'CREEPER FEED' : 'CAMERA STARTING');
      $('turnTimer').textContent = g && g.active ? fmtClock(g.active.remainingMs) : '0:00';
      return;
    }
    showSingle('arena', 'ARENA / QUEUE', 'WAITING FOR CREEPER TURN');
    if (guest.wasActive) {
      guest.wasActive = false;
      showDone.hidden = false;
      $('doneTitle').textContent = guest.boomed ? 'GG. YOU EXPLODED.' : 'TURN OVER.';
      $('doneLine').textContent = guest.boomed
        ? 'The Server felt that. Watch the chat — did the wall hold?'
        : 'Your creeper was pulled off the field. The queue is always open.';
      clearGuest();
      return;
    }
    if (guest.token) {
      showQueued.hidden = false;
      var position = 0;
      if (g && g.queuePreview) {
        var idx = g.queuePreview.indexOf(guest.nickname);
        if (idx !== -1) position = idx + 1;
      }
      $('queuedLine').textContent = position
        ? 'You are #' + position + ' in the creeper queue.'
        : 'You are in the creeper queue.';
      $('queuedEta').textContent = g
        ? (position === 1
            ? 'Next creeper slot in ' + fmtClock(g.nextTurnInMs) + '.'
            : 'Slots open every ' + fmtClock(g.turnEveryMs) + ' — next in ' + fmtClock(g.nextTurnInMs) + '.')
        : '';
    } else {
      showJoin.hidden = false;
      if (g && g.queuePreview && g.queuePreview.length) {
        $('queuePreview').textContent = g.queuePreview.join(' · ') + (g.queueLength > g.queuePreview.length ? ' · +' + (g.queueLength - g.queuePreview.length) : '');
      } else {
        $('queuePreview').textContent = g ? 'empty — be the first creeper' : '—';
      }
    }
  }

  // ----- input plumbing -----
  var KEYMAP = {
    KeyW: 'forward', ArrowUp: 'forward',
    KeyS: 'back', ArrowDown: 'back',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right',
    Space: 'jump'
  };
  window.addEventListener('keydown', function (e) {
    if (!guest.canControl()) return;
    var key = KEYMAP[e.code];
    if (key) {
      if (e.code === 'Space' || e.code.indexOf('Arrow') === 0) e.preventDefault();
      if (!guest.keys[key]) { guest.keys[key] = true; guest.dirty = true; }
    } else if (e.code === 'KeyF') {
      sendBoom();
    }
  });
  window.addEventListener('keyup', function (e) {
    var key = KEYMAP[e.code];
    if (key && guest.keys[key]) { guest.keys[key] = false; guest.dirty = true; }
  });
  window.addEventListener('blur', function () {
    Object.keys(guest.keys).forEach(function (k) { guest.keys[k] = false; });
    guest.dirty = true;
  });

  $('clickCatch').addEventListener('click', function () {
    if (!guest.canControl()) return;
    if (singleVideo.requestPointerLock) singleVideo.requestPointerLock();
  });
  document.addEventListener('pointerlockchange', function () {
    $('clickCatch').hidden = !(guest.canControl() && !guest.touch && document.pointerLockElement !== singleVideo);
  });
  document.addEventListener('mousemove', function (e) {
    if (!guest.canControl() || document.pointerLockElement !== singleVideo) return;
    if (e.movementX || e.movementY) {
      guest.yaw = (guest.yaw === null ? 0 : guest.yaw) - e.movementX * LOOK_SENS;
      guest.pitch = clampPitch(guest.pitch - e.movementY * LOOK_SENS);
      guest.dirty = true;
    }
  });
  function clampPitch(p) { return Math.max(-MAX_PITCH, Math.min(MAX_PITCH, p)); }

  // touch: left-half joystick on the stage, right-half look, buttons
  var stick = $('stick'), stickThumb = $('stickThumb');
  var stickId = null, lookId = null, lastLook = null;
  if (guest.touch) {
    $('singleStage').addEventListener('touchstart', function (e) {
      if (!guest.canControl()) return;
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        var target = e.target;
        if (target === stick || stick.contains(target)) continue;
        if (target.tagName === 'BUTTON') continue;
        if (t.clientX < window.innerWidth / 2) continue; // left = joystick zone handled by stick
        if (lookId === null) { lookId = t.identifier; lastLook = { x: t.clientX, y: t.clientY }; }
      }
    }, { passive: true });
    $('singleStage').addEventListener('touchmove', function (e) {
      if (!guest.canControl()) return;
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        if (t.identifier === lookId && lastLook) {
          guest.yaw = (guest.yaw === null ? 0 : guest.yaw) - (t.clientX - lastLook.x) * TOUCH_LOOK_SENS;
          guest.pitch = clampPitch(guest.pitch - (t.clientY - lastLook.y) * TOUCH_LOOK_SENS);
          lastLook = { x: t.clientX, y: t.clientY };
          guest.dirty = true;
        }
      }
    }, { passive: true });
    $('singleStage').addEventListener('touchend', function (e) {
      for (var i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === lookId) { lookId = null; lastLook = null; }
      }
    }, { passive: true });
    stick.addEventListener('touchstart', function (e) { e.preventDefault(); stickId = e.changedTouches[0].identifier; }, { passive: false });
    stick.addEventListener('touchmove', function (e) {
      e.preventDefault();
      for (var i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier !== stickId) continue;
        var r = stick.getBoundingClientRect();
        var dx = (e.changedTouches[i].clientX - (r.left + r.width / 2)) / (r.width / 2);
        var dy = (e.changedTouches[i].clientY - (r.top + r.height / 2)) / (r.height / 2);
        stickThumb.style.transform = 'translate(' + clampAbs(dx * 22) + 'px,' + clampAbs(dy * 22) + 'px)';
        setKey('forward', dy < -0.3); setKey('back', dy > 0.3);
        setKey('left', dx < -0.3); setKey('right', dx > 0.3);
      }
    }, { passive: false });
    var endStick = function (e) {
      for (var i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === stickId) {
          stickId = null;
          stickThumb.style.transform = '';
          setKey('forward', false); setKey('back', false);
          setKey('left', false); setKey('right', false);
        }
      }
    };
    stick.addEventListener('touchend', endStick); stick.addEventListener('touchcancel', endStick);
    $('jumpBtn').addEventListener('touchstart', function (e) { e.preventDefault(); setKey('jump', true); }, { passive: false });
    $('jumpBtn').addEventListener('touchend', function (e) { e.preventDefault(); setKey('jump', false); }, { passive: false });
    $('boomBtnTouch').addEventListener('touchstart', function (e) { e.preventDefault(); sendBoom(); }, { passive: false });
  }
  function setKey(key, value) {
    if (value && !guest.canControl()) return;
    if (guest.keys[key] === value) return;
    guest.keys[key] = value;
    guest.dirty = true;
  }
  function clampAbs(v) { return Math.max(-1, Math.min(1, v)); }

  function sendBoom() {
    if (!guest.canControl() || guest.boomed || !guest.token) return;
    guest.boomed = true;
    $('boomBtn').disabled = true;
    $('boomBtn').textContent = '…';
    guestPost('/guest/input', {
      token: guest.token, keys: snapshotKeys(), boom: true
    }).then(function (r) {
      if (r && r.exploded) $('boomBtn').textContent = 'BOOM!';
    }).catch(function () {
      guest.boomed = false;
      $('boomBtn').disabled = false;
      $('boomBtn').textContent = 'BOOM';
    });
  }
  $('boomBtn').addEventListener('click', sendBoom);

  function snapshotKeys() {
    return {
      forward: !!guest.keys.forward, back: !!guest.keys.back,
      left: !!guest.keys.left, right: !!guest.keys.right, jump: !!guest.keys.jump
    };
  }

  setInterval(function () {
    if (!guest.turnLive() || !guest.token) return;
    var now = Date.now();
    var wantSend = guest.dirty || now - guest.lastSend > 500;
    if (!wantSend || now - guest.lastSend < 80) return;
    guest.lastSend = now;
    guest.dirty = false;
    // Normalize yaw before sending: the gateway bounds it at ±8π and the
    // browser accumulates without limit while dragging.
    var yaw = guest.yaw;
    if (yaw !== null) yaw = ((yaw % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
    guestPost('/guest/input', {
      token: guest.token,
      keys: snapshotKeys(),
      look: guest.cameraReady() ? { yaw: yaw === null ? undefined : yaw, pitch: guest.pitch } : undefined
    }).catch(function () {});
  }, 40);

  // ---------- QR chip ----------
  function drawQrOn(canvas, size) {
    var qr = qrcode(0, 'M');
    qr.addData(location.origin + '/?v=play', 'Byte');
    qr.make();
    var count = qr.getModuleCount();
    var scale = Math.max(1, Math.floor(size / (count + 8)));
    var offset = Math.floor((size - count * scale) / 2);
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for (var r = 0; r < count; r++)
      for (var c = 0; c < count; c++)
        if (qr.isDark(r, c)) ctx.fillRect(offset + c * scale, offset + r * scale, scale, scale);
  }
  function drawQr() {
    try {
      drawQrOn($('qrCanvas'), 96)
      drawQrOn($('playQrCanvas'), 110)
    } catch (e) {
      $('qrCanvas').hidden = true
      $('playQrCanvas').hidden = true
    }
  }
  $('joinChip').addEventListener('click', function () { setMode('play'); });

  function renderChip() {
    var g = telemetry && telemetry.guest;
    $('joinChip').hidden = state.mode === 'play' || !guestAvailable();
    if ($('joinChip').hidden) return;
    if (g && g.active) {
      $('chipSub').textContent = g.active.nickname + ' is playing · next slot in ' + fmtClock(g.nextTurnInMs);
    } else if (g) {
      $('chipSub').textContent = g.queueLength
        ? g.queueLength + ' in queue · next slot in ' + fmtClock(g.nextTurnInMs)
        : 'next slot in ' + fmtClock(g.nextTurnInMs);
    } else {
      $('chipSub').textContent = 'queue warming up…';
    }
  }

  // ---------- polling ----------
  var lastGuestStatusAt = 0;
  function fetchJson(url, timeoutMs) {
    var opts = { cache: 'no-store' };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
      opts.signal = AbortSignal.timeout(timeoutMs || 6000);
    return fetch(url, opts).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
  }
  function pollState() {
    if (pollBusy) return;
    pollBusy = true;
    fetchJson(API_BASE + '/arena/state.json')
      .catch(function () { return fetchJson(STATE_FALLBACK); })
      .then(function (data) {
        // The arena snapshot can be older than the last /guest/status read;
        // never let a stale snapshot erase an active turn's credentials.
        if (
          data &&
          data.guest !== undefined &&
          telemetry &&
          telemetry.guest &&
          Date.now() - lastGuestStatusAt < 3000
        ) {
          data.guest = telemetry.guest;
        }
        if (!data || !data.bots || !data.updated) throw new Error('Invalid game telemetry');
        telemetry = data;
        lastStateReceivedAt = Date.now();
        renderAvailability();
        renderVillageBar();
        renderChat();
        renderChip();
        if (state.mode === 'focus') render();
        else if (state.mode === 'pov') renderFocusPicker();
        if (state.mode === 'play') renderPlay();
      })
      .catch(function () { renderTelemetryStatus(); })
      .finally(function () { pollBusy = false; });
  }
  setInterval(renderTelemetryStatus, 2000);
  setInterval(pollState, 2000);
  pollState();

  setInterval(function () {
    if (!guestAvailable() || (!guest.token && state.mode !== 'play')) return;
    guestStatus().then(function (s) {
      if (!s) return;
      lastGuestStatusAt = Date.now();
      if (telemetry && telemetry.guest && telemetry.guest.queueLength !== undefined) {
        telemetry.guest.queuePreview = s.queuePreview || telemetry.guest.queuePreview;
        telemetry.guest.queueLength = s.queueLength;
        telemetry.guest.active = s.active;
        telemetry.guest.nextTurnInMs = s.nextTurnInMs;
        telemetry.guest.camera = s.camera;
      } else if (telemetry) {
        telemetry.guest = s;
      }
      if (state.mode === 'play') renderPlay();
      if (telemetry && telemetry.guest && telemetry.guest.active && guest.nickname &&
          telemetry.guest.active.nickname === guest.nickname && state.mode !== 'play') {
        // my turn started while browsing elsewhere: jump to the play view
        setMode('play');
      }
    });
  }, 1000);

  // ---------- chat toggle (small screens) ----------
  $('chatToggle').addEventListener('click', function () {
    $('chatRail').classList.toggle('open');
  });

  // ---------- deep links ----------
  var params = new URLSearchParams(location.search);
  var v = params.get('v');
  var c = params.get('c');
  if (v === 'grid' || v === 'arena' || v === 'play' || v === 'focus') setMode(v, c ? c.toLowerCase() : 'cinder');
  else if (v && FOUNDING.indexOf(v) !== -1) setMode('pov', v);
  else setMode('focus', 'mira');
  drawQr();
})();
