import {TestBed} from '@angular/core/testing';
import {Subject} from 'rxjs';
import {describe, expect, it} from 'vitest';

import {PersonaService} from './persona.service';
import {PersonaApi} from './persona-api.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {
    AutoproxyMode,
    GuildPersonaDto,
    PersonaApprovalState,
    PersonaCastMemberDto,
    PersonaDto,
    PersonaScope,
    PersonaUpstreamState,
} from '../dtos/response/persona.dto';

function persona(over: Partial<PersonaDto> = {}): PersonaDto {
    return {
        id: 'per_1',
        scope: PersonaScope.User,
        ownerUserId: 'u1',
        name: 'Alanna',
        avatarUrl: null,
        pronouns: 'she/her',
        color: '#88aaff',
        shortBio: 'A ranger.',
        isRetired: false,
        createdAt: '2026-08-01T00:00:00Z',
        ...over,
    };
}

function entry(over: Partial<GuildPersonaDto> = {}): GuildPersonaDto {
    return {
        persona: persona(),
        personaId: 'per_1',
        guildId: 'g1',
        approvalState: PersonaApprovalState.Approved,
        canSpeak: true,
        ...over,
    };
}

function member(over: Partial<PersonaCastMemberDto> = {}): PersonaCastMemberDto {
    return {
        personaId: 'per_2',
        name: 'Marek',
        avatarUrl: null,
        color: '#334455',
        pronouns: 'he/him',
        tag: null,
        isRetired: false,
        ...over,
    };
}

function queued<T>(into: Subject<T>[]): Subject<T> {
    const subject = new Subject<T>();
    into.push(subject);
    return subject;
}

/** Only what the service calls. Every read hands back a subject the test flushes itself. */
function apiStub() {
    const own: Subject<PersonaDto[]>[] = [];
    const guild: Subject<GuildPersonaDto[]>[] = [];
    const pending: Subject<GuildPersonaDto[]>[] = [];
    const guildCast: Subject<PersonaCastMemberDto[]>[] = [];
    return {
        own,
        guild,
        pending,
        guildCast,
        listOwn: () => queued(own),
        listGuild: () => queued(guild),
        listPending: () => queued(pending),
        getGuildCast: () => queued(guildCast),
    };
}

function wsStub() {
    return {
        personaProfileChangedObservable: new Subject<any>(),
        personaCreatedObservable: new Subject<any>(),
        personaUpdatedObservable: new Subject<any>(),
        personaDeletedObservable: new Subject<any>(),
        personaAdoptedObservable: new Subject<any>(),
        personaUnadoptedObservable: new Subject<any>(),
        personaReviewRequestedObservable: new Subject<any>(),
        personaReviewCompletedObservable: new Subject<any>(),
        personaGrantCreatedObservable: new Subject<any>(),
        personaGrantDeletedObservable: new Subject<any>(),
        personaPageCreatedObservable: new Subject<any>(),
        personaPagePulledObservable: new Subject<any>(),
        autoproxyChangedObservable: new Subject<any>(),
    };
}

/**
 * A guild whose cast has been read. Every handler is wired on the first read and most of them are
 * gated on the cast having been loaded, so there is no useful state before this.
 */
function withCast(rows: GuildPersonaDto[] = [entry()]) {
    const api = apiStub();
    const ws = wsStub();
    TestBed.configureTestingModule({
        providers: [
            {provide: PersonaApi, useValue: api},
            {provide: GuildWebsocketService, useValue: ws},
        ],
    });
    const service = TestBed.inject(PersonaService);
    service.ensureCast('g1');
    api.guild[0].next(rows);
    return {service, api, ws};
}

describe('PersonaService character events', () => {
    it('patches every field PersonaUpdated now carries, not only the name', () => {
        const {service, ws} = withCast();

        ws.personaUpdatedObservable.next({
            guildId: 'g1',
            personaId: 'per_1',
            scope: PersonaScope.User,
            name: 'Alanna Reyes',
            avatarUrl: 'https://cdn/a.png',
            pronouns: 'they/them',
            color: '#ff0000',
            shortBio: 'A ranger, retired.',
            isRetired: true,
        });

        const row = service.entry('g1', 'per_1')!.persona;
        expect(row.name).toBe('Alanna Reyes');
        expect(row.color).toBe('#ff0000');
        expect(row.pronouns).toBe('they/them');
        expect(row.shortBio).toBe('A ranger, retired.');
        expect(row.isRetired).toBe(true);
    });

    it('reads the account list for a personal character it has never seen', () => {
        const {api, ws} = withCast();

        ws.personaCreatedObservable.next({
            personaId: 'per_9',
            scope: PersonaScope.User,
            name: 'Marek',
            isRetired: false,
        });

        expect(api.own.length).toBe(1);
    });

    it('leaves a guild-owned character to the adoption that follows it', () => {
        const {api, ws} = withCast();

        ws.personaCreatedObservable.next({
            guildId: 'g1',
            personaId: 'per_9',
            scope: PersonaScope.Guild,
            name: 'The Innkeeper',
            isRetired: false,
        });

        expect(api.own.length).toBe(0);
        expect(api.guild.length).toBe(1);
    });

    it('retires rather than forgets when the character had already spoken', () => {
        const {service, ws} = withCast();

        ws.personaDeletedObservable.next({guildId: 'g1', personaId: 'per_1', retired: true});
        expect(service.entry('g1', 'per_1')?.persona.isRetired).toBe(true);

        ws.personaDeletedObservable.next({guildId: 'g1', personaId: 'per_1', retired: false});
        expect(service.entry('g1', 'per_1')).toBeNull();
    });
});

describe('PersonaService adoption events', () => {
    it('reads the cast again for a character it does not hold', () => {
        const {api, ws} = withCast([]);

        ws.personaAdoptedObservable.next({
            guildId: 'g1',
            personaId: 'per_2',
            name: 'Marek',
            approvalState: PersonaApprovalState.Draft,
            canSpeak: false,
        });

        expect(api.guild.length).toBe(2);
    });

    it('patches in place for a character it already holds', () => {
        const {service, api, ws} = withCast();

        ws.personaAdoptedObservable.next({
            guildId: 'g1',
            personaId: 'per_1',
            name: 'Alanna',
            tag: '[AR]',
            wikiPageId: 'wp_1',
            approvalState: PersonaApprovalState.Submitted,
            canSpeak: false,
        });

        expect(api.guild.length).toBe(1);
        expect(service.entry('g1', 'per_1')?.tag).toBe('[AR]');
        expect(service.entry('g1', 'per_1')?.approvalState).toBe(PersonaApprovalState.Submitted);
    });

    it('drops the entry the guild no longer adopts', () => {
        const {service, ws} = withCast();

        ws.personaUnadoptedObservable.next({guildId: 'g1', personaId: 'per_1'});

        expect(service.cast('g1')).toEqual([]);
    });

    it('reads the cast again when a grant moves, since canSpeak is per reader', () => {
        const {api, ws} = withCast();

        ws.personaGrantCreatedObservable.next({
            guildId: 'g1',
            personaId: 'per_1',
            grantId: 'pg_1',
            userId: 'u2',
        });
        ws.personaGrantDeletedObservable.next({
            guildId: 'g1',
            personaId: 'per_1',
            grantId: 'pg_1',
            userId: 'u2',
        });

        expect(api.guild.length).toBe(3);
    });
});

describe('PersonaService review queue', () => {
    it('stays quiet for a player who never loaded the queue', () => {
        const {api, ws} = withCast();

        ws.personaReviewRequestedObservable.next({
            guildId: 'g1',
            personaId: 'per_1',
            name: 'Alanna',
            approvalState: PersonaApprovalState.Submitted,
            isResubmission: false,
        });

        expect(api.pending.length).toBe(0);
    });

    it('reads the queue again for a reviewer holding it', () => {
        const {service, api, ws} = withCast();
        service.ensurePending('g1');
        api.pending[0].next([]);

        ws.personaReviewRequestedObservable.next({
            guildId: 'g1',
            personaId: 'per_1',
            name: 'Alanna',
            approvalState: PersonaApprovalState.Submitted,
            isResubmission: true,
        });

        expect(api.pending.length).toBe(2);
    });

    it('takes a decided character off the queue and keeps the reviewer reason', () => {
        const {service, api, ws} = withCast([entry({approvalState: PersonaApprovalState.Submitted})]);
        service.ensurePending('g1');
        api.pending[0].next([entry({approvalState: PersonaApprovalState.Submitted})]);

        ws.personaReviewCompletedObservable.next({
            guildId: 'g1',
            personaId: 'per_1',
            name: 'Alanna',
            approvalState: PersonaApprovalState.ChangesRequested,
            approved: false,
            reviewedByUserId: 'u2',
            reason: 'Needs a shorter bio.',
            canSpeak: false,
        });

        expect(service.pending('g1')).toEqual([]);
        expect(service.entry('g1', 'per_1')?.changesRequestedReason).toBe('Needs a shorter bio.');
        expect(service.entry('g1', 'per_1')?.approvalState).toBe(PersonaApprovalState.ChangesRequested);
    });

    it('clears the reason again once the character is approved', () => {
        const {service, ws} = withCast([entry({changesRequestedReason: 'Needs a shorter bio.'})]);

        ws.personaReviewCompletedObservable.next({
            guildId: 'g1',
            personaId: 'per_1',
            name: 'Alanna',
            approvalState: PersonaApprovalState.Approved,
            approved: true,
            reviewedByUserId: 'u2',
            reviewedAt: '2026-08-18T10:00:00Z',
            canSpeak: true,
        });

        expect(service.entry('g1', 'per_1')?.changesRequestedReason).toBeNull();
        expect(service.entry('g1', 'per_1')?.approvedByUserId).toBe('u2');
    });

    it('forgets the queue when the permission behind it goes', () => {
        const {service, api, ws} = withCast();
        service.ensurePending('g1');
        api.pending[0].next([entry()]);

        service.forgetPending('g1');
        ws.personaReviewRequestedObservable.next({
            guildId: 'g1',
            personaId: 'per_1',
            name: 'Alanna',
            approvalState: PersonaApprovalState.Submitted,
            isResubmission: false,
        });

        expect(service.pending('g1')).toEqual([]);
        expect(api.pending.length).toBe(1);
    });
});

describe('PersonaService page and autoproxy events', () => {
    it('links the page a character just gained', () => {
        const {service, ws} = withCast();

        ws.personaPageCreatedObservable.next({
            guildId: 'g1',
            personaId: 'per_1',
            pageId: 'wp_7',
            title: 'Alanna',
        });

        expect(service.entry('g1', 'per_1')?.wikiPageId).toBe('wp_7');
    });

    it('bumps the page version a pull rewrote', () => {
        const {service, ws} = withCast([entry({wikiPageId: 'wp_7'})]);

        ws.personaPagePulledObservable.next({
            guildId: 'g1',
            personaId: 'per_1',
            pageId: 'wp_7',
            strategy: 'KeepLocal',
            upstreamState: PersonaUpstreamState.Current,
            upstreamRevisionNumber: 4,
        });

        expect(service.pageVersion('wp_7')).toBe(1);
        expect(service.entry('g1', 'per_1')?.upstreamState).toBe(PersonaUpstreamState.Current);
    });

    it('takes the channel autoproxy another window set', () => {
        const {service, ws} = withCast();

        ws.autoproxyChangedObservable.next({
            guildId: 'g1',
            channelId: 'c1',
            mode: AutoproxyMode.Sticky,
            personaId: 'per_1',
        });

        expect(service.autoproxy('c1')).toEqual({
            channelId: 'c1',
            mode: AutoproxyMode.Sticky,
            personaId: 'per_1',
        });
    });
});

describe('PersonaService guild cast', () => {
    it('sorts retired characters last and the rest by name', () => {
        const {service, api} = withCast();
        service.ensureGuildCast('g1');
        api.guildCast[0].next([
            member({personaId: 'c', name: 'Zed'}),
            member({personaId: 'a', name: 'Old One', isRetired: true}),
            member({personaId: 'b', name: 'Ana'}),
        ]);

        expect(service.guildCast('g1').map(m => m.personaId)).toEqual(['b', 'c', 'a']);
    });

    it('reads once per guild until something forces it', () => {
        const {service, api} = withCast();
        service.ensureGuildCast('g1');
        api.guildCast[0].next([member()]);
        service.ensureGuildCast('g1');

        expect(api.guildCast.length).toBe(1);

        service.ensureGuildCast('g1', true);
        expect(api.guildCast.length).toBe(2);
    });

    it('keeps the list it already had when the read fails', () => {
        const {service, api} = withCast();
        service.ensureGuildCast('g1');
        api.guildCast[0].next([member()]);

        service.ensureGuildCast('g1', true);
        api.guildCast[1].error(new Error('503'));

        expect(service.guildCast('g1').map(m => m.personaId)).toEqual(['per_2']);
        expect(service.isGuildCastLoading('g1')).toBe(false);
    });

    it('reads again when the guild adopts or drops a character', () => {
        const {service, api, ws} = withCast();
        service.ensureGuildCast('g1');
        api.guildCast[0].next([member()]);

        ws.personaAdoptedObservable.next({
            guildId: 'g1',
            personaId: 'per_3',
            name: 'Wren',
            approvalState: PersonaApprovalState.Draft,
            canSpeak: false,
        });
        expect(api.guildCast.length).toBe(2);

        ws.personaUnadoptedObservable.next({guildId: 'g1', personaId: 'per_3'});
        expect(api.guildCast.length).toBe(3);
    });

    it('stays quiet for a guild whose cast nothing has asked for', () => {
        const {api, ws} = withCast();

        ws.personaAdoptedObservable.next({
            guildId: 'g1',
            personaId: 'per_3',
            name: 'Wren',
            approvalState: PersonaApprovalState.Draft,
            canSpeak: false,
        });

        expect(api.guildCast.length).toBe(0);
    });
});

describe('PersonaService identity resolution', () => {
    it('prefers the speakable entry, which carries the overrides set here', () => {
        const {service, api} = withCast([entry({displayName: 'The Ranger'})]);
        service.ensureGuildCast('g1');
        api.guildCast[0].next([member({personaId: 'per_1', name: 'Alanna'})]);

        expect(service.identity('g1', 'per_1')?.name).toBe('The Ranger');
    });

    it('falls to the guild cast for a character the caller cannot speak as', () => {
        const {service, api} = withCast();
        service.ensureGuildCast('g1');
        api.guildCast[0].next([member()]);

        expect(service.identity('g1', 'per_2', {name: 'Stale'})).toMatchObject({
            name: 'Marek',
            pronouns: 'he/him',
            initial: 'M',
        });
    });

    it('falls to the hint when the cast has never been read', () => {
        const {service} = withCast();

        expect(service.identity('g1', 'per_9', {name: 'Wren'})?.name).toBe('Wren');
    });

    it('is null with no entry, no cast member and no hint', () => {
        const {service} = withCast();

        expect(service.identity('g1', 'per_9')).toBeNull();
    });
});
