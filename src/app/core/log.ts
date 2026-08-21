import * as Sentry from '@sentry/angular';

/**
 * A diagnostic that is neither a warning nor a fault: what the app just did.
 *
 * Also filed as a Sentry breadcrumb, so the last thing that happened before a crash is in the
 * report rather than only in a console nobody was watching. Use `console.warn` or `console.error`
 * when something is actually wrong.
 */
export function trace(message: string, ...details: unknown[]): void {
    Sentry.addBreadcrumb({level: 'info', message, data: details.length ? {details} : undefined});
    console.info(message, ...details);
}
