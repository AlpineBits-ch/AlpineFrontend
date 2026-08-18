import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {of} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {WikiPageDto} from '../../../../../dtos/response/wiki.dto';
import {GuildService} from '../../../../../services/guild.service';
import {WikiService} from '../../../../../services/wiki.service';
import {NavigationService} from '../../../../main-page/navigation.service';
import {WikiStateService} from '../wiki-state.service';
import {WikiDeepLinkService} from './wiki-deep-link.service';

const GUILD = {id: 'g1', features: 'Wiki, Personas'};

function page(over: Partial<WikiPageDto> = {}): WikiPageDto {
    return {
        id: 'p1',
        guildId: 'g1',
        title: 'Vera',
        slug: 'vera',
        content: 'She keeps the keys.',
        authorId: 'author',
        lastEditorId: 'author',
        tags: [],
        isPinned: false,
        visibility: 'public',
        revisionCount: 1,
        createdAt: new Date('2026-08-01T00:00:00Z'),
        updatedAt: new Date('2026-08-01T00:00:00Z'),
        ...over,
    } as WikiPageDto;
}

function abilities(over: Record<string, boolean> = {}) {
    return {
        canCreate: false,
        canEditAny: false,
        canEditOwn: false,
        canDelete: false,
        canManageStructure: false,
        canManageRevisions: false,
        canPublish: false,
        ...over,
    };
}

describe('WikiDeepLinkService', () => {
    let nav: {
        mainView: ReturnType<typeof signal>;
        selectServer: ReturnType<typeof vi.fn>;
        openWiki: ReturnType<typeof vi.fn>;
    };
    let state: {
        wiki: ReturnType<typeof signal>;
        abilitiesResolved: ReturnType<typeof signal>;
        abilities: ReturnType<typeof signal>;
        ownUserId: ReturnType<typeof signal>;
        openPage: ReturnType<typeof vi.fn>;
        openEditor: ReturnType<typeof vi.fn>;
    };
    let getPage: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        nav = {
            mainView: signal({type: 'wiki', guildId: 'g1'}),
            selectServer: vi.fn(),
            openWiki: vi.fn(),
        };
        state = {
            wiki: signal({guildId: 'g1', pages: [{id: 'p1', guildId: 'g1'}]}),
            abilitiesResolved: signal(true),
            abilities: signal(abilities({canEditAny: true})),
            ownUserId: signal('me'),
            openPage: vi.fn(),
            openEditor: vi.fn(),
        };
        getPage = vi.fn(() => of(page()));

        TestBed.configureTestingModule({
            providers: [
                WikiDeepLinkService,
                {provide: NavigationService, useValue: nav},
                {provide: WikiStateService, useValue: state},
                {provide: WikiService, useValue: {getPage}},
                {provide: GuildService, useValue: {guilds: signal([GUILD])}},
            ],
        });
    });

    function open(options?: {edit?: boolean}): boolean {
        const service = TestBed.inject(WikiDeepLinkService);
        const opened = service.open('g1', 'p1', options);
        TestBed.tick();
        return opened;
    }

    it('reads a page from the listing without fetching it', () => {
        expect(open()).toBe(true);
        expect(state.openPage).toHaveBeenCalled();
        expect(state.openEditor).not.toHaveBeenCalled();
        expect(getPage).not.toHaveBeenCalled();
    });

    it('opens the editor on the whole page when asked to edit', () => {
        open({edit: true});

        expect(getPage).toHaveBeenCalledWith('g1', 'p1');
        expect(state.openEditor).toHaveBeenCalledWith(page());
        expect(state.openPage).not.toHaveBeenCalled();
    });

    it('falls back to reading when this member may not edit the page', () => {
        state.abilities.set(abilities({canEditOwn: true}));
        open({edit: true});

        expect(state.openEditor).not.toHaveBeenCalled();
        expect(state.openPage).toHaveBeenCalled();
    });

    it('edits a page of our own under canEditOwn', () => {
        state.abilities.set(abilities({canEditOwn: true}));
        state.ownUserId.set('author');
        open({edit: true});

        expect(state.openEditor).toHaveBeenCalled();
    });

    // The fail-closed abilities would otherwise send an editor straight to the reader.
    it('waits for the member fetch before deciding an edit link', () => {
        state.abilitiesResolved.set(false);
        open({edit: true});
        expect(state.openEditor).not.toHaveBeenCalled();
        expect(state.openPage).not.toHaveBeenCalled();

        state.abilitiesResolved.set(true);
        TestBed.tick();
        expect(state.openEditor).toHaveBeenCalled();
    });

    it('does not wait on abilities for a read link', () => {
        state.abilitiesResolved.set(false);
        open();
        expect(state.openPage).toHaveBeenCalled();
    });

    it('drops the target when the wiki is switched off', () => {
        TestBed.overrideProvider(GuildService, {
            useValue: {guilds: signal([{id: 'g1', features: 'Personas'}])},
        });
        expect(open({edit: true})).toBe(false);
        expect(state.openEditor).not.toHaveBeenCalled();
    });
});
