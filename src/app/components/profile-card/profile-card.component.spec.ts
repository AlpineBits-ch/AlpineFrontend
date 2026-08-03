import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection} from '@angular/core';
import {ProfileCardComponent} from './profile-card.component';
import {OnlineStatus, ProfileDto, ProfileFont} from '../../dtos/response/profile.dto';

/**
 * The API mints an avatar and a banner URL for every profile whether or not an image was
 * ever uploaded, so both fields arrive populated and only the request tells you otherwise.
 */
const PROFILE: ProfileDto = {
    id: 'prfl_1',
    userId: 'usr_1',
    userName: 'ada',
    bio: undefined,
    avatarUrl: 'https://api.example/api/v1/social/profiles/prfl_1/avatar',
    bannerUrl: 'https://api.example/api/v1/social/profiles/prfl_1/banner',
    accentColor: '#5865F2',
    font: ProfileFont.Default,
    createdAt: new Date('2020-01-01T00:00:00Z'),
    updatedAt: new Date('2020-01-02T00:00:00Z'),
    onlineStatus: OnlineStatus.Online,
};

function setup(profile: ProfileDto = PROFILE): {
    fixture: ComponentFixture<ProfileCardComponent>;
    banner: () => HTMLImageElement | null;
    bannerBox: () => HTMLElement;
} {
    TestBed.configureTestingModule({
        imports: [ProfileCardComponent],
        providers: [provideZonelessChangeDetection()],
    });

    const fixture = TestBed.createComponent(ProfileCardComponent);
    fixture.componentRef.setInput('profile', profile);
    fixture.detectChanges();

    const host = (): HTMLElement => fixture.nativeElement as HTMLElement;

    return {
        fixture,
        banner: () => host().querySelector<HTMLImageElement>('.profile-banner-img'),
        bannerBox: () => host().querySelector<HTMLElement>('.profile-banner')!,
    };
}

describe('ProfileCardComponent banner', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('retires the banner image once the URL turns out to serve nothing', () => {
        const {fixture, banner} = setup();
        expect(banner()).not.toBeNull();

        banner()!.dispatchEvent(new Event('error'));
        fixture.detectChanges();

        // Left in place, the element is the browser's broken-image glyph.
        expect(banner()).toBeNull();
    });

    it('shows the accent colour in place of a banner that failed to load', () => {
        const {fixture, banner, bannerBox} = setup();

        banner()!.dispatchEvent(new Event('error'));
        fixture.detectChanges();

        expect(bannerBox().style.background).toContain('rgb(88, 101, 242)');
    });

    it('keeps a banner that loads', () => {
        const {banner} = setup();

        expect(banner()).not.toBeNull();
        expect(banner()!.getAttribute('src')).toContain('/banner');
    });
});
