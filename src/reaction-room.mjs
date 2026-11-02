const PRESETS = Object.freeze({
  'builder-next': '下一位 Builder 就是我',
  'build-tomorrow': '这个我回去就搭',
  'scope-creep': '能不能现场加个需求',
  'pm-coding': '产品经理已经开始写代码了',
  'coffee-hot': '从 Idea 到上线，咖啡还没凉',
  'boss-screenshot': '这页建议老板截图',
  'describe-problem': '不会写代码，但会描述问题',
  'side-project': '我的 Side Project 有救了',
  'production': '这不是 Demo，这是生产力',
  'delivery-speed': '全球部署，比我点外卖还快',
  'lightning-speed': 'Ready at lightning speed',
  'last-mile': '最后一公里已经修成高速公路',
  'serverless': '没有服务器，但到处都有服务',
  'global-now': '代码刚写完，全球已经能访问',
  'cities-ready': 'Global network: ready',
  'just-build': 'Cloudflare：你只管 Build',
  'agent-pressure': 'Agent 已经开始卷我了',
  'emotional-value': 'AI 在写代码，我在提供情绪价值',
  'agent-accepts': 'Agent：这个需求我接了',
  'collaborate-first': 'Human vs. AI，先合作再竞争',
  'prompt-well': 'Prompt 写得好，发布下班早',
  'magic-logs': '像魔法，但有日志',
  'do-state': 'Durable Objects：状态稳住了',
  'wrangler-ritual': 'wrangler deploy 才是真正的仪式感'
});

const EMOJIS = Object.freeze({
  clap: '👏', fire: '🔥', mindblown: '🤯', rocket: '🚀', idea: '💡', hundred: '💯',
  laugh: '😂', heart: '❤️', brick: '🧱', robot: '🤖', lightning: '⚡', globe: '🌏'
});

const COLORS = ['orange', 'blue', 'green', 'purple', 'pink', 'yellow'];

export class ReactionRoom {
  constructor(state) {
    this.state = state;
    this.clients = new Map();
    this.screens = new Set();
    this.roomTimestamps = [];
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const role = new URL(request.url).searchParams.get('role') === 'screen' ? 'screen' : 'audience';
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const now = Date.now();
    this.clients.set(server, { role, tokens: 3, lastRefill: now, violations: [], mutedUntil: 0 });
    if (role === 'screen') this.screens.add(server);
    server.send(JSON.stringify({ type: 'connected', role }));
    server.addEventListener('message', event => this.handleMessage(server, event.data));
    server.addEventListener('close', () => this.removeClient(server));
    server.addEventListener('error', () => this.removeClient(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  handleMessage(ws, raw) {
    const client = this.clients.get(ws);
    if (!client || client.role !== 'audience' || typeof raw !== 'string' || raw.length > 256) return;
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (!message || message.type !== 'send' || typeof message.id !== 'string') return;
    const source = message.kind === 'emoji' ? EMOJIS : message.kind === 'preset' ? PRESETS : null;
    const content = source && source[message.id];
    if (!content) return this.send(ws, { type: 'rejected', reason: 'invalid_reaction' });
    const now = Date.now();
    if (now < client.mutedUntil) return this.send(ws, { type: 'rate_limited', retryAfter: client.mutedUntil - now });
    const elapsed = now - client.lastRefill;
    client.tokens = Math.min(3, client.tokens + elapsed / 1200);
    client.lastRefill = now;
    if (client.tokens < 1) {
      client.violations = client.violations.filter(time => now - time < 5000);
      client.violations.push(now);
      if (client.violations.length >= 4) client.mutedUntil = now + 10000;
      return this.send(ws, { type: 'rate_limited', retryAfter: client.mutedUntil > now ? 10000 : Math.ceil((1 - client.tokens) * 1200) });
    }
    this.roomTimestamps = this.roomTimestamps.filter(time => now - time < 1000);
    if (this.roomTimestamps.length >= 20) return this.send(ws, { type: 'rate_limited', retryAfter: 1000 });
    client.tokens -= 1;
    this.roomTimestamps.push(now);
    const reaction = {
      type: 'reaction',
      id: crypto.randomUUID(),
      kind: message.kind,
      content,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      timestamp: now
    };
    for (const screen of this.screens) this.send(screen, reaction);
    this.send(ws, { type: 'sent', id: reaction.id });
  }

  send(ws, message) {
    try { if (ws.readyState === 1) ws.send(JSON.stringify(message)); } catch {}
  }

  removeClient(ws) {
    this.clients.delete(ws);
    this.screens.delete(ws);
  }
}
