import {describe, expect, it, vi} from 'vitest';
import {TestBed} from '@angular/core/testing';
import {ChangeDetectionStrategy, Component, signal, viewChild} from '@angular/core';
import {provideNoopAnimations} from '@angular/platform-browser/animations';
import {provideTranslateService} from '@ngx-translate/core';
import {of} from 'rxjs';
import {ChannelSettingsModalComponent, mergeChannelResponse} from './channel-settings-modal.component';
import {GuildService} from '../../../../services/guild.service';
import {ChannelDto, ChannelPermission, ChannelType, GuildDto} from '../../../../dtos/response/guild.dto';

function channel(id: string, name: string, extra: Partial<ChannelDto> = {}): ChannelDto {
    return {
        id,
        name,
        description: '',
        type: ChannelType.Voice,
        guildId: 'g1',
        isAgeRestricted: false,
        isPrivate: false,
        categoryId: undefined,
        permissions: [],
        position: 0,
        slowModeSeconds: 0,
        parentChannelId: undefined,
        ...extra,
    } as ChannelDto;
}

@Component({
    imports: [ChannelSettingsModalComponent],
    template: `<app-channel-settings-modal
        (channelUpdated)="onUpdated($event)"
        [(isVisible)]="visible"
        [guild]="guild()"
    />`,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
class HostComponent {
    readonly visible = signal(false);
    readonly guild = signal<GuildDto>({
        id: 'g1',
        channels: [channel('c1', 'first'), channel('c2', 'second')],
        categories: [],
        roles: [],
    } as unknown as GuildDto);
    readonly modal = viewChild.required(ChannelSettingsModalComponent);

    onUpdated(updated: ChannelDto): void {
        this.guild.update(g => ({...g, channels: g.channels.map(c => (c.id === updated.id ? updated : c))}));
    }
}

function setup(updateChannel = vi.fn()) {
    TestBed.configureTestingModule({
        providers: [
            provideTranslateService(),
            provideNoopAnimations(),
            {provide: GuildService, useValue: {updateChannel}},
        ],
    });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return fixture;
}

function nameInput(): HTMLInputElement {
    return document.body.querySelector('#channel-overview-name') as HTMLInputElement;
}

async function settle(fixture: ReturnType<typeof setup>): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
}

describe('ChannelSettingsModalComponent', () => {
    it('shows the second channel in the page body after opening it', async () => {
        const fixture = setup();
        const host = fixture.componentInstance;

        host.modal().open(host.guild().channels[0]);
        await settle(fixture);
        expect(nameInput().value).toBe('first');

        host.modal().open(host.guild().channels[1]);
        await settle(fixture);
        expect(nameInput().value).toBe('second');
    });

    it('follows a saved change so a second save starts from it', async () => {
        const saved = channel('c1', 'renamed', {permissions: undefined as unknown as ChannelPermission[]});
        const updateChannel = vi.fn().mockReturnValue(of(saved));
        const fixture = setup(updateChannel);
        const host = fixture.componentInstance;
        const perm = {id: 'p1', roleId: 'r1'} as ChannelPermission;
        host.guild.update(g => ({
            ...g,
            channels: [channel('c1', 'first', {permissions: [perm]}), g.channels[1]],
        }));

        host.modal().open(host.guild().channels[0]);
        await settle(fixture);
        nameInput().value = 'renamed';
        nameInput().dispatchEvent(new Event('input'));
        await settle(fixture);
        (document.body.querySelector('p-button[label="Save Changes"] button') as HTMLButtonElement).click();
        await settle(fixture);

        const stored = host.guild().channels[0];
        expect(stored.name).toBe('renamed');
        expect(stored.permissions).toEqual([perm]);
        expect(host.modal().channel()).toBe(stored);
        expect(document.body.querySelector('p-button[label="Save Changes"]')).toBeNull();
    });
});

describe('mergeChannelResponse', () => {
    it('keeps permissions and parent the response left out', () => {
        const perm = {id: 'p1'} as ChannelPermission;
        const current = channel('c1', 'old', {permissions: [perm], parentChannelId: 'parent'});
        const response = {
            ...channel('c1', 'new'),
            permissions: null,
            parentChannelId: undefined,
        } as unknown as ChannelDto;

        const merged = mergeChannelResponse(current, response);

        expect(merged.name).toBe('new');
        expect(merged.permissions).toEqual([perm]);
        expect(merged.parentChannelId).toBe('parent');
    });
});
