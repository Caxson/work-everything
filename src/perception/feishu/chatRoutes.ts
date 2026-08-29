/**
 * Which conversation an event came from.
 *
 * A reply must land in the conversation that produced the event, and "whatever
 * chat is on screen when the reply is ready" is not that — the user will have
 * moved on. So the perceiver records the origin against the trace id, and the
 * sender resolves it back. The table is deliberately bounded and in-memory: it
 * is routing for work in flight, not history, and the trajectory already has
 * the durable record.
 */

export interface ChatRoute {
  readonly chatTitle: string;
  readonly messageId: string;
  readonly ts: number;
}

export const DEFAULT_ROUTE_CAPACITY = 500;

export class ChatRouteTable {
  private routes = new Map<string, ChatRoute>();

  constructor(private readonly capacity: number = DEFAULT_ROUTE_CAPACITY) {}

  remember(traceId: string, route: ChatRoute): void {
    const next = new Map(this.routes);
    next.delete(traceId);
    next.set(traceId, route);
    while (next.size > this.capacity) {
      const oldest = next.keys().next();
      if (oldest.done === true) break;
      next.delete(oldest.value);
    }
    this.routes = next;
  }

  lookup(traceId: string): ChatRoute | undefined {
    return this.routes.get(traceId);
  }

  get size(): number {
    return this.routes.size;
  }
}
