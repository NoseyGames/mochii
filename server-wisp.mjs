import { createConnection } from 'node:net';
import { domainToASCII } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import ipaddr from 'ipaddr.js';
import { isPublicAddress, resolvePublicAddress } from './server-network.mjs';

// A bounded implementation of the TCP subset of Wisp v1/v2. In particular,
// pending DNS/connect work belongs to a stream and cannot outlive its close.
// Epoxy can encode a whole plaintext HTTP upload in one Wisp message.
const MAX_FRAME = 8 * 1024 * 1024;
const MAX_INPUT_BUFFER = 16 * 1024 * 1024;
const MAX_GLOBAL_INPUT_BUFFER = 64 * 1024 * 1024;
const MAX_OUTPUT_BUFFER = 2 * 1024 * 1024;
const MAX_STREAMS = 64;
const MAX_STREAMS_GLOBAL = 1024;
const FLOW_WINDOW = 128;
const CLOSED = { voluntary: 0x02, network: 0x03, blocked: 0x48, throttled: 0x49 };

function packet(type, id, payload) {
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32LE(id, 1);
  return Buffer.concat([header, payload]);
}

function flowPacket(id, credit) {
  const payload = Buffer.alloc(4);
  payload.writeUInt32LE(credit);
  return packet(0x03, id, payload);
}

function hostnameFrom(data) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  if (text !== text.trim() || /[\x00-\x20\x7f/\\:@\[\]]/.test(text) || ipaddr.isValid(text)) return null;
  const hostname = domainToASCII(text).toLowerCase();
  if (!hostname || hostname.length > 253) return null;
  const labels = hostname.replace(/\.$/, '').split('.');
  if (labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return hostname;
}

function validInfo(data) {
  if (data.length < 7 || data[0] !== 0x05 || data.readUInt32LE(1) !== 0 || data[5] !== 2) return false;
  // Unknown optional extensions may be ignored, but their framing must be valid.
  for (let offset = 7; offset < data.length;) {
    if (offset + 5 > data.length) return false;
    const end = offset + 5 + data.readUInt32LE(offset + 1);
    if (end > data.length) return false;
    offset = end;
  }
  return true;
}

export function createWispGateway(config, { resolve = resolvePublicAddress, connect = createConnection } = {}) {
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  const perIp = new Map();
  const clients = new Set();
  let streamCount = 0;
  let pendingLookups = 0;
  let globalIncomingBytes = 0;

  function attach(ws, req) {
    const ip = req.socket.remoteAddress || 'unknown';
    clients.add(ws);
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    const streams = new Map();
    const isV2 = ws.protocol === 'wisp-v2';
    let negotiated = !isV2;
    let closed = false;
    let incomingBytes = 0;
    let alive = true;
    let packetRate = 0;
    let rateWindow = Date.now();

    const send = (data, callback) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return false;
      if (ws.bufferedAmount + data.length > MAX_OUTPUT_BUFFER) { ws.terminate(); return false; }
      ws.send(data, error => { if (error) ws.terminate(); callback?.(error); });
      return true;
    };

    const closeStream = (stream, reason) => {
      if (!stream || stream.closed) return;
      stream.closed = true;
      streams.delete(stream.id);
      streamCount--;
      clearTimeout(stream.deadline);
      incomingBytes -= stream.queuedBytes;
      globalIncomingBytes -= stream.queuedBytes;
      stream.queuedBytes = 0;
      stream.queue.length = 0;
      stream.socket?.destroy();
      if (reason !== undefined) send(packet(0x04, stream.id, Buffer.from([reason])));
    };

    const flush = stream => {
      if (stream.closed || !stream.connected || stream.writing || !stream.queue.length) return;
      const data = stream.queue.shift();
      stream.writing = true;
      stream.socket.write(data, error => {
        if (stream.closed) return;
        stream.writing = false;
        stream.queuedBytes -= data.length;
        incomingBytes -= data.length;
        globalIncomingBytes -= data.length;
        if (error) { closeStream(stream, CLOSED.network); return; }
        stream.acknowledged++;
        // Wisp grants are absolute, not additive. Early grants race DATA still
        // in flight and would make strict credit checks reject honest clients.
        // Wait for the whole granted window before granting another one.
        if (stream.acknowledged >= FLOW_WINDOW) {
          stream.credit += stream.acknowledged;
          stream.acknowledged = 0;
          send(flowPacket(stream.id, stream.credit));
        }
        flush(stream);
      });
    };

    const openStream = async (id, hostname, port) => {
      if (streams.size >= MAX_STREAMS || streamCount >= MAX_STREAMS_GLOBAL || pendingLookups >= 64 ||
          [...streams.values()].filter(stream => stream.hostname === hostname).length >= 16) {
        send(packet(0x04, id, Buffer.from([CLOSED.throttled])));
        return;
      }
      const stream = { id, hostname, port, closed: false, connected: false, socket: null, queue: [], queuedBytes: 0, credit: FLOW_WINDOW, acknowledged: 0, writing: false };
      streams.set(id, stream);
      streamCount++;
      stream.deadline = setTimeout(() => closeStream(stream, CLOSED.network), 15000);
      stream.deadline.unref();
      try {
        let address;
        pendingLookups++;
        try { address = await resolve(hostname); } finally { pendingLookups--; }
        if (stream.closed || closed || ws.readyState !== WebSocket.OPEN) { closeStream(stream); return; }
        if (!isPublicAddress(address)) { closeStream(stream, CLOSED.blocked); return; }
        // Connect to the validated literal. Never ask the TCP layer to resolve
        // the hostname again, avoiding DNS rebinding between check and use.
        const socket = connect({ host: address, port, allowHalfOpen: false });
        stream.socket = socket;
        socket.setNoDelay(true);
        socket.setTimeout(120000);
        socket.on('timeout', () => closeStream(stream, CLOSED.network));
        socket.on('connect', () => {
          if (stream.closed || closed) { socket.destroy(); return; }
          clearTimeout(stream.deadline);
          stream.connected = true;
          flush(stream);
        });
        socket.on('data', data => {
          if (stream.closed) return;
          socket.pause();
          send(packet(0x02, id, data), error => {
            if (!error && !stream.closed) socket.resume();
          });
        });
        socket.on('error', () => closeStream(stream, CLOSED.network));
        socket.on('close', () => closeStream(stream, CLOSED.voluntary));
      } catch (error) {
        closeStream(stream, error?.code === 'EACCES' ? CLOSED.blocked : CLOSED.network);
      }
    };

    const handshakeTimer = setTimeout(() => { if (!negotiated) ws.terminate(); }, 10000);
    handshakeTimer.unref();
    if (negotiated) clearTimeout(handshakeTimer);
    const heartbeat = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      ws.ping();
    }, 30000);
    heartbeat.unref();
    ws.on('pong', () => { alive = true; });
    // ws already starts the appropriate close handshake for receiver errors
    // (including 1009 for oversize payloads). Keep it from becoming unhandled.
    ws.on('error', () => {});
    ws.on('close', () => {
      closed = true;
      clearTimeout(handshakeTimer);
      clearInterval(heartbeat);
      for (const stream of streams.values()) closeStream(stream);
      clients.delete(ws);
      const count = (perIp.get(ip) || 1) - 1;
      if (count) perIp.set(ip, count); else perIp.delete(ip);
    });
    ws.on('message', (data, binary) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      const invalid = () => { ws.close(1002, 'Invalid Wisp packet'); setTimeout(() => ws.terminate(), 1000).unref(); };
      try {
        if (Date.now() - rateWindow >= 1000) { packetRate = 0; rateWindow = Date.now(); }
        if (++packetRate > 10000) { ws.terminate(); return; }
        if (!binary || data.length < 5) { invalid(); return; }
        if (!negotiated) {
          if (!validInfo(data)) { invalid(); return; }
          negotiated = true;
          clearTimeout(handshakeTimer);
          send(flowPacket(0, FLOW_WINDOW));
          return;
        }
        const type = data[0];
        const id = data.readUInt32LE(1);
        if (!id) { if (type === 0x04 && data.length === 6) ws.close(); else invalid(); return; }
        if (type === 0x01) {
          if (data.length < 9 || data.length > 1024 || streams.has(id)) { invalid(); return; }
          const hostname = hostnameFrom(data.subarray(8));
          const port = data.readUInt16LE(6);
          if (data[5] !== 0x01 || !hostname || !config.allowedPorts.has(port)) {
            send(packet(0x04, id, Buffer.from([CLOSED.blocked])));
            return;
          }
          void openStream(id, hostname, port);
        } else if (type === 0x02) {
          const stream = streams.get(id);
          // In-flight data can arrive after a remote close; safely discard it.
          if (!stream) return;
          const payload = data.subarray(5);
          if (--stream.credit < 0 || incomingBytes + payload.length > MAX_INPUT_BUFFER || globalIncomingBytes + payload.length > MAX_GLOBAL_INPUT_BUFFER) { ws.terminate(); return; }
          incomingBytes += payload.length;
          globalIncomingBytes += payload.length;
          stream.queuedBytes += payload.length;
          stream.queue.push(payload);
          flush(stream);
        } else if (type === 0x04 && data.length === 6) closeStream(streams.get(id));
        else invalid();
      } catch { invalid(); }
    });
    send(isV2 ? packet(0x05, 0, Buffer.from([2, 0])) : flowPacket(0, FLOW_WINDOW));
  }

  return {
    canAccept(req) {
      return clients.size < config.maxConnections && (perIp.get(req.socket.remoteAddress || 'unknown') || 0) < config.maxConnectionsPerIp;
    },
    upgrade(req, socket, head) { wsServer.handleUpgrade(req, socket, head, ws => attach(ws, req)); },
    close() { for (const ws of clients) ws.terminate(); wsServer.close(); },
  };
}
