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
    this.sendTo(client, 'hello', { clientId: id, seq: this.seq });
    req.on('close', () => {
      this.clients.delete(id);
      try { res.end(); } catch {}
    });
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
    for (const [id, client] of this.clients) {
      try {
        client.res.write(`: ping ${Date.now()}\n\n`);
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
