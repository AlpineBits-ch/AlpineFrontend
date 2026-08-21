import {signal} from '@angular/core';
import {Observable, Subject} from 'rxjs';
import {ConnectionState} from '../services/realtime-connection.service';
import {PayloadOf, RealtimeEvent} from '../services/realtime-events';

/**
 * Stand-in for `RealtimeConnectionService` in specs. Provide it with
 * `{provide: RealtimeConnectionService, useValue: realtime}` and push payloads with {@link emit}.
 *
 * `emit` reaches both conventions: whatever subscribed through {@link stream} and whatever
 * registered through {@link on}.
 */
export class FakeRealtimeConnection {
    readonly connectionState = signal(ConnectionState.Connected);
    readonly invocations: {method: string; args: unknown[]}[] = [];
    private readonly subjects = new Map<string, Subject<any>>();

    stream<K extends RealtimeEvent>(event: K): Observable<PayloadOf<K>> {
        return this.subjectFor(event).asObservable();
    }

    emit<K extends RealtimeEvent>(event: K, payload: PayloadOf<K>): void {
        this.subjectFor(event).next(payload);
    }

    /** For events that have no {@link RealtimeEventMap} entry yet. */
    emitRaw(event: string, payload: unknown): void {
        this.subjectFor(event).next(payload);
    }

    on(event: string, handler: (...args: any[]) => void): void {
        this.subjectFor(event).subscribe(payload => handler(payload));
    }

    off(event: string): void {
        this.subjects.delete(event);
    }

    async invoke(method: string, ...args: unknown[]): Promise<void> {
        this.invocations.push({method, args});
    }

    async start(): Promise<void> {}

    private subjectFor(event: string): Subject<any> {
        let subject = this.subjects.get(event);
        if (!subject) {
            subject = new Subject<any>();
            this.subjects.set(event, subject);
        }
        return subject;
    }
}
