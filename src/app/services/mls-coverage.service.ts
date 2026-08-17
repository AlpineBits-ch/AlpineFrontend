import {inject, Injectable, signal} from '@angular/core';
import {firstValueFrom} from 'rxjs';
import {MlsService} from './mls.service';
import {MlsTransportService} from './mls-transport.service';
import {MlsSyncService} from './mls-sync.service';
import {MlsJoinRequestService, describeRequestFailure} from './mls-join-request.service';
import {DeviceIdentityService} from './device-identity.service';
import {MlsCoverageDto, OwnDeviceCoverageDto, UnreachableDeviceDto} from '../dtos/mls.dto';

/** Everything the client is allowed to say about who can read a context: the conclusion after the local cross-check, not the wire shape. */
export interface MlsCoverageView {
    contextId: string;
    isChannel: boolean;
    /** False when the context has no live group. Nothing at all is rendered in that case. */
    encrypted: boolean;
    generation: number | null;
    /** True only when the server reported this device uncovered AND it holds no group: an external-commit joiner reads as uncovered while decrypting perfectly. */
    thisDeviceExcluded: boolean;
    /** Other devices on this account that cannot read it. Reference material, never a badge. */
    otherOwnDevices: OwnDeviceCoverageDto[];
    /** Other participants' devices that cannot read it. */
    peerDevices: UnreachableDeviceDto[];
    /** The device list could not be read; the lists above are then whatever was last known, and "nothing known" must never render as "nobody is stranded". */
    unavailable: boolean;
}

/** How far the one repair on offer has got. */
export type MlsAccessRequestState =
    | {state: 'idle'}
    | {state: 'submitting'}
    /** Submitted, or already open from an earlier attempt. A status, not a progress indicator. */
    | {state: 'waiting'}
    | {state: 'failed'; message: string};

/** Asks which devices were left out of a context's encryption. It reports and never repairs: the repair is {@link requestAccess}. Not polled; cached against the generation this device knows. */
@Injectable({providedIn: 'root'})
export class MlsCoverageService {
    private readonly transport = inject(MlsTransportService);
    private readonly mls = inject(MlsService);
    private readonly sync = inject(MlsSyncService);
    private readonly joinRequests = inject(MlsJoinRequestService);
    private readonly deviceIdentity = inject(DeviceIdentityService);

    /** What to render, per context. Survives the components that read it. */
    private readonly _views = signal<Record<string, MlsCoverageView>>({});

    private readonly _requests = signal<Record<string, MlsAccessRequestState>>({});

    /** Freshness bookkeeping: an answer that could not be read lands in {@link _views} and never here, or one outage silences the question for the session. */
    private readonly asked = new Map<string, {localGeneration: number | null}>();

    /** In flight per context, so two triggers landing together do not both fetch. */
    private readonly inFlight = new Map<string, Promise<void>>();

    constructor() {
        // A commit changes the answer without necessarily moving this device's generation, so `ensure`
        // cannot notice it alone. Nothing is fetched here; the next natural trigger does that.
        this.sync.contextChanged.subscribe(({contextId}) => this.invalidate(contextId));
    }

    /** Reactive: read from a `computed` in whatever renders it. */
    coverageOf(contextId: string): MlsCoverageView | null {
        return this._views()[contextId] ?? null;
    }

    requestStateOf(contextId: string): MlsAccessRequestState {
        return this._requests()[contextId] ?? {state: 'idle'};
    }

    /** Whether there is anything to say about devices other than this one. `unavailable` counts: "could not check" is something to say. */
    hasDeviceReport(contextId: string): boolean {
        const view = this.coverageOf(contextId);
        if (!view) return false;
        return view.otherOwnDevices.length > 0 || view.peerDevices.length > 0 || view.unavailable;
    }

    /** Fetches unless this device's view of the group is the one already answered for: compared against {@link MlsService.getKnownGeneration}, never a fetch count. */
    async ensure(contextId: string, isChannel: boolean): Promise<void> {
        const asked = this.asked.get(contextId);
        if (asked && asked.localGeneration === (await this.mls.getKnownGeneration(contextId))) return;

        await this.refresh(contextId, isChannel);
    }

    /** Asks again regardless of what is cached. */
    async refresh(contextId: string, isChannel: boolean): Promise<void> {
        const running = this.inFlight.get(contextId);
        if (running) return running;

        const task = this.load(contextId, isChannel).finally(() => this.inFlight.delete(contextId));
        this.inFlight.set(contextId, task);
        return task;
    }

    /** Drops the cached answer so the next natural trigger asks again. */
    invalidate(contextId: string): void {
        this.asked.delete(contextId);
    }

    /** Everything this service knows, dropped. For sign-out and account switches. */
    clear(): void {
        this.asked.clear();
        this.inFlight.clear();
        this._views.set({});
        this._requests.set({});
    }

    /** Asks a member to let this device in, through {@link MlsJoinRequestService} so an already-open request is not duplicated. The waiting state is terminal. */
    async requestAccess(contextId: string, isChannel: boolean): Promise<void> {
        if (this.requestStateOf(contextId).state === 'submitting') return;
        this.setRequestState(contextId, {state: 'submitting'});

        try {
            const existing = await this.joinRequests.myPendingRequest(contextId, isChannel);
            if (!existing || existing.state !== 'Pending') {
                await this.joinRequests.requestAccess(contextId, isChannel);
            }
            this.setRequestState(contextId, {state: 'waiting'});
        } catch (err) {
            this.setRequestState(contextId, {state: 'failed', message: describeRequestFailure(err)});
        }
    }

    private setRequestState(contextId: string, state: MlsAccessRequestState): void {
        this._requests.update(current => ({...current, [contextId]: state}));
    }

    private setView(contextId: string, view: MlsCoverageView): void {
        this._views.update(current => ({...current, [contextId]: view}));
    }

    private async load(contextId: string, isChannel: boolean): Promise<void> {
        let dto: MlsCoverageDto;
        try {
            dto = await firstValueFrom(this.transport.getCoverage(contextId, isChannel));
        } catch (err) {
            // "Could not be read" is not the same answer as "nobody is stranded".
            console.warn('Could not read device coverage', contextId, err);
            this.markUnavailable(contextId, isChannel);
            return;
        }

        if (dto.coverageUnavailable) {
            this.markUnavailable(contextId, isChannel);
            return;
        }

        this.setView(contextId, await this.interpret(contextId, isChannel, dto));
        this.asked.set(contextId, {
            localGeneration: await this.mls.getKnownGeneration(contextId),
        });
    }

    /** Turns the server's evidence into the only claims this client can stand behind. */
    private async interpret(
        contextId: string,
        isChannel: boolean,
        dto: MlsCoverageDto,
    ): Promise<MlsCoverageView> {
        const empty: MlsCoverageView = {
            contextId,
            isChannel,
            encrypted: false,
            generation: null,
            thisDeviceExcluded: false,
            otherOwnDevices: [],
            peerDevices: [],
            unavailable: false,
        };

        // Nothing to be outside of. Not "everybody is outside".
        if (!dto.encrypted) return empty;

        const deviceId = await this.deviceIdentity.deviceId();
        const own = dto.ownDevices ?? [];

        // `=== false`, not `!covered`: a device missing from the list is a server that declined to
        // report, and absence of a verdict is not a verdict.
        const serverSaysUncovered = own.find(d => d.deviceId === deviceId)?.covered === false;
        const holdsGroup = await this.holdsGroupFor(contextId, dto.generation ?? null);

        return {
            ...empty,
            encrypted: true,
            generation: dto.generation ?? null,
            thisDeviceExcluded: serverSaysUncovered && !holdsGroup,
            otherOwnDevices: own.filter(d => !d.covered && d.deviceId !== deviceId),
            peerDevices: dto.unreachableDevices ?? [],
        };
    }

    /** Whether this device holds keys for the group the answer is about, scoped to THAT generation: an "ever held a group here" test waves through the exact case this catches. */
    private async holdsGroupFor(contextId: string, generation: number | null): Promise<boolean> {
        if (generation === null) return (await this.mls.getActiveGroupId(contextId)) !== null;
        return (await this.mls.getGroupId(contextId, generation)) !== null;
    }

    /** Records that the question could not be answered, without answering it: whatever was last known is kept and only flagged. */
    private markUnavailable(contextId: string, isChannel: boolean): void {
        const previous = this.coverageOf(contextId);
        this.setView(
            contextId,
            previous
                ? {...previous, unavailable: true}
                : {
                      contextId,
                      isChannel,
                      encrypted: false,
                      generation: null,
                      thisDeviceExcluded: false,
                      otherOwnDevices: [],
                      peerDevices: [],
                      unavailable: true,
                  },
        );
    }
}
