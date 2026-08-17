import {
    Component,
    computed,
    effect,
    ElementRef,
    inject,
    Injector,
    input,
    output,
    signal,
    untracked,
    viewChildren,
} from '@angular/core';
import {NgClass} from '@angular/common';
import {TranslateModule} from '@ngx-translate/core';
import {EmojiDataService, EmojiSuggestion} from '../../../../../services/emoji-data.service';

/** The : emoji picker, backed by EmojiDataService (the same shortcode index the chat composer autocompletes against), so :tada means the same thing in a page as in a message and the wiki adds no second emoji table. The plugin will not open this before two query characters, which keeps "Note: a thing" from popping a picker mid-sentence. */
@Component({
    selector: 'app-wiki-emoji-menu',
    imports: [NgClass, TranslateModule],
    template: `
        @if (open()) {
            <div
                [style.left.px]="position().left"
                [style.top.px]="position().top"
                class="fixed z-50 w-64 overflow-hidden rounded-xl border border-border bg-card
                        shadow-xl"
            >
                <div class="thin-scrollbar max-h-72 overflow-y-auto py-1">
                    @for (emoji of matches(); track emoji.id; let i = $index) {
                        <button
                            #itemEl
                            (click)="selected.emit(emoji)"
                            [ngClass]="
                                i === activeIndex()
                                    ? 'bg-brand/25 ring-1 ring-inset ring-brand/40'
                                    : 'hover:bg-hover'
                            "
                            class="flex w-full cursor-pointer items-center gap-2.5 border-0
                                       bg-transparent px-3 py-1.5 text-left"
                        >
                            <span class="w-5 shrink-0 text-center text-[1rem] leading-none">
                                {{ emoji.native }}
                            </span>
                            <span class="min-w-0 flex-1 truncate text-[0.8125rem] text-text-primary">
                                :{{ emoji.id }}:
                            </span>
                            <span class="shrink-0 truncate text-[0.6875rem] text-text-muted">
                                {{ emoji.name }}
                            </span>
                        </button>
                    }
                    @if (matches().length === 0) {
                        <p class="px-3 py-2 text-[0.75rem] text-text-muted">
                            {{ 'WIKI.EMOJI_MENU.NO_MATCH' | translate }}
                        </p>
                    }
                </div>
            </div>
        }
    `,
})
export class WikiEmojiMenuComponent {
    readonly open = input(false);
    readonly query = input('');
    readonly position = input<{top: number; left: number}>({top: 0, left: 0});

    readonly selected = output<EmojiSuggestion>();

    protected readonly activeIndex = signal(0);

    private readonly injector = inject(Injector);
    private readonly itemEls = viewChildren<ElementRef<HTMLElement>>('itemEl');

    /** Resolved on first open rather than injected up front: EmojiDataService pulls the emoji dataset in its constructor, and most wiki sessions never type a colon, so injecting it as a field would download it for all of them. */
    private readonly emojiData = signal<EmojiDataService | null>(null);

    /** Empty until the dataset resolves; the search reads its signal, so this re-runs then. */
    protected readonly matches = computed<EmojiSuggestion[]>(() => {
        const data = this.emojiData();
        const query = this.query().trim();
        if (!data || !query) return [];
        return data.search(query);
    });

    constructor() {
        effect(() => {
            if (this.open() && !untracked(this.emojiData)) {
                this.emojiData.set(this.injector.get(EmojiDataService));
            }
        });

        // The result set changes shape on every keystroke, and Enter on a row that no longer exists does nothing at all, which reads as a broken menu.
        effect(() => {
            const length = this.matches().length;
            if (untracked(this.activeIndex) >= length) this.activeIndex.set(0);
        });

        effect(() => {
            const index = this.activeIndex();
            if (!this.open()) return;
            this.itemEls()[index]?.nativeElement.scrollIntoView({block: 'nearest'});
        });
    }

    /** Returns true when the key was consumed, so the editor does not also act on it. */
    handleKey(key: string): boolean {
        if (!this.open()) return false;
        const items = this.matches();
        if (key === 'ArrowDown') {
            this.activeIndex.update(i => (i + 1) % Math.max(1, items.length));
            return true;
        }
        if (key === 'ArrowUp') {
            this.activeIndex.update(i => (i - 1 + items.length) % Math.max(1, items.length));
            return true;
        }
        if (key === 'Enter' || key === 'Tab') {
            const emoji = items[this.activeIndex()];
            // Not consumed when there is nothing to pick: Enter has to keep splitting the paragraph while a two-letter colon run happens to match no emoji.
            if (!emoji) return false;
            this.selected.emit(emoji);
            return true;
        }
        return false;
    }

    reset(): void {
        this.activeIndex.set(0);
    }
}
