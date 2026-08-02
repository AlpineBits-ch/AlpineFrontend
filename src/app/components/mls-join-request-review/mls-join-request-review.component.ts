import {Component, computed, effect, inject, input, signal, untracked} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {firstValueFrom} from 'rxjs';
import {Button} from 'primeng/button';

import {
    describeRequestFailure,
    JoinRequestVerificationError,
    MlsJoinRequestDto,
    MlsJoinRequestService,
} from '../../services/mls-join-request.service';
import {MessagingWebsocketService} from '../../services/messaging-websocket.service';
import {MlsService} from '../../services/mls.service';
import {DeviceIdentityService} from '../../services/device-identity.service';
import {ProfileService} from '../../services/profile.service';

/** One pending request, with everything the wording depends on already decided. */
interface JoinRequestRow {
    request: MlsJoinRequestDto;
    /** Another device of the signed-in account, rather than the person on the other side. */
    isOwnAccount: boolean;
    /** Headline: who is asking. */
    who: string;
    /** What the human is actually being asked to check before they tap anything. */
    question: string;
    /** The requester's self-chosen device name, when a push happened to carry one. */
    deviceName: string | null;
    alreadyApproved: boolean;
    /** Approvals still outstanding after this member's, for a context that needs more than one. */
    remainingApprovals: number;
}

/**
 * The review surface for MLS admission requests, inside the context they are about.
 *
 * <p><b>Why this exists.</b> A device that is not in a conversation's MLS group cannot read it,
 * and the only repair is a member minting an Add commit for it - the server holds no group keys
 * and cannot admit anyone. Alpine could *ask* (`MlsJoinRequestService.relink`, plus the launch
 * sweep) and could *approve* (`MlsJoinRequestService.approve`), but the approve half had exactly
 * one caller, in guild channel settings. For a DM there was no surface at all: a request was
 * submitted correctly, the server pushed it to every member, and it then sat Pending until it
 * expired because nothing anywhere asked a human about it. The mechanism worked end to end and
 * nobody was ever shown the question.</p>
 *
 * <p><b>The fingerprint is the review.</b> `signatureKeyFingerprint` is the requester's long-lived
 * identity key, stable across every key package they will ever mint, and it is the value a person
 * can read out over a phone call. `keyPackageHash` is deliberately not shown: it changes on every
 * request, so a human comparing it would be comparing noise, and treating it as the out-of-band
 * value would teach people that a mismatch is normal.</p>
 *
 * <p><b>Two different trust questions.</b> Another device of your own account is asking "is that
 * really my new laptop", answerable by looking at the other device. Your correspondent's device is
 * asking "is that really their device", answerable only by contacting them some other way - and
 * never by asking the server, which is the party the comparison exists to defend against (§L.3).
 * The wording has to say which one is being asked, because the same button means two things.</p>
 */
@Component({
    selector: 'app-mls-join-request-review',
    standalone: true,
    imports: [Button],
    template: `
        @if (rows().length > 0) {
            <div class="mx-4 mb-3 rounded-xl border border-sky-400/30 bg-sky-400/[0.08] px-4 py-3"
                 data-testid="join-request-review">
                <div class="flex items-start gap-2.5">
                    <i class="pi pi-user-plus text-sky-300 text-[0.875rem] shrink-0 mt-0.5"></i>
                    <p class="m-0 text-[0.8125rem] font-medium text-text-primary">
                        {{ heading() }}
                    </p>
                </div>

                <!--
                  Loud, and separate from every other failure. A mismatch between the key package
                  that comes back and the one that was reviewed is what tampering looks like from
                  here, so it must never be collapsed into a generic error toast.
                -->
                @if (verificationError(); as message) {
                    <div class="mt-2.5 flex items-start gap-2 rounded-lg border border-red-500/40
                                bg-red-500/10 px-3 py-2" data-testid="verification-error">
                        <i class="pi pi-exclamation-triangle text-red-300 text-[0.875rem] shrink-0 mt-0.5"></i>
                        <div class="min-w-0">
                            <p class="m-0 text-[0.8125rem] text-red-200">Nothing was added. {{ message }}</p>
                            <p class="m-0 mt-0.5 text-xs text-red-300/80">
                                This can mean someone is tampering with the admission rather than
                                that something broke. Do not approve again until you have confirmed
                                the fingerprint with its owner directly.
                            </p>
                        </div>
                    </div>
                }

                @for (row of rows(); track row.request.id) {
                    <div class="mt-2.5 border-t border-white/[0.06] pt-2.5">
                        <p class="m-0 text-[0.8125rem] text-text-primary">{{ row.who }}</p>

                        @if (row.deviceName) {
                            <p class="m-0 mt-0.5 text-xs text-text-muted">
                                It calls itself "{{ row.deviceName }}". That name is chosen by the
                                device and proves nothing on its own.
                            </p>
                        }

                        <p class="m-0 mt-0.5 text-xs text-text-muted">{{ row.question }}</p>

                        <p class="m-0 mt-1.5 font-mono text-sm tracking-wider text-text-primary"
                           data-testid="fingerprint">{{ row.request.signatureKeyFingerprint }}</p>

                        @if (row.alreadyApproved) {
                            <p class="m-0 mt-1.5 text-xs text-emerald-300">
                                You have approved this. It still needs
                                {{ row.remainingApprovals }} more.
                            </p>
                        } @else {
                            <div class="mt-2 flex gap-1">
                                <p-button (onClick)="approve(row)" [disabled]="!!actingOn()"
                                          [loading]="actingOn() === row.request.id" [text]="true"
                                          label="Approve" severity="success" size="small"/>
                                <p-button (onClick)="deny(row)" [disabled]="!!actingOn()"
                                          [text]="true" label="Deny" severity="danger" size="small"/>
                            </div>
                        }
                    </div>
                }

                @if (actionError(); as message) {
                    <p class="m-0 mt-2 text-xs text-red-300" data-testid="action-error">{{ message }}</p>
                }
            </div>
        }

        <!--
          Kept outside the panel above, which renders nothing while the queue is unknown. A read
          that failed is not an empty queue, and silently showing no requests is the exact failure
          this whole surface exists to end.
        -->
        @if (loadError()) {
            <p class="mx-4 mb-3 text-xs text-amber-300" data-testid="load-error">
                Could not check whether any device is waiting to be let into this conversation.
            </p>
        }
    `,
})
export class MlsJoinRequestReviewComponent {
    readonly contextId = input.required<string>();
    readonly isChannel = input(false);
    /**
     * Display names for the people in the context, keyed by user id.
     *
     * <p>Passed in rather than resolved here: the host already holds the roster, and a review
     * prompt that has to fetch a profile before it can word itself would appear late, which for a
     * prompt whose whole job is to be noticed is the same as not appearing.</p>
     */
    readonly participantNames = input<Record<string, string>>({});

    protected readonly actingOn = signal<string | null>(null);
    /** Set only by {@link JoinRequestVerificationError}; everything else goes to `actionError`. */
    protected readonly verificationError = signal<string | null>(null);
    protected readonly actionError = signal<string | null>(null);
    protected readonly loadError = signal(false);

    private readonly joinRequests = inject(MlsJoinRequestService);
    private readonly mls = inject(MlsService);
    private readonly deviceIdentity = inject(DeviceIdentityService);
    private readonly profiles = inject(ProfileService);
    private readonly messagingWs = inject(MessagingWebsocketService);

    private readonly requests = signal<MlsJoinRequestDto[]>([]);
    private readonly ownDeviceId = signal<string | null>(null);
    /** Device names harvested from pushes, keyed by request id - see the event's own comment. */
    private readonly pushedDeviceNames = signal<Record<string, string>>({});

    protected readonly rows = computed<JoinRequestRow[]>(() => {
        const ownUserId = this.profiles.ownProfile()?.userId ?? null;
        const ownDeviceId = this.ownDeviceId();
        const names = this.participantNames();
        const deviceNames = this.pushedDeviceNames();

        return this.requests()
            .filter(request => request.state === 'Pending')
            // The device asking is not a reviewer of its own request. The server refuses that
            // outright, so offering the button would be offering an action that must fail - and
            // on the machine that is locked out, which is the one most likely to press it.
            .filter(request => request.requesterDeviceId !== ownDeviceId)
            .map(request => {
                const isOwnAccount = !!ownUserId && request.requesterUserId === ownUserId;
                const peerName = names[request.requesterUserId] ?? 'Someone in this conversation';

                return {
                    request,
                    isOwnAccount,
                    who: isOwnAccount
                        ? 'Another of your own devices is asking to be let in.'
                        : `${peerName} added a device, and it is asking to be let in.`,
                    question: isOwnAccount
                        // Answerable without leaving the account: the other device shows its own
                        // fingerprint on the banner that told it to ask.
                        ? 'Open the device that is asking and compare the fingerprint it shows '
                        + 'against this one. If you are not looking at that device right now, deny '
                        + 'this - a device you cannot see is a device you cannot vouch for.'
                        : `Check with ${peerName} some other way - a call, in person - that their `
                        + 'new device shows this same fingerprint. Do not ask here, and do not '
                        + 'take the server\'s word for it: relaying this request is all it can do.',
                    deviceName: deviceNames[request.id] ?? null,
                    alreadyApproved: !!ownUserId && request.approverUserIds.includes(ownUserId),
                    remainingApprovals: Math.max(
                        0, request.requiredApprovals - request.approverUserIds.length),
                } satisfies JoinRequestRow;
            });
    });

    protected readonly heading = computed(() =>
        this.rows().length === 1
            ? 'A device is waiting to be let into this conversation'
            : `${this.rows().length} devices are waiting to be let into this conversation`);

    constructor() {
        effect(() => {
            const contextId = this.contextId();
            untracked(() => {
                // Everything below belongs to the conversation it came from, and this host is
                // reused as the user moves between conversations. A tampering warning raised in
                // one - the most alarming thing this panel can say - would otherwise be left
                // standing over the next conversation opened, against a request that never failed.
                this.requests.set([]);
                this.pushedDeviceNames.set({});
                this.verificationError.set(null);
                this.actionError.set(null);
                void this.refresh(contextId);
            });
        });

        // The server pushes on submit, so a request filed while this conversation is open has to
        // appear without a reload. The push is only a prompt - it carries no key package by design
        // - so the answer still comes from re-reading the queue.
        this.messagingWs.mlsJoinRequestObservable
            .pipe(takeUntilDestroyed())
            .subscribe(event => {
                if (event.contextId !== this.contextId()) return;
                if (event.requesterDeviceName) {
                    this.pushedDeviceNames.update(current => ({
                        ...current,
                        [event.requestId]: event.requesterDeviceName!,
                    }));
                }
                void this.refresh(this.contextId());
            });
    }

    protected async approve(row: JoinRequestRow): Promise<void> {
        if (this.actingOn()) return;
        this.actingOn.set(row.request.id);
        this.verificationError.set(null);
        this.actionError.set(null);

        try {
            await this.joinRequests.approve(this.contextId(), this.isChannel(), row.request);
        } catch (err) {
            if (err instanceof JoinRequestVerificationError) {
                this.verificationError.set(err.message);
            } else {
                this.actionError.set(describeRequestFailure(err));
            }
        } finally {
            this.actingOn.set(null);
            // Whatever happened, the queue is the authority on what is still open. A failed
            // verification leaves the request there, which is correct - it was not admitted.
            await this.refresh(this.contextId());
        }
    }

    protected async deny(row: JoinRequestRow): Promise<void> {
        if (this.actingOn()) return;
        this.actingOn.set(row.request.id);
        this.actionError.set(null);

        try {
            await firstValueFrom(
                this.joinRequests.deny(this.contextId(), this.isChannel(), row.request.id));
        } catch (err) {
            this.actionError.set(describeRequestFailure(err));
        } finally {
            this.actingOn.set(null);
            await this.refresh(this.contextId());
        }
    }

    /**
     * Re-reads the queue, unless this device is in no position to act on it.
     *
     * <p><b>The group check is a precondition, not a nicety.</b> Admission is an Add commit, and
     * only a device that holds the group can produce one. A device that is itself locked out -
     * which, for a conversation whose join requests are piling up, is a very likely thing to be
     * looking at this - would be shown an Approve button whose every press ends in "MLS session is
     * locked" or "no group found". Nothing is rendered in that state, and the unreadable banner
     * beside it already says why this device cannot read the conversation.</p>
     */
    private async refresh(contextId: string): Promise<void> {
        if (!contextId) return;

        try {
            const [deviceId, groupId] = await Promise.all([
                this.deviceIdentity.deviceId().catch(() => null),
                this.mls.getActiveGroupId(contextId),
            ]);

            this.ownDeviceId.set(deviceId);

            if (!groupId) {
                this.requests.set([]);
                this.loadError.set(false);
                return;
            }

            this.requests.set(
                await firstValueFrom(this.joinRequests.list(contextId, this.isChannel())));
            this.loadError.set(false);
        } catch {
            this.requests.set([]);
            this.loadError.set(true);
        }
    }
}
