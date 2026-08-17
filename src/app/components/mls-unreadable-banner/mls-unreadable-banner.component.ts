import {Component, computed, effect, inject, input, output} from '@angular/core';
import {Button} from 'primeng/button';
import {TranslateModule} from '@ngx-translate/core';
import {MlsFailureReason, MlsHealthService} from '../../services/mls-health.service';
import {MlsRelinkStatus} from '../../services/mls-join-request.service';
import {MlsCoverageService} from '../../services/mls-coverage.service';

/** Says, in the conversation it applies to, that this device cannot read it, and offers the fix. */
@Component({
    selector: 'app-mls-unreadable-banner',
    standalone: true,
    imports: [Button, TranslateModule],
    template: `
        @switch (mode()) {
            @case ('observed') {
                <div
                    class="mx-4 mb-3 flex items-start gap-2.5 rounded-xl border border-amber-500/30
                            bg-amber-500/[0.08] px-4 py-3"
                >
                    <i class="pi pi-lock-open text-amber-300 text-[0.875rem] shrink-0 mt-0.5"></i>
                    <div class="min-w-0 flex-1">
                        <p class="m-0 text-[0.8125rem] text-text-primary">{{ title() }}</p>
                        <p class="m-0 mt-0.5 text-xs text-text-muted">{{ detail() }}</p>
                        <!-- The outcome of the last re-link, in the same block that offered it. -->
                        @if (status(); as s) {
                            <p
                                class="m-0 mt-1.5 text-xs"
                                [class.text-red-300]="s.tone === 'failed'"
                                [class.text-amber-200]="s.tone === 'pending'"
                                [class.text-emerald-300]="s.tone === 'ok'"
                                [class.text-text-muted]="s.tone === 'working'"
                                data-testid="relink-status"
                            >
                                {{ s.message }}
                            </p>
                        }
                    </div>
                    <p-button
                        (onClick)="relink.emit(contextId())"
                        [disabled]="status()?.tone === 'working'"
                        [text]="true"
                        label="Re-link device"
                        severity="warn"
                        size="small"
                    />
                </div>
            }
            @case ('coverage') {
                <div
                    class="mx-4 mb-3 flex flex-col gap-3 rounded-xl border border-border-default
                            bg-card/60 p-4"
                    data-testid="coverage-notice"
                >
                    <div class="flex items-start gap-3">
                        <i class="pi pi-lock text-connecting mt-0.5"></i>
                        <div class="min-w-0">
                            @if (waiting()) {
                                <p class="m-0 text-sm font-medium text-text-primary">
                                    {{ 'DEVICE_ACCESS.WAITING_TITLE' | translate }}
                                </p>
                                <p class="m-0 mt-1 text-xs text-text-muted">
                                    {{ waitingBodyKey() | translate }}
                                </p>
                            } @else {
                                <p class="m-0 text-sm font-medium text-text-primary">
                                    {{ 'DEVICE_ACCESS.THIS_DEVICE_TITLE' | translate }}
                                </p>
                                <!-- Copy must not imply a sync: a device admitted now joins at the current epoch. -->
                                <p class="m-0 mt-1 text-xs text-text-muted">
                                    {{ bodyKey() | translate }}
                                </p>
                            }
                        </div>
                    </div>

                    @if (!waiting()) {
                        <div class="flex items-center justify-end">
                            <p-button
                                (onClick)="requestAccess()"
                                [disabled]="submitting()"
                                [label]="'DEVICE_ACCESS.REQUEST' | translate"
                                severity="primary"
                                size="small"
                            />
                        </div>
                    }

                    @if (requestFailure(); as message) {
                        <p class="m-0 pl-7 text-xs text-offline" data-testid="coverage-notice-error">
                            {{ message }}
                        </p>
                    }
                </div>
            }
        }
    `,
})
export class MlsUnreadableBannerComponent {
    readonly contextId = input.required<string>();
    /** Picks the noun in the copy, and tells the join request which collection to post to. */
    readonly isChannel = input<boolean>(false);
    /** What the last re-link attempt achieved, if anything. Null before the first press. */
    readonly status = input<MlsRelinkStatus | null>(null);
    /** Set when the host has its own access surface. Suppresses the coverage mode only, never the observed one. */
    readonly accessOfferedElsewhere = input<boolean>(false);
    /** Raised when the user asks to re-link. The host decides what that means. */
    readonly relink = output<string>();

    private readonly health = inject(MlsHealthService);
    private readonly coverage = inject(MlsCoverageService);

    constructor() {
        // Mounting this banner is the "context was opened" trigger; `ensure` keeps it to once per context.
        effect(() => {
            const contextId = this.contextId();
            const isChannel = this.isChannel();
            void this.coverage.ensure(contextId, isChannel);
        });
    }

    protected readonly mode = computed<'observed' | 'coverage' | null>(() => {
        if (this.health.isBroken(this.contextId())) return 'observed';
        if (this.accessOfferedElsewhere()) return null;
        return this.coverage.coverageOf(this.contextId())?.thisDeviceExcluded ? 'coverage' : null;
    });

    protected readonly bodyKey = computed(() =>
        this.isChannel() ? 'DEVICE_ACCESS.THIS_DEVICE_BODY_CHANNEL' : 'DEVICE_ACCESS.THIS_DEVICE_BODY',
    );

    protected readonly waitingBodyKey = computed(() =>
        this.isChannel() ? 'DEVICE_ACCESS.WAITING_BODY_CHANNEL' : 'DEVICE_ACCESS.WAITING_BODY',
    );

    protected readonly waiting = computed(
        () => this.coverage.requestStateOf(this.contextId()).state === 'waiting',
    );

    protected readonly submitting = computed(
        () => this.coverage.requestStateOf(this.contextId()).state === 'submitting',
    );

    protected readonly requestFailure = computed(() => {
        const state = this.coverage.requestStateOf(this.contextId());
        return state.state === 'failed' ? state.message : null;
    });

    protected requestAccess(): void {
        void this.coverage.requestAccess(this.contextId(), this.isChannel());
    }

    protected readonly title = computed(() => {
        switch (this.reason()) {
            case 'removed':
                return 'This device was removed from the conversation';
            case 'not-admitted':
                return 'This device has not been added to the conversation';
            case 'join-failed':
                return 'This device could not join the conversation';
            case 'downgraded':
                return 'Encryption for this conversation is being reported as switched off';
            default:
                return 'This device cannot read this conversation';
        }
    });

    protected readonly detail = computed(() => {
        switch (this.reason()) {
            case 'removed':
                // Correct MLS behaviour, so it must read as deliberate rather than as breakage.
                return 'Messages sent from now on are encrypted to a group this device is no longer in.';
            case 'not-admitted':
                return (
                    'Someone already in the conversation has to admit this device before it can ' +
                    'read anything sent here.'
                );
            case 'join-failed':
                return (
                    'The invitation for this device could not be used. Re-linking mints fresh ' +
                    'keys and asks to be admitted again.'
                );
            case 'downgraded':
                // Stated as a refusal, not a warning: nothing will be sent in the clear here.
                return (
                    'This device has encrypted messages here before, so it will not send ' +
                    'anything in the clear. Nothing has been sent unencrypted. If encryption was ' +
                    'genuinely turned off, turn it off from this device to confirm.'
                );
            default:
                return 'Recent messages could not be decrypted on this device.';
        }
    });

    private readonly reason = computed<MlsFailureReason | null>(
        () => this.health.healthOf(this.contextId())?.reason ?? null,
    );
}
