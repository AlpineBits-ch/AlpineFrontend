# Multi-Device Calls & Voice Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the client side of the backend's multi-device calls/voice-channels spec: a per-device identifier on every relevant call, fixing the two documented multi-device bugs (a decline on one device ending an active call on another; joining a guild voice channel on a second device not kicking the first), and changing call hang-up to "leave" (not "end for everyone") semantics.

**Architecture:** Reuse the existing MLS device ID (`MlsService.getOrCreateDeviceIdentifier()`) everywhere the spec requires a device identifier. A new HTTP interceptor adds `X-Device-Id` globally; the realtime hub connection gains the same id as a query param via a lazy-construction refactor of `RealtimeConnectionService`. New SignalR events are wired through the existing per-domain wrapper-service pattern (`VoiceWebsocketService`, `GuildWebsocketService`) into the existing call/voice state services (`CallSessionService`, `CallStateService`, `CallWebRtcService`, `VoiceChannelService`), reusing existing UI surfaces (toasts, the call panel) rather than building new ones.

**Tech Stack:** Angular 21 (signals, functional HTTP interceptors), RxJS, `@microsoft/signalr`, Vitest (via `@angular/build:unit-test`, globals enabled - no need to import `describe`/`it`/`expect`/`vi`).

## Global Constraints

- Backend does not exist yet - endpoints will 404 and events will never fire until the backend ships. Implement the full contract now anyway (per user decision); don't gate behind a feature flag.
- Reuse `MlsService.getOrCreateDeviceIdentifier()` as the device id everywhere - never generate a second identifier.
- Send `X-Device-Id` as an HTTP header; append `deviceId` as a hub-connection query param (exact param name: `deviceId`).
- No new "End call for everyone" UI action - the existing single hang-up button becomes "leave" (`PUT /call/{id}/leave`), not "end" (`PUT /call/{id}/end`).
- No changes to `CallDto`/`CallParticipant` response shapes.
- Reuse existing UI surfaces: `ToastService` for device-takeover/kick notifications, the existing `.conn-banner` style in `call-panel.component.html` for the alone-timeout countdown. No new banner/toast components.
- Full design context: `docs/superpowers/specs/2026-07-29-multi-device-calls-voice-design.md`.

---

### Task 1: `VoiceService.leaveCall`

**Files:**
- Modify: `src/app/services/voice.service.ts:64` (add new method after `endCall`)
- Test: `src/app/services/voice.service.spec.ts` (new file)

**Interfaces:**
- Produces: `VoiceService.leaveCall(callId: string): Observable<CallDto>` - `PUT {base}/call/{callId}/leave` with an empty body, same response shape as `acceptCall`/`declineCall`/`endCall`.

- [ ] **Step 1: Write the failing test**

Create `src/app/services/voice.service.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {VoiceService} from './voice.service';
import {ApiConfigService} from './api-config.service';

const BASE = 'https://api.test.example/api/v1/messaging/voice';

function setup() {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
        ],
    });
    return {
        service: TestBed.inject(VoiceService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

describe('VoiceService.leaveCall', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('PUTs to /call/{id}/leave with an empty body', () => {
        const {service, ctrl} = setup();
        service.leaveCall('call_1').subscribe();
        const req = ctrl.expectOne(`${BASE}/call/call_1/leave`);
        expect(req.request.method).toBe('PUT');
        expect(req.request.body).toEqual({});
        req.flush({
            id: 'call_1', conversationId: 'conv_1',
            createdAt: new Date(), updatedAt: new Date(),
            tracks: [], participants: [],
        });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ng test`
Expected: FAIL - `service.leaveCall is not a function`

- [ ] **Step 3: Add the method**

In `src/app/services/voice.service.ts`, immediately after `endCall` (line 66):

```ts
    leaveCall(callId: string): Observable<CallDto> {
        return this.client.put<CallDto>(`${this.base}/call/${callId}/leave`, {});
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ng test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/services/voice.service.ts src/app/services/voice.service.spec.ts
git commit -m "feat: add VoiceService.leaveCall for multi-device call leave semantics"
```

---

### Task 2: `X-Device-Id` HTTP interceptor

**Files:**
- Create: `src/app/interceptors/device-id-interceptor.ts`
- Create: `src/app/interceptors/device-id-interceptor.spec.ts`
- Modify: `src/app/app.config.ts:48`

**Interfaces:**
- Consumes: `MlsService.getOrCreateDeviceIdentifier(): Promise<string>` (existing), `ApiConfigService.baseUrl(): string` (existing).
- Produces: `deviceIdInterceptor: HttpInterceptorFn`, `_resetDeviceIdCache(): void` (test-only, mirrors `_resetInterceptorState` in `token-interceptor.ts`).

- [ ] **Step 1: Write the failing test**

Create `src/app/interceptors/device-id-interceptor.spec.ts`:

```ts
import {HttpClient, provideHttpClient, withInterceptors} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {TestBed} from '@angular/core/testing';
import {_resetDeviceIdCache, deviceIdInterceptor} from './device-id-interceptor';
import {ApiConfigService} from '../services/api-config.service';
import {MlsService} from '../services/mls.service';

const BASE = 'https://api.venta.gg';

function setup(getOrCreateDeviceIdentifier = vi.fn().mockResolvedValue('device-abc')) {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(withInterceptors([deviceIdInterceptor])),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            {provide: MlsService, useValue: {getOrCreateDeviceIdentifier}},
        ],
    });
    return {
        http: TestBed.inject(HttpClient),
        ctrl: TestBed.inject(HttpTestingController),
        getOrCreateDeviceIdentifier,
    };
}

beforeEach(() => _resetDeviceIdCache());
afterEach(() => TestBed.inject(HttpTestingController).verify());

describe('deviceIdInterceptor', () => {
    it('sets X-Device-Id on requests to the API base URL', () => {
        const {http, ctrl} = setup();
        http.get(`${BASE}/api/v1/messaging/voice/call/1`).subscribe();
        const req = ctrl.expectOne(`${BASE}/api/v1/messaging/voice/call/1`);
        expect(req.request.headers.get('X-Device-Id')).toBe('device-abc');
        req.flush({});
    });

    it('does not touch requests outside the API base URL', () => {
        const {http, ctrl} = setup();
        http.get('https://other-service.example/ping').subscribe();
        const req = ctrl.expectOne('https://other-service.example/ping');
        expect(req.request.headers.has('X-Device-Id')).toBe(false);
        req.flush({});
    });

    it('resolves the device id only once across multiple requests', () => {
        const {http, ctrl, getOrCreateDeviceIdentifier} = setup();
        http.get(`${BASE}/a`).subscribe();
        http.get(`${BASE}/b`).subscribe();
        ctrl.match(() => true).forEach(r => r.flush({}));
        expect(getOrCreateDeviceIdentifier).toHaveBeenCalledTimes(1);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ng test`
Expected: FAIL - cannot find module `./device-id-interceptor`

- [ ] **Step 3: Create the interceptor**

Create `src/app/interceptors/device-id-interceptor.ts`:

```ts
import {HttpInterceptorFn} from '@angular/common/http';
import {inject} from '@angular/core';
import {from, switchMap} from 'rxjs';
import {ApiConfigService} from '../services/api-config.service';
import {MlsService} from '../services/mls.service';

// Shared across all interceptor invocations so the Tauri store is only hit once
// per app session, since this now runs on every gateway request.
let deviceIdPromise: Promise<string> | null = null;

/** Reset module-level state between test runs. */
export function _resetDeviceIdCache(): void {
    deviceIdPromise = null;
}

export const deviceIdInterceptor: HttpInterceptorFn = (req, next) => {
    const apiConfig = inject(ApiConfigService);
    if (!req.url.startsWith(apiConfig.baseUrl())) return next(req);

    const mlsService = inject(MlsService);
    if (!deviceIdPromise) deviceIdPromise = mlsService.getOrCreateDeviceIdentifier();

    return from(deviceIdPromise).pipe(
        switchMap(deviceId => next(req.clone({setHeaders: {'X-Device-Id': deviceId}}))),
    );
};
```

- [ ] **Step 4: Register the interceptor**

In `src/app/app.config.ts`, add the import near the other interceptor imports (line 18-19):

```ts
import {tokenInterceptor} from "./interceptors/token-interceptor";
import {deviceIdInterceptor} from "./interceptors/device-id-interceptor";
import {timeoutInterceptor} from "./interceptors/timeout.interceptor";
```

And update the `provideHttpClient` call (line 48):

```ts
        provideHttpClient(withInterceptors([tokenInterceptor, deviceIdInterceptor, timeoutInterceptor])),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx ng test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/interceptors/device-id-interceptor.ts src/app/interceptors/device-id-interceptor.spec.ts src/app/app.config.ts
git commit -m "feat: add X-Device-Id HTTP interceptor for multi-device calls/voice"
```

---

### Task 3: Hub connection `deviceId` query param

**Files:**
- Modify: `src/app/services/realtime-connection.service.ts` (full rewrite of construction logic)
- Test: `src/app/services/realtime-connection.service.spec.ts` (new file)

**Interfaces:**
- Consumes: `MlsService.getOrCreateDeviceIdentifier(): Promise<string>` (existing).
- Produces: `RealtimeConnectionService.on/off/invoke/start/connectionState` - **unchanged public signatures**, so `MessagingWebsocketService`, `VoiceWebsocketService`, `GuildWebsocketService`, `IsleVoiceWebsocketService` need no changes.

- [ ] **Step 1: Write the failing test**

Create `src/app/services/realtime-connection.service.spec.ts`:

```ts
vi.mock('@microsoft/signalr', () => {
    class FakeHubConnection {
        state = 'Disconnected';
        handlers = new Map<string, (...args: any[]) => void>();
        on(event: string, handler: (...args: any[]) => void) {
            this.handlers.set(event, handler);
        }
        off(event: string) {
            this.handlers.delete(event);
        }
        async start() {
            this.state = 'Connected';
        }
        async invoke() { /* no-op */
        }
        onreconnecting() { /* no-op */
        }
        onreconnected() { /* no-op */
        }
        onclose() { /* no-op */
        }
    }
    class FakeHubConnectionBuilder {
        url = '';
        withUrl(url: string) {
            this.url = url;
            return this;
        }
        withAutomaticReconnect() {
            return this;
        }
        build() {
            const conn = new FakeHubConnection();
            (globalThis as any).__lastFakeHubConnection = conn;
            (globalThis as any).__lastFakeHubConnectionUrl = this.url;
            return conn;
        }
    }
    return {
        HubConnectionBuilder: FakeHubConnectionBuilder,
        HubConnectionState: {Connected: 'Connected', Disconnected: 'Disconnected', Connecting: 'Connecting'},
    };
});

import {TestBed} from '@angular/core/testing';
import {RealtimeConnectionService} from './realtime-connection.service';
import {AuthService} from './auth.service';
import {NotificationService} from './notification.service';
import {ApiConfigService} from './api-config.service';
import {MlsService} from './mls.service';

function setup(deviceId: Promise<string>) {
    TestBed.configureTestingModule({
        providers: [
            {provide: AuthService, useValue: {ensureValidToken: () => Promise.resolve('token')}},
            {provide: NotificationService, useValue: {createNotification: () => Promise.resolve()}},
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            {provide: MlsService, useValue: {getOrCreateDeviceIdentifier: () => deviceId}},
        ],
    });
    return {service: TestBed.inject(RealtimeConnectionService)};
}

describe('RealtimeConnectionService - device id on hub URL', () => {
    it('builds the hub connection URL with the resolved deviceId as a query param', async () => {
        const {service} = setup(Promise.resolve('device-abc'));

        await service.start();

        expect((globalThis as any).__lastFakeHubConnectionUrl)
            .toBe('https://api.test.example/api/v1/ws/hub?deviceId=device-abc');
    });

    it('queues on() registrations made before start() and applies them once connected', async () => {
        const {service} = setup(Promise.resolve('device-abc'));
        const handler = vi.fn();

        service.on('call.CallEnded', handler);
        await service.start();

        const conn = (globalThis as any).__lastFakeHubConnection;
        expect(conn.handlers.get('call.CallEnded')).toBe(handler);
    });

    it('falls back to no deviceId query param if device id resolution fails', async () => {
        const {service} = setup(Promise.reject(new Error('store unavailable')));

        await service.start();

        expect((globalThis as any).__lastFakeHubConnectionUrl)
            .toBe('https://api.test.example/api/v1/ws/hub');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ng test`
Expected: FAIL - the URL will be missing `?deviceId=...` (current code builds the connection synchronously in the constructor with no device id).

- [ ] **Step 3: Rewrite `realtime-connection.service.ts`**

Replace the full contents of `src/app/services/realtime-connection.service.ts` with:

```ts
import {inject, Injectable, signal} from '@angular/core';
import * as signalR from '@microsoft/signalr';
import {AuthService} from './auth.service';
import {NotificationService, NotificationSound} from './notification.service';
import {ApiConfigService} from './api-config.service';
import {MlsService} from './mls.service';

export enum ConnectionState {
    Connected,
    Disconnected,
    Connecting,
}

/**
 * Owns the single SignalR connection for the whole app (`/api/v1/ws/hub`).
 *
 * Since the backend cutover to one connection per user, every feature that used
 * to have its own hub (messaging, voice/calls, guild) now shares this connection.
 * Event and method names are domain-prefixed (`conversation.*`, `presence.*`,
 * `call.*`, `guild.*`, `guild.voice.*`) so a single pipe can carry all of them.
 *
 * Feature services register their handlers via {@link on} and send via
 * {@link invoke}; they keep their own public observables so consumers are
 * unaffected by the consolidation.
 *
 * The connection is built lazily inside {@link start} (not the constructor)
 * because its URL needs the async-resolved device id (see the multi-device
 * calls/voice spec). `.on()`/`.off()` are still safe to call before `start()`:
 * registrations made early are queued and replayed once the connection exists.
 */
@Injectable({providedIn: 'root'})
export class RealtimeConnectionService {
    public readonly connectionState = signal(ConnectionState.Disconnected);
    private hubConnection: signalR.HubConnection | null = null;
    private readonly authService = inject(AuthService);
    private readonly notificationService = inject(NotificationService);
    private readonly apiConfig = inject(ApiConfigService);
    private readonly mlsService = inject(MlsService);
    private starting?: Promise<void>;
    private reconnectNotified = false;
    private readonly pendingHandlers: Array<{ event: string; handler: (...args: any[]) => void }> = [];

    /** Register a server → client event handler. Safe to call before or after {@link start}. */
    on(event: string, handler: (...args: any[]) => void): void {
        if (this.hubConnection) {
            this.hubConnection.on(event, handler);
        } else {
            this.pendingHandlers.push({event, handler});
        }
    }

    /** Remove all handlers for an event. */
    off(event: string): void {
        this.hubConnection?.off(event);
    }

    /**
     * Fire a client → server invocation. No-op when disconnected and never rejects
     * -errors are logged so callers can treat it as fire-and-forget.
     */
    async invoke(method: string, ...args: unknown[]): Promise<void> {
        if (!this.hubConnection || this.hubConnection.state !== signalR.HubConnectionState.Connected) return;
        try {
            await this.hubConnection.invoke(method, ...args);
        } catch (err) {
            console.error(`Realtime invoke '${method}' failed:`, err);
        }
    }

    /** Idempotent: starts the connection once; concurrent callers share one attempt. */
    async start(): Promise<void> {
        if (this.hubConnection?.state === signalR.HubConnectionState.Connected) return;
        if (this.starting) return this.starting;

        this.starting = this.buildConnection()
            .then(conn => {
                this.hubConnection = conn;
                this.wireLifecycle(conn);
                for (const {event, handler} of this.pendingHandlers) conn.on(event, handler);
                this.pendingHandlers.length = 0;
                return conn.start();
            })
            .then(() => {
                this.connectionState.set(ConnectionState.Connected);
            })
            .catch(err => {
                console.error('Realtime: connection error', err);
                this.connectionState.set(ConnectionState.Disconnected);
            })
            .finally(() => {
                this.starting = undefined;
            });

        return this.starting;
    }

    private async buildConnection(): Promise<signalR.HubConnection> {
        let query = '';
        try {
            const deviceId = await this.mlsService.getOrCreateDeviceIdentifier();
            query = `?deviceId=${encodeURIComponent(deviceId)}`;
        } catch (err) {
            console.error('Realtime: failed to resolve device id, connecting without one', err);
        }

        return new signalR.HubConnectionBuilder()
            .withUrl(this.apiConfig.baseUrl() + '/api/v1/ws/hub' + query, {
                accessTokenFactory: () => this.authService.ensureValidToken(),
            })
            .withAutomaticReconnect({
                nextRetryDelayInMilliseconds: retryContext =>
                    Math.min(1000 * Math.pow(2, retryContext.previousRetryCount), 60_000),
            })
            .build();
    }

    private wireLifecycle(conn: signalR.HubConnection): void {
        conn.onreconnecting(() => {
            if (!this.reconnectNotified) {
                this.reconnectNotified = true;
                this.notificationService.createNotification({
                    title: 'Reconnecting',
                    message: 'Attempting to reconnect...',
                    sound: NotificationSound.NewMessage,
                }).catch(() => {
                });
            }
            this.connectionState.set(ConnectionState.Connecting);
        });

        conn.onreconnected(() => {
            this.reconnectNotified = false;
            this.connectionState.set(ConnectionState.Connected);
        });

        conn.onclose(() => {
            this.reconnectNotified = false;
            this.connectionState.set(ConnectionState.Disconnected);
        });
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ng test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/services/realtime-connection.service.ts src/app/services/realtime-connection.service.spec.ts
git commit -m "feat: append deviceId query param to the realtime hub connection"
```

---

### Task 4: New call WS events + `describeCallEndedReason`

**Files:**
- Modify: `src/app/services/voice-websocket.service.ts`
- Test: `src/app/services/voice-websocket.service.spec.ts` (new file)

**Interfaces:**
- Produces:
  - `WsCallAccepted { callId: string; deviceId: string }`
  - `WsCallDeviceDismissed { callId: string; deviceId: string }`
  - `WsCallDeviceTakeover { callId: string; oldDeviceId: string; newDeviceId: string }`
  - `WsCallParticipantLeft { callId: string; userId: string }`
  - `WsCallAlone { callId: string; userId: string; deadline: string }`
  - `WsCallEnded { callId: string; reason?: string }` (adds `reason`)
  - `VoiceWebsocketService.callAcceptedObservable: Subject<WsCallAccepted>`
  - `VoiceWebsocketService.callDeviceDismissedObservable: Subject<WsCallDeviceDismissed>`
  - `VoiceWebsocketService.callDeviceTakeoverObservable: Subject<WsCallDeviceTakeover>`
  - `VoiceWebsocketService.callParticipantLeftObservable: Subject<WsCallParticipantLeft>`
  - `VoiceWebsocketService.callAloneObservable: Subject<WsCallAlone>`
  - `describeCallEndedReason(reason?: string): string` - exported pure function.

- [ ] **Step 1: Write the failing tests**

Create `src/app/services/voice-websocket.service.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {describeCallEndedReason, VoiceWebsocketService} from './voice-websocket.service';
import {RealtimeConnectionService} from './realtime-connection.service';

function setupRealtimeStub() {
    const handlers = new Map<string, (...args: any[]) => void>();
    return {
        on: vi.fn((event: string, handler: (...args: any[]) => void) => handlers.set(event, handler)),
        off: vi.fn(),
        invoke: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        connectionState: () => 0,
        handlers,
    };
}

describe('describeCallEndedReason', () => {
    it('maps Declined to "Call declined"', () => {
        expect(describeCallEndedReason('Declined')).toBe('Call declined');
    });

    it('maps AloneTimeout to "Call ended - no one rejoined"', () => {
        expect(describeCallEndedReason('AloneTimeout')).toBe('Call ended - no one rejoined');
    });

    it('maps UserEnded to "Call ended"', () => {
        expect(describeCallEndedReason('UserEnded')).toBe('Call ended');
    });

    it('maps AllParticipantsLeft to "Call ended"', () => {
        expect(describeCallEndedReason('AllParticipantsLeft')).toBe('Call ended');
    });

    it('defaults to "Call ended" for an undefined/unknown reason', () => {
        expect(describeCallEndedReason(undefined)).toBe('Call ended');
        expect(describeCallEndedReason('SomethingNew')).toBe('Call ended');
    });
});

describe('VoiceWebsocketService - new multi-device call events', () => {
    async function setup() {
        const realtimeStub = setupRealtimeStub();
        TestBed.configureTestingModule({
            providers: [
                {provide: RealtimeConnectionService, useValue: realtimeStub},
            ],
        });
        const service = TestBed.inject(VoiceWebsocketService);
        await service.start();
        return {service, realtimeStub};
    }

    it('registers call.CallAccepted and forwards to callAcceptedObservable', async () => {
        const {service, realtimeStub} = await setup();
        const received: unknown[] = [];
        service.callAcceptedObservable.subscribe(e => received.push(e));

        realtimeStub.handlers.get('call.CallAccepted')?.({callId: 'call_1', deviceId: 'device_1'});

        expect(received).toEqual([{callId: 'call_1', deviceId: 'device_1'}]);
    });

    it('registers call.CallDeviceDismissed and forwards to callDeviceDismissedObservable', async () => {
        const {service, realtimeStub} = await setup();
        const received: unknown[] = [];
        service.callDeviceDismissedObservable.subscribe(e => received.push(e));

        realtimeStub.handlers.get('call.CallDeviceDismissed')?.({callId: 'call_1', deviceId: 'device_2'});

        expect(received).toEqual([{callId: 'call_1', deviceId: 'device_2'}]);
    });

    it('registers call.CallDeviceTakeover and forwards to callDeviceTakeoverObservable', async () => {
        const {service, realtimeStub} = await setup();
        const received: unknown[] = [];
        service.callDeviceTakeoverObservable.subscribe(e => received.push(e));

        realtimeStub.handlers.get('call.CallDeviceTakeover')?.({
            callId: 'call_1', oldDeviceId: 'device_1', newDeviceId: 'device_2',
        });

        expect(received).toEqual([{callId: 'call_1', oldDeviceId: 'device_1', newDeviceId: 'device_2'}]);
    });

    it('registers call.CallParticipantLeft and forwards to callParticipantLeftObservable', async () => {
        const {service, realtimeStub} = await setup();
        const received: unknown[] = [];
        service.callParticipantLeftObservable.subscribe(e => received.push(e));

        realtimeStub.handlers.get('call.CallParticipantLeft')?.({callId: 'call_1', userId: 'user_1'});

        expect(received).toEqual([{callId: 'call_1', userId: 'user_1'}]);
    });

    it('registers call.CallAlone and forwards to callAloneObservable', async () => {
        const {service, realtimeStub} = await setup();
        const received: unknown[] = [];
        service.callAloneObservable.subscribe(e => received.push(e));

        realtimeStub.handlers.get('call.CallAlone')?.({
            callId: 'call_1', userId: 'user_1', deadline: '2026-07-29T12:00:00Z',
        });

        expect(received).toEqual([{callId: 'call_1', userId: 'user_1', deadline: '2026-07-29T12:00:00Z'}]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ng test`
Expected: FAIL - `describeCallEndedReason` and the new observables don't exist yet.

- [ ] **Step 3: Add the new types, observables and registrations**

In `src/app/services/voice-websocket.service.ts`, replace:

```ts
export interface WsCallEnded {
    callId: string;
}
```

with:

```ts
export interface WsCallEnded {
    callId: string;
    reason?: 'Declined' | 'UserEnded' | 'AllParticipantsLeft' | 'AloneTimeout';
}

/** Broadcast to all of a user's devices when one of them accepts a call. */
export interface WsCallAccepted {
    callId: string;
    deviceId: string;
}

/** Sent only to the device whose decline arrived after the user was already
 *  connected elsewhere - treat like a locally-cancelled ring, not "call ended". */
export interface WsCallDeviceDismissed {
    callId: string;
    deviceId: string;
}

/** Sent only to the device whose connection was just taken over by another of
 *  the user's devices accepting the same call. */
export interface WsCallDeviceTakeover {
    callId: string;
    oldDeviceId: string;
    newDeviceId: string;
}

/** A participant left a still-active call (the call keeps running for others). */
export interface WsCallParticipantLeft {
    callId: string;
    userId: string;
}

/** The call dropped to exactly one connected participant; deadline is ISO-8601. */
export interface WsCallAlone {
    callId: string;
    userId: string;
    deadline: string;
}

/** Maps the new `call.CallEnded` reason to user-facing copy. */
export function describeCallEndedReason(reason?: string): string {
    switch (reason) {
        case 'Declined':
            return 'Call declined';
        case 'AloneTimeout':
            return 'Call ended - no one rejoined';
        default:
            return 'Call ended';
    }
}
```

Then add the new observables right after `public callEndedObservable = new Subject<WsCallEnded>();`:

```ts
    public callAcceptedObservable = new Subject<WsCallAccepted>();
    public callDeviceDismissedObservable = new Subject<WsCallDeviceDismissed>();
    public callDeviceTakeoverObservable = new Subject<WsCallDeviceTakeover>();
    public callParticipantLeftObservable = new Subject<WsCallParticipantLeft>();
    public callAloneObservable = new Subject<WsCallAlone>();
```

Then add the registrations right after `this.realtime.on('call.CallEnded', (d: WsCallEnded) => this.callEndedObservable.next(d));`:

```ts
        this.realtime.on('call.CallAccepted', (d: WsCallAccepted) => this.callAcceptedObservable.next(d));
        this.realtime.on('call.CallDeviceDismissed', (d: WsCallDeviceDismissed) => this.callDeviceDismissedObservable.next(d));
        this.realtime.on('call.CallDeviceTakeover', (d: WsCallDeviceTakeover) => this.callDeviceTakeoverObservable.next(d));
        this.realtime.on('call.CallParticipantLeft', (d: WsCallParticipantLeft) => this.callParticipantLeftObservable.next(d));
        this.realtime.on('call.CallAlone', (d: WsCallAlone) => this.callAloneObservable.next(d));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ng test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/services/voice-websocket.service.ts src/app/services/voice-websocket.service.spec.ts
git commit -m "feat: add multi-device call events and CallEnded reason to VoiceWebsocketService"
```

---

### Task 5: `CallSessionService` - leave semantics + alone deadline

**Files:**
- Modify: `src/app/services/call-session.service.ts`
- Test: `src/app/services/call-session.service.spec.ts` (new file)

**Interfaces:**
- Consumes: `VoiceService.leaveCall` (Task 1).
- Produces:
  - `CallSessionService.end(silent = false): void` (was `end(): void`)
  - `CallSessionService.aloneDeadline: Signal<Date | null>`
  - `CallSessionService.setAloneDeadline(deadline: Date | null): void`
  - `onParticipantJoined` now clears `aloneDeadline` once participants exceed 1.

- [ ] **Step 1: Write the failing tests**

Create `src/app/services/call-session.service.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {of} from 'rxjs';
import {CallSessionService} from './call-session.service';
import {ProfileService} from './profile.service';
import {ConversationStore} from '../stores/conversation.store';
import {VoiceService} from './voice.service';
import {AudioSettingsService} from './audio-settings.service';
import {RustMediaService} from './rust-media.service';
import {ScreenPickerService} from './screen-picker.service';
import type {ActiveCallSession} from './call-session.types';
import type {CallDto} from '../dtos/response/call.dto';

function setup(leaveCall = vi.fn().mockReturnValue(of({} as CallDto))) {
    TestBed.configureTestingModule({
        providers: [
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'me'}), getCachedByUserId: () => undefined}},
            {provide: ConversationStore, useValue: {entities: () => []}},
            {provide: VoiceService, useValue: {leaveCall}},
            {provide: AudioSettingsService, useValue: {}},
            {provide: RustMediaService, useValue: {}},
            {provide: ScreenPickerService, useValue: {}},
        ],
    });
    return {service: TestBed.inject(CallSessionService), leaveCall};
}

const BASE_SESSION: ActiveCallSession = {
    callId: 'call_1',
    conversationId: 'conv_1',
    participants: [{
        userId: 'me', displayName: 'Me', avatarLabel: 'M', avatarUrl: undefined,
        isLocal: true, isMuted: false, isSpeaking: false, isCameraOn: false, videoStream: undefined,
    }],
    screenShares: [],
    local: {isMuted: false, isDeafened: false, isCameraOn: false, isSharing: false},
    startedAt: new Date(),
};

describe('CallSessionService.end', () => {
    it('calls leaveCall and clears the session when silent is false (default)', () => {
        const {service, leaveCall} = setup();
        service.session.set(BASE_SESSION);

        service.end();

        expect(leaveCall).toHaveBeenCalledWith('call_1');
        expect(service.session()).toBeNull();
    });

    it('does not call leaveCall when silent is true', () => {
        const {service, leaveCall} = setup();
        service.session.set(BASE_SESSION);

        service.end(true);

        expect(leaveCall).not.toHaveBeenCalled();
        expect(service.session()).toBeNull();
    });

    it('clears aloneDeadline', () => {
        const {service} = setup();
        service.session.set(BASE_SESSION);
        service.setAloneDeadline(new Date());

        service.end(true);

        expect(service.aloneDeadline()).toBeNull();
    });

    it('is a no-op when there is no active session', () => {
        const {service, leaveCall} = setup();

        service.end();

        expect(leaveCall).not.toHaveBeenCalled();
    });
});

describe('CallSessionService - aloneDeadline clears once a second participant joins', () => {
    it('clears aloneDeadline once a second participant joins', () => {
        const {service} = setup();
        service.session.set(BASE_SESSION);
        service.setAloneDeadline(new Date());

        service.onParticipantJoined('other-user');

        expect(service.aloneDeadline()).toBeNull();
        expect(service.session()?.participants.map(p => p.userId)).toEqual(['me', 'other-user']);
    });

    it('leaves aloneDeadline untouched when the "join" is a duplicate of the local user', () => {
        const {service} = setup();
        service.session.set(BASE_SESSION);
        const deadline = new Date();
        service.setAloneDeadline(deadline);

        service.onParticipantJoined('me'); // already present -existing guard no-ops this

        expect(service.aloneDeadline()).toBe(deadline);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ng test`
Expected: FAIL - `service.end(true)` doesn't skip the network call, `aloneDeadline`/`setAloneDeadline` don't exist.

- [ ] **Step 3: Implement the changes**

In `src/app/services/call-session.service.ts`, add the field near `pttGateOpen` (after line 19):

```ts
    /** Set from `call.CallAlone` - the deadline the server will force-end the call
     *  at if nobody else rejoins. Cleared once a second participant is present. */
    readonly aloneDeadline = signal<Date | null>(null);
```

Replace `end()`:

```ts
    end(): void {
        const s = this.session();
        if (!s) return;
        // Stop any active local media streams before tearing down
        s.participants.find(p => p.isLocal)?.videoStream?.getTracks().forEach(t => t.stop());
        s.screenShares.find(sh => sh.isLocal)?.stream?.getTracks().forEach(t => t.stop());
        // TODO(webrtc): disconnect all peer connections
        this.voiceService.endCall(s.callId).subscribe();
        this.session.set(null);
    }
```

with:

```ts
    /**
     * Tears down the active call session. `silent: true` skips calling the leave
     * endpoint -used when the server has already ended the call/session for us
     * (a device takeover, or reacting to an already-delivered `CallEnded`), where
     * calling `leave` again would be a pointless, possibly-erroring network call.
     */
    end(silent = false): void {
        const s = this.session();
        if (!s) return;
        // Stop any active local media streams before tearing down
        s.participants.find(p => p.isLocal)?.videoStream?.getTracks().forEach(t => t.stop());
        s.screenShares.find(sh => sh.isLocal)?.stream?.getTracks().forEach(t => t.stop());
        // TODO(webrtc): disconnect all peer connections
        if (!silent) this.voiceService.leaveCall(s.callId).subscribe();
        this.session.set(null);
        this.aloneDeadline.set(null);
    }

    setAloneDeadline(deadline: Date | null): void {
        this.aloneDeadline.set(deadline);
    }
```

Update `onParticipantJoined` to clear `aloneDeadline` once there's more than one participant - add one line at the end of the method body:

```ts
    onParticipantJoined(userId: string): void {
        const s = this.session();
        if (!s || s.participants.some(p => p.userId === userId)) return;

        const conv = this.conversationStore.entities().find(c => c.id === s.conversationId);
        const member = conv?.members.find(m => m.userId === userId);
        const profile = this.profileService.getCachedByUserId(userId);
        const ownId = this.profileService.ownProfile()?.userId;

        const participant: CallParticipantUi = {
            userId,
            displayName: member?.cachedUserName ?? profile?.userName ?? 'Unknown',
            avatarLabel: (member?.cachedUserName?.[0] ?? '?').toUpperCase(),
            avatarUrl: profile?.avatarUrl,
            isLocal: userId === ownId,
            isMuted: false,
            isSpeaking: false,
            isCameraOn: false,
            videoStream: undefined,
        };

        this.session.update(st => st ? {...st, participants: [...st.participants, participant]} : st);
        if ((this.session()?.participants.length ?? 0) > 1) this.aloneDeadline.set(null);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ng test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/services/call-session.service.ts src/app/services/call-session.service.spec.ts
git commit -m "feat: CallSessionService.end supports silent teardown, adds aloneDeadline"
```

---

### Task 6: `CallStateService` - multi-device ring dismissal & takeover

**Files:**
- Modify: `src/app/services/call-state.service.ts`
- Test: `src/app/services/call-state.service.spec.ts` (new file)

**Interfaces:**
- Consumes: `VoiceWebsocketService.callAcceptedObservable/callDeviceDismissedObservable/callDeviceTakeoverObservable` (Task 4), `VoiceService.leaveCall` (Task 1), `CallSessionService.end(silent)` (Task 5).
- Produces: no new public API - behavioral change only (`cancelOutgoing` calls `leaveCall` instead of `endCall`; three new internal subscriptions).

- [ ] **Step 1: Write the failing tests**

Create `src/app/services/call-state.service.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {of, Subject} from 'rxjs';
import {CallStateService} from './call-state.service';
import {VoiceWebsocketService, WsCallEnded} from './voice-websocket.service';
import {VoiceService} from './voice.service';
import {ProfileService} from './profile.service';
import {ConversationStore} from '../stores/conversation.store';
import {CallSessionService} from './call-session.service';
import {NavigationService} from '../features/main-page/navigation.service';
import {SoundSettingsService} from './sound-settings.service';
import {ToastService} from './toast.service';
import type {CallDto} from '../dtos/response/call.dto';

const CALL: CallDto = {
    id: 'call_1', conversationId: 'conv_1',
    createdAt: new Date(), updatedAt: new Date(),
    tracks: [], participants: [{userId: 'other'}],
};

function setup() {
    const wsStub = {
        incomingCallObservable: new Subject<CallDto>(),
        callEndedObservable: new Subject<WsCallEnded>(),
        participantJoinedObservable: new Subject<unknown>(),
        callAcceptedObservable: new Subject<{ callId: string; deviceId: string }>(),
        callDeviceDismissedObservable: new Subject<{ callId: string; deviceId: string }>(),
        callDeviceTakeoverObservable: new Subject<{ callId: string; oldDeviceId: string; newDeviceId: string }>(),
    };

    const leaveCall = vi.fn().mockReturnValue({subscribe: () => {
    }});
    const endCall = vi.fn().mockReturnValue({subscribe: () => {
    }});
    // Emits synchronously so startCall()'s pendingCallDto is actually set -needed
    // for cancelOutgoing() to exercise the leaveCall-vs-endCall call site below.
    const createCall = vi.fn().mockReturnValue(of(CALL));

    const callSessionStub = {
        session: vi.fn(() => null as { callId: string } | null),
        join: vi.fn(),
        end: vi.fn(),
    };

    const toastStub = {info: vi.fn(), httpError: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn()};

    TestBed.configureTestingModule({
        providers: [
            {provide: VoiceWebsocketService, useValue: wsStub},
            {provide: VoiceService, useValue: {leaveCall, endCall, createCall}},
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'me'})}},
            {provide: ConversationStore, useValue: {entities: () => []}},
            {provide: CallSessionService, useValue: callSessionStub},
            {provide: NavigationService, useValue: {openConversation: vi.fn()}},
            {provide: SoundSettingsService, useValue: {playIncomingRing: vi.fn(), playRingback: vi.fn()}},
            {provide: ToastService, useValue: toastStub},
        ],
    });

    return {
        service: TestBed.inject(CallStateService),
        ws: wsStub,
        callSession: callSessionStub,
        toast: toastStub,
        leaveCall,
        endCall,
    };
}

describe('CallStateService - multi-device ring dismissal', () => {
    it('dismisses the incoming call UI on CallAccepted for the same callId', () => {
        const {service, ws} = setup();
        service.incomingCall.set({call: CALL, displayName: 'Alice', avatarLabel: 'A'});

        ws.callAcceptedObservable.next({callId: 'call_1', deviceId: 'device_b'});

        expect(service.incomingCall()).toBeNull();
    });

    it('dismisses the incoming call UI on CallDeviceDismissed for the same callId', () => {
        const {service, ws} = setup();
        service.incomingCall.set({call: CALL, displayName: 'Alice', avatarLabel: 'A'});

        ws.callDeviceDismissedObservable.next({callId: 'call_1', deviceId: 'device_b'});

        expect(service.incomingCall()).toBeNull();
    });

    it('ignores CallAccepted for a different callId', () => {
        const {service, ws} = setup();
        service.incomingCall.set({call: CALL, displayName: 'Alice', avatarLabel: 'A'});

        ws.callAcceptedObservable.next({callId: 'some-other-call', deviceId: 'device_b'});

        expect(service.incomingCall()).not.toBeNull();
    });
});

describe('CallStateService - device takeover', () => {
    it('ends the local session silently and shows a toast when the active call matches', () => {
        const {ws, callSession, toast} = setup();
        callSession.session.mockReturnValue({callId: 'call_1'});

        ws.callDeviceTakeoverObservable.next({callId: 'call_1', oldDeviceId: 'device_a', newDeviceId: 'device_b'});

        expect(callSession.end).toHaveBeenCalledWith(true);
        expect(toast.info).toHaveBeenCalledWith('You joined this call on another device');
    });

    it('does nothing when the takeover targets a different call', () => {
        const {ws, callSession, toast} = setup();
        callSession.session.mockReturnValue({callId: 'call_1'});

        ws.callDeviceTakeoverObservable.next({callId: 'call_2', oldDeviceId: 'device_a', newDeviceId: 'device_b'});

        expect(callSession.end).not.toHaveBeenCalled();
        expect(toast.info).not.toHaveBeenCalled();
    });
});

describe('CallStateService.cancelOutgoing', () => {
    it('calls leaveCall, not endCall, to cancel a not-yet-answered outgoing call', () => {
        const {service, leaveCall, endCall} = setup();
        service.startCall('conv_1', ['other'], 'Alice', 'A');
        // createCall's stub emits synchronously, so pendingCallDto is now set to CALL.

        service.cancelOutgoing();

        expect(leaveCall).toHaveBeenCalledWith('call_1');
        expect(endCall).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ng test`
Expected: FAIL - `CallStateService` doesn't yet subscribe to `callAcceptedObservable`/`callDeviceDismissedObservable`/`callDeviceTakeoverObservable`.

- [ ] **Step 3: Implement the changes**

In `src/app/services/call-state.service.ts`, replace the constructor's incoming-call wiring:

```ts
    constructor() {
        this.sub = this.ws.incomingCallObservable.subscribe(call => {
            if (this.callSession.session()) return; // already in a call, ignore late/duplicate events
            this.incomingCall.set(this.resolveCallInfo(call));
            this.startRingtone();
        });
        // The caller may cancel, hang up, or the call may otherwise end before we've
        // accepted/declined - nothing else clears the incoming-call overlay/ringtone
        // in that case, so without this the card and ringing would persist forever
        // and a subsequent Accept click would silently fail against a dead call.
        this.incomingEndedSub = this.ws.callEndedObservable.subscribe(({callId}) => {
            if (this.incomingCall()?.call.id !== callId) return;
            this.stopRingtone();
            this.incomingCall.set(null);
        });
        document.addEventListener('keydown', this.devKeyHandler);
    }
```

with:

```ts
    constructor() {
        this.sub = this.ws.incomingCallObservable.subscribe(call => {
            if (this.callSession.session()) return; // already in a call, ignore late/duplicate events
            this.incomingCall.set(this.resolveCallInfo(call));
            this.startRingtone();
        });
        // The caller may cancel, hang up, or the call may otherwise end before we've
        // accepted/declined - nothing else clears the incoming-call overlay/ringtone
        // in that case, so without this the card and ringing would persist forever
        // and a subsequent Accept click would silently fail against a dead call.
        this.incomingEndedSub = this.ws.callEndedObservable.subscribe(({callId}) =>
            this.dismissIncomingIfMatches(callId));
        // Another of my devices accepted this call -dismiss this device's ring the
        // same way a cancelled ring is dismissed, not as "call ended".
        this.callAcceptedSub = this.ws.callAcceptedObservable.subscribe(({callId}) =>
            this.dismissIncomingIfMatches(callId));
        // I declined here after already accepting on another device (a race) -
        // dismiss silently, do not show "call ended".
        this.callDeviceDismissedSub = this.ws.callDeviceDismissedObservable.subscribe(({callId}) =>
            this.dismissIncomingIfMatches(callId));
        // I accepted this same call on another device while connected here - the
        // server has already moved the call there; tear down locally without
        // calling leave ourselves.
        this.callDeviceTakeoverSub = this.ws.callDeviceTakeoverObservable.subscribe(({callId}) => {
            if (this.callSession.session()?.callId !== callId) return;
            this.callSession.end(true);
            this.toast.info('You joined this call on another device');
        });
        document.addEventListener('keydown', this.devKeyHandler);
    }

    private dismissIncomingIfMatches(callId: string): void {
        if (this.incomingCall()?.call.id !== callId) return;
        this.stopRingtone();
        this.incomingCall.set(null);
    }
```

Add the three new subscription fields next to the existing ones:

```ts
    private sub: Subscription;
    private incomingEndedSub: Subscription;
    private callAcceptedSub: Subscription;
    private callDeviceDismissedSub: Subscription;
    private callDeviceTakeoverSub: Subscription;
```

Update `ngOnDestroy` to unsubscribe them:

```ts
    ngOnDestroy(): void {
        this.pendingCallSub?.unsubscribe();
        this.stopRingtone();
        this.sub.unsubscribe();
        this.incomingEndedSub.unsubscribe();
        this.callAcceptedSub.unsubscribe();
        this.callDeviceDismissedSub.unsubscribe();
        this.callDeviceTakeoverSub.unsubscribe();
        document.removeEventListener('keydown', this.devKeyHandler);
    }
```

Finally, update `cancelOutgoing` to use `leaveCall` instead of `endCall` - canceling your own not-yet-answered outgoing call is "the only connected participant leaves", which the new contract models as `leave` (dropping to zero connected participants ends the call immediately), not an explicit `end`:

```ts
    cancelOutgoing(): void {
        this.pendingCallSub?.unsubscribe();
        this.pendingCallSub = null;
        if (this.pendingCallDto) {
            this.voiceService.leaveCall(this.pendingCallDto.id).subscribe();
            this.pendingCallDto = null;
        }
        this.stopRingtone();
        this.outgoingCall.set(null);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ng test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/services/call-state.service.ts src/app/services/call-state.service.spec.ts
git commit -m "feat: CallStateService handles multi-device ring dismissal and takeover"
```

---

### Task 7: `CallWebRtcService` - CallParticipantLeft, CallAlone, CallEnded reason toast

**Files:**
- Modify: `src/app/services/call-webrtc.service.ts`

**Interfaces:**
- Consumes: `VoiceWebsocketService.callParticipantLeftObservable/callAloneObservable` (Task 4), `CallSessionService.setAloneDeadline` / `end(silent)` (Task 5), `describeCallEndedReason` (Task 4).

This task's new logic is thin delegation to already-tested methods (`CallSessionService.onParticipantLeft`, `setAloneDeadline`, `end`, and `describeCallEndedReason`, all covered by Tasks 4-5's tests). Fully unit-testing the wiring itself would require mocking `RTCPeerConnection`, `getUserMedia`, and the entire CF-session HTTP flow that `connect()` performs before `setupWsListeners()` even runs - disproportionate for three delegate calls. This task is verified by the existing test suite (regression) plus a manual check using the repo's existing dev-shortcut fake-call path.

- [ ] **Step 1: Add the new subscriptions and update the CallEnded handler**

In `src/app/services/call-webrtc.service.ts`, add the import:

```ts
import {ConnectionState, describeCallEndedReason, VoiceWebsocketService} from './voice-websocket.service';
```

Add the `ToastService` dependency next to the other injected services:

```ts
    private toast = inject(ToastService);
```

(with `import {ToastService} from './toast.service';` added to the imports.)

In `setupWsListeners()`, add two new subscriptions to the `this.wsSubs = [...]` array, and replace the existing `callEndedObservable` subscription. Full replacement of the method body:

```ts
    private setupWsListeners(): void {
        this.wsSubs = [
            // Someone joined → add to UI and subscribe to their audio track
            this.voiceWs.participantJoinedObservable.subscribe(e => {
                console.log('[WebRTC] ParticipantJoined received in WS listener', e);
                this.callSession.onParticipantJoined(e.userId);
                void this.subscribeToTrack(e.userId, e.cfSessionId, e.audioTrackName, 'audio');
            }),

            // Someone left → remove from UI (tracks will auto-end via onended)
            this.voiceWs.participantLeftObservable.subscribe(e => {
                this.callSession.onParticipantLeft(e.userId);
                this.subscribedAudioUserIds.delete(e.userId);
                this.participantsWithAudio.update(s => {
                    const n = new Set(s);
                    n.delete(e.userId);
                    return n;
                });
            }),

            // Application-level "left the call" event -handled the same way as the
            // WebRTC-level ParticipantLeft above. Both firing for the same departure
            // is harmless since onParticipantLeft is an idempotent array filter.
            this.voiceWs.callParticipantLeftObservable.subscribe(e => {
                this.callSession.onParticipantLeft(e.userId);
                this.subscribedAudioUserIds.delete(e.userId);
                this.participantsWithAudio.update(s => {
                    const n = new Set(s);
                    n.delete(e.userId);
                    return n;
                });
            }),

            // Call dropped to exactly one connected participant -surface the
            // server's 5-minute grace-period deadline.
            this.voiceWs.callAloneObservable.subscribe(e => {
                this.callSession.setAloneDeadline(new Date(e.deadline));
            }),

            // New video / screen track published → subscribe to it
            this.voiceWs.trackPublishedObservable.subscribe(e => {
                const localId = this.callSession.session()?.participants.find(p => p.isLocal)?.userId;
                if (e.userId === localId) return; // Skip own tracks
                if (e.kind === 'video') {
                    void this.subscribeToTrack(e.userId, e.cfSessionId, e.trackName, 'video');
                } else if (e.kind === 'screen') {
                    void this.subscribeToTrack(e.userId, e.cfSessionId, e.trackName, 'screen', e.shareId);
                }
            }),

            // Remote mute/speaking/camera state changes
            this.voiceWs.muteChangedObservable.subscribe(e =>
                this.callSession.onMuteChanged(e.userId, e.isMuted)),

            this.voiceWs.speakingChangedObservable.subscribe(e =>
                this.callSession.onSpeakingChanged(e.userId, e.isSpeaking)),

            this.voiceWs.cameraChangedObservable.subscribe(e => {
                // Turn-off: update UI immediately (track.onended handles stream cleanup)
                if (!e.isCameraOn) this.callSession.onCameraChanged(e.userId, false);
                // Turn-on: handled by trackPublishedObservable → subscribeToTrack → ontrack → onCameraChanged
            }),

            // Screen share start: surface in UI immediately (stream arrives via ontrack)
            this.voiceWs.screenShareStartedObservable.subscribe(e => {
                this.callSession.onScreenShareStarted(e.shareId, e.userId, undefined);
            }),

            this.voiceWs.screenShareStoppedObservable.subscribe(e =>
                this.callSession.onScreenShareStopped(e.shareId)),

            // Call ended server-side -tear down without calling leave again (the
            // server already ended it), and tell the user why, unless we're the one
            // who just hung up (session was already nulled by our own end() call
            // before this event could arrive, so wasActive is false and it stays
            // silent, matching today's self-hangup UX).
            this.voiceWs.callEndedObservable.subscribe(e => {
                const wasActive = !!this.callSession.session();
                this.callSession.end(true);
                if (wasActive) this.toast.info(describeCallEndedReason(e.reason));
            }),
        ];
    }
```

- [ ] **Step 2: Run the full test suite to check for regressions**

Run: `npx ng test`
Expected: PASS (no existing test exercises `CallWebRtcService` directly, so this step confirms nothing else broke - e.g. that the file still compiles and Tasks 1-6's tests still pass).

- [ ] **Step 3: Confirm the rest of the call/voice suite still passes**

Run: `npx ng test`
Expected: PASS - this is the practical verification available pre-backend: the delegated
behaviors (`onParticipantLeft`, `setAloneDeadline`, `end(silent)`, `describeCallEndedReason`)
are covered by Tasks 4-5's tests, and this step confirms the new wiring didn't break any
existing call-panel/call-state/call-session test. Genuine end-to-end verification of a real
`CallEnded`/`CallAlone`/`CallParticipantLeft` event requires the backend to exist, so note in
the PR description that this specific wiring needs a manual pass once the backend ships.

- [ ] **Step 4: Commit**

```bash
git add src/app/services/call-webrtc.service.ts
git commit -m "feat: CallWebRtcService handles CallParticipantLeft, CallAlone, CallEnded reason"
```

---

### Task 8: Call panel - alone-timeout countdown UI

**Files:**
- Create: `src/app/features/messaging/components/conversation/call-panel/call-panel.utils.ts`
- Create: `src/app/features/messaging/components/conversation/call-panel/call-panel.utils.spec.ts`
- Modify: `src/app/features/messaging/components/conversation/call-panel/call-panel.component.ts`
- Modify: `src/app/features/messaging/components/conversation/call-panel/call-panel.component.html`

**Interfaces:**
- Consumes: `CallSessionService.aloneDeadline` (Task 5).
- Produces: `formatAloneCountdown(deadline: Date, now?: Date): string`.

- [ ] **Step 1: Write the failing test**

Create `src/app/features/messaging/components/conversation/call-panel/call-panel.utils.spec.ts`:

```ts
import {formatAloneCountdown} from './call-panel.utils';

describe('formatAloneCountdown', () => {
    it('formats a deadline 4 minutes and 30 seconds away as "04:30"', () => {
        const now = new Date('2026-07-29T12:00:00Z');
        const deadline = new Date('2026-07-29T12:04:30Z');
        expect(formatAloneCountdown(deadline, now)).toBe('04:30');
    });

    it('formats a deadline under a minute away as "00:09"', () => {
        const now = new Date('2026-07-29T12:00:00Z');
        const deadline = new Date('2026-07-29T12:00:09Z');
        expect(formatAloneCountdown(deadline, now)).toBe('00:09');
    });

    it('clamps to "00:00" once the deadline has passed', () => {
        const now = new Date('2026-07-29T12:05:00Z');
        const deadline = new Date('2026-07-29T12:00:00Z');
        expect(formatAloneCountdown(deadline, now)).toBe('00:00');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ng test`
Expected: FAIL - cannot find module `./call-panel.utils`.

- [ ] **Step 3: Create the pure formatting function**

Create `src/app/features/messaging/components/conversation/call-panel/call-panel.utils.ts`:

```ts
/** Formats the time remaining until `deadline` as "MM:SS", clamped to "00:00" once passed. */
export function formatAloneCountdown(deadline: Date, now: Date = new Date()): string {
    const remainingMs = deadline.getTime() - now.getTime();
    const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
    const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
    const sec = (totalSec % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ng test`
Expected: PASS

- [ ] **Step 5: Wire it into the call panel component**

In `src/app/features/messaging/components/conversation/call-panel/call-panel.component.ts`, add the import:

```ts
import {formatAloneCountdown} from './call-panel.utils';
```

Add a new protected field next to `duration`:

```ts
    protected duration = '00:00';
    protected aloneCountdown = signal<string | null>(null);
```

Update `ngOnInit` to also refresh `aloneCountdown` on the same 1-second tick:

```ts
    ngOnInit(): void {
        this.durationInterval = setInterval(() => {
            const s = this.callSession.session();
            if (!s) return;
            const elapsed = Math.floor((Date.now() - new Date(s.startedAt).getTime()) / 1000);
            const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
            const sec = (elapsed % 60).toString().padStart(2, '0');
            this.duration = `${m}:${sec}`;

            const deadline = this.callSession.aloneDeadline();
            this.aloneCountdown.set(deadline ? formatAloneCountdown(deadline) : null);
        }, 1000);
    }
```

- [ ] **Step 6: Add the banner to the template**

In `src/app/features/messaging/components/conversation/call-panel/call-panel.component.html`, add a new banner right after the existing "No-audio warning" block (after the block that ends at the line `}` following `No audio received from some participants -they may need to rejoin`):

```html
        <!-- ── Alone-timeout warning ─────────────────────────────────────────── -->
        @if (aloneCountdown(); as countdown) {
            <div class="conn-banner conn-banner--warn">
                <svg class="shrink-0" fill="currentColor" height="13" viewBox="0 0 24 24" width="13">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
                </svg>
                <span>Waiting for others to rejoin - call ends in {{ countdown }}</span>
            </div>
        }
```

- [ ] **Step 7: Run the full test suite**

Run: `npx ng test`
Expected: PASS

- [ ] **Step 8: Manual visual check of the banner**

The `formatAloneCountdown` logic itself is fully covered by Step 4's test. To confirm the banner
*renders* correctly (styling, placement, text), temporarily hardcode a deadline while developing:
in `call-panel.component.ts`'s `ngOnInit`, temporarily add
`this.callSession.setAloneDeadline(new Date(Date.now() + 5 * 60_000));` right before the
`setInterval` call, run `npm start`, open a conversation, press `Ctrl+Alt+C` to fake-join a call
(existing dev shortcut in `call-state.service.ts`), and confirm the "Waiting for others to
rejoin - call ends in 05:00" banner appears above the controls bar and counts down. Remove the
temporary line afterward - it must not be part of the commit.

- [ ] **Step 9: Commit**

```bash
git add src/app/features/messaging/components/conversation/call-panel/call-panel.utils.ts \
        src/app/features/messaging/components/conversation/call-panel/call-panel.utils.spec.ts \
        src/app/features/messaging/components/conversation/call-panel/call-panel.component.ts \
        src/app/features/messaging/components/conversation/call-panel/call-panel.component.html
git commit -m "feat: show alone-timeout countdown in the call panel"
```

---

### Task 9: `GuildWebsocketService` - `guild.voice.KickedByOtherDevice`

**Files:**
- Modify: `src/app/services/guild-websocket.service.ts`
- Modify: `src/app/services/guild-websocket.service.spec.ts` (existing file - add tests, don't replace)

**Interfaces:**
- Produces: `WsKickedByOtherDevice { channelId: string; guildId: string }`, `GuildWebsocketService.kickedByOtherDeviceObservable: Subject<WsKickedByOtherDevice>`.

- [ ] **Step 1: Write the failing test**

In `src/app/services/guild-websocket.service.spec.ts`, update the top import line:

```ts
import {GuildMessageCreatedPayload, GuildWebsocketService, mapGuildMessageCreatedPayload} from './guild-websocket.service';
```

Add these imports alongside it:

```ts
import {TestBed} from '@angular/core/testing';
import {RealtimeConnectionService} from './realtime-connection.service';
import {NotificationService} from './notification.service';
import {ProfileService} from './profile.service';
```

Append a new describe block at the end of the file:

```ts
function setupRealtimeStub() {
    const handlers = new Map<string, (...args: any[]) => void>();
    return {
        on: vi.fn((event: string, handler: (...args: any[]) => void) => handlers.set(event, handler)),
        off: vi.fn(),
        invoke: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        connectionState: () => 0,
        handlers,
    };
}

describe('GuildWebsocketService - guild.voice.KickedByOtherDevice', () => {
    it('forwards guild.voice.KickedByOtherDevice to kickedByOtherDeviceObservable', async () => {
        const realtimeStub = setupRealtimeStub();
        TestBed.configureTestingModule({
            providers: [
                {provide: RealtimeConnectionService, useValue: realtimeStub},
                {provide: NotificationService, useValue: {}},
                {provide: ProfileService, useValue: {}},
            ],
        });
        const service = TestBed.inject(GuildWebsocketService);
        await service.start();

        const received: unknown[] = [];
        service.kickedByOtherDeviceObservable.subscribe(e => received.push(e));

        realtimeStub.handlers.get('guild.voice.KickedByOtherDevice')?.({channelId: 'chan_1', guildId: 'guild_1'});

        expect(received).toEqual([{channelId: 'chan_1', guildId: 'guild_1'}]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ng test`
Expected: FAIL - `kickedByOtherDeviceObservable` doesn't exist on `GuildWebsocketService`.

- [ ] **Step 3: Add the event to `guild-websocket.service.ts`**

Add the interface right after `WsMovedToChannel`:

```ts
export interface WsMovedToChannel {
    channelId: string;
    guildId: string;
    movedBy: string;
}

/** Sent only to the device whose voice-channel session was just closed because
 *  the same user joined the same channel from another device. */
export interface WsKickedByOtherDevice {
    channelId: string;
    guildId: string;
}
```

Add the observable right after `public movedToChannelObservable = new Subject<WsMovedToChannel>();`:

```ts
    public kickedByOtherDeviceObservable = new Subject<WsKickedByOtherDevice>();
```

Add the registration right after `this.realtime.on('guild.voice.MovedToChannel', (d: WsMovedToChannel) => this.movedToChannelObservable.next(d));`:

```ts
        this.realtime.on('guild.voice.KickedByOtherDevice', (d: WsKickedByOtherDevice) => this.kickedByOtherDeviceObservable.next(d));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ng test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/services/guild-websocket.service.ts src/app/services/guild-websocket.service.spec.ts
git commit -m "feat: add guild.voice.KickedByOtherDevice event to GuildWebsocketService"
```

---

### Task 10: `VoiceChannelService` - handle device takeover kick

**Files:**
- Modify: `src/app/services/voice-channel.service.ts`
- Test: `src/app/services/voice-channel.service.spec.ts` (new file)

**Interfaces:**
- Consumes: `GuildWebsocketService.kickedByOtherDeviceObservable` (Task 9), existing `VoiceChannelService.doLeave(guildId, channelId, silent)`.
- Produces: no new public API - reacts to the new event by tearing down the joined channel and showing a toast.

- [ ] **Step 1: Write the failing tests**

Create `src/app/services/voice-channel.service.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {of, Subject} from 'rxjs';
import {VoiceChannelService} from './voice-channel.service';
import {VoiceRTCService} from './voice-rtc.service';
import {GuildVoiceService} from './guild-voice.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {ProfileService} from './profile.service';
import {SoundSettingsService} from './sound-settings.service';
import {AudioSettingsService} from './audio-settings.service';
import {ToastService} from './toast.service';

function flush(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

function setup() {
    const guildWsStub = {
        kickedByOtherDeviceObservable: new Subject<{ channelId: string; guildId: string }>(),
        userJoinedVoiceObservable: new Subject<unknown>(),
        userLeftVoiceObservable: new Subject<unknown>(),
        guildParticipantJoinedObservable: new Subject<unknown>(),
        guildTrackPublishedObservable: new Subject<unknown>(),
        guildTrackClosedObservable: new Subject<unknown>(),
        voiceMuteChangedObservable: new Subject<unknown>(),
        voiceDeafenChangedObservable: new Subject<unknown>(),
        voiceCameraChangedObservable: new Subject<unknown>(),
        voiceScreenShareStartedObservable: new Subject<unknown>(),
        voiceScreenShareStoppedObservable: new Subject<unknown>(),
        movedToChannelObservable: new Subject<unknown>(),
        invokeVoiceHeartbeat: vi.fn(),
    };

    const rtcStub = {
        rtcState: () => 'new',
        participantsWithAudio: () => new Set<string>(),
        localVideoStream: () => null,
        localScreenStream: () => null,
        localScreenHasAudio: () => false,
        localScreenAudioMuted: () => false,
        videoStreams: () => new Map(),
        screenStreams: () => new Map(),
        screenAudioMuted: () => new Map(),
        speakingChanges$: new Subject<{ userId: string; isSpeaking: boolean }>(),
        screenEnded$: new Subject<void>(),
        closeAllTracks: vi.fn().mockResolvedValue(undefined),
        teardown: vi.fn(),
    };

    const guildVoiceStub = {
        leave: vi.fn().mockReturnValue(of(undefined)),
        join: vi.fn(),
        getState: vi.fn(),
    };

    const toastStub = {info: vi.fn(), httpError: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn()};

    TestBed.configureTestingModule({
        providers: [
            {provide: VoiceRTCService, useValue: rtcStub},
            {provide: GuildVoiceService, useValue: guildVoiceStub},
            {provide: GuildWebsocketService, useValue: guildWsStub},
            {
                provide: ProfileService,
                useValue: {ownProfile: () => ({userId: 'me', userName: 'Me', avatarUrl: undefined}), getCachedByUserId: () => undefined},
            },
            {provide: SoundSettingsService, useValue: {playVoiceJoin: vi.fn(), playVoiceLeave: vi.fn()}},
            {provide: AudioSettingsService, useValue: {settings: () => ({inputMode: 'always-on'})}},
            {provide: ToastService, useValue: toastStub},
        ],
    });

    return {
        service: TestBed.inject(VoiceChannelService),
        guildWs: guildWsStub,
        guildVoice: guildVoiceStub,
        toast: toastStub,
    };
}

describe('VoiceChannelService - guild.voice.KickedByOtherDevice', () => {
    it('tears down the joined channel silently (no leave HTTP call) and shows a toast', async () => {
        const {service, guildWs, guildVoice, toast} = setup();
        service.joinedChannelId.set('chan_1');
        service.joinedGuildId.set('guild_1');
        service.joinedChannelName.set('General');
        service.joinedGuildName.set('My Guild');

        guildWs.kickedByOtherDeviceObservable.next({channelId: 'chan_1', guildId: 'guild_1'});
        await flush();

        expect(guildVoice.leave).not.toHaveBeenCalled();
        expect(toast.info).toHaveBeenCalledWith('You joined this channel from another device');
        expect(service.joinedChannelId()).toBeNull();
        expect(service.joinedGuildId()).toBeNull();
    });

    it('ignores the event when it targets a channel other than the one currently joined', async () => {
        const {service, guildWs, toast} = setup();
        service.joinedChannelId.set('chan_1');
        service.joinedGuildId.set('guild_1');

        guildWs.kickedByOtherDeviceObservable.next({channelId: 'chan_2', guildId: 'guild_1'});
        await flush();

        expect(toast.info).not.toHaveBeenCalled();
        expect(service.joinedChannelId()).toBe('chan_1');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ng test`
Expected: FAIL - `VoiceChannelService` doesn't subscribe to `kickedByOtherDeviceObservable` yet.

- [ ] **Step 3: Implement the handler**

In `src/app/services/voice-channel.service.ts`, add the import:

```ts
import {ToastService} from './toast.service';
```

Add the injected dependency next to `audioSettings`:

```ts
    private audioSettings = inject(AudioSettingsService);
    private toast = inject(ToastService);
```

Add the subscription in the constructor, alongside the other `guildWsSvc` subscriptions:

```ts
        this.guildWsSvc.movedToChannelObservable.subscribe(e => void this.onMovedToChannel(e));
        this.guildWsSvc.kickedByOtherDeviceObservable.subscribe(e => void this.onKickedByOtherDevice(e));
```

Add the handler method next to `onMovedToChannel`:

```ts
    private async onKickedByOtherDevice(e: { channelId: string; guildId: string }): Promise<void> {
        if (e.channelId !== this.joinedChannelId()) return;
        const guildId = this.joinedGuildId();
        if (!guildId) return;
        await this.doLeave(guildId, e.channelId, true); // silent: server already removed us
        this.joinedChannelId.set(null);
        this.joinedGuildId.set(null);
        this.joinedChannelName.set(null);
        this.joinedGuildName.set(null);
        this.localState.set({isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: false});
        this.toast.info('You joined this channel from another device');
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ng test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/services/voice-channel.service.ts src/app/services/voice-channel.service.spec.ts
git commit -m "feat: VoiceChannelService tears down on guild.voice.KickedByOtherDevice"
```

---

## Final check

After Task 10, run the full suite once more (`npx ng test`) and confirm every new spec file passes together (not just in isolation) - the interceptor and hub-connection tests reset module-level state in `beforeEach`, but it's worth a final full-suite pass to be sure nothing was missed.
