import {Component, computed, effect, inject, input, signal, untracked} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {firstValueFrom, merge} from 'rxjs';
import {Button} from 'primeng/button';

import {
    describeRequestFailure,
    JoinRequestVerificationError,
    MlsJoinRequestDto,
    MlsJoinRequestService,
} from '../../services/mls-join-request.service';
import {MessagingWebsocketService} from '../../services/messaging-websocket.service';
import {GuildWebsocketService} from '../../services/guild-websocket.service';
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

/** The review surface for MLS admission requests, inside the context they are about. */
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

                <!-- A key package mismatch is what tampering looks like, so it must never collapse into a generic error toast. -->
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

        <!-- Kept outside the panel above: a read that failed is not an empty queue. -->
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
    /** Display names for the people in the context, keyed by user id. */
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
    private readonly guildWs = inject(GuildWebsocketService);

    private readonly requests = signal<MlsJoinRequestDto[]>([]);
    private readonly ownDeviceId = signal<string | null>(null);
    /** Device names harvested from pushes, keyed by request id. */
    private readonly pushedDeviceNames = signal<Record<string, string>>({});

    protected readonly rows = computed<JoinRequestRow[]>(() => {
        const ownUserId = this.profiles.ownProfile()?.userId ?? null;
        const ownDeviceId = this.ownDeviceId();
        const names = this.participantNames();
        const deviceNames = this.pushedDeviceNames();

        return this.requests()
            .filter(request => request.state === 'Pending')
            // The device asking is not a reviewer of its own request; the server refuses that outright.
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
                        // The other device shows its own fingerprint on the banner that told it to ask.
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
                // Must reset on a context switch, or one conversation's tampering warning stands over the next.
                this.requests.set([]);
                this.pushedDeviceNames.set({});
                this.verificationError.set(null);
                this.actionError.set(null);
                void this.refresh(contextId);
            });
        });

        // Both sockets: channel requests arrive on the guild one, conversation requests on the messaging one.
        merge(this.messagingWs.mlsJoinRequestObservable, this.guildWs.mlsJoinRequestObservable)
            .pipe(takeUntilDestroyed())
            .subscribe(event => {
                if (event.contextId !== this.contextId()) return;
                // Guarded on the id: the channel push carries none, and keying under '' captions an unrelated request.
                if (event.requestId && event.requesterDeviceName) {
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
            // The queue is the authority on what is still open, whatever happened above.
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

    /** Re-reads the queue, unless this device holds no group and so could not approve anything. */
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
