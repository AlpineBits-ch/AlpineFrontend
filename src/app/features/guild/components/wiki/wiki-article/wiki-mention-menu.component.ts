import {
    Component,
    computed,
    effect,
    ElementRef,
    inject,
    input,
    output,
    signal,
    untracked,
    viewChildren,
} from '@angular/core';
import {toObservable, toSignal} from '@angular/core/rxjs-interop';
import {catchError, debounceTime, of, switchMap} from 'rxjs';
import {NgClass} from '@angular/common';
import {TranslateModule} from '@ngx-translate/core';
import {AppAvatarComponent} from '../../../../../components/avatar/avatar.component';
import {GuildMemberDto} from '../../../../../dtos/response/member.dto';
import {GuildService} from '../../../../../services/guild.service';

/** What the article needs to write the mention. Deliberately not the whole member DTO. */
export interface WikiMentionMember {
    userId: string;
    /** The name to render in the page. Frozen into the document at insert time. */
    name: string;
}

/** A mention href, e.g. user:0198...; same shape as wiki: page links and for the same reason: an ordinary Link mark round-trips through the markdown serializer for free, so a mention survives save and reload with no custom node or serializer. Must stay in the Link extension's protocol allowlist, or the mark is dropped at parse time (see HANDOFF). */
export const USER_LINK_PROTOCOL = 'user';

/** Anchored, so `username:` cannot match. Requires at least one id character. */
const USER_HREF_RE = /^user:(.+)$/;

export function userHref(userId: string): string {
    return `${USER_LINK_PROTOCOL}:${userId}`;
}

export function parseUserHref(href: string | null | undefined): string | null {
    if (!href) return null;
    const match = USER_HREF_RE.exec(href);
    return match ? match[1] : null;
}

/** The @ member picker: server-side search like the chat composer's mention overlay, rather than a member list held in memory, since a guild roster can run to thousands. */
@Component({
    selector: 'app-wiki-mention-menu',
    imports: [NgClass, TranslateModule, AppAvatarComponent],
    template: `
        @if (open()) {
            <div
                [style.left.px]="position().left"
                [style.top.px]="position().top"
                class="fixed z-50 w-64 overflow-hidden rounded-xl border border-border bg-card
                        shadow-xl"
            >
                <div class="thin-scrollbar max-h-72 overflow-y-auto py-1">
                    @for (member of matches(); track member.userId; let i = $index) {
                        <button
                            #itemEl
                            (click)="selected.emit(member)"
                            [ngClass]="
                                i === activeIndex()
                                    ? 'bg-brand/25 ring-1 ring-inset ring-brand/40'
                                    : 'hover:bg-hover'
                            "
                            class="flex w-full cursor-pointer items-center gap-2.5 border-0
                                       bg-transparent px-3 py-1.5 text-left"
                        >
                            <app-avatar
                                [userId]="member.userId"
                                [label]="initial(member)"
                                styleClass="!w-6 !h-6 !text-[0.625rem]"
                            />
                            <span class="min-w-0 flex-1 truncate text-[0.8125rem] text-white/75">
                                {{ member.name }}
                            </span>
                        </button>
                    }
                    @if (matches().length === 0) {
                        <p class="px-3 py-2 text-[0.75rem] text-white/30">
                            {{ 'WIKI.MENTION_MENU.NO_MATCH' | translate }}
                        </p>
                    }
                </div>
            </div>
        }
    `,
})
export class WikiMentionMenuComponent {
    readonly open = input(false);
    readonly query = input('');
    readonly position = input<{top: number; left: number}>({top: 0, left: 0});
    readonly guildId = input('');

    readonly selected = output<WikiMentionMember>();

    protected readonly activeIndex = signal(0);

    private readonly guildService = inject(GuildService);
    private readonly itemEls = viewChildren<ElementRef<HTMLElement>>('itemEl');

    private readonly request = computed(() => ({
        guildId: this.guildId(),
        query: this.query().trim(),
        open: this.open(),
    }));

    /** Debounced, and nothing is fetched while the menu is shut: @ in prose is common enough that an eager request per keystroke would be a steady trickle of roster calls from anyone writing an email address. */
    private readonly members = toSignal(
        toObservable(this.request).pipe(
            debounceTime(150),
            switchMap(request => {
                if (!request.open || !request.guildId) return of<GuildMemberDto[]>([]);
                const source = request.query
                    ? this.guildService.searchMembers(request.guildId, request.query)
                    : this.guildService.getMembers(request.guildId, 0, 30);
                // A failed lookup shows "no members match", which is true enough for a picker and better than an unhandled error while someone is typing.
                return source.pipe(catchError(() => of<GuildMemberDto[]>([])));
            }),
        ),
        {initialValue: [] as GuildMemberDto[]},
    );

    protected readonly matches = computed<WikiMentionMember[]>(() =>
        this.members()
            // `profile` is optional on the DTO and a member without one has no name to render.
            .filter(member => !!member.profile)
            .map(member => ({
                userId: member.userId,
                name: member.nickname?.trim() || member.profile!.userName,
            }))
            .slice(0, 8),
    );

    constructor() {
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
            const member = items[this.activeIndex()];
            // Not consumed with an empty list: `@` sitting in prose must not swallow Enter.
            if (!member) return false;
            this.selected.emit(member);
            return true;
        }
        return false;
    }

    reset(): void {
        this.activeIndex.set(0);
    }

    protected initial(member: WikiMentionMember): string {
        return member.name.charAt(0).toUpperCase();
    }
}
