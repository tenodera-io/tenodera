/**
 * Channel-based WebSocket transport.
 * Maps to the tenodera-protocol wire format.
 */

export type Message =
  | { type: 'open'; channel: string; payload: string; [key: string]: unknown }
  | { type: 'ready'; channel: string }
  | { type: 'data'; channel: string; data: unknown }
  | { type: 'control'; channel: string; command: string; [key: string]: unknown }
  | { type: 'close'; channel: string; problem?: string }
  | { type: 'ping' }
  | { type: 'pong' };

type ChannelCallback = (msg: Message) => void;

const REQUEST_TIMEOUT_MS = 30_000;

let ws: WebSocket | null = null;
let channelListeners: Map<string, ChannelCallback> = new Map();
let nextChannelId = 1;
let connectPromise: Promise<void> | null = null;

export function connect(): Promise<void> {
  if (connectPromise) return connectPromise;

  connectPromise = new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sessionId = sessionStorage.getItem('session_id') ?? '';
    ws = new WebSocket(`${proto}//${location.host}/api/ws?session_id=${encodeURIComponent(sessionId)}`);

    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WebSocket connection failed'));

    ws.onmessage = (event) => {
      try {
        const msg: Message = JSON.parse(event.data);

        if (msg.type === 'ping') {
          ws?.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        if ('channel' in msg && msg.channel) {
          const cb = channelListeners.get(msg.channel);
          if (cb) cb(msg);
        }
      } catch {
        console.warn('invalid message from server', event.data);
      }
    };

    ws.onclose = () => {
      ws = null;
      connectPromise = null;
      channelListeners.clear();
    };
  });

  return connectPromise;
}

export function disconnect() {
  ws?.close();
  ws = null;
  connectPromise = null;
  channelListeners.clear();
}

/**
 * Open a channel and return an object to interact with it.
 */
export function openChannel(
  payload: string,
  options: Record<string, unknown> = {},
) {
  const channel = String(nextChannelId++);

  // Send open message
  ws?.send(
    JSON.stringify({
      type: 'open',
      channel,
      payload,
      ...options,
    }),
  );

  return {
    channel,

    onMessage(cb: ChannelCallback) {
      channelListeners.set(channel, cb);
    },

    send(data: unknown) {
      ws?.send(
        JSON.stringify({ type: 'data', channel, data }),
      );
    },

    close() {
      ws?.send(JSON.stringify({ type: 'close', channel }));
      channelListeners.delete(channel);
    },
  };
}

/**
 * One-shot channel: open, collect all data messages, return on close.
 * Times out after REQUEST_TIMEOUT_MS to prevent leaked promises/listeners.
 */
export function request(
  payload: string,
  options: Record<string, unknown> = {},
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const ch = openChannel(payload, options);
    const results: unknown[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      channelListeners.delete(ch.channel);
      reject(new Error('request timeout'));
    }, REQUEST_TIMEOUT_MS);

    ch.onMessage((msg) => {
      if (settled) return;
      if (msg.type === 'data' && 'data' in msg) {
        results.push(msg.data);
      } else if (msg.type === 'close') {
        settled = true;
        clearTimeout(timer);
        channelListeners.delete(ch.channel);
        if ('problem' in msg && msg.problem) {
          reject(new Error(String(msg.problem)));
        } else {
          resolve(results);
        }
      }
    });
  });
}
