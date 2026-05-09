/* =====================================================================
 * godice-adapter.js
 * ---------------------------------------------------------------------
 * Thin event-emitter wrapper around the (unmaintained) global GoDice
 * class. Solves three problems with the upstream API:
 *
 *   1. Prototype-override pattern means callbacks are GLOBAL to the
 *      class. Adding handlers on a 2nd instance overwrites the 1st.
 *      We install the prototype handlers once and route by diceId.
 *
 *   2. We need a single subscribe() interface so app.js doesn't have
 *      to know about the upstream API.
 *
 *   3. Web Bluetooth is unavailable in many environments (iOS Safari,
 *      file://, HTTP). Callers can use enableManualMode() to drive the
 *      same event stream from manual user input.
 *
 * Public API:
 *   const dm = new DiceManager();
 *   dm.on('roll',       (e) => ...);   // {diceId, value, raw}
 *   dm.on('rollStart',  (e) => ...);   // {diceId}
 *   dm.on('connected',  (e) => ...);   // {diceId, color, battery}
 *   dm.on('disconnect', (e) => ...);   // {diceId}
 *   dm.on('battery',    (e) => ...);   // {diceId, level}
 *   dm.on('color',      (e) => ...);   // {diceId, colorIdx, colorName}
 *
 *   await dm.pairNew();         // browser dialog -> resolves with diceId
 *   dm.list();                  // [{diceId, color, battery, connected}]
 *   dm.setLed(diceId, [r,g,b]);
 *   dm.pulseLed(diceId, count, on, off, [r,g,b]);
 *   dm.disconnect(diceId);
 *
 *   dm.manualRoll(diceId, value);   // for manual mode / on-screen tap
 *
 *   DiceManager.isBluetoothSupported();
 * ===================================================================== */

(function (global) {
  'use strict';

  const COLORS = ['BLACK', 'RED', 'GREEN', 'BLUE', 'YELLOW', 'ORANGE'];

  function isBluetoothSupported() {
    return typeof navigator !== 'undefined' &&
           !!navigator.bluetooth &&
           typeof navigator.bluetooth.requestDevice === 'function' &&
           typeof global.GoDice === 'function';
  }

  class DiceManager {
    constructor() {
      this._listeners = {};                // event -> Set<fn>
      this._dice = new Map();              // diceId -> { instance, color, battery, connected, manual, lastValue }
      this._installed = false;
      this._installPrototypeHandlers();
    }

    /* ----------------- event emitter ----------------- */
    on(event, fn) {
      (this._listeners[event] ||= new Set()).add(fn);
      return () => this._listeners[event].delete(fn);
    }
    _emit(event, payload) {
      const set = this._listeners[event];
      if (!set) return;
      for (const fn of set) {
        try { fn(payload); } catch (err) { console.error('[DiceManager]', event, err); }
      }
    }

    /* ----------------- centralized prototype handlers ----------------- */
    _installPrototypeHandlers() {
      if (this._installed) return;
      if (typeof global.GoDice !== 'function') {
        // godice.js failed to load (CDN blocked / offline). Adapter still
        // works in manual mode — we just can't pair real dice.
        this._installed = true;
        return;
      }
      const Proto = global.GoDice.prototype;
      const self = this;

      Proto.onDiceConnected = function (diceId /*, instance */) {
        const rec = self._dice.get(diceId);
        if (rec) rec.connected = true;
        self._emit('connected', { diceId });
        // Fire follow-up requests to learn color and battery.
        try { this.getDiceColor && this.getDiceColor(); } catch (e) {}
        try { this.getBatteryLevel && this.getBatteryLevel(); } catch (e) {}
      };

      Proto.onDiceDisconnected = function (diceId) {
        const rec = self._dice.get(diceId);
        if (rec) rec.connected = false;
        self._emit('disconnect', { diceId });
      };

      Proto.onBatteryLevel = function (diceId, level) {
        const rec = self._dice.get(diceId);
        if (rec) rec.battery = level;
        self._emit('battery', { diceId, level });
      };

      Proto.onDiceColor = function (diceId, colorIdx) {
        const rec = self._dice.get(diceId);
        const colorName = COLORS[colorIdx] || 'UNKNOWN';
        if (rec) rec.color = colorName;
        self._emit('color', { diceId, colorIdx, colorName });
      };

      Proto.onRollStart = function (diceId) {
        self._emit('rollStart', { diceId });
      };

      Proto.onStable = function (diceId, value, xyzAccRaw) {
        const rec = self._dice.get(diceId);
        if (rec) rec.lastValue = value;
        self._emit('roll', { diceId, value, raw: xyzAccRaw, kind: 'stable' });
      };

      // Tilt-stable: settled on edge / unusual orientation. Treat as
      // a real roll but flag it so UI can suggest re-rolling.
      Proto.onTiltStable = function (diceId, xyzAccRaw, value) {
        const rec = self._dice.get(diceId);
        if (rec) rec.lastValue = value;
        self._emit('roll', { diceId, value, raw: xyzAccRaw, kind: 'tilt' });
      };

      // Fake-stable: bumped die — DO NOT count as a roll. Surface as
      // a separate event so UI can ignore by default.
      Proto.onFakeStable = function (diceId, value, xyzAccRaw) {
        self._emit('fakeRoll', { diceId, value, raw: xyzAccRaw });
      };

      // Move-stable: small reorientation between faces — also not a roll.
      Proto.onMoveStable = function (diceId, value, xyzAccRaw) {
        const rec = self._dice.get(diceId);
        if (rec) rec.lastValue = value;
        self._emit('moveStable', { diceId, value, raw: xyzAccRaw });
      };

      this._installed = true;
    }

    /* ----------------- pairing / connection ----------------- */
    async pairNew() {
      if (!isBluetoothSupported()) {
        throw new Error('Web Bluetooth not available in this browser. Use manual mode.');
      }
      const inst = new global.GoDice();
      try {
        await inst.requestDevice();
      } catch (e) {
        // user cancelled or BLE error
        throw e;
      }
      // requestDevice resolves once the device is connecting; the
      // diceId is only known after onDiceConnected fires. Wait for it.
      const diceId = await this._waitForId(inst);
      this._dice.set(diceId, {
        instance: inst,
        color: null,
        battery: null,
        connected: true,
        manual: false,
        lastValue: null,
      });
      return diceId;
    }

    _waitForId(inst, timeoutMs = 12000) {
      return new Promise((resolve, reject) => {
        const start = Date.now();
        const poll = () => {
          // The library stores the device id on the instance under
          // a few possible keys depending on version. Probe common ones.
          const id = inst.diceId || inst._diceId || inst.deviceId ||
                     (inst.bluetoothDevice && inst.bluetoothDevice.id);
          if (id) return resolve(id);
          if (Date.now() - start > timeoutMs) {
            return reject(new Error('Timed out waiting for die id (connection may have failed).'));
          }
          setTimeout(poll, 80);
        };
        poll();
      });
    }

    list() {
      const out = [];
      for (const [diceId, rec] of this._dice) {
        out.push({
          diceId,
          color: rec.color,
          battery: rec.battery,
          connected: rec.connected,
          manual: rec.manual,
          lastValue: rec.lastValue,
        });
      }
      return out;
    }

    has(diceId) { return this._dice.has(diceId); }

    disconnect(diceId) {
      const rec = this._dice.get(diceId);
      if (!rec) return;
      try {
        const dev = rec.instance && rec.instance.bluetoothDevice;
        if (dev && dev.gatt && dev.gatt.connected) dev.gatt.disconnect();
      } catch (e) { /* swallow */ }
      this._dice.delete(diceId);
      this._emit('disconnect', { diceId, removed: true });
    }

    /* ----------------- LED control ----------------- */
    setLed(diceId, rgb1, rgb2) {
      const rec = this._dice.get(diceId);
      if (!rec || rec.manual || !rec.instance) return;
      try { rec.instance.setLed(rgb1 || null, rgb2 || rgb1 || null); } catch (e) { /* ignore */ }
    }
    pulseLed(diceId, count, onTime, offTime, rgb) {
      const rec = this._dice.get(diceId);
      if (!rec || rec.manual || !rec.instance) return;
      try { rec.instance.pulseLed(count, onTime, offTime, rgb); } catch (e) { /* ignore */ }
    }
    setLedAll(rgb1, rgb2) {
      for (const id of this._dice.keys()) this.setLed(id, rgb1, rgb2);
    }
    pulseLedAll(count, onTime, offTime, rgb) {
      for (const id of this._dice.keys()) this.pulseLed(id, count, onTime, offTime, rgb);
    }
    ledOff(diceId) { this.setLed(diceId, [0,0,0], [0,0,0]); }
    ledOffAll() { for (const id of this._dice.keys()) this.ledOff(id); }

    /* ----------------- battery polling ----------------- */
    refreshBattery(diceId) {
      const rec = this._dice.get(diceId);
      if (!rec || rec.manual || !rec.instance) return;
      try { rec.instance.getBatteryLevel(); } catch (e) {}
    }
    refreshBatteryAll() { for (const id of this._dice.keys()) this.refreshBattery(id); }

    /* ----------------- manual / virtual dice ----------------- */
    /**
     * Add a virtual die that responds to manualRoll() calls but doesn't
     * touch Bluetooth. Useful for iPad fallback or development.
     */
    addManual(label = 'manual') {
      const diceId = 'manual:' + label + ':' + Date.now().toString(36);
      this._dice.set(diceId, {
        instance: null,
        color: null,
        battery: null,
        connected: true,
        manual: true,
        lastValue: null,
      });
      this._emit('connected', { diceId, manual: true });
      return diceId;
    }

    manualRoll(diceId, value) {
      const rec = this._dice.get(diceId);
      if (!rec) return;
      rec.lastValue = value;
      this._emit('roll', { diceId, value, raw: null, kind: 'manual' });
    }
  }

  /* ---------- expose on window ---------- */
  global.DiceManager = DiceManager;
  DiceManager.isBluetoothSupported = isBluetoothSupported;
  DiceManager.COLORS = COLORS;

})(typeof window !== 'undefined' ? window : this);
