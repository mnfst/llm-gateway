import { Controller, Sse } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Observable } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { TenantCtx, TenantContext } from '../common/decorators/tenant-context.decorator';
import { IngestEventBusService } from '../common/services/ingest-event-bus.service';

interface MessageEvent {
  data: string;
  type: string;
}

// `/api/v1/events` is one long-lived connection per dashboard tab, and the
// browser's EventSource auto-reconnects every few seconds whenever it drops.
// Counting those against the global 100-req/60s-per-IP ThrottlerGuard — a
// budget already shared with the dashboard's analytics polling — risks 429s
// that sever the live stream and then trigger more reconnects. The proxy opts
// out of the global limiter the same way; the SSE stream should too.
@SkipThrottle()
@Controller('api/v1')
export class SseController {
  constructor(private readonly eventBus: IngestEventBusService) {}

  @Sse('events')
  events(@TenantCtx() ctx: TenantContext): Observable<MessageEvent> {
    // Each bus event fans out as TWO SSE messages: the typed one (so new
    // clients can target by kind) AND the legacy 'ping' (so older frontends
    // listening on 'ping' still see every change during a partial upgrade).
    // A null tenantId (fresh account) keeps the stream open but never emits.
    return this.eventBus.forTenant(ctx.tenantId).pipe(
      mergeMap((evt) => [
        { type: evt.kind, data: evt.kind },
        { type: 'ping', data: 'ping' },
      ]),
    );
  }
}
