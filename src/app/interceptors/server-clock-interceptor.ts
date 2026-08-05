import {HttpInterceptorFn, HttpResponse} from '@angular/common/http';
import {inject} from '@angular/core';
import {tap} from 'rxjs';
import {ApiConfigService} from '../services/api-config.service';
import {ServerClockService} from '../services/server-clock.service';

/**
 * Feeds {@link ServerClockService} from the `Date` header every API response already carries.
 *
 * <p>Passive: it reads a response and never modifies a request, so it cannot fail a call. It is
 * also the only reason the app knows the server's time at all — there is no ping/pong, no
 * `serverTime` field on any payload, and the SignalR hub sends nothing timestamped. Rather than
 * add an endpoint for it, this takes the reading off traffic that happens anyway.</p>
 *
 * <p>Scoped to our own base URL: a `Date` header from Klipy or a CDN says nothing about the clock
 * that stamps `startedAt`.</p>
 */
export const serverClockInterceptor: HttpInterceptorFn = (req, next) => {
    const apiConfig = inject(ApiConfigService);
    if (!req.url.startsWith(apiConfig.baseUrl())) return next(req);

    const clock = inject(ServerClockService);
    const sentAt = Date.now();

    return next(req).pipe(
        tap(event => {
            if (!(event instanceof HttpResponse)) return;

            const header = event.headers.get('Date');
            if (!header) return;

            clock.adopt(Date.parse(header), sentAt, Date.now());
        }),
    );
};
