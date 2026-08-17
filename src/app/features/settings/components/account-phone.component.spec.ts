import {signal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {provideFakePlatform} from '../../../platform/testing/provide-fake-platform';
import {AccountPhoneComponent} from './account-phone.component';
import {ApiConfigService} from '../../../services/api-config.service';
import {SettingsUiService} from '../../../services/settings-ui.service';
import {UserService} from '../../../services/user.service';
import {AccountStatus, UserDto, UserType} from '../../../dtos/response/UserDto';

const BASE = 'https://api.test.example';
const PHONE_URL = `${BASE}/api/v1/identity/users/self/phone`;

/** Everything a test pokes at. All of it is `protected` on the component. */
interface Internals {
    stored(): string | null;
    loading(): boolean;
    draft: { set(value: string): void; (): string };
    problemKey(): string | null;
    canSave(): boolean;
    saving(): boolean;
    removing(): boolean;
    save(): Promise<void>;
    remove(): Promise<void>;
}

function makeUser(overrides: Partial<UserDto> = {}): UserDto {
    return {
        id: 'u1',
        email: 'me@example.com',
        userType: UserType.Standard,
        createdAt: new Date(),
        updatedAt: new Date(),
        birthDate: new Date(),
        phoneVerifiedAt: undefined,
        emailVerifiedAt: new Date(),
        ageVerification: undefined,
        encryptedMasterKey: undefined,
        steamId: undefined,
        status: AccountStatus.Active,
        deletionRequestedAt: undefined,
        purgeScheduledAt: undefined,
        ...overrides,
    };
}

function setup(self: UserDto | null) {
    TestBed.configureTestingModule({
        imports: [AccountPhoneComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            MessageService,
            // The real UserService is used deliberately (see below), and its chain reaches
            // MlsService -> MlsEngine. Inert fakes, since nothing on the phone path encrypts.
            provideFakePlatform(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
        ],
    });

    // The real service, minus its `getSelf` round trip: the point of the design is that this
    // component reads the profile somebody else already loaded rather than fetching a second copy,
    // and a test that stubbed the service could not observe that.
    const users = TestBed.inject(UserService);
    users.self.set(self);

    const fixture: ComponentFixture<AccountPhoneComponent> =
        TestBed.createComponent(AccountPhoneComponent);
    fixture.detectChanges();

    return {
        fixture,
        users,
        ctrl: TestBed.inject(HttpTestingController),
        settingsUi: TestBed.inject(SettingsUiService),
        api: fixture.componentInstance as unknown as Internals,
        html: () => fixture.nativeElement.textContent as string,
        find: (testId: string) =>
            fixture.nativeElement.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null,
    };
}

describe('AccountPhoneComponent', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    describe('reading the account', () => {
        it('fetches nothing of its own, because self is already loaded for it', () => {
            const {ctrl} = setup(makeUser({phoneNumber: '+41791234567'}));
            // The whole reason `phoneNumber` rides along on /users/self rather than getting its own
            // GET. A second read here would be one per settings visit for one string.
            ctrl.verify();
        });

        it('seeds the box with the number already on the account', () => {
            const {api} = setup(makeUser({phoneNumber: '+41791234567'}));

            expect(api.stored()).toBe('+41791234567');
            expect(api.draft()).toBe('+41791234567');
        });

        it('shows an empty box and says so when the account has none', () => {
            const {api, find} = setup(makeUser({phoneNumber: null}));

            expect(api.stored()).toBeNull();
            expect(api.draft()).toBe('');
            expect(find('phone-none')).not.toBeNull();
        });

        it('waits rather than rendering an empty box before self has landed', () => {
            // An empty field is a statement - "you have no number" - and it must not be made by a
            // component that has simply not been told yet.
            const {api, find} = setup(null);

            expect(api.loading()).toBe(true);
            expect(find('phone-none')).toBeNull();
        });

        it('re-seeds when the stored number changes underneath, as another device would do', () => {
            const {api, users, fixture} = setup(makeUser({phoneNumber: null}));

            users.self.set(makeUser({phoneNumber: '+41791234567'}));
            fixture.detectChanges();

            expect(api.draft()).toBe('+41791234567');
        });
    });

    describe('validation before the write', () => {
        it('offers no save for an empty box, and does not call that an error', () => {
            const {api} = setup(makeUser({phoneNumber: null}));

            expect(api.canSave()).toBe(false);
            expect(api.problemKey()).toBeNull();
        });

        it('names the missing + rather than saying invalid', () => {
            const {api, fixture} = setup(makeUser({phoneNumber: null}));
            api.draft.set('079 123 45 67');
            fixture.detectChanges();

            expect(api.problemKey()).toBe('ACCOUNT.PHONE.PROBLEM.NO_PLUS');
            expect(api.canSave()).toBe(false);
        });

        it('refuses a leading 00 instead of rewriting it', () => {
            // The rule this feature would most plausibly be "fixed" to break. Rewriting 00 to + is
            // wrong in enough countries to store a stranger's number, and nothing verifies the
            // result.
            const {api, fixture} = setup(makeUser({phoneNumber: null}));
            api.draft.set('0041791234567');
            fixture.detectChanges();

            expect(api.problemKey()).toBe('ACCOUNT.PHONE.PROBLEM.NO_PLUS');
            expect(api.canSave()).toBe(false);
        });

        it('accepts the separators a pasted contact card carries', () => {
            const {api, fixture} = setup(makeUser({phoneNumber: null}));
            api.draft.set('+41 79 123 45 67');
            fixture.detectChanges();

            expect(api.problemKey()).toBeNull();
            expect(api.canSave()).toBe(true);
        });

        it('will not save a number that is already the stored one', () => {
            // Re-submitting is a success server-side, so this costs nothing but noise. It also stops
            // the button reading as if there were something unsaved.
            const {api, fixture} = setup(makeUser({phoneNumber: '+41791234567'}));
            api.draft.set('+41 79 123 45 67');
            fixture.detectChanges();

            expect(api.canSave()).toBe(false);
        });
    });

    describe('writing', () => {
        it('PUTs the normalised form, not the typed form', async () => {
            const {api, ctrl, fixture} = setup(makeUser({phoneNumber: null}));
            api.draft.set('+41 79 123 45 67');
            fixture.detectChanges();

            const done = api.save();
            const req = ctrl.expectOne(PHONE_URL);
            expect(req.request.method).toBe('PUT');
            expect(req.request.body).toEqual({phoneNumber: '+41791234567'});
            req.flush({phoneNumber: '+41791234567'});
            await done;

            expect(api.stored()).toBe('+41791234567');
        });

        it('leaves the stored number alone when the write is refused', async () => {
            const {api, ctrl, fixture} = setup(makeUser({phoneNumber: '+41791234567'}));
            api.draft.set('+15550104477');
            fixture.detectChanges();

            const done = api.save();
            ctrl.expectOne(PHONE_URL).flush('nope', {status: 400, statusText: 'Bad Request'});
            await done;

            // A failed write that left the new number on screen as if it had stuck would be a lie
            // about who can reach this person.
            expect(api.stored()).toBe('+41791234567');
            expect(api.saving()).toBe(false);
        });

        it('DELETEs and clears, so changing your mind is one press', async () => {
            const {api, ctrl} = setup(makeUser({phoneNumber: '+41791234567'}));

            const done = api.remove();
            const req = ctrl.expectOne(PHONE_URL);
            expect(req.request.method).toBe('DELETE');
            req.flush(null, {status: 204, statusText: 'No Content'});
            await done;

            expect(api.stored()).toBeNull();
            expect(api.removing()).toBe(false);
        });

        it('offers no remove when there is nothing to remove', () => {
            const {find} = setup(makeUser({phoneNumber: null}));
            expect(find('phone-remove')).toBeNull();
        });

        it('offers remove as a visible button whenever there is a number', () => {
            const {find} = setup(makeUser({phoneNumber: '+41791234567'}));
            expect(find('phone-remove')).not.toBeNull();
        });
    });

    describe('the deep link from the sharing toggle', () => {
        it('claims the phone anchor so a second page cannot also act on it', () => {
            const {settingsUi, fixture} = setup(makeUser({phoneNumber: null}));

            settingsUi.open('profile', 'phone');
            fixture.detectChanges();

            expect(settingsUi.requestedAnchor()).toBeNull();
        });

        it('ignores an anchor meant for something else', () => {
            const {settingsUi, fixture} = setup(makeUser({phoneNumber: null}));

            settingsUi.open('profile', 'avatar');
            fixture.detectChanges();

            expect(settingsUi.requestedAnchor()).toBe('avatar');
        });
    });
});
