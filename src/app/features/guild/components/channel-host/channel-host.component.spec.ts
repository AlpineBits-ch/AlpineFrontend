import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {provideTranslateService} from '@ngx-translate/core';
import {describe, expect, it} from 'vitest';

import {ChannelHostComponent} from './channel-host.component';
import {NavigationService} from '../../../main-page/navigation.service';
import {ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';

function channelFixture(type: ChannelType): ChannelDto {
    return {
        id: 'c1',
        createdAt: new Date(0),
        updatedAt: new Date(0),
        name: 'the sauna',
        description: '',
        type,
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

function setup(type: ChannelType): ComponentFixture<ChannelHostComponent> {
    TestBed.configureTestingModule({
        imports: [ChannelHostComponent],
        providers: [
            provideTranslateService({defaultLanguage: 'en'}),
            {provide: NavigationService, useValue: {mobileNavOpen: signal(false)}},
        ],
    });

    const fixture = TestBed.createComponent(ChannelHostComponent);
    fixture.componentRef.setInput('channel', channelFixture(type));
    fixture.detectChanges();
    return fixture;
}

describe('ChannelHostComponent', () => {
    it('renders the placeholder for a type this build does not know', () => {
        const fixture = setup('Sauna' as ChannelType);

        expect(fixture.nativeElement.querySelector('app-unsupported-channel')).not.toBeNull();
    });

    it('passes the channel through to the view it picked', () => {
        const fixture = setup('Sauna' as ChannelType);

        expect(fixture.nativeElement.textContent).toContain('the sauna');
    });
});
