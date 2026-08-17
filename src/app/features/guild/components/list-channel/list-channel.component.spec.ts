import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {of} from 'rxjs';

import {ListChannelComponent} from './list-channel.component';
import {ListService} from '../../../../services/list.service';
import {GuildService} from '../../../../services/guild.service';
import {ProfileService} from '../../../../services/profile.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {ChannelDto, ChannelType, GuildDto} from '../../../../dtos/response/guild.dto';
import {ListItem} from '../../../../dtos/response/list.dto';

function channelFixture(): ChannelDto {
    return {
        id: 'c1',
        createdAt: new Date(0),
        updatedAt: new Date(0),
        name: 'groceries',
        description: '',
        type: ChannelType.List,
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

function itemFixture(id: string, overrides: Partial<ListItem> = {}): ListItem {
    return {
        id,
        channelId: 'c1',
        text: id,
        quantity: null,
        note: null,
        section: null,
        assigneeUserId: null,
        addedByUserId: 'me',
        isChecked: false,
        checkedAt: null,
        checkedByUserId: null,
        position: 0,
        sourcePantryItemId: null,
        createdAt: '2026-08-03T00:00:00Z',
        ...overrides,
    };
}

type UpdateSpy = (channelId: string, itemId: string, dto: Record<string, unknown>) => Promise<boolean>;

function setup(
    opts: {
        features?: string;
        items?: ListItem[];
        rolePermissions?: string;
        updateItem?: UpdateSpy;
    } = {},
) {
    const guild = {
        id: 'g1',
        ownerId: 'someone-else',
        features: opts.features ?? 'Lists',
    } as unknown as GuildDto;

    const listService = {
        stateFor: () => ({
            items: opts.items ?? [],
            loading: false,
            hasLoaded: true,
            loadFailed: false,
            forbidden: false,
        }),
        ensureLoaded: () => {},
        reload: () => {},
        setChecked: () => Promise.resolve(true),
        addItem: () => Promise.resolve(true),
        updateItem: opts.updateItem ?? (() => Promise.resolve(true)),
        deleteItem: () => Promise.resolve(true),
        moveItem: () => Promise.resolve(true),
        clearChecked: () => Promise.resolve(true),
    };

    TestBed.configureTestingModule({
        imports: [ListChannelComponent],
        providers: [
            provideTranslateService({defaultLanguage: 'en'}),
            MessageService,
            {provide: ListService, useValue: listService},
            {
                provide: NavigationService,
                useValue: {workspace: signal({type: 'server', guild}), mobileNavOpen: signal(false)},
            },
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'me'})}},
            {
                provide: GuildService,
                useValue: {
                    getOwnMember: () =>
                        of({
                            permissions: opts.rolePermissions ?? 'ViewChannel',
                            // Both masks get the same names; each parser keeps only the ones it defines.
                            modulePermissions: opts.rolePermissions ?? 'ViewChannel',
                            roleMembers: [],
                        }),
                },
            },
        ],
    });

    const fixture: ComponentFixture<ListChannelComponent> = TestBed.createComponent(ListChannelComponent);
    fixture.componentRef.setInput('channel', channelFixture());
    fixture.detectChanges();
    return fixture;
}

describe('ListChannelComponent', () => {
    it('renders nothing when the guild has no Lists module', () => {
        // §13.2: the module being off is not a permission problem; drawing "you're not allowed" over a household that doesn't do shopping lists is the failure it warns about.
        const fixture = setup({features: 'VoiceChannels'});
        expect(fixture.nativeElement.textContent.trim()).toBe('');
    });

    it('renders the list when the module is on', () => {
        const fixture = setup({items: [itemFixture('a', {text: 'Milk'})]});
        expect(fixture.nativeElement.textContent).toContain('Milk');
    });

    it('renders quantity verbatim rather than as a parsed number', () => {
        const fixture = setup({items: [itemFixture('a', {text: 'Bananas', quantity: 'a bunch'})]});
        expect(fixture.nativeElement.textContent).toContain('a bunch');
    });

    it('badges a row the pantry restocked', () => {
        const fixture = setup({items: [itemFixture('a', {sourcePantryItemId: 'p9'})]});
        expect(fixture.nativeElement.textContent).toContain('LIST.FROM_PANTRY');
    });

    it('does not badge an ordinary row', () => {
        const fixture = setup({items: [itemFixture('a')]});
        expect(fixture.nativeElement.textContent).not.toContain('LIST.FROM_PANTRY');
    });

    it('hides the composer without AddListItems', () => {
        const fixture = setup({rolePermissions: 'ViewChannel,CheckOffListItems'});
        expect(fixture.nativeElement.querySelector('input[pInputText]')).toBe(null);
    });

    it('shows the composer with AddListItems', () => {
        const fixture = setup({rolePermissions: 'ViewChannel,AddListItems'});
        expect(fixture.nativeElement.querySelector('input[pInputText]')).not.toBe(null);
    });

    it('offers "clear done" only with ManageLists', () => {
        // Scoped to the header: the per-row delete button shares the glyph, and AddListItems does grant that for your own rows; only the list-wide clear needs ManageLists.
        const checked = [itemFixture('a', {isChecked: true})];
        const without = setup({rolePermissions: 'ViewChannel,AddListItems', items: checked});
        expect(without.nativeElement.querySelector('header .pi-trash')).toBe(null);

        TestBed.resetTestingModule();
        const granted = setup({rolePermissions: 'ViewChannel,ManageLists', items: checked});
        expect(granted.nativeElement.querySelector('header .pi-trash')).not.toBe(null);
    });

    it('empties a quantity with "" - a null would be read as "leave it alone" and change nothing', async () => {
        const updateItem = vi.fn<UpdateSpy>(() => Promise.resolve(true));
        const row = itemFixture('a', {text: 'Milk', quantity: '2 packs'});
        const fixture = setup({rolePermissions: 'ViewChannel,ManageLists', items: [row], updateItem});
        const api = fixture.componentInstance as unknown as {
            startEdit(item: ListItem): void;
            editQuantity: {set(v: string): void};
            saveEdit(item: ListItem): Promise<void>;
        };

        api.startEdit(row);
        api.editQuantity.set('');
        await api.saveEdit(row);

        expect(updateItem).toHaveBeenCalledWith('c1', 'a', {text: 'Milk', quantity: ''});
    });

    it('does not offer "clear done" when nothing is ticked', () => {
        const fixture = setup({rolePermissions: 'ViewChannel,ManageLists', items: [itemFixture('a')]});
        expect(fixture.nativeElement.querySelector('header .pi-trash')).toBe(null);
    });
});
