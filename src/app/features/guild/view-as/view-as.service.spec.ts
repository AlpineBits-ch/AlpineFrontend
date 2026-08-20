import {TestBed} from '@angular/core/testing';
import {of} from 'rxjs';
import {vi} from 'vitest';
import {ViewAsService} from './view-as.service';
import {GuildService} from '../../../services/guild.service';
import {Permissions} from '../../../enums/permissions.enum';
import {EffectivePermissionsDto} from '../../../dtos/response/effective-permissions.dto';

const GUILD = 'guild_1';
const SUBJECT = {kind: 'role' as const, id: 'role_1', name: 'Recruit'};

function trace(permissions: string): EffectivePermissionsDto {
    return {
        channelId: 'chan_1',
        subjectKind: 'Role',
        subjectId: 'role_1',
        permissions,
        modulePermissions: 'None',
        sources: [],
    };
}

function setup(permissions = 'ViewChannel') {
    const guildService = {getEffectivePermissions: vi.fn(() => of(trace(permissions)))};

    TestBed.configureTestingModule({
        providers: [ViewAsService, {provide: GuildService, useValue: guildService}],
    });

    return {service: TestBed.inject(ViewAsService), guildService};
}

describe('ViewAsService', () => {
    it('is inactive until a subject is entered', () => {
        const {service} = setup();

        expect(service.active(GUILD)()).toBe(false);
    });

    it('holds the subject per guild', () => {
        const {service} = setup();

        service.enter(GUILD, SUBJECT);

        expect(service.subject(GUILD)()?.name).toBe('Recruit');
        expect(service.subject('guild_2')()).toBeNull();
    });

    it('denies everything until the trace lands', () => {
        const {service} = setup();
        service.enter(GUILD, SUBJECT);

        expect(service.can(GUILD, 'chan_1', Permissions.ViewChannel)).toBe(false);
    });

    it('answers from the trace once requested', () => {
        const {service} = setup('ViewChannel, ReadMessageHistory');
        service.enter(GUILD, SUBJECT);
        service.request(GUILD, 'chan_1');

        expect(service.can(GUILD, 'chan_1', Permissions.ViewChannel)).toBe(true);
        expect(service.can(GUILD, 'chan_1', Permissions.SendMessages)).toBe(false);
    });

    it('asks for a channel once, however many times it is requested', () => {
        const {service, guildService} = setup();
        service.enter(GUILD, SUBJECT);

        service.request(GUILD, 'chan_1');
        service.request(GUILD, 'chan_1');

        expect(guildService.getEffectivePermissions).toHaveBeenCalledTimes(1);
    });

    it('drops the cache on exit, so a second subject cannot read the first one answers', () => {
        const {service} = setup();
        service.enter(GUILD, SUBJECT);
        service.request(GUILD, 'chan_1');
        service.exit(GUILD);

        expect(service.active(GUILD)()).toBe(false);
        expect(service.can(GUILD, 'chan_1', Permissions.ViewChannel)).toBe(false);
    });

    it('never answers true for an unresolved channel, even mid-flight', () => {
        const {service} = setup();
        service.enter(GUILD, SUBJECT);
        service.request(GUILD, 'chan_1');

        expect(service.can(GUILD, 'chan_1', Permissions.ViewChannel)).toBe(true);
        expect(service.can(GUILD, 'chan_2', Permissions.ViewChannel)).toBe(false);
    });

    it('does not serve the first subject trace to a second subject entered after exit', () => {
        const {service, guildService} = setup('ViewChannel');
        service.enter(GUILD, SUBJECT);
        service.request(GUILD, 'chan_1');
        expect(service.can(GUILD, 'chan_1', Permissions.ViewChannel)).toBe(true);

        service.exit(GUILD);
        guildService.getEffectivePermissions.mockReturnValue(of(trace('')));
        service.enter(GUILD, {kind: 'member', id: 'member_1', name: 'Ash'});

        expect(service.can(GUILD, 'chan_1', Permissions.ViewChannel)).toBe(false);
    });
});
