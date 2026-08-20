import {describe, expect, it} from 'vitest';
import {TestBed} from '@angular/core/testing';
import {Component, signal} from '@angular/core';
import {provideTranslateService} from '@ngx-translate/core';
import {ChannelType} from '../../../../../../dtos/response/guild.dto';
import {ChannelIconPickerComponent} from './channel-icon-picker.component';

@Component({
    imports: [ChannelIconPickerComponent],
    template: `
        <app-channel-icon-picker [(icon)]="icon" [(iconColor)]="iconColor" [channelType]="type()" />
    `,
})
class HostComponent {
    readonly icon = signal('');
    readonly iconColor = signal('');
    readonly type = signal(ChannelType.Text);
}

function setup() {
    TestBed.configureTestingModule({providers: [provideTranslateService()]});
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return fixture;
}

describe('ChannelIconPickerComponent', () => {
    it('offers every palette swatch plus a default chip', () => {
        const fixture = setup();
        const swatches = fixture.nativeElement.querySelectorAll('[data-testid="icon-colour-swatch"]');
        expect(swatches.length).toBe(12);
        expect(fixture.nativeElement.querySelector('[data-testid="icon-colour-default"]')).not.toBeNull();
    });

    it('writes the chosen colour back through the model', () => {
        const fixture = setup();
        const swatch = fixture.nativeElement.querySelectorAll('[data-testid="icon-colour-swatch"]')[0];
        swatch.click();
        fixture.detectChanges();
        expect(fixture.componentInstance.iconColor()).toMatch(/^#[0-9a-fA-F]{6}$/);
    });

    it('clears the colour through the default chip', () => {
        const fixture = setup();
        fixture.componentInstance.iconColor.set('#F87171');
        fixture.detectChanges();
        fixture.nativeElement.querySelector('[data-testid="icon-colour-default"]').click();
        fixture.detectChanges();
        expect(fixture.componentInstance.iconColor()).toBe('');
    });

    it('writes the chosen icon back through the model', () => {
        const fixture = setup();
        fixture.nativeElement.querySelector('[data-testid="icon-open"]').click();
        fixture.detectChanges();
        fixture.nativeElement.querySelectorAll('[data-testid="icon-option"]')[0].click();
        fixture.detectChanges();
        expect(fixture.componentInstance.icon()).toMatch(/^[a-z0-9-]{1,48}$/);
    });

    it('filters the grid by the search term', () => {
        const fixture = setup();
        fixture.nativeElement.querySelector('[data-testid="icon-open"]').click();
        fixture.detectChanges();
        const search = fixture.nativeElement.querySelector('[data-testid="icon-search"]');
        search.value = 'swords';
        search.dispatchEvent(new Event('input'));
        fixture.detectChanges();
        const options = fixture.nativeElement.querySelectorAll('[data-testid="icon-option"]');
        expect(options.length).toBe(1);
    });

    it('clears the icon through the default option', () => {
        const fixture = setup();
        fixture.componentInstance.icon.set('swords');
        fixture.detectChanges();
        fixture.nativeElement.querySelector('[data-testid="icon-open"]').click();
        fixture.detectChanges();
        fixture.nativeElement.querySelector('[data-testid="icon-default"]').click();
        fixture.detectChanges();
        expect(fixture.componentInstance.icon()).toBe('');
    });
});
