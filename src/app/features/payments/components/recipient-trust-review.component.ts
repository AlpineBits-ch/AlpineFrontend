import {ChangeDetectionStrategy, Component, computed, input, model} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {Button} from 'primeng/button';
import {AttestationInconsistency, RecipientTrust, SealPlan, TrustLevel} from '../device-trust';

/** One flagged device, with the wording already decided. */
interface FlaggedRow {
    trust: RecipientTrust;
    deviceLabel: string;
    /** The translation key for what is wrong with it. */
    reasonKey: string;
    /** One line per way the server's account of this device fails to add up. */
    inconsistencyKeys: string[];
    /** True for the states that mean somebody may be tampering rather than merely unproven. */
    alarming: boolean;
    confirmed: boolean;
    /** No key to seal to at all, so there is nothing to confirm. */
    confirmable: boolean;
}

const REASON_KEYS: Readonly<Record<TrustLevel, string>> = {
    'key-changed': 'PAY.TRUST.REASON_KEY_CHANGED',
    'attestation-inconsistent': 'PAY.TRUST.REASON_INCONSISTENT',
    revoked: 'PAY.TRUST.REASON_REVOKED',
    inactive: 'PAY.TRUST.REASON_INACTIVE',
    unattested: 'PAY.TRUST.REASON_UNATTESTED',
    unusable: 'PAY.TRUST.REASON_UNUSABLE',
    attested: '',
};

const INCONSISTENCY_KEYS: Readonly<Record<AttestationInconsistency, string>> = {
    'certificate-missing': 'PAY.TRUST.INCONSISTENT_CERT_MISSING',
    'certificate-expired': 'PAY.TRUST.INCONSISTENT_CERT_EXPIRED',
    'certificate-dates-reversed': 'PAY.TRUST.INCONSISTENT_CERT_DATES',
    'identity-key-version-regressed': 'PAY.TRUST.INCONSISTENT_VERSION_BACK',
    'identity-key-version-changed': 'PAY.TRUST.INCONSISTENT_VERSION_MOVED',
};

/**
 * The question asked before a seal: these devices cannot prove whose they are, do you want to share
 * your bank details with them anyway.
 */
@Component({
    selector: 'app-recipient-trust-review',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [Button, TranslateModule],
    template: `
        @if (unresolved().length > 0) {
            <!--
              Not swallowed. Sealing against a roster the server admitted was short leaves those
              people unable to read the blob, and this is the only signal that says so.
            -->
            <div class="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 mb-3"
                 data-testid="unresolved-members">
                <p class="m-0 text-[0.8125rem] text-amber-200">
                    {{ 'PAY.TRUST.UNRESOLVED' | translate: {count: unresolved().length} }}
                </p>
            </div>
        }

        @if (rows().length > 0) {
            <div class="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3"
                 data-testid="trust-review">
                <p class="m-0 text-[0.8125rem] font-medium text-text-primary">
                    {{ 'PAY.TRUST.HEADING' | translate: {count: rows().length} }}
                </p>
                <p class="m-0 mt-1 text-xs text-text-muted">
                    {{ 'PAY.TRUST.SUBHEADING' | translate }}
                </p>

                @for (row of rows(); track row.trust.attestation.deviceId) {
                    <div class="mt-3 border-t border-white/[0.06] pt-3"
                         [attr.data-testid]="'trust-row-' + row.trust.attestation.deviceId">
                        <p class="m-0 text-[0.8125rem] text-text-primary">{{ row.deviceLabel }}</p>

                        <p class="m-0 mt-0.5 text-xs"
                           [class.text-red-300]="row.alarming"
                           [class.text-text-muted]="!row.alarming">
                            {{ row.reasonKey | translate }}
                        </p>

                        <!--
                          Listed one by one rather than summarised. "The server contradicted itself"
                          is not actionable; "it says this device is certificated and did not supply
                          the certificate" is something a person can repeat to somebody who can act.
                        -->
                        @for (key of row.inconsistencyKeys; track key) {
                            <p class="m-0 mt-0.5 text-xs text-red-300"
                               [attr.data-testid]="'inconsistency-' + key">
                                {{ key | translate }}
                            </p>
                        }

                        @if (row.trust.fingerprint) {
                            <p class="m-0 mt-1.5 font-mono text-sm tracking-wider text-text-primary"
                               data-testid="fingerprint">{{ row.trust.fingerprint }}</p>
                        }

                        @if (row.trust.previousFingerprint; as previous) {
                            <p class="m-0 mt-0.5 text-xs text-text-muted">
                                {{ 'PAY.TRUST.PREVIOUS_FINGERPRINT' | translate }}
                            </p>
                            <p class="m-0 font-mono text-sm tracking-wider text-text-muted"
                               data-testid="previous-fingerprint">{{ previous }}</p>
                        }

                        @if (row.confirmable) {
                            <div class="mt-2">
                                <p-button (onClick)="toggle(row)" [text]="true" size="small"
                                          [severity]="row.confirmed ? 'success' : 'secondary'"
                                          [label]="(row.confirmed
                                              ? 'PAY.TRUST.CONFIRMED'
                                              : 'PAY.TRUST.CONFIRM') | translate"/>
                            </div>
                        } @else {
                            <p class="m-0 mt-2 text-xs text-text-muted">
                                {{ 'PAY.TRUST.NOT_CONFIRMABLE' | translate }}
                            </p>
                        }
                    </div>
                }
            </div>
        }
    `,
})
export class RecipientTrustReviewComponent {
    readonly plan = input.required<SealPlan>();
    /**
     * The devices the user has agreed to. Two-way, because the parent submits the seal and has to
     * pass the same set back into the next plan.
     */
    readonly confirmed = model<ReadonlySet<string>>(new Set<string>());

    protected readonly unresolved = computed(() => this.plan().unresolvedMemberIds);

    protected readonly rows = computed<FlaggedRow[]>(() => {
        const confirmed = this.confirmed();
        // Only the blocked list. A device the user already confirmed moves into `included` on the
        // next plan and stops being a question - which is the point of confirming it.
        return this.plan().blocked.map(trust => ({
            trust,
            deviceLabel: trust.attestation.deviceName?.trim()
                || trust.attestation.deviceId,
            reasonKey: REASON_KEYS[trust.level] || 'PAY.TRUST.REASON_UNATTESTED',
            inconsistencyKeys: trust.inconsistencies.map(i => INCONSISTENCY_KEYS[i]),
            // A key that moved under a device we already sealed to is the shape of an actual
            // substitution, and a directory disagreeing with its own evidence is the shape of one
            // being attempted. Everything else is unproven, which is not the same thing.
            alarming: trust.level === 'key-changed'
                || trust.level === 'attestation-inconsistent'
                || trust.level === 'revoked',
            confirmed: confirmed.has(trust.attestation.deviceId),
            confirmable: trust.level !== 'unusable',
        }));
    });

    protected toggle(row: FlaggedRow): void {
        const next = new Set(this.confirmed());
        const deviceId = row.trust.attestation.deviceId;
        if (next.has(deviceId)) next.delete(deviceId);
        else next.add(deviceId);
        this.confirmed.set(next);
    }
}
