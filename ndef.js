// NDEF-Kodierung für einen einzelnen URI-Record auf NFC-Forum-Type-2-Tags (NTAG21x).

// URI-Kennungen laut NFC Forum RTD-URI (nur die für Webadressen relevanten)
const PREFIXES = ["", "http://www.", "https://www.", "http://", "https://"];

export function encodeUriRecord(url) {
  let code = 0;
  for (let i = PREFIXES.length - 1; i > 0; i--) {
    if (url.startsWith(PREFIXES[i])) { code = i; break; }
  }
  const rest = new TextEncoder().encode(url.slice(PREFIXES[code].length));
  const payloadLen = 1 + rest.length;
  const short = payloadLen < 256;
  // MB | ME | (SR) | TNF=1 (Well-known)
  const header = [short ? 0xD1 : 0xC1, 0x01];
  if (short) header.push(payloadLen);
  else header.push((payloadLen >>> 24) & 0xFF, (payloadLen >>> 16) & 0xFF, (payloadLen >>> 8) & 0xFF, payloadLen & 0xFF);
  header.push(0x55, code); // Typ "U", URI-Kennung
  const out = new Uint8Array(header.length + rest.length);
  out.set(header);
  out.set(rest, header.length);
  return out;
}

// Vollständiger Speicherinhalt ab Seite 4: NDEF-TLV + Terminator-TLV
export function buildTlv(url) {
  const msg = encodeUriRecord(url);
  const len = msg.length < 0xFF ? [msg.length] : [0xFF, msg.length >> 8, msg.length & 0xFF];
  const out = new Uint8Array(1 + len.length + msg.length + 1);
  out[0] = 0x03;
  out.set(len, 1);
  out.set(msg, 1 + len.length);
  out[out.length - 1] = 0xFE;
  return out;
}

// Liest die TLV-Kette ab Seite 4.
// Rückgabe: { complete: false } wenn die Bytes noch nicht reichen,
// sonst { complete: true, message: Uint8Array | null }.
export function parseTlv(bytes) {
  let i = 0;
  while (i < bytes.length) {
    const t = bytes[i];
    if (t === 0x00) { i++; continue; }           // NULL-TLV
    if (t === 0xFE) return { complete: true, message: null };
    if (i + 1 >= bytes.length) return { complete: false };
    let len = bytes[i + 1], head = 2;
    if (len === 0xFF) {
      if (i + 3 >= bytes.length) return { complete: false };
      len = (bytes[i + 2] << 8) | bytes[i + 3];
      head = 4;
    }
    if (t === 0x03) {
      if (i + head + len > bytes.length) return { complete: false };
      return { complete: true, message: Uint8Array.from(bytes.slice(i + head, i + head + len)) };
    }
    i += head + len;                             // Lock-/Memory-Control-TLV o. Ä. überspringen
  }
  return { complete: false };
}

// Erste URI aus einer NDEF-Nachricht, sonst null
export function uriFromMessage(msg) {
  let i = 0;
  while (i < msg.length) {
    const h = msg[i];
    const sr = h & 0x10, il = h & 0x08, tnf = h & 0x07;
    const typeLen = msg[i + 1];
    let p = i + 2, payloadLen;
    if (sr) { payloadLen = msg[p]; p += 1; }
    else { payloadLen = ((msg[p] << 24) | (msg[p + 1] << 16) | (msg[p + 2] << 8) | msg[p + 3]) >>> 0; p += 4; }
    const idLen = il ? msg[p++] : 0;
    const type = msg.slice(p, p + typeLen);
    p += typeLen + idLen;
    const payload = msg.slice(p, p + payloadLen);
    if (tnf === 1 && typeLen === 1 && type[0] === 0x55 && payload.length) {
      return (PREFIXES[payload[0]] || "") + new TextDecoder().decode(payload.slice(1));
    }
    if (h & 0x40) break;                         // ME: letzter Record
    i = p + payloadLen;
  }
  return null;
}

// Belegte Bytes auf dem Tag (ohne die 4 Byte Capability Container)
export function ndefSize(url) {
  return buildTlv(url).length;
}
