import {Component, computed, inject, input, output, signal} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {AiMetadata} from '../../../../../services/ai-provider';
import {AiConnectFormComponent} from '../../../../../shared/ai-connect-form/ai-connect-form.component';
import {WikiAiService} from '../wiki-ai.service';
import {describeAiError, isMissingProvider} from './wiki-ai-shared';

/**
 * Tags and an edit summary, offered at the moment you are about to save.
 *
 * Both are things people skip - not because they disagree that a page should be tagged, but
 * because naming the change is the last thing between them and being finished. So this asks for
 * nothing up front and interrupts nothing: it is one muted line until it is pressed, and every
 * suggestion is applied one click at a time rather than written into the page on arrival.
 *
 * It deliberately owns no tag editor. The right rail already has one, and a second control for
 * the same field is how the two end up disagreeing about what the page's tags are - so accepted
 * tags leave here as an event and land in the editor that already exists.
 */
@Component({
    selector: 'app-wiki-ai-metadata',
    imports: [TranslateModule, AiConnectFormComponent],
    template: `
        @if (content().trim()) {
            <div class="flex flex-col gap-2">

                @if (connecting()) {
                    <div class="rounded-lg border border-border bg-card p-3">
                        <p class="mb-3 text-[0.75rem] text-white/50">
                            {{ 'WIKI.AI.CONNECT_INTRO' | translate }}
                        </p>
                        <app-ai-connect-form (connected)="onConnected()" [showBilling]="false"/>
                    </div>
                } @else if (running()) {
                    <div class="flex items-center gap-2 text-[0.75rem] text-white/40">
                        <i class="pi pi-spin pi-spinner text-[0.6875rem]"></i>
                        <span class="flex-1">{{ 'WIKI.AI.META.RUNNING' | translate }}</span>
                        <button (click)="stop()"
                                class="cursor-pointer border-0 bg-transparent p-0 text-[0.75rem]
                                       text-white/40 hover:text-white/70" type="button">
                            {{ 'WIKI.AI.STOP' | translate }}
                        </button>
                    </div>
                } @else if (!suggested()) {
                    <button (click)="suggest()"
                            class="flex w-fit cursor-pointer items-center gap-1.5 border-0
                                   bg-transparent p-0 text-[0.75rem] text-white/35
                                   hover:text-brand-dim" type="button">
                        <i class="pi pi-sparkles text-[0.6875rem]"></i>
                        {{ 'WIKI.AI.META.SUGGEST' | translate }}
                    </button>
                }

                @if (error(); as message) {
                    <p class="text-[0.75rem] leading-snug text-white/50">
                        {{ message }}
                        <button (click)="suggest()"
                                class="ml-1 cursor-pointer border-0 bg-transparent p-0
                                       text-[0.75rem] text-brand-dim hover:underline" type="button">
                            {{ 'COMMON.RETRY' | translate }}
                        </button>
                    </p>
                }

                @if (suggested(); as metadata) {
                    <div class="flex flex-col gap-2 rounded-lg border border-white/[0.08]
                                bg-white/[0.02] px-3 py-2.5">

                        @if (pendingTags().length) {
                            <div class="flex flex-wrap items-center gap-1.5">
                                <span class="mr-0.5 text-[0.6875rem] text-white/30">
                                    {{ 'WIKI.AI.META.TAGS' | translate }}
                                </span>
                                @for (tag of pendingTags(); track tag) {
                                    <button (click)="acceptTag(tag)"
                                            class="flex cursor-pointer items-center gap-1 rounded-full
                                                   border border-brand/30 bg-brand/[0.12] px-2 py-0.5
                                                   text-[0.6875rem] text-brand-dim hover:bg-brand/20"
                                            type="button">
                                        <i class="pi pi-plus text-[0.5rem]"></i>{{ tag }}
                                    </button>
                                }
                                @if (pendingTags().length > 1) {
                                    <button (click)="acceptAllTags()"
                                            class="cursor-pointer border-0 bg-transparent p-0
                                                   text-[0.6875rem] text-white/35 hover:text-white/70"
                                            type="button">
                                        {{ 'WIKI.AI.META.ADD_ALL' | translate }}
                                    </button>
                                }
                            </div>
                        }

                        @if (metadata.editSummary) {
                            <div class="flex items-center gap-2">
                                <span class="shrink-0 text-[0.6875rem] text-white/30">
                                    {{ 'WIKI.AI.META.SUMMARY' | translate }}
                                </span>
                                <span class="flex-1 truncate text-[0.75rem] text-white/60">
                                    {{ metadata.editSummary }}
                                </span>
                                <button (click)="summarySelected.emit(metadata.editSummary)"
                                        class="shrink-0 cursor-pointer rounded border-0
                                               bg-white/[0.06] px-2 py-0.5 text-[0.6875rem]
                                               text-white/70 hover:bg-hover" type="button">
                                    {{ 'WIKI.AI.META.USE' | translate }}
                                </button>
                            </div>
                        }

                        @if (metadata.summary) {
                            <div class="flex items-center gap-2">
                                <span class="shrink-0 text-[0.6875rem] text-white/30">
                                    {{ 'WIKI.AI.META.DESCRIPTION' | translate }}
                                </span>
                                <span class="flex-1 truncate text-[0.75rem] text-white/60">
                                    {{ metadata.summary }}
                                </span>
                                <button (click)="descriptionSelected.emit(metadata.summary)"
                                        class="shrink-0 cursor-pointer rounded border-0
                                               bg-white/[0.06] px-2 py-0.5 text-[0.6875rem]
                                               text-white/70 hover:bg-hover" type="button">
                                    {{ 'WIKI.AI.META.USE' | translate }}
                                </button>
                            </div>
                        }

                        <button (click)="dismiss()"
                                class="w-fit cursor-pointer border-0 bg-transparent p-0
                                       text-[0.6875rem] text-white/25 hover:text-white/60"
                                type="button">{{ 'WIKI.AI.META.DISMISS' | translate }}
                        </button>
                    </div>
                }
            </div>
        }
    `,
})
export class WikiAiMetadataComponent {
    readonly pageTitle = input('');
    readonly content = input('');
    readonly existingTags = input<readonly string[]>([]);

    /** Tags the user accepted. The rail's tag editor is what actually holds them. */
    readonly tagsSelected = output<string[]>();
    /** The revision summary for this edit. */
    readonly summarySelected = output<string>();
    /** A one-line description of the page, for whatever surface wants one. */
    readonly descriptionSelected = output<string>();

    protected readonly running = signal(false);
    protected readonly connecting = signal(false);
    protected readonly error = signal<string | null>(null);
    protected readonly suggested = signal<AiMetadata | null>(null);

    /** Suggestions minus anything the page already has, and minus anything just accepted. */
    protected readonly pendingTags = computed(() => {
        const taken = new Set([
            ...this.existingTags().map(tag => tag.toLowerCase()),
            ...this.accepted().map(tag => tag.toLowerCase()),
        ]);
        return (this.suggested()?.tags ?? []).filter(tag => !taken.has(tag.toLowerCase()));
    });

    private readonly ai = inject(WikiAiService);
    private readonly accepted = signal<string[]>([]);
    private controller?: AbortController;

    protected async suggest(): Promise<void> {
        if (this.running()) return;
        this.controller?.abort();
        const controller = new AbortController();
        this.controller = controller;
        this.running.set(true);
        this.error.set(null);

        try {
            const metadata = await this.ai.suggestMetadata({
                title: this.pageTitle(),
                content: this.content(),
                existingTags: this.existingTags(),
            }, controller.signal);
            this.accepted.set([]);
            this.suggested.set(metadata);
        } catch (err) {
            if (controller.signal.aborted) return;
            if (isMissingProvider(err)) {
                this.connecting.set(true);
                return;
            }
            this.error.set(describeAiError(err));
        } finally {
            if (this.controller === controller) this.controller = undefined;
            this.running.set(false);
        }
    }

    protected stop(): void {
        this.controller?.abort();
        this.controller = undefined;
        this.running.set(false);
    }

    protected acceptTag(tag: string): void {
        this.accepted.update(tags => [...tags, tag]);
        this.tagsSelected.emit([tag]);
    }

    protected acceptAllTags(): void {
        const tags = this.pendingTags();
        if (!tags.length) return;
        this.accepted.update(current => [...current, ...tags]);
        this.tagsSelected.emit(tags);
    }

    protected dismiss(): void {
        this.suggested.set(null);
        this.accepted.set([]);
        this.error.set(null);
    }

    protected onConnected(): void {
        this.connecting.set(false);
        void this.ai.refresh();
        void this.suggest();
    }
}
