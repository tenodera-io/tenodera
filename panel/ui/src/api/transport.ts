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

let ws: WebSocket | null = null;
let channelListeners: Map<string, ChannelCallback[]> = new Map();
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
          const listeners = channelListeners.get(msg.channel);
          if (listeners) {
            for (const cb of listeners) cb(msg);
          }
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

  const callbacks: ChannelCallback[] = [];
  channelListeners.set(channel, callbacks);

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
      callbacks.push(cb);
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
 */
export function request(
  payload: string,
  options: Record<string, unknown> = {},
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const ch = openChannel(payload, options);
    const results: unknown[] = [];

    ch.onMessage((msg) => {
      if (msg.type === 'data' && 'data' in msg) {
        results.push(msg.data);
      } else if (msg.type === 'close') {
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
