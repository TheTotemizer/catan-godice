/* =====================================================================
 * Catan Companion — app.js
 * ---------------------------------------------------------------------
 * Single-file UI controller. Manages:
 *   - game state (players, rolls, timers, robber events)
 *   - screen routing (welcome / setup / game)
 *   - GoDice wiring via DiceManager
 *   - persistence to localStorage
 * ===================================================================== */

(function () {
  'use strict';

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ============================================================ *
   * CONSTANTS
   * ============================================================ */

  const PLAYER_COLORS = [
    { key: 'red',    label: 'Red',    css: 'var(--p-1)' },
    { key: 'blue',   label: 'Blue',   css: 'var(--p-2)' },
    { key: 'white',  label: 'White',  css: 'var(--p-3)' },
    { key: 'orange', label: 'Orange', css: 'var(--p-4)' },
    { key: 'green',  label: 'Green',  css: 'var(--p-5)' },
    { key: 'purple', label: 'Purple', css: 'var(--p-6)' },
  ];

  // RGB used for dice LEDs to mirror player color
  const PLAYER_LED_RGB = {
    red:    [255, 30,  30 ],
    blue:   [40,  120, 230],
    white:  [220, 220, 200],
    orange: [240, 130, 30 ],
    green:  [40,  200, 90 ],
    purple: [150, 80,  200],
  };

  // Probability of each 2d6 sum (for stats expected line)
  const EXPECTED_FREQ_2D6 = {
    2: 1/36, 3: 2/36, 4: 3/36, 5: 4/36, 6: 5/36, 7: 6/36,
    8: 5/36, 9: 4/36, 10: 3/36, 11: 2/36, 12: 1/36,
  };

  const STORAGE_KEY = 'catan-companion-v1';
  const DEFAULT_PLAYERS = [
    { name: 'Player 1', colorKey: 'red'    },
    { name: 'Player 2', colorKey: 'blue'   },
    { name: 'Player 3', colorKey: 'white'  },
  ];

  /* ============================================================ *
   * STATE
   * ============================================================ */

  let state = freshState();
  function freshState() {
    return {
      phase: 'welcome',   // 'welcome' | 'setup' | 'game'
      setupStep: 1,
      players: JSON.parse(JSON.stringify(DEFAULT_PLAYERS)),
      rules: {
        sixPlayer: false,
        rerollFirstSeven: false,
        ledPerPlayer: true,
        autoStartTimer: true,
      },
      // dice configured for the game
      // [{diceId, color, role}]  role: 'prod1' | 'prod2' | 'extra'
      configuredDice: [],
      manualMode: false,

      activePlayerIndex: 0,
      turnNumber: 1,
      gameStartedAt: null,        // ms timestamp
      turnStartedAt: null,
      perPlayerTotalMs: [],       // by player index
      longestTurnMs: 0,

      currentTurn: {
        rolled: false,
        sumPending: null,         // when both dice rolled — sum
        dieValues: { },           // diceId -> last value this turn (for sum calc)
        robberPending: false,
        sbpPending: false,
      },

      rollLog: [],                // {ts, sum, dice:{id:value}, byPlayerIdx, isSeven}
      sevenCount: 0,
      firstSevenHandled: false,
      stats: { counts: {} },      // sum -> count

      vp: [],                     // by player index
      longestRoadHolder: null,    // player index or null
      largestArmyHolder: null,
    };
  }

  function ensureCollectionsForPlayers() {
    while (state.perPlayerTotalMs.length < state.players.length) state.perPlayerTotalMs.push(0);
    while (state.vp.length < state.players.length) state.vp.push(2); // start at 2 (initial settlements)
    state.perPlayerTotalMs = state.perPlayerTotalMs.slice(0, state.players.length);
    state.vp = state.vp.slice(0, state.players.length);
  }

  /* ============================================================ *
   * DICE MANAGER
   * ============================================================ */

  const dice = new DiceManager();

  function isBluetoothEnv() {
    // Browser-level support only — does NOT require the GoDice library
    // to be loaded. (Library failure is surfaced separately so users get
    // an accurate diagnosis instead of a generic "not supported".)
    return DiceManager.isBluetoothSupported();
  }
  function isLibraryReady() {
    return DiceManager.isLibraryLoaded() && !window.__GODICE_LOAD_FAILED__;
  }

  // Roll-event wiring — single point of entry for *all* roll outcomes
  dice.on('roll', ({ diceId, value, kind }) => onDieRoll(diceId, value, kind));
  dice.on('rollStart', ({ diceId }) => {
    // Visual jiggle on the matching slot
    const slot = configuredSlotFor(diceId);
    if (slot != null) {
      const el = $(`#die-face-${slot}`);
      if (el) el.classList.add('rolling');
    }
  });
  dice.on('connected', ({ diceId, manual }) => {
    renderSetupDice();
    toast(manual ? 'Manual die added' : 'Die connected', 'ok');
  });
  dice.on('disconnect', ({ diceId, removed }) => {
    if (!removed) toast('A die disconnected', 'warn');
    renderSetupDice();
    renderSettingsDice();
  });
  dice.on('color',   () => { renderSetupDice(); refreshGameDieLabels(); });
  dice.on('battery', () => { renderSetupDice(); renderSettingsDice(); });

  // Periodic battery refresh
  setInterval(() => dice.refreshBatteryAll(), 5 * 60 * 1000);

  /* ============================================================ *
   * SCREEN ROUTING
   * ============================================================ */

  function showScreen(name) {
    state.phase = name;
    $$('.screen').forEach(s => s.classList.toggle('hidden', s.dataset.screen !== name));
    if (name === 'setup') renderSetup();
    if (name === 'game')  renderGame();
    persist();
  }

  function showOverlay(name) {
    $$('.overlay').forEach(o => o.classList.toggle('hidden', o.dataset.overlay !== name));
    if (name === 'discard') renderDiscardList();
    if (name === 'stats')   renderStats();
    if (name === 'aids')    renderAids();
    if (name === 'settings') renderSettings();
  }
  function closeOverlays() { $$('.overlay').forEach(o => o.classList.add('hidden')); }

  /* ============================================================ *
   * WELCOME SCREEN
   * ============================================================ */

  function renderWelcome() {
    const saved = loadSaved();
    const card = $('#resume-card');
    if (saved && saved.phase === 'game') {
      const players = (saved.players || []).map(p => p.name).join(', ');
      $('#resume-info').textContent =
        `${saved.players?.length || 0} players (${players}) · turn ${saved.turnNumber} · ${saved.rollLog?.length || 0} rolls`;
      card.classList.remove('hidden');
    } else {
      card.classList.add('hidden');
    }
    renderBluetoothBanner();
  }

  function renderBluetoothBanner() {
    const el = $('#bt-warn');
    if (!el) return;
    const diag = DiceManager.diagnostics();
    let html;
    if (diag.bluetoothApiUsable && isLibraryReady()) {
      html = `<strong>Web Bluetooth ready.</strong> Tap "Pair a die" in setup and your browser will show the chooser.`;
    } else if (!diag.secureContext) {
      html = `<strong>Insecure context.</strong> Web Bluetooth needs HTTPS or localhost. ` +
             `You're on <code>${diag.protocol}//${diag.host}</code>.`;
    } else if (!diag.hasNavigatorBluetooth) {
      html = `<strong>This browser doesn't expose Web Bluetooth.</strong> ` +
             `On Android use Chrome or Edge (Firefox doesn't support it; Samsung Internet usually does over HTTPS). ` +
             `On iPad/iPhone Safari, Web Bluetooth isn't available — use manual entry. ` +
             `Make sure system Bluetooth is on and the browser has Location permission.`;
    } else if (!diag.bluetoothApiUsable) {
      html = `<strong>Bluetooth API present but unusable.</strong> ` +
             `Try enabling Bluetooth at the OS level and granting Location permission to this browser.`;
    } else if (!isLibraryReady()) {
      html = `<strong>Web Bluetooth is supported in your browser, but the GoDice helper library failed to load from the CDN.</strong> ` +
             `This usually means a network filter, ad blocker, or VPN is blocking jsdelivr.net. ` +
             `Try disabling extensions/blockers, or download <code>godice.js</code> from the GoDice GitHub repo and host it next to <code>index.html</code>.`;
    } else {
      html = `<strong>Web Bluetooth not available.</strong> Use manual entry to play.`;
    }
    el.innerHTML = html + ` <a href="#" data-action="show-diagnostics" style="color:var(--c-primary)">Show diagnostics</a>`;
  }

  /* ============================================================ *
   * SETUP — STEP 1: PLAYERS + RULES
   * ============================================================ */

  function renderSetup() {
    // Step indicator
    $$('[data-step-dot]').forEach(d => d.classList.toggle('active', +d.dataset.stepDot === state.setupStep));
    $$('.setup-step').forEach(el => el.classList.toggle('hidden', +el.dataset.step !== state.setupStep));

    if (state.setupStep === 1) renderSetupPlayers();
    if (state.setupStep === 2) renderSetupDice();
    if (state.setupStep === 3) renderSetupRoles();
  }

  function renderSetupPlayers() {
    const list = $('#player-list');
    list.innerHTML = '';
    state.players.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'player-row';
      const swatchColor = PLAYER_COLORS.find(c => c.key === p.colorKey)?.css || '#888';
      row.innerHTML = `
        <span class="swatch" style="background:${swatchColor}"></span>
        <input type="text" value="${escapeHtml(p.name)}" data-player-name="${i}" maxlength="20" />
        <select data-player-color="${i}">
          ${PLAYER_COLORS.map(c =>
            `<option value="${c.key}" ${c.key === p.colorKey ? 'selected' : ''}>${c.label}</option>`
          ).join('')}
        </select>
        <button class="btn ghost" data-action="remove-player" data-i="${i}" title="Remove">✕</button>
      `;
      list.appendChild(row);
    });
    $('#player-count-hint').textContent = `${state.players.length} players (3–6 supported)`;

    // rule toggles: read current state
    $$('input[data-rule]').forEach(inp => {
      inp.checked = !!state.rules[inp.dataset.rule];
    });
    // disable next if not enough players
    const enoughPlayers = state.players.length >= 3 && state.players.length <= 6;
    $$('[data-action="step-next"]').forEach(b => { b.disabled = !enoughPlayers; });
  }

  /* ============================================================ *
   * SETUP — STEP 2: DICE PAIRING
   * ============================================================ */

  function renderSetupDice() {
    const status = $('#ble-status');
    if (state.manualMode) {
      status.className = 'ble-status warn';
      status.textContent = 'Manual mode — tap dice in-game to enter rolls.';
    } else if (!isBluetoothEnv()) {
      status.className = 'ble-status warn';
      status.textContent =
        'Web Bluetooth not available here. You can still play with manual entry.';
    } else {
      status.className = 'ble-status ok';
      status.textContent = 'Ready to pair. Tap "Pair a die" — your browser will show a chooser.';
    }

    const list = $('#dice-list');
    list.innerHTML = '';
    const all = dice.list();
    if (all.length === 0) {
      list.innerHTML = `<div class="card subtle">No dice paired yet.</div>`;
    }
    all.forEach((d, idx) => {
      const card = document.createElement('div');
      card.className = 'die-card ' + (d.connected ? 'connected' : 'disconnected');
      const colorName = d.color || (d.manual ? 'Manual' : 'Unknown');
      const battery = d.battery != null ? `${d.battery}%` : '—';
      const last = d.lastValue != null ? d.lastValue : '—';
      card.innerHTML = `
        <div class="die-meta">
          <div class="die-mini">${last}</div>
          <div>
            <div><strong>Die ${idx + 1}</strong></div>
            <div class="muted small">${colorName}${d.manual ? ' (virtual)' : ''}</div>
            <div class="battery">🔋 ${battery}</div>
          </div>
        </div>
        <div class="die-actions">
          ${d.manual ? '' : `<button class="btn tiny" data-action="led-test" data-id="${d.diceId}">Flash LED</button>`}
          <button class="btn tiny ghost" data-action="forget-die" data-id="${d.diceId}">Remove</button>
        </div>
      `;
      list.appendChild(card);
    });

    // 'Next' enabled only if at least 2 dice are present
    const enough = all.length >= 2;
    $('#to-step-3').disabled = !enough;
  }

  /* ============================================================ *
   * SETUP — STEP 3: ROLE ASSIGNMENT
   * ============================================================ */

  function renderSetupRoles() {
    const wrap = $('#role-assign');
    wrap.innerHTML = '';
    const all = dice.list();

    // Initialize configuredDice if empty: first two = prod1/prod2, rest extra
    if (state.configuredDice.length === 0) {
      state.configuredDice = all.map((d, i) => ({
        diceId: d.diceId,
        color: d.color,
        role: i === 0 ? 'prod1' : i === 1 ? 'prod2' : 'extra',
      }));
    } else {
      // sync any newly added/removed dice
      const existingIds = new Set(state.configuredDice.map(c => c.diceId));
      all.forEach((d, i) => {
        if (!existingIds.has(d.diceId)) state.configuredDice.push({
          diceId: d.diceId, color: d.color, role: 'extra',
        });
      });
      state.configuredDice = state.configuredDice.filter(c => all.some(d => d.diceId === c.diceId));
    }

    state.configuredDice.forEach((cd, idx) => {
      const d = all.find(x => x.diceId === cd.diceId);
      if (!d) return;
      const colorName = d.color || (d.manual ? 'Manual' : 'Unknown');
      const row = document.createElement('div');
      row.className = 'role-row';
      row.innerHTML = `
        <div class="die-mini" style="width:36px;height:36px;font-size:1.1rem">${d.lastValue ?? '?'}</div>
        <div style="flex:1">
          <div><strong>Die ${idx + 1}</strong> <span class="muted">— ${colorName}</span></div>
        </div>
        <select data-role-for="${cd.diceId}">
          <option value="prod1"  ${cd.role === 'prod1'  ? 'selected' : ''}>Production die A</option>
          <option value="prod2"  ${cd.role === 'prod2'  ? 'selected' : ''}>Production die B</option>
          <option value="extra"  ${cd.role === 'extra'  ? 'selected' : ''}>Extra (unused)</option>
        </select>
      `;
      wrap.appendChild(row);
    });

    // Validate: exactly one prod1 and one prod2
    const counts = state.configuredDice.reduce((acc, c) => (acc[c.role] = (acc[c.role] || 0) + 1, acc), {});
    const valid = counts.prod1 === 1 && counts.prod2 === 1;
    $('[data-action="start-game"]').disabled = !valid;
    if (!valid) {
      const note = document.createElement('div');
      note.className = 'muted small';
      note.textContent = 'Assign exactly one die to "Production die A" and one to "Production die B".';
      wrap.appendChild(note);
    }
  }

  /* ============================================================ *
   * GAME SCREEN
   * ============================================================ */

  function renderGame() {
    ensureCollectionsForPlayers();
    refreshGameDieLabels();
    updateRollDisplay();
    renderRollLog();
    renderActivePlayer();
    renderPlayersMini();
    updateClocks();
    if (state.rules.sixPlayer) $('#sbp-btn').classList.remove('hidden');
    else $('#sbp-btn').classList.add('hidden');
  }

  function refreshGameDieLabels() {
    const all = dice.list();
    const prod = state.configuredDice.filter(c => c.role === 'prod1' || c.role === 'prod2');
    prod.sort((a, b) => a.role.localeCompare(b.role));
    [0, 1].forEach(slot => {
      const cd = prod[slot];
      const labelEl = $(`#die-label-${slot}`);
      const dieEl = $$(`#dice-display .die`)[slot];
      if (!cd) {
        labelEl.textContent = `Die ${slot + 1} (unset)`;
        dieEl.className = 'die';
        return;
      }
      const d = all.find(x => x.diceId === cd.diceId);
      const colorName = (d?.color || cd.color || 'BLACK').toUpperCase();
      dieEl.className = 'die color-' + colorName;
      labelEl.textContent = colorName.charAt(0) + colorName.slice(1).toLowerCase() + (d?.manual ? ' (manual)' : '');
    });
  }

  function configuredSlotFor(diceId) {
    const prod = state.configuredDice.filter(c => c.role === 'prod1' || c.role === 'prod2');
    prod.sort((a, b) => a.role.localeCompare(b.role));
    const i = prod.findIndex(c => c.diceId === diceId);
    return i === -1 ? null : i;
  }

  function updateRollDisplay() {
    const prod = state.configuredDice.filter(c => c.role === 'prod1' || c.role === 'prod2');
    prod.sort((a, b) => a.role.localeCompare(b.role));
    [0, 1].forEach(slot => {
      const cd = prod[slot];
      const v = cd ? state.currentTurn.dieValues[cd.diceId] : null;
      const el = $(`#die-face-${slot}`);
      el.textContent = v != null ? v : '?';
      el.classList.remove('rolling');
    });
    const sumEl = $('#roll-sum');
    const sumWrap = sumEl.parentElement;
    if (state.currentTurn.sumPending != null) {
      sumEl.textContent = state.currentTurn.sumPending;
      sumWrap.classList.toggle('is-seven', state.currentTurn.sumPending === 7);
      $('#prod-hint').textContent = productionHint(state.currentTurn.sumPending);
    } else {
      sumEl.textContent = '—';
      sumWrap.classList.remove('is-seven');
      $('#prod-hint').textContent = state.currentTurn.rolled ? 'Rolling…' : 'Roll to begin';
    }
  }

  function productionHint(sum) {
    if (sum === 7) return '🚨 7! Discard if >7 cards, then move robber.';
    if (sum === 2 || sum === 12) return `Production on ${sum} (rare)`;
    if (sum === 6 || sum === 8) return `Production on ${sum} (hot — most likely roll)`;
    return `Production on ${sum}`;
  }

  function renderActivePlayer() {
    const p = state.players[state.activePlayerIndex];
    if (!p) return;
    const colorObj = PLAYER_COLORS.find(c => c.key === p.colorKey);
    $('#active-name').textContent = p.name;
    const card = $('#active-player-card');
    const tag = $('#active-color');
    card.style.setProperty('--player-color', colorObj?.css || 'transparent');
    tag.style.setProperty('--player-color', colorObj?.css || 'transparent');
    $('#turn-counter').textContent = `Turn ${state.turnNumber} · ${p.name}`;
  }

  function renderPlayersMini() {
    const ul = $('#players-mini-list');
    ul.innerHTML = '';
    state.players.forEach((p, i) => {
      const li = document.createElement('li');
      const colorObj = PLAYER_COLORS.find(c => c.key === p.colorKey);
      const isActive = i === state.activePlayerIndex;
      const lr = state.longestRoadHolder === i ? '<span class="badge lr">LR</span>' : '';
      const la = state.largestArmyHolder === i ? '<span class="badge la">LA</span>' : '';
      li.className = isActive ? 'active' : '';
      li.innerHTML = `
        <span class="swatch" style="background:${colorObj?.css}"></span>
        <span class="pname">${escapeHtml(p.name)}${lr}${la}</span>
        <span class="pvp">${state.vp[i] ?? 0}</span>
      `;
      ul.appendChild(li);
    });
  }

  /* ============================================================ *
   * ROLL HANDLING
   * ============================================================ */

  function onDieRoll(diceId, value, kind) {
    const cd = state.configuredDice.find(c => c.diceId === diceId);
    if (!cd) return;
    if (cd.role !== 'prod1' && cd.role !== 'prod2') {
      toast(`Extra die rolled ${value}`, 'ok');
      return;
    }

    state.currentTurn.dieValues[diceId] = value;
    state.currentTurn.rolled = true;
    // Reset displayed sum until both dice settle for the new roll
    state.currentTurn.sumPending = null;
    if (state.rules.autoStartTimer && !state.turnStartedAt) startTurnTimer();

    // Need both production dice to have values
    const prod = state.configuredDice.filter(c => c.role === 'prod1' || c.role === 'prod2');
    const both = prod.every(c => state.currentTurn.dieValues[c.diceId] != null);

    updateRollDisplay();

    if (!both) return;

    // Compute sum
    const sum = prod.reduce((s, c) => s + state.currentTurn.dieValues[c.diceId], 0);
    state.currentTurn.sumPending = sum;
    updateRollDisplay();

    finalizeRoll(sum);
  }

  function finalizeRoll(sum) {
    // House rule: re-roll first 7
    if (sum === 7 && state.rules.rerollFirstSeven && !state.firstSevenHandled) {
      state.firstSevenHandled = true;
      toast('First 7 — house rule re-roll. Roll again!', 'warn');
      // Reset current dice values to invite a new roll
      state.currentTurn.dieValues = {};
      state.currentTurn.sumPending = null;
      updateRollDisplay();
      return;
    }

    // Log the roll
    const entry = {
      ts: Date.now(),
      sum,
      byPlayerIdx: state.activePlayerIndex,
      isSeven: sum === 7,
    };
    state.rollLog.push(entry);
    state.stats.counts[sum] = (state.stats.counts[sum] || 0) + 1;

    if (sum === 7) {
      state.sevenCount++;
      state.currentTurn.robberPending = true;
      // Flash all dice red
      dice.pulseLedAll(4, 30, 30, [255, 0, 0]);
      toast('🚨 7 rolled — robber active', 'danger');
      // Open discard helper
      showOverlay("discard");
    }

    renderRollLog();
    renderPlayersMini();
    persist();

    // Clear so the *next* roll requires both dice to settle again,
    // otherwise a single die jiggling would auto-finalize using the
    // previous turn's value for the other die.
    state.currentTurn.dieValues = {};
  }

  function renderRollLog() {
    const ol = $('#roll-log');
    ol.innerHTML = '';
    // newest at top
    [...state.rollLog].reverse().slice(0, 100).forEach(e => {
      const p = state.players[e.byPlayerIdx];
      const colorObj = PLAYER_COLORS.find(c => c.key === p?.colorKey);
      const li = document.createElement('li');
      if (e.isSeven) li.classList.add('is-seven');
      const time = new Date(e.ts);
      const t = `${pad(time.getHours())}:${pad(time.getMinutes())}`;
      li.innerHTML = `
        <span class="log-sum">${e.sum}</span>
        <span class="log-detail">
          <span class="player-tag" style="background:${colorObj?.css || '#888'}"></span>
          ${escapeHtml(p?.name || '—')}
        </span>
        <span class="log-time">${t}</span>
      `;
      ol.appendChild(li);
    });
  }

  /* ============================================================ *
   * TURN MANAGEMENT
   * ============================================================ */

  function startTurnTimer() {
    if (!state.gameStartedAt) state.gameStartedAt = Date.now();
    state.turnStartedAt = Date.now();
  }

  function endTurn() {
    // Accumulate turn time
    if (state.turnStartedAt) {
      const elapsed = Date.now() - state.turnStartedAt;
      state.perPlayerTotalMs[state.activePlayerIndex] =
        (state.perPlayerTotalMs[state.activePlayerIndex] || 0) + elapsed;
      if (elapsed > state.longestTurnMs) state.longestTurnMs = elapsed;
    }

    // Reset turn-local state
    state.currentTurn = {
      rolled: false,
      sumPending: null,
      dieValues: {},
      robberPending: false,
      sbpPending: false,
    };
    state.turnStartedAt = null;

    // 5-6 player Special Build Phase trigger
    if (state.rules.sixPlayer && state.players.length >= 5) {
      // Pause for SBP before advancing turn
      showOverlay('sbp');
      return;
    }

    advancePlayer();
  }

  function advancePlayer() {
    state.activePlayerIndex = (state.activePlayerIndex + 1) % state.players.length;
    if (state.activePlayerIndex === 0) state.turnNumber++;
    renderGame();
    // LED color for new active player
    if (state.rules.ledPerPlayer) {
      const p = state.players[state.activePlayerIndex];
      const rgb = PLAYER_LED_RGB[p.colorKey] || [255,255,255];
      dice.setLedAll(rgb, rgb);
    }
    persist();
  }

  function updateClocks() {
    if (state.gameStartedAt) {
      $('#game-clock').textContent = formatDuration(Date.now() - state.gameStartedAt);
    } else {
      $('#game-clock').textContent = '00:00';
    }
    if (state.turnStartedAt) {
      $('#turn-clock').textContent = formatDuration(Date.now() - state.turnStartedAt);
    } else {
      $('#turn-clock').textContent = '00:00';
    }
  }
  setInterval(() => { if (state.phase === 'game') updateClocks(); }, 500);

  /* ============================================================ *
   * DISCARD HELPER (7 / robber)
   * ============================================================ */

  // Per-discard scratch state — not persisted
  let discardCounts = {};

  function renderDiscardList() {
    discardCounts = {};
    state.players.forEach((_, i) => discardCounts[i] = 0);
    const wrap = $('#discard-list');
    wrap.innerHTML = '';
    state.players.forEach((p, i) => {
      const colorObj = PLAYER_COLORS.find(c => c.key === p.colorKey);
      const row = document.createElement('div');
      row.className = 'discard-row';
      row.dataset.i = i;
      row.innerHTML = `
        <span class="swatch" style="background:${colorObj?.css}"></span>
        <span class="pname">${escapeHtml(p.name)}</span>
        <button class="btn count-btn ghost" data-discard-action="dec" data-i="${i}">−</button>
        <span class="count-num" data-count="${i}">0</span>
        <button class="btn count-btn" data-discard-action="inc" data-i="${i}">+</button>
        <span class="needed" data-needed="${i}">no discard</span>
      `;
      wrap.appendChild(row);
    });
  }

  function updateDiscardRow(i) {
    const cards = discardCounts[i] || 0;
    const needed = cards > 7 ? Math.floor(cards / 2) : 0;
    const row = $(`.discard-row[data-i="${i}"]`);
    if (!row) return;
    $(`[data-count="${i}"]`).textContent = cards;
    $(`[data-needed="${i}"]`).textContent =
      needed > 0 ? `discard ${needed}` : (cards > 0 ? 'safe (≤7)' : 'no discard');
    row.classList.toggle('safe', needed === 0 && cards > 0);
  }

  /* ============================================================ *
   * STATS
   * ============================================================ */

  function renderStats() {
    const total = state.rollLog.length;
    $('#stats-total').textContent = total;

    // Build chart 2-12
    const chart = $('#stats-chart');
    chart.innerHTML = '';
    const counts = state.stats.counts;
    let maxCount = 1;
    for (let s = 2; s <= 12; s++) maxCount = Math.max(maxCount, counts[s] || 0, total * EXPECTED_FREQ_2D6[s]);

    // Determine hot/cold (top 2 / bottom 2 by deviation from expected)
    const dev = {};
    for (let s = 2; s <= 12; s++) {
      const expected = total * EXPECTED_FREQ_2D6[s];
      dev[s] = (counts[s] || 0) - expected;
    }
    const sortedByDev = Object.keys(dev).map(Number).sort((a, b) => dev[b] - dev[a]);
    const hot = total >= 8 ? new Set(sortedByDev.slice(0, 2)) : new Set();
    const cold = total >= 8 ? new Set(sortedByDev.slice(-2)) : new Set();

    for (let s = 2; s <= 12; s++) {
      const c = counts[s] || 0;
      const expected = total * EXPECTED_FREQ_2D6[s];
      const heightPct = (c / maxCount) * 100;
      const expectedPct = (expected / maxCount) * 100;
      const bar = document.createElement('div');
      bar.className = 'stats-bar';
      if (s === 7) bar.classList.add('is-seven');
      if (hot.has(s)) bar.classList.add('hot');
      if (cold.has(s)) bar.classList.add('cold');
      bar.innerHTML = `
        <div class="bar-wrap">
          <div class="bar" style="height:${heightPct}%"></div>
          <div class="expected-line" style="bottom:${expectedPct}%" title="Expected: ${expected.toFixed(1)}"></div>
        </div>
        <div class="value">${c}</div>
        <div class="label">${s}</div>
      `;
      chart.appendChild(bar);
    }

    // Per-player rolls
    const byPlayer = state.players.map((_, i) =>
      state.rollLog.filter(r => r.byPlayerIdx === i).length
    );
    const byPlayerSevens = state.players.map((_, i) =>
      state.rollLog.filter(r => r.byPlayerIdx === i && r.isSeven).length
    );
    const byPlayerWrap = $('#stats-by-player');
    byPlayerWrap.innerHTML = '';
    state.players.forEach((p, i) => {
      const colorObj = PLAYER_COLORS.find(c => c.key === p.colorKey);
      const row = document.createElement('div');
      row.className = 'discard-row';
      row.innerHTML = `
        <span class="swatch" style="background:${colorObj?.css}"></span>
        <span class="pname">${escapeHtml(p.name)}</span>
        <span class="muted small">rolls</span>
        <span class="count-num">${byPlayer[i]}</span>
        <span class="muted small">7s</span>
        <span class="count-num" style="color:var(--c-danger)">${byPlayerSevens[i]}</span>
        <span class="muted small">turn time</span>
        <span class="count-num mono">${formatDuration(state.perPlayerTotalMs[i] || 0)}</span>
      `;
      byPlayerWrap.appendChild(row);
    });
  }

  /* ============================================================ *
   * AIDS / VP / longest road / largest army
   * ============================================================ */

  function renderAids() {
    // VP grid
    const grid = $('#vp-grid');
    grid.innerHTML = '';
    state.players.forEach((p, i) => {
      const colorObj = PLAYER_COLORS.find(c => c.key === p.colorKey);
      const row = document.createElement('div');
      row.className = 'vp-row';
      row.innerHTML = `
        <span class="swatch" style="background:${colorObj?.css}"></span>
        <span class="name">${escapeHtml(p.name)}</span>
        <div class="vp-controls">
          <button class="btn ghost" data-vp-action="dec" data-i="${i}">−</button>
          <span class="vp-num" data-vp="${i}">${state.vp[i] ?? 0}</span>
          <button class="btn" data-vp-action="inc" data-i="${i}">+</button>
        </div>
      `;
      grid.appendChild(row);
    });

    // Longest road / largest army selects
    const lrSel = $('#longest-road-select');
    const laSel = $('#largest-army-select');
    const opts = ['<option value="">— none —</option>']
      .concat(state.players.map((p, i) => `<option value="${i}">${escapeHtml(p.name)}</option>`));
    lrSel.innerHTML = opts.join('');
    laSel.innerHTML = opts.join('');
    lrSel.value = state.longestRoadHolder ?? '';
    laSel.value = state.largestArmyHolder ?? '';
  }

  /* ============================================================ *
   * SETTINGS
   * ============================================================ */

  function renderSettings() {
    const wrap = $('#settings-rules');
    wrap.innerHTML = `
      <legend>Rules</legend>
      <label><input type="checkbox" data-rule="sixPlayer" ${state.rules.sixPlayer?'checked':''} /> 5–6 player Special Build Phase</label>
      <label><input type="checkbox" data-rule="rerollFirstSeven" ${state.rules.rerollFirstSeven?'checked':''} /> Re-roll first 7</label>
      <label><input type="checkbox" data-rule="ledPerPlayer" ${state.rules.ledPerPlayer?'checked':''} /> LED dice in active player color</label>
      <label><input type="checkbox" data-rule="autoStartTimer" ${state.rules.autoStartTimer?'checked':''} /> Auto-start turn timer on first roll</label>
    `;
    renderSettingsDice();
  }
  function renderSettingsDice() {
    const wrap = $('#settings-dice');
    if (!wrap) return;
    const all = dice.list();
    if (all.length === 0) {
      wrap.innerHTML = `<p class="muted small">No dice paired.</p>`;
      return;
    }
    wrap.innerHTML = '';
    all.forEach((d, idx) => {
      const battery = d.battery != null ? `${d.battery}%` : '—';
      const row = document.createElement('div');
      row.className = 'discard-row';
      row.innerHTML = `
        <strong>Die ${idx + 1}</strong>
        <span class="muted">${d.color || (d.manual ? 'manual' : '?')}</span>
        <span class="muted">🔋 ${battery}</span>
        ${d.manual ? '' : `<button class="btn tiny" data-action="led-test" data-id="${d.diceId}">Flash</button>`}
        <button class="btn tiny ghost" data-action="forget-die" data-id="${d.diceId}">Remove</button>
      `;
      wrap.appendChild(row);
    });
  }

  /* ============================================================ *
   * EVENT WIRING
   * ============================================================ */

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-action]');
    if (!t) return;
    const action = t.dataset.action;
    handleAction(action, t, ev);
  });

  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.matches('[data-player-name]')) {
      state.players[+t.dataset.playerName].name = t.value;
      persist();
      renderPlayersMini();
    }
    if (t.matches('input[data-rule]')) {
      state.rules[t.dataset.rule] = t.checked;
      persist();
      if (state.phase === 'game') {
        $('#sbp-btn').classList.toggle('hidden', !state.rules.sixPlayer);
      }
    }
  });
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.matches('[data-player-color]')) {
      state.players[+t.dataset.playerColor].colorKey = t.value;
      persist();
      renderSetupPlayers();
      renderPlayersMini();
    }
    if (t.matches('[data-role-for]')) {
      const cd = state.configuredDice.find(c => c.diceId === t.dataset.roleFor);
      if (cd) cd.role = t.value;
      renderSetupRoles();
    }
    if (t.id === 'longest-road-select') {
      state.longestRoadHolder = t.value === '' ? null : +t.value;
      renderPlayersMini();
      persist();
    }
    if (t.id === 'largest-army-select') {
      state.largestArmyHolder = t.value === '' ? null : +t.value;
      renderPlayersMini();
      persist();
    }
  });

  function handleAction(action, el, ev) {
    switch (action) {
      case 'new-game':
        state = freshState();
        state.phase = 'setup';
        state.setupStep = 1;
        ensureCollectionsForPlayers();
        showScreen('setup');
        break;
      case 'show-diagnostics':
        ev && ev.preventDefault && ev.preventDefault();
        showDiagnosticsDialog();
        break;
      case 'resume':
        showScreen('game');
        break;
      case 'discard-saved':
        clearSaved();
        renderWelcome();
        break;
      case 'back-to-welcome':
        showScreen('welcome');
        renderWelcome();
        break;
      case 'add-player':
        if (state.players.length >= 6) return toast('Max 6 players', 'warn');
        const usedColors = new Set(state.players.map(p => p.colorKey));
        const free = PLAYER_COLORS.find(c => !usedColors.has(c.key))?.key || 'red';
        state.players.push({ name: `Player ${state.players.length + 1}`, colorKey: free });
        ensureCollectionsForPlayers();
        renderSetupPlayers();
        break;
      case 'remove-player':
        if (state.players.length <= 3) return toast('Min 3 players', 'warn');
        state.players.splice(+el.dataset.i, 1);
        ensureCollectionsForPlayers();
        renderSetupPlayers();
        break;
      case 'step-next':
        state.setupStep = Math.min(3, state.setupStep + 1);
        renderSetup();
        break;
      case 'step-prev':
        state.setupStep = Math.max(1, state.setupStep - 1);
        renderSetup();
        break;
      case 'pair-die':
        pairDieAction();
        break;
      case 'manual-mode':
        state.manualMode = true;
        // Add 2 manual dice if none
        const all = dice.list();
        if (all.filter(d => d.manual).length < 2 && all.length < 2) {
          dice.addManual('A');
          dice.addManual('B');
        }
        renderSetupDice();
        break;
      case 'led-test':
        dice.pulseLed(el.dataset.id, 3, 30, 30, [120, 200, 255]);
        break;
      case 'forget-die':
        dice.disconnect(el.dataset.id);
        state.configuredDice = state.configuredDice.filter(c => c.diceId !== el.dataset.id);
        renderSetupDice();
        if (state.setupStep === 3) renderSetupRoles();
        break;
      case 'start-game':
        state.phase = 'game';
        state.gameStartedAt = null;     // starts on first roll if autoStart
        state.turnNumber = 1;
        state.activePlayerIndex = 0;
        ensureCollectionsForPlayers();
        // Initial LED color
        if (state.rules.ledPerPlayer) {
          const p = state.players[0];
          const rgb = PLAYER_LED_RGB[p.colorKey] || [255,255,255];
          dice.setLedAll(rgb, rgb);
        }
        showScreen('game');
        toast(`${state.players[0].name}'s turn`, 'ok');
        break;
      case 'end-turn':
        endTurn();
        break;
      case 'open-settings':
        showOverlay('settings'); break;
      case 'open-stats':
        showOverlay('stats'); break;
      case 'open-aids':
        showOverlay('aids'); break;
      case 'open-discard':
        showOverlay('discard'); break;
      case 'open-sbp':
        showOverlay('sbp'); break;
      case 'close-overlay':
        closeOverlays(); break;
      case 'confirm-robber':
        state.currentTurn.robberPending = false;
        closeOverlays();
        toast('Robber moved', 'ok');
        break;
      case 'finish-sbp':
        closeOverlays();
        advancePlayer();
        break;
      case 'reset-stats':
        state.rollLog = [];
        state.stats = { counts: {} };
        toast('Stats reset', 'ok');
        renderRollLog();
        persist();
        break;
      case 'end-game':
        if (!confirm('End the current game? Stats will be saved to localStorage history but the active game will close.')) return;
        archiveGame();
        state = freshState();
        showScreen('welcome');
        renderWelcome();
        break;
      case 'clear-log':
        state.rollLog = [];
        state.stats = { counts: {} };
        renderRollLog();
        toast('Log cleared', 'ok');
        persist();
        break;
    }
  }

  // Manual roll on tap
  document.addEventListener('click', (ev) => {
    const dieEl = ev.target.closest('.dice-display .die');
    if (!dieEl || state.phase !== 'game') return;
    const slot = +dieEl.dataset.dieSlot;
    const prod = state.configuredDice.filter(c => c.role === 'prod1' || c.role === 'prod2');
    prod.sort((a, b) => a.role.localeCompare(b.role));
    const cd = prod[slot];
    if (!cd) return;
    const rec = dice.list().find(d => d.diceId === cd.diceId);
    // Only allow tap-to-enter for manual dice; for real dice, ignore.
    if (!rec || !rec.manual) return;
    const next = prompt('Enter rolled value (1-6):', rec.lastValue || '');
    const n = parseInt(next, 10);
    if (!Number.isFinite(n) || n < 1 || n > 6) return;
    dice.manualRoll(cd.diceId, n);
  });

  // Discard +/- buttons
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-discard-action]');
    if (!t) return;
    const i = +t.dataset.i;
    discardCounts[i] = Math.max(0, (discardCounts[i] || 0) + (t.dataset.discardAction === 'inc' ? 1 : -1));
    updateDiscardRow(i);
  });

  // VP +/- buttons
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-vp-action]');
    if (!t) return;
    const i = +t.dataset.i;
    state.vp[i] = Math.max(0, Math.min(20, (state.vp[i] || 0) + (t.dataset.vpAction === 'inc' ? 1 : -1)));
    $(`[data-vp="${i}"]`).textContent = state.vp[i];
    renderPlayersMini();
    persist();
    if (state.vp[i] >= 10) {
      toast(`🏆 ${state.players[i].name} reached 10 VP!`, 'ok');
    }
  });

  /* ============================================================ *
   * PAIRING ACTION
   * ============================================================ */

  async function pairDieAction() {
    if (state.manualMode) {
      // Add manual die
      dice.addManual(String.fromCharCode(65 + dice.list().length));
      renderSetupDice();
      return;
    }
    if (!isBluetoothEnv()) {
      toast('Web Bluetooth unavailable in this browser', 'warn');
      // offer manual fallback
      if (confirm('Web Bluetooth not available. Switch to manual entry mode?')) {
        state.manualMode = true;
        dice.addManual('A');
        dice.addManual('B');
        renderSetupDice();
      }
      return;
    }
    try {
      const id = await dice.pairNew();
      // ask GoDice to set die type to D6 explicitly (even though it's default)
      try {
        const inst = (dice._dice.get(id) || {}).instance;
        if (inst && inst.setDieType && window.GoDice && GoDice.diceTypes) {
          inst.setDieType(GoDice.diceTypes.D6);
        }
      } catch (e) {}
      toast('Die paired', 'ok');
      renderSetupDice();
    } catch (e) {
      // user cancelled chooser is common — don't yell
      console.warn(e);
      if (e && /cancel/i.test(e.message)) return;
      toast('Pairing failed: ' + (e.message || e), 'danger');
    }
  }

  /* ============================================================ *
   * PERSISTENCE
   * ============================================================ */

  function persist() {
    try {
      const snap = { ...state, configuredDice: state.configuredDice.map(c => ({...c, instance: undefined})) };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
    } catch (e) { /* quota / disabled */ }
  }
  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
    catch (e) { return null; }
  }
  function clearSaved() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }
  function archiveGame() {
    try {
      const archive = JSON.parse(localStorage.getItem(STORAGE_KEY + ':archive') || '[]');
      archive.unshift({
        endedAt: Date.now(),
        players: state.players.map(p => p.name),
        turnNumber: state.turnNumber,
        rolls: state.rollLog.length,
        sevens: state.sevenCount,
      });
      localStorage.setItem(STORAGE_KEY + ':archive', JSON.stringify(archive.slice(0, 20)));
      clearSaved();
    } catch (e) {}
  }

  /* ============================================================ *
   * UTILS
   * ============================================================ */

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[m]));
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function formatDuration(ms) {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2400);
    setTimeout(() => el.remove(), 2900);
  }

  function showDiagnosticsDialog() {
    const d = DiceManager.diagnostics();
    const rows = [
      ['Page protocol',          d.protocol],
      ['Host',                   d.host],
      ['Secure context?',        d.secureContext ? 'yes' : 'NO (Bluetooth requires HTTPS or localhost)'],
      ['navigator.bluetooth?',   d.hasNavigatorBluetooth ? 'yes' : 'NO (browser does not expose the API)'],
      ['Web Bluetooth usable?',  d.bluetoothApiUsable ? 'yes' : 'NO'],
      ['GoDice library loaded?', d.goDiceLibraryLoaded ? 'yes' : 'NO (CDN blocked or load failed)'],
      ['User agent',             d.userAgent],
    ];
    const lines = rows.map(r =>
      `<tr><th style="text-align:left;padding:.25rem .5rem;color:var(--c-ink-dim);font-weight:500">${r[0]}</th>` +
      `<td style="padding:.25rem .5rem;font-family:var(--font-mono);font-size:.85rem;word-break:break-all">${escapeHtml(String(r[1]))}</td></tr>`
    ).join('');

    let host = $('#diagnostics-modal');
    if (host) host.remove();
    host = document.createElement('div');
    host.id = 'diagnostics-modal';
    host.className = 'overlay';
    host.innerHTML = `
      <div class="drawer" style="max-width:560px">
        <header><h2>Diagnostics</h2>
          <button class="btn ghost icon" data-action="close-diag">✕</button></header>
        <div class="drawer-body">
          <p class="muted">Share this with whoever's helping you debug.</p>
          <table style="width:100%;border-collapse:collapse">${lines}</table>
          <p class="muted small" style="margin-top:1rem">If <strong>Web Bluetooth usable</strong> is "no" but you're on Chrome/Edge over HTTPS with system Bluetooth on, try: <em>chrome://flags</em> → search "Web Bluetooth" → ensure not disabled. Also grant Location permission to the browser on Android.</p>
        </div>
      </div>
    `;
    document.body.appendChild(host);
    host.addEventListener('click', (e) => {
      if (e.target === host || e.target.closest('[data-action="close-diag"]')) host.remove();
    });
  }

  /* ============================================================ *
   * BOOTSTRAP
   * ============================================================ */

  function boot() {
    const saved = loadSaved();
    if (saved && saved.phase === 'game') {
      // Hydrate. Bluetooth pairings DON'T survive a page refresh, so
      // any configured dice missing from DiceManager get re-registered
      // as manual dice. The user can re-pair real dice from Settings.
      Object.assign(state, saved);
      state.currentTurn = state.currentTurn || { rolled:false, sumPending:null, dieValues:{}, robberPending:false, sbpPending:false };
      ensureCollectionsForPlayers();
      const restoredManualMap = new Map();
      (state.configuredDice || []).forEach((cd, idx) => {
        if (!dice.has(cd.diceId)) {
          const newId = dice.addManual('restored-' + idx);
          restoredManualMap.set(cd.diceId, newId);
        }
      });
      state.configuredDice = (state.configuredDice || []).map(cd => {
        if (restoredManualMap.has(cd.diceId)) {
          return { ...cd, diceId: restoredManualMap.get(cd.diceId) };
        }
        return cd;
      });
      if (restoredManualMap.size > 0) state.manualMode = true;
    }
    showScreen(state.phase || 'welcome');
    renderWelcome();
    // Re-render the BT banner after async script loading settles —
    // GoDice library may finish loading after our boot() runs.
    setTimeout(renderBluetoothBanner, 100);
    setTimeout(renderBluetoothBanner, 1500);
  }
  boot();

})();
