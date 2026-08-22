import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {provideTranslateService} from '@ngx-translate/core';
import {MutualsWidgetComponent} from './mutuals-widget.component';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {MutualFriendSummary, OnlineStatus, ProfileDto, ProfileFont} from '../../../dtos/response/profile.dto';
import {ProfileService} from '../../../services/profile.service';
import {OsInfo} from '../../../platform/ports/os-info.port';

function owner(mutualFriends?: MutualFriendSummary[]): ProfileDto {
    return {
        id: 'p1',
        userId: 'u1',
        userName: 'Nova',
        bio: undefined,
        avatarUrl: undefined,
        bannerUrl: undefined,
        accentColor: null,
        font: ProfileFont.Default,
        createdAt: new Date(),
        updatedAt: new Date(),
        onlineStatus: OnlineStatus.Online,
        mutualFriends,
    };
}

function render(profile: ProfileDto) {
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
    const fixture = TestBed.createComponent(MutualsWidgetComponent);
    const widget: CanvasWidgetDto = {
        id: 'a',
        type: 'mutuals',
        x: 0,
        y: 0,
        w: 2,
        h: 1,
        visibility: 'everyone',
        card: false,
        config: {},
    };
    fixture.componentRef.setInput('widget', widget);
    fixture.componentRef.setInput('owner', profile);
    fixture.detectChanges();
    return fixture;
}

describe('MutualsWidgetComponent', () => {
    it('draws a face per mutual, up to four', () => {
        const friends = Array.from({length: 6}, (_, i) => ({
            profileId: `p${i}`,
            userId: `u${i}`,
            userName: `friend${i}`,
        }));
        const fixture = render(owner(friends));
        expect(fixture.nativeElement.querySelectorAll('app-avatar')).toHaveLength(4);
    });

    it('renders nothing when the viewer may not see mutuals', () => {
        const fixture = render(owner(undefined));
        expect(fixture.nativeElement.textContent.trim()).toBe('');
    });

    it('renders nothing when there are no mutuals', () => {
        const fixture = render(owner([]));
        expect(fixture.nativeElement.textContent.trim()).toBe('');
    });
});
