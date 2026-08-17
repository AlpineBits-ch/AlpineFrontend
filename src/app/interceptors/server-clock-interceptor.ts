import {HttpInterceptorFn, HttpResponse} from '@angular/common/http';
import {inject} from '@angular/core';
import {tap} from 'rxjs';
import {ApiConfigService} from '../services/api-config.service';
import {ServerClockService} from '../services/server-clock.service';

/**
 * Feeds {@link ServerClockService} from the `Date` header every API response already carries.
 * Passive, and scoped to our own base URL: a third-party `Date` header says nothing useful.
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
