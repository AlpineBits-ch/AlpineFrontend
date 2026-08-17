import {signal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {ConversationAvatarComponent} from './conversation-avatar.component';
import {ConversationDto, ConversationMemberDto} from '../../../../dtos/response/conversation.dto';
import {ConversationEncryption} from '../../../../enums/conversation-encryption.enum';
import {OnlineStatus, ProfileDto} from '../../../../dtos/response/profile.dto';
import {ProfileService} from '../../../../services/profile.service';
import {TypingService} from '../../../../services/typing.service';
import {ApiConfigService} from '../../../../services/api-config.service';
import {OsInfo} from '../../../../platform/ports/os-info.port';

const BASE = 'https://api.test.example';
const OWN_ID = 'user_self';

function member(userId: string, name: string, joinedAtIso: string): ConversationMemberDto {
    return {
        id: `mem_${userId}`,
        createdAt: new Date(joinedAtIso),
        updatedAt: new Date(joinedAtIso),
        userId,
        cachedUserName: name,
        lastReadMessageId: undefined,
        mentionCount: 0,
    };
}

function profile(userId: string, avatarUrl: string | undefined): ProfileDto {
    return {
        id: `prof_${userId}`,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        userName: userId,
        bio: undefined,
        userId,
        avatarUrl,
        bannerUrl: undefined,
        accentColor: null,
        font: 'Default' as ProfileDto['font'],
        onlineStatus: OnlineStatus.Offline,
    };
}

function conversation(
    members: ConversationMemberDto[],
    iconUpdatedAt: string | null = null,
): ConversationDto {
    return {
        id: 'conv_1',
        createdAt: new Date(),
        updatedAt: new Date(),
        name: 'Group',
        iconUpdatedAt,
        members: [member(OWN_ID, 'Self', '2026-01-01T00:00:00Z'), ...members],
        encryptionState: ConversationEncryption.Plain,
    };
}

interface Setup {
    conversation: ConversationDto;
    cached?: Record<string, ProfileDto>;
    ownAvatar?: string;
}

function setup(options: Setup): ComponentFixture<ConversationAvatarComponent> {
    const cached = options.cached ?? {};

    TestBed.configureTestingModule({
        imports: [ConversationAvatarComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            {provide: OsInfo, useValue: {isMobile: false}},
            // Stubbed because the real one reaches the realtime connection, which reaches OAuth.
            {provide: TypingService, useValue: {state: signal(new Map<string, Set<string>>())}},
            {
                provide: ProfileService,
                useValue: {
                    ownProfile: signal(profile(OWN_ID, options.ownAvatar)),
                    getCachedByUserId: (id: string) => cached[id],
                    getOnlineStatus: () => 0,
                    resolveByUserId: () => undefined,
                },
            },
        ],
    });

    const fixture = TestBed.createComponent(ConversationAvatarComponent);
    fixture.componentRef.setInput('conversation', options.conversation);
    fixture.detectChanges();
    return fixture;
}

function tileImages(fixture: ComponentFixture<ConversationAvatarComponent>): (string | null)[] {
    return [...fixture.nativeElement.querySelectorAll('.conv-tile img')].map((img: HTMLImageElement) =>
        img.getAttribute('src'),
    );
}

describe('ConversationAvatarComponent group composite', () => {
    it('takes the two oldest members that have a picture', () => {
        const fixture = setup({
            conversation: conversation([
                member('user_a', 'Ada', '2026-02-01T00:00:00Z'),
                member('user_b', 'Bo', '2026-03-01T00:00:00Z'),
                member('user_c', 'Cy', '2026-04-01T00:00:00Z'),
            ]),
            cached: {
                user_a: profile('user_a', 'https://cdn/a.png'),
                user_b: profile('user_b', undefined),
                user_c: profile('user_c', 'https://cdn/c.png'),
            },
        });

        // Bo is skipped for having no picture, not for joining late.
        expect(tileImages(fixture)).toEqual([
            expect.stringContaining('https://cdn/a.png'),
            expect.stringContaining('https://cdn/c.png'),
        ]);
    });

    it('fills the second slot with the current user when only one member has a picture', () => {
        const fixture = setup({
            conversation: conversation([
                member('user_a', 'Ada', '2026-02-01T00:00:00Z'),
                member('user_b', 'Bo', '2026-03-01T00:00:00Z'),
            ]),
            cached: {user_a: profile('user_a', 'https://cdn/a.png')},
            ownAvatar: 'https://cdn/self.png',
        });

        expect(tileImages(fixture)).toEqual([
            expect.stringContaining('https://cdn/a.png'),
            expect.stringContaining('https://cdn/self.png'),
        ]);
    });

    it('falls back to an initial for the slot nobody can fill', () => {
        const fixture = setup({
            conversation: conversation([
                member('user_a', 'Ada', '2026-02-01T00:00:00Z'),
                member('user_b', 'Bo', '2026-03-01T00:00:00Z'),
            ]),
            cached: {user_a: profile('user_a', 'https://cdn/a.png')},
        });

        const tiles = [...fixture.nativeElement.querySelectorAll('.conv-tile')];

        expect(tileImages(fixture)).toEqual([expect.stringContaining('https://cdn/a.png')]);
        expect(tiles[1].querySelector('img')).toBeNull();
        expect(tiles[1].querySelector('.conv-tile-initial').textContent.trim()).toBe('B');
    });

    it('draws the single fallback avatar when nobody in reach has a picture', () => {
        const fixture = setup({
            conversation: conversation([
                member('user_a', 'Ada', '2026-02-01T00:00:00Z'),
                member('user_b', 'Bo', '2026-03-01T00:00:00Z'),
            ]),
        });

        expect(fixture.nativeElement.querySelector('.conv-stack')).toBeNull();
        expect(fixture.nativeElement.querySelector('app-avatar')).not.toBeNull();
    });

    it('re-picks past a picture that turns out to serve nothing', () => {
        const fixture = setup({
            conversation: conversation([
                member('user_a', 'Ada', '2026-02-01T00:00:00Z'),
                member('user_b', 'Bo', '2026-03-01T00:00:00Z'),
                member('user_c', 'Cy', '2026-04-01T00:00:00Z'),
            ]),
            cached: {
                // Every profile is minted an avatar URL, so all three look usable until one 404s.
                user_a: profile('user_a', 'https://cdn/a.png'),
                user_b: profile('user_b', 'https://cdn/b.png'),
                user_c: profile('user_c', 'https://cdn/c.png'),
            },
        });

        const failing = fixture.nativeElement.querySelectorAll('.conv-tile img')[1] as HTMLImageElement;
        failing.dispatchEvent(new Event('error'));
        fixture.detectChanges();

        expect(tileImages(fixture)).toEqual([
            expect.stringContaining('https://cdn/a.png'),
            expect.stringContaining('https://cdn/c.png'),
        ]);
    });

    it('prefers the group icon over any composite', () => {
        const fixture = setup({
            conversation: conversation(
                [
                    member('user_a', 'Ada', '2026-02-01T00:00:00Z'),
                    member('user_b', 'Bo', '2026-03-01T00:00:00Z'),
                ],
                '2026-08-17T19:24:49Z',
            ),
            cached: {
                user_a: profile('user_a', 'https://cdn/a.png'),
                user_b: profile('user_b', 'https://cdn/b.png'),
            },
        });

        expect(fixture.nativeElement.querySelector('.conv-stack')).toBeNull();
    });
});
