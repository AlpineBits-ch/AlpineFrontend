import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {beforeEach, describe, expect, it} from 'vitest';
import {ProfileMutualLineComponent} from './profile-mutual-line.component';
import {ProfileService} from '../../services/profile.service';
import {OsInfo} from '../../platform/ports/os-info.port';
import {ProfileDto, ProfileFont, OnlineStatus} from '../../dtos/response/profile.dto';

function profile(overrides: Partial<ProfileDto> = {}): ProfileDto {
    return {
        id: 'prfl_1',
        createdAt: new Date(0),
        updatedAt: new Date(0),
        userName: 'subject',
        bio: undefined,
        userId: 'user-subject',
        avatarUrl: undefined,
        bannerUrl: undefined,
        accentColor: null,
        font: ProfileFont.Default,
        onlineStatus: OnlineStatus.Online,
        ...overrides,
    };
}

/**
 * The visibility contract: a field the viewer may not see is absent from the payload entirely, and
 * an empty array means there are none. Neither may render a count.
 */
describe('ProfileMutualLineComponent', () => {
    let fixture: ComponentFixture<ProfileMutualLineComponent>;

    function render(p: ProfileDto): string {
        fixture.componentRef.setInput('profile', p);
        fixture.detectChanges();
        return fixture.nativeElement.textContent ?? '';
    }

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                provideTranslateService(),
                {
                    provide: ProfileService,
                    useValue: {getCachedByUserId: () => undefined, resolveByUserId: () => undefined},
                },
                {provide: OsInfo, useValue: {isMobile: false}},
            ],
        });
        fixture = TestBed.createComponent(ProfileMutualLineComponent);
    });

    it('draws nothing when both keys are absent', () => {
        expect(render(profile()).trim()).toBe('');
    });

    it('draws nothing when both lists are present but empty', () => {
        expect(render(profile({mutualFriends: [], mutualServers: []})).trim()).toBe('');
    });

    it('shows only the friends half when servers are not visible', () => {
        const text = render(
            profile({
                mutualFriends: [{profileId: 'prfl_2', userId: 'user-2', userName: 'ann'}],
            }),
        );

        expect(text).toContain('PROFILE.MUTUAL_FRIENDS');
        expect(text).not.toContain('PROFILE.MUTUAL_SERVERS');
    });

    it('shows only the servers half when friends are not visible', () => {
        const text = render(profile({mutualServers: [{guildId: 'gld_1', name: 'Alpha'}]}));

        expect(text).toContain('PROFILE.MUTUAL_SERVERS');
        expect(text).not.toContain('PROFILE.MUTUAL_FRIENDS');
    });

    it('caps the avatar stack at three however many friends there are', () => {
        render(
            profile({
                mutualFriends: Array.from({length: 7}, (_, i) => ({
                    profileId: `prfl_${i}`,
                    userId: `user-${i}`,
                    userName: `friend-${i}`,
                })),
            }),
        );

        expect(fixture.nativeElement.querySelectorAll('app-avatar')).toHaveLength(3);
    });

    it('raises a separate event per half', () => {
        const seen: string[] = [];
        fixture.componentRef.setInput(
            'profile',
            profile({
                mutualFriends: [{profileId: 'prfl_2', userId: 'user-2', userName: 'ann'}],
                mutualServers: [{guildId: 'gld_1', name: 'Alpha'}],
            }),
        );
        fixture.componentInstance.friendsClick.subscribe(() => seen.push('friends'));
        fixture.componentInstance.serversClick.subscribe(() => seen.push('servers'));
        fixture.detectChanges();

        const buttons = fixture.nativeElement.querySelectorAll('button');
        buttons[0].click();
        buttons[1].click();

        expect(seen).toEqual(['friends', 'servers']);
    });
});
