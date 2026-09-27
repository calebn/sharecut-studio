/**
 * Shared WebSocket double for hook and app tests. Stub it with
 * `vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket)`
 * and call `FakeWebSocket.reset()` in `beforeEach`.
 */
export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  /** On: start OPEN and fire `onopen` on a microtask. Off: start CONNECTING; call `open()`. */
  static autoOpen = true;

  static reset(options: { autoOpen?: boolean } = {}): void {
    FakeWebSocket.instances = [];
    FakeWebSocket.autoOpen = options.autoOpen ?? true;
  }

  readyState: number;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  sent: string[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    this.readyState = FakeWebSocket.autoOpen
      ? FakeWebSocket.OPEN
      : FakeWebSocket.CONNECTING;
    FakeWebSocket.instances.push(this);
    if (FakeWebSocket.autoOpen) {
      queueMicrotask(() => this.onopen?.());
    }
  }

  /** Open a CONNECTING socket by hand. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    this.closed = true;
    this.onclose?.({ code });
  }

  emit(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}
