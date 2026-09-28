// Tag lesen und schreiben, wahlweise über Web NFC (Chrome auf Android)
// oder einen PN532 über Web Serial (Chrome/Edge am PC).

import { PN532 } from "./pn532.js";

export const mode = "NDEFReader" in window ? "nfc" : PN532.supported() ? "serial" : null;

// Adresse aus einer Web-NFC-Nachricht; akzeptiert auch Text-Records mit einer Adresse
function nfcUrl(message) {
  const recs = message.records.map(r => ({
    type: r.recordType,
    text: r.data ? new TextDecoder(r.encoding || "utf-8").decode(r.data) : ""
  }));
  const hit = recs.find(r => r.type === "url" || r.type === "absolute-url")
    || recs.find(r => r.type === "text" && /^https?:\/\/\S+#/.test(r.text.trim()));
  return hit ? hit.text.trim() : "";
}

function nfcOnce(signal, onTag, onError) {
  const reader = new NDEFReader();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; fn(v); } };
    signal.addEventListener("abort", () => finish(reject, new DOMException("Abgebrochen", "AbortError")));
    reader.onreadingerror = () => onError?.("Tag nicht lesbar. Nochmal kurz an die Rückseite des Handys halten.");
    reader.onreading = e => {
      if (done) return;
      Promise.resolve(onTag(reader, e)).then(v => finish(resolve, v), err => finish(reject, err));
    };
    reader.scan({ signal }).catch(err => finish(reject, err));
  });
}

export class TagIO {
  constructor() { this.dev = null; }

  get ready() { return mode === "nfc" || !!this.dev; }
  get label() { return mode === "nfc" ? "NFC des Handys" : this.dev ? `${this.dev.firmware} verbunden` : "PN532 über USB"; }

  async connect() {
    if (this.dev) await this.dev.close();
    this.dev = null;
    this.dev = await PN532.connect();
  }

  // Bereits freigegebenen Port ohne Nachfrage verbinden
  async autoConnect() {
    if (mode !== "serial") return false;
    const ports = await navigator.serial.getPorts();
    if (ports.length !== 1) return false;
    await this.connect();
    return true;
  }

  // Liefert die Adresse auf dem Tag ("" wenn keine)
  async read(signal, onError) {
    if (mode === "nfc") return nfcOnce(signal, (r, e) => nfcUrl(e.message), onError);
    await this.dev.waitForTag(signal);
    return (await this.dev.readUrl()) ?? "";
  }

  // Liest den Tag, berechnet mit transform(aktuelleAdresse) die neue Adresse und schreibt sie.
  // transform wirft einen Fehler, wenn es der falsche Tag ist; dann wird nichts geschrieben.
  async update(transform, signal, onError) {
    if (mode === "nfc") {
      return nfcOnce(signal, async (reader, e) => {
        const url = transform(nfcUrl(e.message));
        await reader.write({ records: [{ recordType: "url", data: url }] }, { signal });
        return { url, verified: false };
      }, onError);
    }
    await this.dev.waitForTag(signal);
    const info = await this.dev.tagInfo();
    const url = transform((await this.dev.readUrl(info)) ?? "");
    return { url, verified: true, ...await this.dev.writeUrl(url, info) };
  }
}

export function friendly(e) {
  if (e?.name === "AbortError") return "Abgebrochen.";
  if (e?.name === "NotAllowedError") return "Der Browser hat den NFC-Zugriff nicht erlaubt. In den Website-Einstellungen NFC zulassen.";
  if (e?.name === "NotSupportedError") return "NFC ist aus oder wird nicht unterstützt. In den Android-Einstellungen NFC einschalten.";
  if (e?.name === "NetworkError") return "Übertragung zum Tag abgebrochen. Tag ruhig halten und nochmal versuchen.";
  return e?.message || String(e);
}
