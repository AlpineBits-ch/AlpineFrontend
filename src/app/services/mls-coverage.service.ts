import {inject, Injectable, signal} from '@angular/core';
import {firstValueFrom} from 'rxjs';
import {MlsService} from './mls.service';
import {MlsTransportService} from './mls-transport.service';
import {MlsSyncService} from './mls-sync.service';
import {MlsJoinRequestService, describeRequestFailure} from './mls-join-request.service';
import {DeviceIdentityService} from './device-identity.service';
import {MlsCoverageDto, OwnDeviceCoverageDto, UnreachableDeviceDto} from '../dtos/mls.dto';

/**
 * Everything the client is allowed to say about who can read a context.
 *
 * <p>Deliberately not the wire shape. The server's answer is evidence about devices; this is the
 * conclusion after the local cross-check, with the current device separated out because it is the
 * only one that has an action available.</p>
 */
export interface MlsCoverageView {
    contextId: string;
    isChannel: boolean;
    /** False when the context has no live group. Nothing at all is rendered in that case. */
    encrypted: boolean;
    generation: number | null;
    /**
     * The device this client is running on cannot read the context.
     *
     * <p>True only when the server reported it uncovered <b>and</b> this device holds no group for
     * the context. Both halves are required: a device that joined by external commit leaves none of
     * the three traces the server counts and reads as uncovered while decrypting perfectly.</p>
     */
    thisDeviceExcluded: boolean;
    /** Other devices on this account that cannot read it. Reference material, never a badge. */
    otherOwnDevices: OwnDeviceCoverageDto[];
    /** Other participants' devices that cannot read it. */
    peerDevices: UnreachableDeviceDto[];
    /**
     * The device list could not be read. The lists above are then whatever was last known, which
     * may be nothing - and "nothing known" must never be presented as "nobody is stranded".
     */
    unavailable: boolean;
}

/** How far the one repair on offer has got. */
export type MlsAccessRequestState =
    | {state: 'idle'}
    | {state: 'submitting'}
    /** Submitted, or already open from an earlier attempt. Days may pass; this is a status, not
     * a progress indicator. */
    | {state: 'waiting'}
    | {state: 'failed'; message: string};

/**
 * Asks, long after the fact, which devices were left out of a context's encryption.
 *
 * <p>A device gets into an MLS group exactly one way: some member's client seals it a Welcome. A
 * device with no key package available at that moment is simply left out, and nothing ever adds it
 * afterwards. The server reports that at three moments - creating a conversation, enabling
 * encryption, and the commit that admits somebody - each of which is one response handed to one
 * client. The information exists for a few seconds, in one place, and then it is gone.</p>
 *
 * <p><b>It reports, it does not repair.</b> The server holds no group keys and cannot add a device
 * to a group. The repair is {@link requestAccess}, which asks a member to.</p>
 *
 * <p>Not polled. The answer only changes when the group does, so it is fetched on the triggers that
 * mean the group moved and cached against the generation this device knows for the context.</p>
 */
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

    /**
     * Freshness bookkeeping, separate from {@link _views} on purpose.
     *
     * <p>An answer that could not be read is still worth displaying on the screen that asked for
     * it, but it must not count as having been asked - otherwise one sibling-service outage would
     * silence the question for the rest of the session. So it lands in `_views` and never here.</p>
     */
    private readonly asked = new Map<string, {localGeneration: number | null}>();

    /** In flight per context, so two triggers landing together do not both fetch. */
    private readonly inFlight = new Map<string, Promise<void>>();

    constructor() {
        // A commit that added or removed anyone changes the answer, and it is the one §4 trigger
        // that does not necessarily move this device's generation - so `ensure` cannot notice it by
        // itself. Nothing is fetched here; the next natural trigger does that.
        this.sync.contextChanged.subscribe(({contextId}) => this.invalidate(contextId));
    }

    /** Reactive: read from a `computed` in whatever renders it. */
    coverageOf(contextId: string): MlsCoverageView | null {
        return this._views()[contextId] ?? null;
    }

    requestStateOf(contextId: string): MlsAccessRequestState {
        return this._requests()[contextId] ?? {state: 'idle'};
    }

    /**
     * Whether there is anything at all to say about devices other than this one.
     *
     * <p>Shared with the layouts that give the report a slot, so a section header and padding are
     * never drawn around nothing. Note `unavailable` counts: on the screen the user came to in
     * order to ask, "could not check" is something to say.</p>
     */
    hasDeviceReport(contextId: string): boolean {
        const view = this.coverageOf(contextId);
        if (!view) return false;
        return view.otherOwnDevices.length > 0 || view.peerDevices.length > 0 || view.unavailable;
    }

    /**
     * Fetches unless this device's view of the context's group is the one already answered for.
     *
     * <p>The trigger for opening a conversation or channel. Comparing against
     * {@link MlsService.getKnownGeneration} rather than counting fetches is what makes a Welcome
     * landing, or encryption being cycled, invalidate the answer by itself - the group moved, so
     * the previous answer is about a group that no longer decides anything.</p>
     */
    async ensure(contextId: string, isChannel: boolean): Promise<void> {
        const asked = this.asked.get(contextId);
        if (asked && asked.localGeneration === await this.mls.getKnownGeneration(contextId)) return;

        await this.refresh(contextId, isChannel);
    }

    /**
     * Asks again regardless of what is cached.
     *
     * For the encryption screen, where the user has explicitly come to look, and for the retry
     * offered after an unavailable answer.
     */
    async refresh(contextId: string, isChannel: boolean): Promise<void> {
        const running = this.inFlight.get(contextId);
        if (running) return running;

        const task = this.load(contextId, isChannel).finally(() => this.inFlight.delete(contextId));
        this.inFlight.set(contextId, task);
        return task;
    }

    /**
     * Drops the cached answer so the next natural trigger asks again.
     *
     * Called when this client applies a Welcome or publishes a commit for the context, and when a
     * join request of ours is approved or denied - the four moments the group is known to have
     * moved without a new answer having been fetched for it.
     */
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

    /**
     * Asks a member of the context to let this device in.
     *
     * <p>Reuses {@link MlsJoinRequestService} rather than posting a second time: the dedupe against
     * a request this device already has open matters, because the launch-time admission sweep may
     * well have asked for this very context minutes ago, and a second request for the same device
     * is one more thing for a human to review to no effect.</p>
     *
     * <p>The waiting state it leaves behind is deliberately terminal. Approval can take days, and a
     * spinner that runs for days is a lie about what is happening.</p>
     */
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
            // Same treatment as the server's own `coverageUnavailable`: it could not be read, which
            // is not the same answer as nobody being stranded.
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

    /**
     * Turns the server's evidence into the only claims this client can stand behind.
     *
     * The one that needs the cross-check is the current device: `covered: false` for it is a reason
     * to ask whether this device can read the context, and the device can answer that itself.
     */
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

        // `=== false` rather than `!covered`: a device missing from the list entirely is a server
        // that declined to report on this account - which is what happens when `X-Device-Id` was
        // not sent on enable - and absence of a verdict is not a verdict.
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

    /**
     * Whether this device holds keys for the group the server's answer is about.
     *
     * <p><b>Scoped to that generation, not to "has this device ever held a group here".</b> A device
     * that was in generation 1 and left out of generation 2 genuinely cannot read what is being sent
     * now, and it is still holding generation 1's keys - so an ever-held test waves through exactly
     * the case this feature exists to catch. The active-group fallback is only for an answer that
     * names no generation at all, where refusing to claim exclusion is the safer default.</p>
     */
    private async holdsGroupFor(contextId: string, generation: number | null): Promise<boolean> {
        if (generation === null) return (await this.mls.getActiveGroupId(contextId)) !== null;
        return (await this.mls.getGroupId(contextId, generation)) !== null;
    }

    /**
     * Records that the question could not be answered, without answering it.
     *
     * <p>Whatever was last known is kept exactly as it was and only flagged. Replacing a warning
     * with the empty lists that come back on this path would clear a true statement on the strength
     * of a sibling service being down, which is the original silence with extra steps.</p>
     */
    private markUnavailable(contextId: string, isChannel: boolean): void {
        const previous = this.coverageOf(contextId);
        this.setView(contextId, previous
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
            });
    }
}
