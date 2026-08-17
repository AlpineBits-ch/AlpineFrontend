import {ChangeDetectionStrategy, Component, computed, input, model} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {ForumTag, FORUM_LIMITS} from '../../../../dtos/response/forum.dto';
import {ForumTagChipComponent} from './forum-tag-chip.component';

/** Multi-select chip picker over a forum's tags, capped at 5 per post. Moderated tags are filtered out for users who can't apply them rather than shown and rejected: the backend 403s the whole create/update request when one slips through. */
@Component({
    selector: 'app-forum-tag-picker',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [ForumTagChipComponent, TranslateModule],
    template: `
        @if (visibleTags().length > 0) {
            <div class="flex flex-col gap-2">
                <div class="flex items-center justify-between">
                    <span class="text-[0.6875rem] font-semibold uppercase tracking-wider text-text-muted">
                        {{ 'FORUM.TAGS' | translate }}
                        @if (required()) {
                            <span class="text-offline ml-0.5">*</span>
                        }
                    </span>
                    <span
                        class="text-[0.625rem] tabular-nums"
                        [class]="atCap() ? 'text-connecting' : 'text-text-muted'"
                    >
                        {{ selected().length }}/{{ maxTags }}
                    </span>
                </div>
                <div class="flex flex-wrap gap-1.5">
                    @for (tag of visibleTags(); track tag.id) {
                        <button
                            (click)="toggle(tag.id)"
                            [disabled]="!isSelected(tag.id) && atCap()"
                            class="disabled:opacity-35 disabled:cursor-not-allowed"
                            type="button"
                        >
                            <app-forum-tag-chip
                                [emojiUrl]="emojiUrlFor(tag)"
                                [interactive]="true"
                                [selected]="isSelected(tag.id)"
                                [tag]="tag"
                            />
                        </button>
                    }
                </div>
            </div>
        }
    `,
})
export class ForumTagPickerComponent {
    readonly tags = input.required<ForumTag[]>();
    /** Two-way: the picker emits whole sets, which is what PUT .../tags expects. */
    readonly selected = model<string[]>([]);
    readonly canUseModerated = input(false);
    readonly required = input(false);
    /** guild emoji id → presigned image url, for tags that point at a custom emoji. */
    readonly emojiUrls = input<Record<string, string>>({});

    protected readonly maxTags = FORUM_LIMITS.tagsPerPost;

    protected readonly visibleTags = computed(() =>
        this.canUseModerated() ? this.tags() : this.tags().filter(t => !t.moderated),
    );

    protected readonly atCap = computed(() => this.selected().length >= this.maxTags);

    protected isSelected(tagId: string): boolean {
        return this.selected().includes(tagId);
    }

    protected emojiUrlFor(tag: ForumTag): string | null {
        return tag.emojiId ? (this.emojiUrls()[tag.emojiId] ?? null) : null;
    }

    protected toggle(tagId: string): void {
        const current = this.selected();
        if (current.includes(tagId)) {
            this.selected.set(current.filter(id => id !== tagId));
            return;
        }
        if (current.length >= this.maxTags) return;

        // Keep the set in the forum's own tag order so what the user sees here matches the order the server returns applied tags in on the post card.
        const order = this.tags().map(t => t.id);
        this.selected.set([...current, tagId].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    }
}
