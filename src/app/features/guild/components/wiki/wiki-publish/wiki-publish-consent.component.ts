import {ChangeDetectionStrategy, Component, computed, input, output} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule} from '@ngx-translate/core';
import {WikiPublishStep} from '../../../../../services/wiki-publication.service';

/** Chosen in code rather than written in the template, so `i18n-keys.spec.ts` can still see them. */
export const WIKI_PUBLISH_CONSENT_KEYS: readonly string[] = [
    'WIKI_PUBLISH.CONSENT.CONFIRM',
    'WIKI_PUBLISH.CONSENT.RETRY',
    'WIKI_PUBLISH.CONSENT.RETRY_PUBLISH',
    'COMMON.CANCEL',
    'COMMON.CLOSE',
];

/**
 * The consent moment for putting a private page on the open internet. The two consequences are
 * listed as the two writes they are, so a failure can point at the one that did not happen.
 */
@Component({
    selector: 'app-wiki-publish-consent',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [Dialog, Button, PrimeTemplate, TranslateModule],
    template: `
        <p-dialog
            (visibleChange)="!$event && dismissed.emit()"
            [breakpoints]="{'480px': '95vw'}"
            [closable]="!working()"
            [draggable]="false"
            [modal]="true"
            [resizable]="false"
            [style]="{width: '27rem'}"
            [visible]="true"
            appendTo="body"
            maskStyleClass="backdrop-blur-sm"
            styleClass="!bg-card !border !border-white/[0.08] !rounded-2xl"
        >
            <ng-template pTemplate="header">
                <span class="text-base font-semibold text-text-primary">
                    {{ 'WIKI_PUBLISH.CONSENT.TITLE' | translate: {title: title()} }}
                </span>
            </ng-template>

            <p class="m-0 text-sm leading-relaxed text-text-secondary">
                {{ 'WIKI_PUBLISH.CONSENT.LEAD' | translate }}
            </p>

            <ol class="m-0 mt-4 flex list-none flex-col gap-2 p-0">
                <li class="flex gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3.5 py-3">
                    <span
                        [class.border-online]="guildStepDone()"
                        [class.text-online]="guildStepDone()"
                        class="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-white/[0.14] text-[0.6875rem] tabular-nums text-text-muted"
                    >
                        @if (guildStepDone()) {
                            <i class="pi pi-check text-[0.5rem]"></i>
                        } @else {
                            1
                        }
                    </span>
                    <div class="min-w-0 flex-1">
                        <p class="m-0 text-[0.8125rem] font-medium text-text-primary">
                            {{ 'WIKI_PUBLISH.CONSENT.STEP_ONE_TITLE' | translate }}
                        </p>
                        @if (failedStep() === 'visibility') {
                            <p class="m-0 mt-1 text-xs leading-relaxed text-rose-400">
                                {{ 'WIKI_PUBLISH.CONSENT.STEP_ONE_FAILED' | translate }}
                            </p>
                        } @else if (guildStepDone()) {
                            <p class="m-0 mt-1 text-xs leading-relaxed text-online">
                                {{ 'WIKI_PUBLISH.CONSENT.STEP_ONE_DONE' | translate }}
                            </p>
                        } @else {
                            <p class="m-0 mt-1 text-xs leading-relaxed text-text-muted">
                                {{ 'WIKI_PUBLISH.CONSENT.STEP_ONE_BODY' | translate }}
                            </p>
                        }
                    </div>
                </li>

                <!-- Amber, not red: this is the consequential half, and it is not a fault. -->
                <li
                    class="flex gap-3 rounded-xl border border-connecting/25 bg-connecting/[0.06] px-3.5 py-3"
                >
                    <span
                        class="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-connecting/40 text-[0.6875rem] tabular-nums text-connecting"
                    >
                        2
                    </span>
                    <div class="min-w-0 flex-1">
                        <p class="m-0 text-[0.8125rem] font-medium text-text-primary">
                            {{ 'WIKI_PUBLISH.CONSENT.STEP_TWO_TITLE' | translate }}
                        </p>
                        @if (url(); as address) {
                            <p class="m-0 mt-1 truncate font-mono text-[0.75rem] text-text-secondary">
                                {{ address }}
                            </p>
                        }
                        @if (failedStep() === 'publish') {
                            <p class="m-0 mt-1 text-xs leading-relaxed text-rose-400">
                                {{ 'WIKI_PUBLISH.CONSENT.STEP_TWO_FAILED' | translate }}
                            </p>
                        } @else if (url()) {
                            <p class="m-0 mt-1 text-xs leading-relaxed text-text-muted">
                                {{ 'WIKI_PUBLISH.CONSENT.STEP_TWO_BODY' | translate }}
                            </p>
                        } @else {
                            <p class="m-0 mt-1 text-xs leading-relaxed text-text-muted">
                                {{ 'WIKI_PUBLISH.CONSENT.STEP_TWO_WAITING' | translate }}
                            </p>
                        }
                    </div>
                </li>
            </ol>

            <p class="m-0 mt-3 text-[0.6875rem] leading-relaxed text-text-muted">
                {{ 'WIKI_PUBLISH.CONSENT.FOOTNOTE' | translate }}
            </p>

            <div class="mt-4 flex justify-end gap-2 border-t border-white/[0.10] pt-4">
                <p-button
                    (onClick)="dismissed.emit()"
                    [disabled]="working()"
                    [label]="dismissKey() | translate"
                    [text]="true"
                    severity="secondary"
                    size="small"
                />
                <p-button
                    (onClick)="confirmed.emit()"
                    [label]="confirmKey() | translate"
                    [loading]="working()"
                    severity="primary"
                    size="small"
                />
            </div>
        </p-dialog>
    `,
})
export class WikiPublishConsentComponent {
    readonly title = input.required<string>();
    /** The address the page will answer on, or null while the wiki has no public address. */
    readonly url = input<string | null>(null);
    readonly working = input(false);
    readonly failedStep = input<WikiPublishStep | null>(null);

    readonly confirmed = output<void>();
    readonly dismissed = output<void>();

    /** Only the second write can fail with the first already behind it. */
    protected readonly guildStepDone = computed(() => this.failedStep() === 'publish');

    protected readonly confirmKey = computed(() => {
        switch (this.failedStep()) {
            case 'visibility':
                return 'WIKI_PUBLISH.CONSENT.RETRY';
            case 'publish':
                return 'WIKI_PUBLISH.CONSENT.RETRY_PUBLISH';
            default:
                return 'WIKI_PUBLISH.CONSENT.CONFIRM';
        }
    });

    protected readonly dismissKey = computed(() => (this.failedStep() ? 'COMMON.CLOSE' : 'COMMON.CANCEL'));
}
