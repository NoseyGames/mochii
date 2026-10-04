import { destinationHostname, isPublicAddress } from './policy.mjs';

export const LIMITS = Object.freeze({ streams: 4, openedStreams: 20, frame: 1024 * 1024, queued: 2 * 1024 * 1024,
  transfer: 16 * 1024 * 1024, lifetime: 5 * 60 * 1000, connectTimeout: 10000, window: 16 });
const CLOSED = { voluntary: 2, network: 3, blocked: 0x48, throttled: 0x49 };

export function packet(type, id, payload = new Uint8Array()) {
  const output = new Uint8Array(5 + payload.byteLength);
  output[0] = type;
  new DataView(output.buffer).setUint32(1, id, true);
  output.set(payload, 5);
  return output;
}
function flow(id, credit) {
  const body = new Uint8Array(4);
  new DataView(body.buffer).setUint32(0, credit, true);
  return packet(3, id, body);
}
function validInfo(data) {
  if (data.length < 7 || data[0] !== 5 || new DataView(data.buffer, data.byteOffset).getUint32(1, true) !== 0 || data[5] !== 2) return false;
  const types = new Set();
  for (let at = 7; at < data.length;) {
    if (at + 5 > data.length || types.has(data[at])) return false;
    types.add(data[at]);
    const end = at + 5 + new DataView(data.buffer, data.byteOffset).getUint32(at + 1, true);
    if (end > data.length) return false;
    at = end;
  }
  return true;
}

                                                                              
                                                            
export function attachWisp(ws, { connect, resolve, version2 = false, limits = LIMITS,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const streams = new Map();
  let closed = false, negotiated = !version2, opened = 0, queued = 0, transferred = 0;
  let packetCount = 0, packetWindow = Date.now();
  let lifetimeTimer, handshakeTimer;
  const send = data => {
    if (closed || ws.readyState !== 1) return false;
    try { ws.send(data); return true; } catch { shutdown(1011, 'Connection failed'); return false; }
  };
  const closeStream = (stream, reason) => {
    if (!stream || stream.closed) return;
    stream.closed = true;
    streams.delete(stream.id);
    clearTimer(stream.deadline);
    stream.abort.abort();
    queued -= stream.queued;
    stream.queued = 0;
    stream.queue.length = 0;
                                                                          
    try { Promise.resolve(stream.socket?.close()).catch(() => {}); } catch {}
    if (reason !== undefined) send(packet(4, stream.id, Uint8Array.of(reason)));
  };
  function shutdown(code = 1000, reason = 'Closed') {
    if (closed) return;
    closed = true;
    clearTimer(lifetimeTimer);
    clearTimer(handshakeTimer);
    for (const stream of streams.values()) closeStream(stream);
    try { ws.close(code, reason); } catch {}
  }
  const invalid = () => shutdown(1002, 'Invalid Wisp packet');
  const account = bytes => {
    transferred += bytes;
    if (transferred > limits.transfer) { shutdown(1008, 'Session transfer limit'); return false; }
    return true;
  };
  const flush = async stream => {
    if (stream.closed || stream.writing || !stream.writer) return;
    stream.writing = true;
    try {
      while (!stream.closed && stream.queue.length) {
        const data = stream.queue.shift();
        await stream.writer.write(data);
        if (stream.closed) return;
        stream.queued -= data.byteLength;
        queued -= data.byteLength;
                                                                            
                                                                     
        if (++stream.acknowledged === limits.window) {
          stream.acknowledged = 0;
          stream.credit += limits.window;
          send(flow(stream.id, stream.credit));
        }
      }
    } catch { closeStream(stream, CLOSED.network); }
    finally { stream.writing = false; }
  };
  const start = async (id, hostname, port) => {
    if (streams.size >= limits.streams || opened >= limits.openedStreams) {
      send(packet(4, id, Uint8Array.of(CLOSED.throttled)));
      return;
    }
    opened++;
    const stream = { id, closed: false, abort: new AbortController(), queue: [], queued: 0, writing: false,
      credit: limits.window, acknowledged: 0, socket: null, writer: null };
    streams.set(id, stream);
    stream.deadline = setTimer(() => closeStream(stream, CLOSED.network), limits.connectTimeout);
    try {
      const address = await resolve(hostname, stream.abort.signal);
      if (stream.closed || closed) return;
      if (!isPublicAddress(address)) { closeStream(stream, CLOSED.blocked); return; }
      const socket = connect({ hostname: address, port }, { secureTransport: 'off', allowHalfOpen: false });
      stream.socket = socket;
                                                                               
      socket.closed.catch(() => closeStream(stream, CLOSED.network));
      await socket.opened;
      if (stream.closed || closed) return;
      clearTimer(stream.deadline);
      stream.writer = socket.writable.getWriter();
      void flush(stream);
      const reader = socket.readable.getReader();
      try {
        while (!stream.closed && !closed) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!account(value.byteLength)) return;
          for (let at = 0; at < value.byteLength; at += 65536) {
            if (!send(packet(2, id, value.subarray(at, at + 65536)))) return;
          }
        }
      } finally { reader.releaseLock(); }
      closeStream(stream, CLOSED.voluntary);
    } catch (error) { closeStream(stream, error?.code === 'EACCES' ? CLOSED.blocked : CLOSED.network); }
  };
  const receive = event => {
    if (closed) return;
    try {
      const input = event.data;
      if (!(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input)) { invalid(); return; }
      const data = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      if (data.byteLength < 5 || data.byteLength > limits.frame) { shutdown(1009, 'Invalid message size'); return; }
      if (Date.now() - packetWindow >= 1000) { packetCount = 0; packetWindow = Date.now(); }
      if (++packetCount > 2048) { shutdown(1008, 'Packet rate limit'); return; }
      if (!negotiated) {
        if (!validInfo(data)) { invalid(); return; }
        negotiated = true;
        clearTimer(handshakeTimer);
        send(flow(0, limits.window));
        return;
      }
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const type = data[0], id = view.getUint32(1, true);
      if (!id) { if (type === 4 && data.length === 6) shutdown(); else invalid(); return; }
      if (type === 1) {
        if (data.length < 9 || data.length > 261 || streams.has(id)) { invalid(); return; }
        const hostname = destinationHostname(data.subarray(8)), port = view.getUint16(6, true);
        if (data[5] !== 1 || !hostname || ![80, 443].includes(port)) {
          send(packet(4, id, Uint8Array.of(CLOSED.blocked))); return;
        }
        void start(id, hostname, port);
      } else if (type === 2) {
        const stream = streams.get(id);
        if (!stream) return;                                                     
        const payload = data.subarray(5);
        if (--stream.credit < 0 || queued + payload.byteLength > limits.queued) { shutdown(1008, 'Input queue limit'); return; }
        if (!account(payload.byteLength)) return;
        queued += payload.byteLength;
        stream.queued += payload.byteLength;
        stream.queue.push(payload);
        void flush(stream);
      } else if (type === 4 && data.length === 6) closeStream(streams.get(id));
      else invalid();
    } catch { invalid(); }
  };
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('message', receive);
  ws.addEventListener('close', () => shutdown());
  ws.addEventListener('error', () => shutdown(1011, 'Connection failed'));
  lifetimeTimer = setTimer(() => shutdown(1000, 'Session expired; reconnect'), limits.lifetime);
  if (version2) handshakeTimer = setTimer(() => shutdown(1002, 'Handshake timeout'), limits.connectTimeout);
  send(version2 ? packet(5, 0, Uint8Array.of(2, 0)) : flow(0, limits.window));
  return { close: shutdown, get state() { return { closed, streams: streams.size, opened, queued, transferred }; } };
}
