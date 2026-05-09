/* =====================================================================
 * godice-adapter.js — wrapper around the (unmaintained) GoDice global.
 *
 * - Routes class-level prototype callbacks to per-die event subscribers
 * - Manual-entry mode for iPad / browsers without Web Bluetooth
 * - Detects whether the helper library is loaded (CDN can fail)
 * ===================================================================== */
(function (global) {
  'use strict';

  const COLORS = ['BLACK', 'RED', 'GREEN', 'BLUE', 'YELLOW', 'ORANGE'];

  function isBluetoothSupported() {
    return typeof navigator !== 'undefined' &&
           !!navigator.bluetooth &&
           typeof navigator.bluetooth.requestDevice === 'function';
  }
  function isLibraryLoaded() {
    return typeof global.GoDice === 'function';
  }
  function isSecureContext() {
    if (typeof global.isSecureContext === 'boolean') return global.isSecureContext;
    try {
      const loc = global.location || {};
      return loc.protocol === 'https:' || loc.hostname === 'localhost' || loc.hostname === '127.0.0.1';
    } catch (e) { return false; }
  }
  function diagnostics() {
    let proto = '?', host = '?';
    try { proto = global.location.protocol; host = global.location.host; } catch (e) {}
    return {
      secureContext: isSecureContext(),
      protocol: proto,
      host: host,
      hasNavigatorBluetooth: typeof navigator !== 'undefined' && !!navigator.bluetooth,
      bluetoothApiUsable: isBluetoothSupported(),
      goDiceLibraryLoaded: isLibraryLoaded(),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '(no UA)',
    };
  }

  class DiceManager {
    constructor() {
      this._listeners = {};
      this._dice = new Map();
      this._installed = false;
      this._installPrototypeHandlers();
      // GoDice library may load AFTER this constructor (fetched async with
      // CDN fallbacks). Install handlers when the loader signals success
      // OR when polling detects the global.
      if (!this._installed && typeof global.addEventListener === 'function') {
        const retry = () => {
          if (this._installed) return;
          this._installPrototypeHandlers();
        };
        global.addEventListener('godice-loaded', retry, { once: true });
        let tries = 0;
        const poll = () => {
          if (this._installed) return;
          if (typeof global.GoDice === 'function') { retry(); return; }
          if (tries++ < 60) setTimeout(poll, 100);
        };
        setTimeout(poll, 50);
      }
    }

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

    _installPrototypeHandlers() {
      if (this._installed) return;
      if (typeof global.GoDice !== 'function') return;
      const Proto = global.GoDice.prototype;
      const self = this;

      Proto.onDiceConnected = function (diceId) {
        const rec = self._dice.get(diceId);
        if (rec) rec.connected = true;
        self._emit('connected', { diceId });
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
      Proto.onTiltStable = function (diceId, xyzAccRaw, value) {
        const rec = self._dice.get(diceId);
        if (rec) rec.lastValue = value;
        self._emit('roll', { diceId, value, raw: xyzAccRaw, kind: 'tilt' });
      };
      Proto.onFakeStable = function (diceId, value, xyzAccRaw) {
        self._emit('fakeRoll', { diceId, value, raw: xyzAccRaw });
      };
      Proto.onMoveStable = function (diceId, value, xyzAccRaw) {
        const rec = self._dice.get(diceId);
        if (rec) rec.lastValue = value;
        self._emit('moveStable', { diceId, value, raw: xyzAccRaw });
      };

      this._installed = true;
    }

    async pairNew() {
      if (!isBluetoothSupported()) {
        throw new Error('Web Bluetooth not available in this browser. Use manual mode.');
      }
      if (!isLibraryLoaded()) {
        throw new Error('GoDice library not loaded yet — wait a moment and try again.');
      }
      this._installPrototypeHandlers();
      const inst = new global.GoDice();
      try { await inst.requestDevice(); } catch (e) { throw e; }
      const diceId = await this._waitForId(inst);
      this._dice.set(diceId, {
        instance: inst, color: null, battery: null,
        connected: true, manual: false, lastValue: null,
      });
      return diceId;
    }

    _waitForId(inst, timeoutMs = 12000) {
      return new Promise((resolve, reject) => {
        const start = Date.now();
        const poll = () => {
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
          diceId, color: rec.color, battery: rec.battery,
          connected: rec.connected, manual: rec.manual, lastValue: rec.lastValue,
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
      } catch (e) {}
      this._dice.delete(diceId);
      this._emit('disconnect', { diceId, removed: true });
    }

    setLed(diceId, rgb1, rgb2) {
      const rec = this._dice.get(diceId);
      if (!rec || rec.manual || !rec.instance) return;
      try { rec.instance.setLed(rgb1 || null, rgb2 || rgb1 || null); } catch (e) {}
    }
    pulseLed(diceId, count, onTime, offTime, rgb) {
      const rec = this._dice.get(diceId);
      if (!rec || rec.manual || !rec.instance) return;
      try { rec.instance.pulseLed(count, onTime, offTime, rgb); } catch (e) {}
    }
    setLedAll(rgb1, rgb2) { for (const id of this._dice.keys()) this.setLed(id, rgb1, rgb2); }
    pulseLedAll(count, onTime, offTime, rgb) {
      for (const id of this._dice.keys()) this.pulseLed(id, count, onTime, offTime, rgb);
    }
    ledOff(diceId) { this.setLed(diceId, [0,0,0], [0,0,0]); }
    ledOffAll() { for (const id of this._dice.keys()) this.ledOff(id); }

    refreshBattery(diceId) {
      const rec = this._dice.get(diceId);
      if (!rec || rec.manual || !rec.instance) return;
      try { rec.instance.getBatteryLevel(); } catch (e) {}
    }
    refreshBatteryAll() { for (const id of this._dice.keys()) this.refreshBattery(id); }

    addManual(label = 'manual') {
      const diceId = 'manual:' + label + ':' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
      this._dice.set(diceId, {
        instance: null, color: null, battery: null,
        connected: true, manual: true, lastValue: null,
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

  global.DiceManager = DiceManager;
  DiceManager.isBluetoothSupported = isBluetoothSupported;
  DiceManager.isLibraryLoaded      = isLibraryLoaded;
  DiceManager.isSecureContext      = isSecureContext;
  DiceManager.diagnostics          = diagnostics;
  DiceManager.COLORS               = COLORS;

})(typeof window !== 'undefined' ? window : this);
