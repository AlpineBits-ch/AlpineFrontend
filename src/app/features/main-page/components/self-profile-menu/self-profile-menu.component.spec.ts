/** What the menu decides for itself: which face is showing, and which rows exist. */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection, signal} from '@angular/core';
import {of} from 'rxjs';
import {TranslateModule} from '@ngx-translate/core';
import {SelfProfileMenuComponent} from './self-profile-menu.component';
import {ProfileService} from '../../../../services/profile.service';
import {UserService} from '../../../../services/user.service';
import {AccountRegistryService} from '../../../../services/account-registry.service';
import {AccountSwitchService} from '../../../../services/account-switch.service';
import {CallSessionService} from '../../../../services/call-session.service';
import {BrokenImageService} from '../../../../services/broken-image.service';
import {UserType} from '../../../../dtos/response/UserDto';
import {OnlineStatus} from '../../../../dtos/response/profile.dto';

const OWN = {
    userId: 'me',
    userName: 'fakePilotDominic',
    onlineStatus: OnlineStatus.Hidden,
    createdAt: new Date().toISOString(),
};

function setup(options: {userType?: UserType; slots?: {id: string}[]} = {}) {
    const setSelfStatus = vi.fn(() => of(undefined));
    const slots = signal(options.slots ?? [{id: 'active'}]);

    TestBed.configureTestingModule({
        imports: [SelfProfileMenuComponent, TranslateModule.forRoot()],
        providers: [
            provideZonelessChangeDetection(),
            {provide: ProfileService, useValue: {ownProfile: signal(OWN), setSelfStatus}},
            {
                provide: UserService,
                useValue: {self: signal({userType: options.userType ?? UserType.Standard})},
            },
            {
                provide: AccountRegistryService,
                useValue: {slots, activeSlotIdSnapshot: () => 'active', list: vi.fn()},
            },
            {provide: AccountSwitchService, useValue: {environment: {}, switchTo: vi.fn()}},
            {provide: CallSessionService, useValue: {session: () => null}},
            {provide: BrokenImageService, useValue: {isBroken: () => false, markBroken: vi.fn()}},
        ],
    });

    const fixture: ComponentFixture<SelfProfileMenuComponent> =
        TestBed.createComponent(SelfProfileMenuComponent);
    fixture.detectChanges();
    return {fixture, setSelfStatus};
}

function text(fixture: ComponentFixture<SelfProfileMenuComponent>): string {
    fixture.detectChanges();
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

/** The menu's own view state, which the host resets when the popover closes. */
function view(fixture: ComponentFixture<SelfProfileMenuComponent>): string {
    return (fixture.componentInstance as unknown as {view: () => string}).view();
}

function show(fixture: ComponentFixture<SelfProfileMenuComponent>, next: string): void {
    (fixture.componentInstance as unknown as {show: (v: string) => void}).show(next);
    fixture.detectChanges();
}

describe('SelfProfileMenuComponent', () => {
    afterEach(() => TestBed.resetTestingModule());

    it('opens on the root view', () => {
        const {fixture} = setup();
        expect(view(fixture)).toBe('root');
    });

    it('swaps to the status view and back', () => {
        const {fixture} = setup();

        show(fixture, 'status');
        expect(view(fixture)).toBe('status');

        show(fixture, 'root');
        expect(view(fixture)).toBe('root');
    });

    /** Reopening halfway inside a submenu would be a state the user never asked to return to. */
    it('resets to root when the host closes it', () => {
        const {fixture} = setup();
        show(fixture, 'accounts');

        fixture.componentInstance.reset();

        expect(view(fixture)).toBe('root');
    });

    it('hides the admin row from ordinary users', () => {
        const {fixture} = setup({userType: UserType.Standard});
        expect(text(fixture)).not.toContain('ADMIN_PANEL');
    });

    it('shows the admin row to admins', () => {
        const {fixture} = setup({userType: UserType.Admin});
        expect(text(fixture)).toContain('ADMIN_PANEL');
    });

    /** A submenu holding a single button is worse than the button. */
    it('offers Add Account directly when this is the only account', () => {
        const {fixture} = setup({slots: [{id: 'active'}]});

        expect(text(fixture)).toContain('ACCOUNTS.ADD');
        expect(text(fixture)).not.toContain('SWITCH_ACCOUNTS');
    });

    it('offers the switcher once there is somewhere to switch to', () => {
        const {fixture} = setup({slots: [{id: 'active'}, {id: 'other'}]});

        expect(text(fixture)).toContain('SWITCH_ACCOUNTS');
    });

    it('names the current status on the root row', () => {
        const {fixture} = setup();
        expect(text(fixture)).toContain('STATUS.INVISIBLE');
    });

    it('sets the chosen status and returns to root', () => {
        const {fixture, setSelfStatus} = setup();
        show(fixture, 'status');

        (fixture.componentInstance as unknown as {chooseStatus: (s: OnlineStatus) => void}).chooseStatus(
            OnlineStatus.Idle,
        );
        fixture.detectChanges();

        expect(setSelfStatus).toHaveBeenCalledWith(OnlineStatus.Idle);
        expect(view(fixture)).toBe('root');
    });
});
