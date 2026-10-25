import { HttpFailure, type HttpPort, type HttpRequest, type HttpResponse } from "../../src/net/keep-alive-http.js";

export type Handler = (request: HttpRequest, callIndex: number) => HttpResponse | HttpFailure | Promise<HttpResponse | HttpFailure>;

/** An HttpPort whose answers are scripted by the test; nothing touches the network. */
export class FakeHttp implements HttpPort {
  readonly calls: HttpRequest[] = [];
  pings = 0;
  closed = false;

  constructor(public handler: Handler) {}

  async request(request: HttpRequest): Promise<HttpResponse> {
    this.calls.push(request);
    const result = await this.handler(request, this.calls.length - 1);
    if (result instanceof HttpFailure) throw result;
    return result;
  }

  async ping(): Promise<void> {
    this.pings += 1;
  }

  close(): void {
    this.closed = true;
  }
}

export const json = (value: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers,
  body: JSON.stringify(value),
});
