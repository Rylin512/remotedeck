import crypto from 'node:crypto';

export class EventHub {
  constructor() {
    this.clients = new Map();
    this.seq = 0;
    this.heartbeat = setInterval(() => this.ping(), 20_000);
    this.heartbeat.unref?.();
  }

  add(req, res) {
    const id = crypto.randomUUID();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    res.write(': connected\n\n');
    const client = { id, res, ip: req.socket?.remoteAddress || '', connectedAt: Date.now() };
    this.clients.set(id, client);
    const cleanup = () => {
      this.clients.delete(id);
      try { res.end(); } catch {}
    };
    res.on('error', cleanup);
    req.on('aborted', cleanup);
    this.sendTo(client, 'hello', { clientId: id, seq: this.seq });
    req.on('close', cleanup);
    return client;
  }

  sendTo(client, type, payload = {}) {
    try {
      const data = JSON.stringify({ type, seq: ++this.seq, ts: Date.now(), ...payload });
      client.res.write(`event: ${type}\ndata: ${data}\n\n`);
    } catch {
      this.clients.delete(client.id);
      try { client.res.end(); } catch {}
    }
  }

  broadcast(type, payload = {}) {
    if (this.clients.size === 0) return;
    const data = JSON.stringify({ type, seq: ++this.seq, ts: Date.now(), ...payload });
    for (const [id, client] of this.clients) {
      try {
        client.res.write(`event: ${type}\ndata: ${data}\n\n`);
      } catch {
        this.clients.delete(id);
        try { client.res.end(); } catch {}
      }
    }
  }

  ping() {
    const data = JSON.stringify({ type: 'ping', seq: ++this.seq, ts: Date.now() });
    for (const [id, client] of this.clients) {
      try {
        if (client.res.writableEnded || client.res.destroyed) {
          this.clients.delete(id);
          continue;
        }
        client.res.write(`event: ping\ndata: ${data}\n\n`);
        if (client.res.writableLength > 1_000_000) {
          this.clients.delete(id);
          client.res.destroy();
        }
      } catch {
        this.clients.delete(id);
        try { client.res.end(); } catch {}
      }
    }
  }

  count() {
    return this.clients.size;
  }

  closeAll() {
    clearInterval(this.heartbeat);
    for (const client of this.clients.values()) {
      try { client.res.end(); } catch {}
    }
    this.clients.clear();
  }
}

export const hub = new EventHub();
