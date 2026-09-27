export class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  static autoOpen = true;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  closed = false;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    if (FakeWebSocket.autoOpen) {
      queueMicrotask(() => this.onopen?.());
    }
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.onclose?.();
  }

  open() {
    this.onopen?.();
  }

  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}
