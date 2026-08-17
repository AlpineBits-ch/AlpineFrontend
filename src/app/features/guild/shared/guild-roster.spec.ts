import {Injector, runInInjectionContext, signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {of, throwError} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {TranslateService} from '@ngx-translate/core';
import {GuildMemberDto, SelfGuildMemberDto} from '../../../dtos/response/member.dto';
import {GuildService} from '../../../services/guild.service';
import {GuildRoster, injectGuildRoster} from './guild-roster';

function member(userId: string, nickname: string | null, userName?: string): GuildMemberDto {
    return {
        userId,
        nickname,
        profile: userName ? ({userName} as GuildMemberDto['profile']) : undefined,
    } as GuildMemberDto;
}

describe('injectGuildRoster', () => {
    let getMembers: ReturnType<typeof vi.fn>;
    let getOwnMember: ReturnType<typeof vi.fn>;
    let injector: Injector;

    beforeEach(() => {
        getMembers = vi.fn().mockReturnValue(of([member('u1', 'Ada'), member('u2', null, 'grace')]));
        getOwnMember = vi.fn().mockReturnValue(of({userId: 'u1'} as SelfGuildMemberDto));

        TestBed.configureTestingModule({
            providers: [
                {provide: GuildService, useValue: {getMembers, getOwnMember}},
                {provide: TranslateService, useValue: {instant: (key: string) => key}},
            ],
        });
        injector = TestBed.inject(Injector);
    });

    function setup(guildId: () => string | null): GuildRoster {
        const roster = runInInjectionContext(injector, () => injectGuildRoster(guildId, 'TEST.SOMEONE'));
        TestBed.tick();
        return roster;
    }

    it('prefers a nickname, falls back to the profile name', () => {
        const roster = setup(() => 'g1');

        expect(roster.nameOf('u1')).toBe('Ada');
        expect(roster.nameOf('u2')).toBe('grace');
    });

    it('answers with the supplied i18n key for anyone not in the roster', () => {
        const roster = setup(() => 'g1');

        expect(roster.nameOf('nobody')).toBe('TEST.SOMEONE');
        expect(roster.nameOf(null)).toBe('TEST.SOMEONE');
        expect(roster.nameOf(undefined)).toBe('TEST.SOMEONE');
    });

    it('takes the first letter for an initial, and never returns an empty one', () => {
        const roster = setup(() => 'g1');

        expect(roster.initialOf('u1')).toBe('A');
        expect(roster.initialOf('u2')).toBe('G');
    });

    it('hands back a fresh nameResolver when the roster lands, so children re-render', () => {
        getMembers.mockReturnValue(of([]));
        const guildId = signal<string | null>('g1');
        const roster = setup(() => guildId());

        const before = roster.nameResolver();
        expect(before('u1')).toBe('TEST.SOMEONE');

        getMembers.mockReturnValue(of([member('u1', 'Ada')]));
        guildId.set('g2');
        TestBed.tick();

        // A stable reference here is the bug this computed exists to prevent: children
        // would keep rendering the fallback until something unrelated changed.
        expect(roster.nameResolver()).not.toBe(before);
        expect(roster.nameResolver()('u1')).toBe('Ada');
    });

    it('fails own-member closed, so a control is never briefly offered to the wrong person', () => {
        getOwnMember.mockReturnValue(throwError(() => new Error('403')));
        const roster = setup(() => 'g1');

        expect(roster.ownMember()).toBeNull();
    });

    it('keeps the previous roster when a refresh fails', () => {
        const roster = setup(() => 'g1');
        expect(roster.members()).toHaveLength(2);

        getMembers.mockReturnValue(throwError(() => new Error('500')));
        TestBed.tick();

        // A failed refresh must not turn every rendered name back into the fallback.
        expect(roster.members()).toHaveLength(2);
    });

    it('does not fetch at all without a guild id', () => {
        setup(() => null);

        expect(getMembers).not.toHaveBeenCalled();
        expect(getOwnMember).not.toHaveBeenCalled();
    });
});
