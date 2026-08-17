import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {DecisionService} from './decision.service';
import {ApiConfigService} from './api-config.service';
import {RealtimeConnectionService} from './realtime-connection.service';
import {
    Decision,
    DecisionCancelled,
    DecisionCreated,
    DecisionStatus,
    DecisionUpdated,
    DecisionVoteKind,
} from '../dtos/response/decision.dto';
import {createDecisionProblem, DECISION_LIMITS, voteBodyProblem} from '../dtos/request/decision.dto';

/** The body as it reaches the server: the JSON round-trip drops `undefined` keys, so an omitted field and a `null` one stay distinguishable. */
function wireBody(body: unknown): unknown {
    return JSON.parse(JSON.stringify(body));
}

const BASE = 'https://api.test.example';
const GUILD = `${BASE}/api/v1/guild`;

/** Handlers the service registered on the hub, so a test can fire a server event by name. */
const hubHandlers = new Map<string, ((payload: never) => void)[]>();

function fireHub<T>(event: string, payload: T): void {
    for (const handler of hubHandlers.get(event) ?? []) handler(payload as never);
}

function decision(overrides: Partial<Decision> = {}): Decision {
    return {
        id: 'deci_1',
        channelId: 'chan_1',
        title: 'Get a dishwasher?',
        createdByUserId: 'user_1',
        status: DecisionStatus.Open,
        options: [{id: 'opti_1', title: 'Buy one', position: 0, supportCount: 0, isBlocked: false}],
        blocks: [],
        ...overrides,
    };
}

function setup() {
    hubHandlers.clear();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            {
                provide: RealtimeConnectionService,
                useValue: {
                    on: (event: string, handler: (payload: never) => void) => {
                        const list = hubHandlers.get(event) ?? [];
                        list.push(handler);
                        hubHandlers.set(event, list);
                    },
                    off: () => undefined,
                },
            },
        ],
    });
    return {
        service: TestBed.inject(DecisionService),
        http: TestBed.inject(HttpTestingController),
    };
}

/** Loads a channel so it counts as tracked - realtime deliberately ignores everything else. */
async function loadChannel(
    service: DecisionService, http: HttpTestingController, decisions: Decision[],
): Promise<void> {
    const loading = service.loadFor('chan_1');
    http.expectOne(`${GUILD}/channels/chan_1/decisions`).flush(decisions);
    await loading;
}

describe('DecisionService realtime', () => {
    it('registers all four listeners exactly once', () => {
        const {service} = setup();
        expect(service).toBeTruthy();

        for (const event of ['guild.DecisionCreated', 'guild.DecisionUpdated',
            'guild.DecisionClosed', 'guild.DecisionCancelled']) {
            expect(hubHandlers.get(event)?.length).toBe(1);
        }
    });

    it('adds a created decision to a channel it is already showing', async () => {
        const {service, http} = setup();
        await loadChannel(service, http, []);

        fireHub<DecisionCreated>('guild.DecisionCreated', {
            guildId: 'gild_1', channelId: 'chan_1', decision: decision(),
        });

        expect(service.stateFor('chan_1').decisions.map(d => d.id)).toEqual(['deci_1']);
        http.verify();
    });

    it('ignores events for a channel it has never loaded', () => {
        const {service, http} = setup();

        fireHub<DecisionCreated>('guild.DecisionCreated', {
            guildId: 'gild_1', channelId: 'chan_other', decision: decision({channelId: 'chan_other'}),
        });

        // Seeding from an event would leave the channel holding one decision and looking loaded.
        expect(service.stateFor('chan_other').decisions).toEqual([]);
        expect(service.stateFor('chan_other').loadedAt).toBe(0);
        http.verify();
    });

    it('replaces the decision wholesale on an update rather than merging fields', async () => {
        const {service, http} = setup();
        await loadChannel(service, http, [decision()]);

        fireHub<DecisionUpdated>('guild.DecisionUpdated', {
            guildId: 'gild_1',
            channelId: 'chan_1',
            decision: decision({
                options: [{id: 'opti_1', title: 'Buy one', position: 0, supportCount: 3, isBlocked: true}],
                blocks: [{userId: 'user_2', optionId: 'opti_1', reason: 'No room'}],
            }),
        });

        const [row] = service.stateFor('chan_1').decisions;
        expect(row.options[0].isBlocked).toBe(true);
        expect(row.blocks.length).toBe(1);
        expect(service.stateFor('chan_1').decisions.length).toBe(1);
        http.verify();
    });

    it('applies the cancel transition locally, since the event carries no decision', async () => {
        const {service, http} = setup();
        await loadChannel(service, http, [decision()]);

        fireHub<DecisionCancelled>('guild.DecisionCancelled', {
            guildId: 'gild_1', channelId: 'chan_1', decisionId: 'deci_1',
        });

        expect(service.stateFor('chan_1').decisions[0].status).toBe(DecisionStatus.Cancelled);
        http.verify();
    });
});

describe('DecisionService loading', () => {
    it('normalises the int enum form off the list endpoint', async () => {
        const {service, http} = setup();
        const loading = service.loadFor('chan_1');
        http.expectOne(`${GUILD}/channels/chan_1/decisions`)
            .flush([{...decision(), status: 2, myVoteKind: 2}]);
        await loading;

        const [row] = service.stateFor('chan_1').decisions;
        expect(row.status).toBe(DecisionStatus.Blocked);
        expect(row.myVoteKind).toBe(DecisionVoteKind.Block);
        http.verify();
    });

    it('distinguishes a 403 - which may mean the module is off, not a permission problem', async () => {
        const {service, http} = setup();
        const loading = service.loadFor('chan_1');
        http.expectOne(`${GUILD}/channels/chan_1/decisions`)
            .flush('nope', {status: 403, statusText: 'Forbidden'});
        await loading;

        expect(service.stateFor('chan_1').error).toBe('forbidden');
        expect(service.stateFor('chan_1').loadedAt).toBe(0);
        http.verify();
    });

    it('does not refetch a fresh list, but does when forced', async () => {
        const {service, http} = setup();
        await loadChannel(service, http, [decision()]);

        await service.loadFor('chan_1');
        http.verify();

        const forced = service.loadFor('chan_1', true);
        http.expectOne(`${GUILD}/channels/chan_1/decisions`).flush([]);
        await forced;
        http.verify();
    });
});

describe('DecisionService writes', () => {
    it('PUTs the vote as an upsert and replaces the local copy with the response', async () => {
        const {service, http} = setup();
        await loadChannel(service, http, [decision()]);

        const voting = service.vote('chan_1', 'deci_1', {
            kind: DecisionVoteKind.Support, optionId: 'opti_1',
        });
        const req = http.expectOne(`${GUILD}/decisions/deci_1/vote`);
        expect(req.request.method).toBe('PUT');
        req.flush(decision({myVoteKind: DecisionVoteKind.Support, myVoteOptionId: 'opti_1'}));
        await voting;

        expect(service.stateFor('chan_1').decisions[0].myVoteOptionId).toBe('opti_1');
        http.verify();
    });

    it('cancels via DELETE and marks the row cancelled rather than dropping it', async () => {
        const {service, http} = setup();
        await loadChannel(service, http, [decision()]);

        const cancelling = service.cancel('chan_1', 'deci_1');
        const req = http.expectOne(`${GUILD}/decisions/deci_1`);
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
        await cancelling;

        expect(service.stateFor('chan_1').decisions[0].status).toBe(DecisionStatus.Cancelled);
        http.verify();
    });
});

describe('voteBodyProblem', () => {
    it('requires a reason on a block - the server returns 400 without one', () => {
        expect(voteBodyProblem({kind: DecisionVoteKind.Block, optionId: 'opti_1'}))
            .toBe('reason-required');
        expect(voteBodyProblem({kind: DecisionVoteKind.Block, optionId: 'opti_1', reason: '   '})).toBe('reason-required');
        expect(voteBodyProblem({kind: DecisionVoteKind.Block, optionId: 'opti_1', reason: 'No room'}))
            .toBeNull();
    });

    it('accepts a whole-decision block: null optionId with a reason is a supported gesture', () => {
        expect(voteBodyProblem({kind: DecisionVoteKind.Block, optionId: null, reason: 'Not our call'}))
            .toBeNull();
    });

    it('requires an optionId on a support', () => {
        expect(voteBodyProblem({kind: DecisionVoteKind.Support})).toBe('option-required');
        expect(voteBodyProblem({kind: DecisionVoteKind.Support, optionId: 'opti_1'})).toBeNull();
    });

    it('needs neither on an abstain', () => {
        expect(voteBodyProblem({kind: DecisionVoteKind.Abstain})).toBeNull();
    });
});

// ── Wire shapes ─────────────────────────────────────────────────────────────
// Asserted against `CreateDecisionDto` and `CastDecisionVoteDto`, not against what the client builds.

describe('DecisionService request bodies', () => {
    it('POSTs a create with the option titles as a bare string list', async () => {
        const {service, http} = setup();
        await loadChannel(service, http, []);

        const creating = service.create('chan_1', {
            title: 'Get a dishwasher?',
            description: 'The sink is a warzone',
            closesAt: '2026-09-01T18:00:00.000Z',
            quorum: 3,
            options: ['Buy one', 'Rota instead'],
        });
        const req = http.expectOne(`${GUILD}/channels/chan_1/decisions`);
        expect(req.request.method).toBe('POST');
        // Options are titles, not objects: `{title}` objects deserialize to empty strings server-side.
        expect(wireBody(req.request.body)).toEqual({
            title: 'Get a dishwasher?',
            description: 'The sink is a warzone',
            closesAt: '2026-09-01T18:00:00.000Z',
            quorum: 3,
            options: ['Buy one', 'Rota instead'],
        });
        req.flush(decision());
        await creating;
        http.verify();
    });

    it('sends an explicit null for the two optional fields rather than omitting them', async () => {
        const {service, http} = setup();
        await loadChannel(service, http, []);

        const creating = service.create('chan_1', {
            title: 'Cat?',
            description: null,
            closesAt: null,
            quorum: null,
            options: ['Yes', 'No'],
        });
        const req = http.expectOne(`${GUILD}/channels/chan_1/decisions`);
        // Both readings are legal, so this pins the one the client actually uses.
        expect(wireBody(req.request.body)).toEqual({
            title: 'Cat?',
            description: null,
            closesAt: null,
            quorum: null,
            options: ['Yes', 'No'],
        });
        req.flush(decision());
        await creating;
    });

    it('PUTs a Support carrying its optionId and nothing else', async () => {
        const {service, http} = setup();
        await loadChannel(service, http, [decision()]);

        const voting = service.vote('chan_1', 'deci_1', {
            kind: DecisionVoteKind.Support, optionId: 'opti_1',
        });
        const req = http.expectOne(`${GUILD}/decisions/deci_1/vote`);
        expect(req.request.method).toBe('PUT');
        // `kind` is the enum NAME: a JsonStringEnumConverter rejects an ordinal outright.
        expect(wireBody(req.request.body)).toEqual({kind: 'Support', optionId: 'opti_1'});
        req.flush(decision());
        await voting;
    });

    it('PUTs an Abstain with neither an option nor a reason', async () => {
        const {service, http} = setup();
        await loadChannel(service, http, [decision()]);

        const voting = service.vote('chan_1', 'deci_1', {kind: DecisionVoteKind.Abstain});
        const req = http.expectOne(`${GUILD}/decisions/deci_1/vote`);
        // The server nulls an abstain's OptionId regardless; sending one would misstate the vote.
        expect(wireBody(req.request.body)).toEqual({kind: 'Abstain'});
        req.flush(decision());
        await voting;
    });

    it('PUTs a Block with its reason, and with a null optionId for a whole-decision block', async () => {
        const {service, http} = setup();
        await loadChannel(service, http, [decision()]);

        const voting = service.vote('chan_1', 'deci_1', {
            kind: DecisionVoteKind.Block, optionId: null, reason: 'Not our call to make',
        });
        const req = http.expectOne(`${GUILD}/decisions/deci_1/vote`);
        expect(wireBody(req.request.body)).toEqual({
            kind: 'Block', optionId: null, reason: 'Not our call to make',
        });
        req.flush(decision());
        await voting;
    });
});

describe('createDecisionProblem', () => {
    const draft = {title: 'Cat?', options: ['Yes', 'No']};

    it('accepts the minimum the server accepts', () => {
        expect(createDecisionProblem(draft)).toBeNull();
    });

    it('counts options after dropping the blanks, as CreateAsync does', () => {
        expect(createDecisionProblem({title: 'Cat?', options: ['Yes', '   ']})).toBe('too-few-options');
        expect(createDecisionProblem({
            title: 'Cat?',
            options: Array.from({length: DECISION_LIMITS.maxOptions + 1}, (_, i) => `Option ${i}`),
        })).toBe('too-many-options');
    });

    it('refuses a title past MaxTitleLength', () => {
        expect(createDecisionProblem({...draft, title: 'x'.repeat(DECISION_LIMITS.titleMaxLength)}))
            .toBeNull();
        expect(createDecisionProblem({...draft, title: 'x'.repeat(DECISION_LIMITS.titleMaxLength + 1)}))
            .toBe('title-too-long');
    });

    it('refuses a deadline that has already passed, but not a null one', () => {
        const now = Date.parse('2026-08-03T12:00:00.000Z');
        expect(createDecisionProblem({...draft, closesAt: '2026-08-03T11:59:00.000Z'}, now))
            .toBe('closes-at-past');
        expect(createDecisionProblem({...draft, closesAt: '2026-08-03T12:01:00.000Z'}, now)).toBeNull();
        expect(createDecisionProblem({...draft, closesAt: null}, now)).toBeNull();
    });

    it('treats a null quorum as "no threshold" and a zero as a mistake', () => {
        expect(createDecisionProblem({...draft, quorum: null})).toBeNull();
        expect(createDecisionProblem({...draft, quorum: 0})).toBe('quorum-too-low');
        expect(createDecisionProblem({...draft, quorum: 1})).toBeNull();
    });
});
