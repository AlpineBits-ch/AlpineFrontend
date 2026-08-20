import {describe, expect, it} from 'vitest';
import {TestBed} from '@angular/core/testing';
import {Component, signal} from '@angular/core';
import {ChannelType} from '../../../../dtos/response/guild.dto';
import {ChannelIconComponent} from './channel-icon.component';

interface Channel {
    type: ChannelType;
    icon?: string;
    iconColor?: string;
}

@Component({
    imports: [ChannelIconComponent],
    template: '<app-channel-icon [channel]="channel()" />',
})
class HostComponent {
    readonly channel = signal<Channel>({type: ChannelType.Text});
}

function render(channel: Channel) {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.channel.set(channel);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
}

describe('ChannelIconComponent', () => {
    it('renders a hash for a plain text channel', () => {
        const el = render({type: ChannelType.Text});
        expect(el.textContent?.trim()).toBe('#');
        expect(el.querySelector('svg')).toBeNull();
    });

    it('renders the type icon for a voice channel', () => {
        const el = render({type: ChannelType.Voice});
        expect(el.querySelector('svg')).not.toBeNull();
        expect(el.textContent?.trim()).toBe('');
    });

    it('renders a custom icon in place of the hash', () => {
        const el = render({type: ChannelType.Text, icon: 'swords'});
        expect(el.querySelector('svg')).not.toBeNull();
        expect(el.textContent?.trim()).toBe('');
    });

    it('falls back to the hash when the stored icon is not shipped', () => {
        const el = render({type: ChannelType.Text, icon: 'not-a-real-icon'});
        expect(el.textContent?.trim()).toBe('#');
    });

    it('leaves an untinted icon without the tint class or property', () => {
        const slot = render({type: ChannelType.Voice}).querySelector('.chan-icon')!;
        expect(slot.classList.contains('chan-icon-tinted')).toBe(false);
        expect((slot as HTMLElement).style.getPropertyValue('--chan-icon-tint')).toBe('');
    });

    it('tints a channel that sets a colour', () => {
        const slot = render({type: ChannelType.Voice, iconColor: '#F87171'}).querySelector('.chan-icon')!;
        expect(slot.classList.contains('chan-icon-tinted')).toBe(true);
        expect((slot as HTMLElement).style.getPropertyValue('--chan-icon-tint')).toBe('#F87171');
    });

    it('ignores a colour that is not #rrggbb', () => {
        const slot = render({type: ChannelType.Voice, iconColor: 'red'}).querySelector('.chan-icon')!;
        expect(slot.classList.contains('chan-icon-tinted')).toBe(false);
    });
});
