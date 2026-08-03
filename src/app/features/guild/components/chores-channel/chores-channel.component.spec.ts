import {signal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {of} from 'rxjs';
import {describe, expect, it} from 'vitest';

import {ChoresChannelComponent} from './chores-channel.component';
import {ChoreService} from '../../../../services/chore.service';
import {GuildService} from '../../../../services/guild.service';
import {ProfileService} from '../../../../services/profile.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {ChannelDto, ChannelType, GuildDto} from '../../../../dtos/response/guild.dto';
import {Chore, ChoreBalanceEntry, ChoreOccurrence} from '../../../../dtos/response/chore.dto';

function channelFixture(): ChannelDto {
    return {
        id: 'c1',
        createdAt: new Date(0),
        updatedAt: new Date(0),
        name: 'chores',
        description: '',
        type: ChannelType.Chores,
        guildId: 'g1',
        isAgeRestricted: false,
        isPrivate: false,
        categoryId: undefined,
        permissions: [],
        position: 0,
        slowModeSeconds: 0,
        parentChannelId: undefined,
    };
}

function choreFixture(overrides: Partial<Chore> = {}): Chore {
    return {
        id: 'chor_1',
        channelId: 'c1',
        title: 'Washing-up',
        description: null,
        intervalDays: 1,
        anchorAt: '2026-08-01T18:00:00.000Z',
        effortMinutes: 15,
        rotationRoleId: 'role_flatmates',
        fixedAssigneeUserId: null,
        graceHours: 12,
        isPaused: false,
        nextDueAt: '2026-08-04T18:00:00.000Z',
        ...overrides,
    };
}

function occurrenceFixture(overrides: Partial<ChoreOccurrence> = {}): ChoreOccurrence {
    return {
        id: 'occr_1',
        choreId: 'chor_1',
        channelId: 'c1',
        title: 'Washing-up',
        dueAt: '2026-08-03T18:00:00.000Z',
        assignedUserId: 'user_anna',
        effortMinutes: 15,
        completedAt: null,
        completedByUserId: null,
        skippedAt: null,
        isOverdue: false,
        ...overrides,
    };
}

function setup(opts: {
    features?: string;
    rolePermissions?: string;
    chores?: Chore[];
    occurrences?: ChoreOccurrence[];
    balance?: ChoreBalanceEntry[];
} = {}) {
    const guild = {
        id: 'g1',
        ownerId: 'someone-else',
        features: opts.features ?? 'Chores',
        roles: [{id: 'role_flatmates', name: 'Flatmates'}],
        channels: [],
    } as unknown as GuildDto;

    const choreService = {
        stateFor: () => ({
            chores: opts.chores ?? [choreFixture()],
            occurrences: opts.occurrences ?? [],
            balance: opts.balance ?? [],
            loading: false,
            loadedAt: 1,
            error: false,
            forbidden: false,
        }),
        loadFor: () => undefined,
        complete: () => of(null),
        unComplete: () => of(null),
        skip: () => of(null),
        swap: () => of(null),
        createChore: () => of(choreFixture()),
        updateChore: () => of(choreFixture()),
        deleteChore: () => of(undefined),
    };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [ChoresChannelComponent],
        providers: [
            provideTranslateService({defaultLanguage: 'en'}),
            MessageService,
            {provide: ChoreService, useValue: choreService},
            {provide: NavigationService, useValue: {mobileNavOpen: signal(false)}},
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'user_ben'}), getCachedByUserId: () => undefined}},
            {
                provide: GuildService,
                useValue: {
                    guilds: signal([guild]),
                    getOwnMember: () => of({
                        permissions: '',
                        roleMembers: [{role: {permissions: opts.rolePermissions ?? 'ViewChannel,ManageChores,CompleteChores'}}],
                    }),
                    getMembers: () => of([
                        {userId: 'user_anna', nickname: 'Anna', profile: {userName: 'anna'}},
                        {userId: 'user_ben', nickname: 'Ben', profile: {userName: 'ben'}},
                    ]),
                },
            },
        ],
    });

    const fixture: ComponentFixture<ChoresChannelComponent> = TestBed.createComponent(ChoresChannelComponent);
    fixture.componentRef.setInput('channel', channelFixture());
    fixture.detectChanges();
    return fixture;
}

/** Untranslated keys render as themselves, so assertions read against the key. */
function text(fixture: ComponentFixture<ChoresChannelComponent>): string {
    return fixture.nativeElement.textContent as string;
}

describe('ChoresChannelComponent module gate', () => {
    it('says the house does not run a rota rather than accusing the user, when the module is off', () => {
        // §10.2: a 403 from a household endpoint usually means the module is off, and the owner is
        // not exempt. Reading `features` first is what lets this say the right sentence.
        const fixture = setup({features: 'VoiceChannels'});
        expect(text(fixture)).toContain('CHORES.MODULE_OFF_TITLE');
        expect(text(fixture)).not.toContain('CHORES.BALANCE_TITLE');
    });

    it('renders the board when the module is on', () => {
        const fixture = setup({occurrences: [occurrenceFixture()]});
        expect(text(fixture)).toContain('Washing-up');
        expect(text(fixture)).not.toContain('CHORES.MODULE_OFF_TITLE');
    });
});

describe('ChoresChannelComponent skipping is not completing', () => {
    it('files a skipped turn under Skipped and never under Done', () => {
        const fixture = setup({
            occurrences: [occurrenceFixture({skippedAt: '2026-08-03T19:12:00.000Z'})],
        });

        expect(text(fixture)).toContain('CHORES.SECTION_SKIPPED');
        // The Done section is not rendered at all, because nothing here is done.
        expect(text(fixture)).not.toContain('CHORES.SECTION_DONE');
    });

    it('explains that the work is still owed, which is why the rota returns', () => {
        const fixture = setup({
            occurrences: [occurrenceFixture({skippedAt: '2026-08-03T19:12:00.000Z'})],
        });
        expect(text(fixture)).toContain('CHORES.SKIPPED_HINT');
    });

    it('does not strike a skipped turn through the way a completed one is', () => {
        const skipped = setup({
            occurrences: [occurrenceFixture({skippedAt: '2026-08-03T19:12:00.000Z'})],
        });
        expect(skipped.nativeElement.querySelector('.line-through')).toBe(null);

        const done = setup({
            occurrences: [occurrenceFixture({
                completedAt: '2026-08-03T19:12:00.000Z',
                completedByUserId: 'user_anna',
            })],
        });
        expect(done.nativeElement.querySelector('.line-through')).not.toBe(null);
    });

    it('still shows a skipped turn as assigned, not as finished by anyone', () => {
        const fixture = setup({
            occurrences: [occurrenceFixture({skippedAt: '2026-08-03T19:12:00.000Z'})],
        });
        expect(text(fixture)).toContain('CHORES.ASSIGNED_TO');
        expect(text(fixture)).not.toContain('CHORES.DONE_BY');
    });
});

describe('ChoresChannelComponent doer versus assignee', () => {
    it('names both when someone did another member\'s turn', () => {
        const fixture = setup({
            occurrences: [occurrenceFixture({
                assignedUserId: 'user_anna',
                completedByUserId: 'user_ben',
                completedAt: '2026-08-03T19:12:00.000Z',
            })],
        });

        // "Ben did Anna's washing-up", plus the credit line - the balance credits the assignee,
        // so collapsing these into one name would credit the wrong flatmate on screen.
        expect(text(fixture)).toContain('CHORES.DONE_BY_PROXY');
        expect(text(fixture)).toContain('CHORES.CREDITED_TO');
    });

    it('uses the single-name form when the assignee did their own turn', () => {
        const fixture = setup({
            occurrences: [occurrenceFixture({
                assignedUserId: 'user_anna',
                completedByUserId: 'user_anna',
                completedAt: '2026-08-03T19:12:00.000Z',
            })],
        });

        expect(text(fixture)).not.toContain('CHORES.DONE_BY_PROXY');
        expect(text(fixture)).not.toContain('CHORES.CREDITED_TO');
    });
});

describe('ChoresChannelComponent balance', () => {
    it('reads a negative balance as behind their share, not as a total', () => {
        const fixture = setup({
            balance: [{userId: 'user_anna', completedMinutes: 30, completedCount: 2, balanceMinutes: -45}],
        });
        expect(text(fixture)).toContain('CHORES.BALANCE_BEHIND');
        expect(text(fixture)).not.toContain('CHORES.BALANCE_AHEAD');
    });

    it('reads a positive balance as ahead of their share', () => {
        const fixture = setup({
            balance: [{userId: 'user_anna', completedMinutes: 90, completedCount: 6, balanceMinutes: 45}],
        });
        expect(text(fixture)).toContain('CHORES.BALANCE_AHEAD');
        expect(text(fixture)).not.toContain('CHORES.BALANCE_BEHIND');
    });

    it('says in copy that the rota is not round-robin', () => {
        const fixture = setup();
        expect(text(fixture)).toContain('CHORES.BALANCE_EXPLAINER');
    });

    it('never renders a bare minus sign as the standing', () => {
        const fixture = setup({
            balance: [{userId: 'user_anna', completedMinutes: 30, completedCount: 2, balanceMinutes: -45}],
        });
        expect(text(fixture)).not.toContain('-45');
    });
});

describe('ChoresChannelComponent permissions', () => {
    it('offers no verbs without CompleteChores', () => {
        const fixture = setup({
            rolePermissions: 'ViewChannel',
            occurrences: [occurrenceFixture()],
        });
        expect(fixture.nativeElement.querySelector('.pi-check')).toBe(null);
    });

    it('offers the verbs with CompleteChores', () => {
        const fixture = setup({
            rolePermissions: 'ViewChannel,CompleteChores',
            occurrences: [occurrenceFixture()],
        });
        expect(fixture.nativeElement.querySelector('.pi-check')).not.toBe(null);
    });

    it('hides chore creation without ManageChores', () => {
        const fixture = setup({rolePermissions: 'ViewChannel,CompleteChores'});
        expect(text(fixture)).not.toContain('CHORES.NEW');
    });

    it('offers chore creation with ManageChores', () => {
        const fixture = setup({rolePermissions: 'ViewChannel,ManageChores'});
        expect(text(fixture)).toContain('CHORES.NEW');
    });
});

describe('ChoresChannelComponent chore editor', () => {
    it('will not save a chore with neither a rotation role nor a fixed assignee', () => {
        const fixture = setup();
        const component = fixture.componentInstance as unknown as {
            openCreate: () => void;
            save: () => void;
            assignmentError: () => string | null;
            showEditor: () => boolean;
        };

        component.openCreate();
        fixture.detectChanges();
        // Nothing picked yet: the server would answer 400, and a raw 400 next to two empty
        // pickers tells the user nothing about which one to fill in.
        expect(component.assignmentError()).toBe('missing');

        component.save();
        fixture.detectChanges();
        expect(component.showEditor()).toBe(true);
        expect(text(fixture)).toContain('CHORES.FORM_ASSIGNMENT_REQUIRED');
    });
});
