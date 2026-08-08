import {Component, computed, effect, inject, input, output} from '@angular/core';
import {Button} from 'primeng/button';
import {TranslateModule} from '@ngx-translate/core';
import {MlsFailureReason, MlsHealthService} from '../../services/mls-health.service';
import {MlsRelinkStatus} from '../../services/mls-join-request.service';
import {MlsCoverageService} from '../../services/mls-coverage.service';

/**
 * Says, in the conversation it applies to, that this device cannot read it - and offers the one
 * action that fixes it.
 *
 * <p>This surface is the point of the whole failure-reporting change. Every one of these states
 * used to be a `console.error` or a bare `catch {}`, so a device that could never join a
 * conversation logged one line per launch and showed its owner nothing. The only symptom anyone
 * could report was "sometimes messages don't arrive", which is why the underlying bug shipped and
 * stayed shipped.</p>
 *
 * <p>Deliberately quiet until a context is genuinely broken: one decrypt failure is ordinary,
 * because a message paged in from beyond the ratchet's reach can never be decrypted and that is
 * correct MLS behaviour rather than a fault.</p>
 *
 * <p><b>Two sources, one banner.</b> The `observed` mode is what this client has watched go wrong.
 * The `coverage` mode is the server's record of which devices were ever sealed a Welcome, which is
 * the only thing that notices a device quietly left out of a group - such a device has had nothing
 * go wrong to observe, because it has never been able to try. They are the same sentence reached
 * from two directions, so they share one place above the composer rather than stacking two notices
 * a reader learns to skip. Where both apply, `observed` wins: it names the specific fault and its
 * repair is the more capable of the two.</p>
 */
@Component({
    selector: 'app-mls-unreadable-banner',
    standalone: true,
    imports: [Button, TranslateModule],
    template: `
        @switch (mode()) {
            @case ('observed') {
                <div class="mx-4 mb-3 flex items-start gap-2.5 rounded-xl border border-amber-500/30
                            bg-amber-500/[0.08] px-4 py-3">
                    <i class="pi pi-lock-open text-amber-300 text-[0.875rem] shrink-0 mt-0.5"></i>
                    <div class="min-w-0 flex-1">
                        <p class="m-0 text-[0.8125rem] text-text-primary">{{ title() }}</p>
                        <p class="m-0 mt-0.5 text-xs text-text-muted">{{ detail() }}</p>
                        <!--
                          The outcome of the last re-link, in the same block that offered it. Without
                          this the button was indistinguishable from a no-op: its only report was a
                          console error, which in a release build is nowhere.
                        -->
                        @if (status(); as s) {
                            <p class="m-0 mt-1.5 text-xs" [class.text-red-300]="s.tone === 'failed'"
                               [class.text-amber-200]="s.tone === 'pending'"
                               [class.text-emerald-300]="s.tone === 'ok'"
                               [class.text-text-muted]="s.tone === 'working'"
                               data-testid="relink-status">{{ s.message }}</p>
                        }
                    </div>
                    <p-button (onClick)="relink.emit(contextId())" [disabled]="status()?.tone === 'working'"
                              [text]="true" label="Re-link device" severity="warn" size="small"/>
                </div>
            }
            @case ('coverage') {
                <div class="mx-4 mb-3 flex flex-col gap-3 rounded-xl border border-border-default
                            bg-card/60 p-4" data-testid="coverage-notice">
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
                                <!--
                                  History does not come back. A device admitted now joins at the
                                  current epoch, so anything sent before that stays unreadable here
                                  forever, and copy implying a sync would be a plain lie.
                                -->
                                <p class="m-0 mt-1 text-xs text-text-muted">
                                    {{ bodyKey() | translate }}
                                </p>
                            }
                        </div>
                    </div>

                    @if (!waiting()) {
                        <div class="flex items-center justify-end">
                            <p-button (onClick)="requestAccess()" [disabled]="submitting()"
                                      [label]="'DEVICE_ACCESS.REQUEST' | translate"
                                      severity="primary" size="small"/>
                        </div>
                    }

                    @if (requestFailure(); as message) {
                        <p class="m-0 pl-7 text-xs text-offline"
                           data-testid="coverage-notice-error">{{ message }}</p>
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
    /**
     * What the last re-link attempt achieved, if anything.
     *
     * <p>Owned by the host because the host is what runs the attempt. Null before the first press.</p>
     */
    readonly status = input<MlsRelinkStatus | null>(null);
    /**
     * Set when the host already has a dedicated surface for a device that holds no group - the
     * channel view's access banner, which replaces the composer outright and carries the identity
     * fingerprint an approver will ask for.
     *
     * <p>Only the coverage mode is suppressed. The observed mode reports faults that banner cannot
     * see, and silencing those would trade one blind spot for another.</p>
     */
    readonly accessOfferedElsewhere = input<boolean>(false);
    /** Raised when the user asks to re-link. The host decides what that means. */
    readonly relink = output<string>();

    private readonly health = inject(MlsHealthService);
    private readonly coverage = inject(MlsCoverageService);

    constructor() {
        // This banner sits in the footer of every conversation and channel, so mounting it *is*
        // the "context was opened" trigger. `ensure` is what keeps that to at most once per context
        // per session - it re-asks only when this device's view of the group has moved since.
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

    protected readonly bodyKey = computed(() => this.isChannel()
        ? 'DEVICE_ACCESS.THIS_DEVICE_BODY_CHANNEL'
        : 'DEVICE_ACCESS.THIS_DEVICE_BODY');

    protected readonly waitingBodyKey = computed(() => this.isChannel()
        ? 'DEVICE_ACCESS.WAITING_BODY_CHANNEL'
        : 'DEVICE_ACCESS.WAITING_BODY');

    protected readonly waiting = computed(
        () => this.coverage.requestStateOf(this.contextId()).state === 'waiting');

    protected readonly submitting = computed(
        () => this.coverage.requestStateOf(this.contextId()).state === 'submitting');

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
                // Correct MLS behaviour, and it must read as deliberate rather than as breakage.
                return 'Messages sent from now on are encrypted to a group this device is no longer in.';
            case 'not-admitted':
                return 'Someone already in the conversation has to admit this device before it can '
                    + 'read anything sent here.';
            case 'join-failed':
                return 'The invitation for this device could not be used. Re-linking mints fresh '
                    + 'keys and asks to be admitted again.';
            case 'downgraded':
                // Stated as a refusal rather than a warning: nothing will be sent in the clear
                // here, and the user needs to know why their message did not go rather than
                // discovering later that it went unencrypted.
                return 'This device has encrypted messages here before, so it will not send '
                    + 'anything in the clear. Nothing has been sent unencrypted. If encryption was '
                    + 'genuinely turned off, turn it off from this device to confirm.';
            default:
                return 'Recent messages could not be decrypted on this device.';
        }
    });

    private readonly reason = computed<MlsFailureReason | null>(
        () => this.health.healthOf(this.contextId())?.reason ?? null,
    );
}
