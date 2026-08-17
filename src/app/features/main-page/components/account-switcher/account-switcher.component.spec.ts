/** The switcher list itself. */
import {TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {AccountSwitcherComponent} from './account-switcher.component';
import {AccountRegistryService, AccountSlot} from '../../../../services/account-registry.service';
import {AccountSwitchService, SwitchEnvironment} from '../../../../services/account-switch.service';
import {CallSessionService} from '../../../../services/call-session.service';

function slot(over: Partial<AccountSlot> & {id: string}): AccountSlot {
    return {
        userId: `user-${over.id}`,
        serverUrl: 'https://venta.gg',
        username: over.id,
        displayName: over.id,
        avatarUrl: null,
        lastUsedAt: 0,
        ...over,
    };
}

let slots: ReturnType<typeof signal<AccountSlot[]>>;
let activeId: ReturnType<typeof signal<string | null>>;
let session: ReturnType<typeof signal<unknown>>;
let switched: string[];
let switchResult: boolean;
let environment: SwitchEnvironment;

function build(): AccountSwitcherComponent {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [TranslateModule.forRoot()],
        providers: [
            {
                provide: AccountRegistryService,
                useValue: {
                    slots: slots.asReadonly(),
                    activeSlotIdSnapshot: activeId.asReadonly(),
                    list: async () => slots(),
                },
            },
            {
                provide: AccountSwitchService,
                useValue: {
                    environment,
                    switchTo: async (id: string) => {
                        switched.push(id);
                        return switchResult;
                    },
                    beginAddAccount: () => {
                        switched.push('add');
                    },
                },
            },
            {provide: CallSessionService, useValue: {session}},
        ],
    });
    const fixture = TestBed.createComponent(AccountSwitcherComponent);
    fixture.detectChanges();
    return fixture.componentInstance;
}

function inner(component: AccountSwitcherComponent) {
    return component as unknown as {
        others: () => AccountSlot[];
        busy: () => boolean;
        choose: (s: AccountSlot) => Promise<void>;
        serverLabel: (s: AccountSlot) => string;
        initial: (s: AccountSlot) => string;
    };
}

beforeEach(() => {
    slots = signal<AccountSlot[]>([slot({id: 'a'}), slot({id: 'b'})]);
    activeId = signal<string | null>('a');
    session = signal<unknown>(null);
    switched = [];
    switchResult = true;
    environment = {
        reenter: () => {},
        callIsLive: () => false,
        confirmLeaveCall: async () => true,
    };
});

it('lists every account except the one that is live', () => {
    const component = build();

    expect(
        inner(component)
            .others()
            .map(s => s.id),
    ).toEqual(['b']);
});

it('lists nothing when this is the only account', () => {
    slots.set([slot({id: 'a'})]);

    expect(inner(build()).others()).toEqual([]);
});

it('switches to the chosen account', async () => {
    const component = build();

    await inner(component).choose(slot({id: 'b'}));

    expect(switched).toEqual(['b']);
});

it('cannot be clicked twice into two reloads', async () => {
    const component = build();
    // Never resolves, standing in for a switch that has committed and is reloading.
    TestBed.inject(AccountSwitchService).switchTo = async (id: string) => {
        switched.push(id);
        return new Promise<boolean>(() => false as never);
    };

    void inner(component).choose(slot({id: 'b'}));
    void inner(component).choose(slot({id: 'b'}));

    expect(switched).toEqual(['b']);
});

it('becomes clickable again when a switch is refused', async () => {
    const component = build();
    switchResult = false;

    await inner(component).choose(slot({id: 'b'}));

    // A successful switch reloads, so nothing runs again. Only a refused one comes back, and that
    // is precisely the case that has to be retryable.
    expect(inner(component).busy()).toBe(false);
    await inner(component).choose(slot({id: 'b'}));
    expect(switched).toEqual(['b', 'b']);
});

describe('the live-call check', () => {
    it('is wired, so a switch cannot silently drop a call', () => {
        build();

        session.set({id: 'call-1'});

        // The service default is "no call". Left unwired, every switch during a call would reload
        // the process without asking.
        expect(environment.callIsLive()).toBe(true);
    });

    it('reports no call when there is none', () => {
        build();

        expect(environment.callIsLive()).toBe(false);
    });
});

describe('labels', () => {
    it('shows the host, so one username on two servers stays distinguishable', () => {
        const component = build();

        expect(inner(component).serverLabel(slot({id: 'a', serverUrl: 'https://self.example:8443'}))).toBe(
            'self.example:8443',
        );
    });

    it('falls back to the raw value for a server url it cannot parse', () => {
        const component = build();

        expect(inner(component).serverLabel(slot({id: 'a', serverUrl: 'not a url'}))).toBe('not a url');
    });

    it('uses the first letter for an account with no avatar', () => {
        const component = build();

        expect(inner(component).initial(slot({id: 'a', username: 'ada'}))).toBe('A');
    });

    it('does not crash on an account whose name has not arrived yet', () => {
        const component = build();

        expect(inner(component).initial(slot({id: 'a', username: '', displayName: ''}))).toBe('?');
    });
});
