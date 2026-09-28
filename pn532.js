// PN532 über Web Serial (HSU/UART, 115200 Baud) und NTAG21x-Zugriff.
// Protokoll: NXP PN532 User Manual UM0701-02, Kap. 6.2 (Rahmen) und 7 (Befehle).

import { buildTlv, parseTlv, uriFromMessage } from "./ndef.js";

const CMD = {
  getFirmwareVersion: 0x02,
  samConfiguration: 0x14,
  rfConfiguration: 0x32,
  inDataExchange: 0x40,
  inListPassiveTarget: 0x4A
};
const CHIPS = { 0x12: "NTAG213", 0x3E: "NTAG215", 0x6D: "NTAG216" };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();

export class PN532 {
  constructor(port) {
    this.port = port;
    this.buf = [];
    this.wake = null;
    this.closed = false;
  }

  static supported() { return "serial" in navigator; }

  // Fragt den Nutzer nach dem Port (beim ersten Mal) und initialisiert das Modul
  static async connect() {
    const known = await navigator.serial.getPorts();
    const port = known.length === 1 ? known[0] : await navigator.serial.requestPort();
    return PN532.open(port);
  }

  static async open(port) {
    await port.open({ baudRate: 115200 });
    const dev = new PN532(port);
    dev.readLoop();
    await dev.init();
    return dev;
  }

  async readLoop() {
    this.reader = this.port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        for (const b of value) this.buf.push(b);
        if (this.wake) { this.wake(); this.wake = null; }
      }
    } catch (e) {
      // Port getrennt
    } finally {
      this.closed = true;
      if (this.wake) { this.wake(); this.wake = null; }
    }
  }

  async close() {
    try { await this.reader?.cancel(); } catch (e) {}
    try { await this.port.close(); } catch (e) {}
  }

  async send(bytes) {
    const w = this.port.writable.getWriter();
    try { await w.write(Uint8Array.from(bytes)); } finally { w.releaseLock(); }
  }

  async byte(deadline) {
    while (!this.buf.length) {
      if (this.closed) throw new Error("Verbindung zum Lesegerät getrennt.");
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("Das Lesegerät antwortet nicht.");
      await Promise.race([new Promise(r => { this.wake = r; }), sleep(left)]);
    }
    return this.buf.shift();
  }

  // Liest den nächsten Rahmen; ACK wird als { ack: true } geliefert
  async frame(deadline) {
    let prev = -1, b;
    for (;;) {                                   // Startcode 00 FF suchen
      b = await this.byte(deadline);
      if (prev === 0x00 && b === 0xFF) break;
      prev = b;
    }
    const len = await this.byte(deadline);
    const lcs = await this.byte(deadline);
    if (len === 0x00 && lcs === 0xFF) return { ack: true };
    if (((len + lcs) & 0xFF) !== 0) throw new Error("Gestörte Antwort vom Lesegerät (Länge).");
    const body = [];
    for (let i = 0; i < len; i++) body.push(await this.byte(deadline));
    const dcs = await this.byte(deadline);
    if ((body.reduce((s, x) => s + x, 0) + dcs) & 0xFF) throw new Error("Gestörte Antwort vom Lesegerät (Prüfsumme).");
    return { ack: false, body };
  }

  async command(cmd, data = [], timeout = 1000) {
    const payload = [0xD4, cmd, ...data];
    const len = payload.length;
    const dcs = (0x100 - (payload.reduce((s, x) => s + x, 0) & 0xFF)) & 0xFF;
    this.buf.length = 0;
    await this.send([0x00, 0x00, 0xFF, len, (0x100 - len) & 0xFF, ...payload, dcs, 0x00]);
    const deadline = Date.now() + timeout;
    const ack = await this.frame(deadline);
    if (!ack.ack) throw new Error("Lesegerät hat den Befehl nicht bestätigt.");
    const res = await this.frame(deadline);
    if (res.ack) throw new Error("Unerwartete Antwort vom Lesegerät.");
    const [tfi, rc, ...rest] = res.body;
    if (tfi === 0x7F) throw new Error("Lesegerät meldet einen Befehlsfehler.");
    if (tfi !== 0xD5 || rc !== cmd + 1) throw new Error("Unerwartete Antwort vom Lesegerät.");
    return rest;
  }

  async init() {
    // HSU-Weckfolge: lange Präambel, dann SAMConfiguration (Normalbetrieb)
    await this.send([0x55, 0x55, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    await this.command(CMD.samConfiguration, [0x01, 0x14, 0x01]);
    const fw = await this.command(CMD.getFirmwareVersion);
    if (fw[0] !== 0x32) throw new Error("Das Gerät an diesem Port ist kein PN532.");
    this.firmware = `PN532 v${fw[1]}.${fw[2]}`;
    // Wenige Aktivierungsversuche, damit die Tag-Suche schnell zurückkehrt
    await this.command(CMD.rfConfiguration, [0x05, 0xFF, 0x01, 0x02]);
  }

  // Sucht einen Tag im Feld; Rückgabe: UID als Hex-Text oder null
  async findTag() {
    const r = await this.command(CMD.inListPassiveTarget, [0x01, 0x00], 1500);
    if (!r[0]) return null;
    const sens = (r[2] << 8) | r[3], sel = r[4], uidLen = r[5];
    if (sens !== 0x0044 || sel !== 0x00) throw new Error("Dieser Tag ist kein NTAG. Bitte NTAG213/215/216 verwenden.");
    return hex(r.slice(6, 6 + uidLen));
  }

  async waitForTag(signal, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (signal?.aborted) throw new DOMException("Abgebrochen", "AbortError");
      const uid = await this.findTag();
      if (uid) return uid;
      await sleep(150);
    }
    throw new Error("Kein Tag gefunden. Bitte den Tag flach auf das Lesegerät legen.");
  }

  async readPages(page) {
    const r = await this.command(CMD.inDataExchange, [0x01, 0x30, page]);
    if (r[0] & 0x3F) throw new Error(`Lesefehler auf Seite ${page}. Tag liegt nicht ruhig auf.`);
    return r.slice(1, 17);
  }

  async writePage(page, four) {
    const r = await this.command(CMD.inDataExchange, [0x01, 0xA2, page, ...four]);
    if (r[0] & 0x3F) throw new Error(`Schreibfehler auf Seite ${page}. Tag liegt nicht ruhig auf oder ist schreibgeschützt.`);
  }

  // Capability Container (Seite 3) auswerten
  async tagInfo() {
    const cc = (await this.readPages(3)).slice(0, 4);
    if (cc[0] !== 0xE1) throw new Error("Tag ist nicht NDEF-formatiert.");
    return { size: cc[2] * 8, chip: CHIPS[cc[2]] || `${cc[2] * 8} Byte`, writable: (cc[3] & 0x0F) === 0 };
  }

  // Liest die URL vom aufgelegten Tag (null bei leerem Tag)
  async readUrl(info) {
    info = info || await this.tagInfo();
    const bytes = [];
    for (let p = 4; bytes.length < info.size; p += 4) {
      bytes.push(...await this.readPages(p));
      const t = parseTlv(bytes);
      if (t.complete) return t.message ? uriFromMessage(t.message) : null;
    }
    return null;
  }

  // Schreibt die URL und liest zur Kontrolle zurück
  async writeUrl(url, info) {
    info = info || await this.tagInfo();
    if (!info.writable) throw new Error("Tag ist schreibgeschützt.");
    const data = [...buildTlv(url)];
    if (data.length > info.size) throw new Error(`Inhalt zu groß: ${data.length} Byte, ${info.chip} fasst ${info.size} Byte.`);
    while (data.length % 4) data.push(0x00);
    for (let i = 0; i < data.length; i += 4) await this.writePage(4 + i / 4, data.slice(i, i + 4));
    const back = await this.readUrl(info);
    if (back !== url) throw new Error("Kontrolle fehlgeschlagen: Der Tag enthält nach dem Schreiben andere Daten.");
    return { bytes: buildTlv(url).length, ...info };
  }
}
