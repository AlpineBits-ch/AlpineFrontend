import {computed, effect, inject, Signal, signal, untracked} from '@angular/core';
import {TranslateService} from '@ngx-translate/core';
import {GuildMemberDto, SelfGuildMemberDto} from '../../../dtos/response/member.dto';
import {GuildService} from '../../../services/guild.service';

/** One page covers a household; these boards render names, they are not a member browser. */
const MEMBER_PAGE_SIZE = 200;

export interface GuildRoster {
    members: Signal<GuildMemberDto[]>;
    memberById: Signal<Map<string, GuildMemberDto>>;
    /** `null` until loaded, and again on failure: permission checks must fail closed. */
    ownMember: Signal<SelfGuildMemberDto | null>;
    nameOf(userId: string | null | undefined): string;
    initialOf(userId: string | null | undefined): string;
    /**
     * `nameOf` as a value, for child panels that render names but hold no roster.
     * Must stay a computed: a bound method reference is stable, so children would
     * render the fallback name until something unrelated changed.
     */
    nameResolver: Signal<(userId: string | null | undefined) => string>;
}

/**
 * Roster for a guild board: members, own member, and name lookup.
 *
 * Call from an injection context. `unknownNameKey` is the i18n key used when a
 * user id is not in the roster, and stays per-module because the locale bundle is
 * a submodule and each board already ships its own key.
 */
export function injectGuildRoster(
    guildId: () => string | null | undefined,
    unknownNameKey: string,
): GuildRoster {
    const guildService = inject(GuildService);
    const translate = inject(TranslateService);

    const members = signal<GuildMemberDto[]>([]);
    const ownMember = signal<SelfGuildMemberDto | null>(null);
    const memberById = computed(() => new Map(members().map(m => [m.userId, m])));

    effect(() => {
        const id = guildId();
        if (!id) {
            untracked(() => {
                members.set([]);
                ownMember.set(null);
            });
            return;
        }
        untracked(() => {
            guildService.getOwnMember(id).subscribe({
                next: member => ownMember.set(member),
                error: () => ownMember.set(null),
            });
            guildService.getMembers(id, 0, MEMBER_PAGE_SIZE).subscribe({
                // Keeps the previous roster: a failed refresh should not turn every
                // rendered name back into the fallback.
                next: rows => members.set(rows),
                error: () => undefined,
            });
        });
    });

    const lookup = (byId: Map<string, GuildMemberDto>, userId: string | null | undefined): string => {
        if (!userId) return translate.instant(unknownNameKey);
        const member = byId.get(userId);
        return member?.nickname ?? member?.profile?.userName ?? translate.instant(unknownNameKey);
    };

    return {
        members: members.asReadonly(),
        ownMember: ownMember.asReadonly(),
        memberById,
        nameOf: userId => lookup(memberById(), userId),
        initialOf: userId => lookup(memberById(), userId).trim().charAt(0).toUpperCase() || '?',
        nameResolver: computed(() => {
            const byId = memberById();
            return (userId: string | null | undefined) => lookup(byId, userId);
        }),
    };
}
