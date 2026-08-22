import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection, signal} from '@angular/core';
import {provideTranslateService} from '@ngx-translate/core';
import {ProfilePageComponent} from './profile-page.component';
import {ProfileService} from '../../../services/profile.service';
import {provideFakePlatform} from '../../../platform/testing/provide-fake-platform';
import {OnlineStatus, ProfileDto, ProfileFont} from '../../../dtos/response/profile.dto';

const OWN: ProfileDto = {
    id: 'prfl_own',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    userName: 'fakePilotDominic',
    bio: undefined,
    userId: 'user-own',
    avatarUrl: undefined,
    bannerUrl: 'https://cdn.test.example/banner.png',
    accentColor: '#336699',
    font: ProfileFont.Default,
    onlineStatus: OnlineStatus.Online,
};

function setup(ownProfile: ProfileDto | undefined) {
    TestBed.configureTestingModule({
        imports: [ProfilePageComponent],
        providers: [
            provideZonelessChangeDetection(),
            provideTranslateService(),
            provideFakePlatform(),
            {
                provide: ProfileService,
                useValue: {
                    ownProfile: signal(ownProfile),
                    getCachedByUserId: () => ownProfile,
                    resolveByUserId: () => undefined,
                },
            },
        ],
    });

    const fixture: ComponentFixture<ProfilePageComponent> = TestBed.createComponent(ProfilePageComponent);
    fixture.detectChanges();
    return fixture;
}

function text(fixture: ComponentFixture<unknown>): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

describe('ProfilePageComponent', () => {
    afterEach(() => TestBed.resetTestingModule());

    it("renders the own profile's banner, avatar and name", () => {
        const fixture = setup(OWN);
        const el = fixture.nativeElement as HTMLElement;

        expect(text(fixture)).toContain('fakePilotDominic');
        expect(el.querySelector('app-avatar')).not.toBeNull();
        expect(el.querySelector('img[alt=""]')?.getAttribute('src')).toContain('banner.png');
    });

    it('shows a loading state instead of throwing when there is no profile yet', () => {
        let fixture!: ComponentFixture<ProfilePageComponent>;
        expect(() => (fixture = setup(undefined))).not.toThrow();

        expect(fixture.nativeElement.querySelector('app-avatar')).toBeNull();
        expect(text(fixture)).not.toContain('fakePilotDominic');
        expect(fixture.nativeElement.querySelector('[role="status"]')).not.toBeNull();
    });
});
