import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {afterEach, describe, expect, it} from 'vitest';
import {ProfileSettingsComponent} from './profile-settings.component';
import {ApiConfigService} from '../../../../../services/api-config.service';
import {ProfileService} from '../../../../../services/profile.service';
import {provideFakePlatform} from '../../../../../platform/testing/provide-fake-platform';
import {AccountStatus, UserDto, UserType} from '../../../../../dtos/response/UserDto';
import {OnlineStatus, ProfileDto, ProfileFont} from '../../../../../dtos/response/profile.dto';

const BASE = 'https://api.test.example';
const SELF_URL = `${BASE}/api/v1/identity/users/self`;

const REMAINING_SECTIONS = ['Account', 'Connections', 'Sessions', 'Change Password', 'Danger Zone'];
const REMOVED_SECTIONS = ['Profile Overview', 'Banner', 'Display', 'Avatar'];

function makeUser(overrides: Partial<UserDto> = {}): UserDto {
    return {
        id: 'u1',
        email: 'me@example.com',
        userType: UserType.Standard,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        birthDate: new Date(0),
        phoneVerifiedAt: undefined,
        emailVerifiedAt: new Date(0),
        ageVerification: undefined,
        encryptedMasterKey: undefined,
        steamId: undefined,
        status: AccountStatus.Active,
        deletionRequestedAt: undefined,
        purgeScheduledAt: undefined,
        ...overrides,
    };
}

function makeProfile(overrides: Partial<ProfileDto> = {}): ProfileDto {
    return {
        id: 'p1',
        createdAt: new Date(0),
        updatedAt: new Date(0),
        userName: 'someone',
        bio: undefined,
        userId: 'u1',
        avatarUrl: undefined,
        bannerUrl: undefined,
        accentColor: null,
        font: ProfileFont.Default,
        onlineStatus: OnlineStatus.Online,
        ...overrides,
    };
}

function render(profile: ProfileDto | undefined = makeProfile()): {
    fixture: ComponentFixture<ProfileSettingsComponent>;
    ctrl: HttpTestingController;
} {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            MessageService,
            provideFakePlatform(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
        ],
    });

    TestBed.inject(ProfileService).ownProfile.set(profile);

    const fixture = TestBed.createComponent(ProfileSettingsComponent);
    fixture.detectChanges();

    const ctrl = TestBed.inject(HttpTestingController);
    ctrl.expectOne(SELF_URL).flush(makeUser());
    fixture.detectChanges();

    return {fixture, ctrl};
}

function headings(fixture: ComponentFixture<ProfileSettingsComponent>): (string | undefined)[] {
    return Array.from(fixture.nativeElement.querySelectorAll('h2')).map(el =>
        (el as HTMLElement).textContent?.trim(),
    );
}

describe('ProfileSettingsComponent', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('mounts without throwing, with or without a profile loaded yet', () => {
        expect(() => render(undefined)).not.toThrow();
    });

    it('renders exactly the sections that still belong here', () => {
        const {fixture} = render();
        expect(headings(fixture)).toEqual(REMAINING_SECTIONS);
    });

    it('does not render the sections the profile page now owns', () => {
        const {fixture} = render();
        const text = headings(fixture);
        for (const removed of REMOVED_SECTIONS) {
            expect(text).not.toContain(removed);
        }
    });
});
