import {ChangeDetectionStrategy, Component, signal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it} from 'vitest';

import {ChipTag, TagChipComponent} from './tag-chip.component';

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TagChipComponent],
    template: `
        <app-tag-chip
            [tag]="tag()"
            [selected]="selected()"
            [interactive]="interactive()"
            [removable]="removable()"
            [size]="size()"
            [emojiUrl]="emojiUrl()"
            [count]="count()"
        />
    `,
})
class HostComponent {
    readonly tag = signal<ChipTag>({name: 'betrayal', color: '#000000'});
    readonly selected = signal(false);
    readonly interactive = signal(false);
    readonly removable = signal(false);
    readonly size = signal<'sm' | 'xs'>('sm');
    readonly emojiUrl = signal<string | null>(null);
    readonly count = signal<number | null>(null);
}

describe('TagChipComponent', () => {
    let fixture: ComponentFixture<HostComponent>;
    let host: HostComponent;

    beforeEach(() => {
        TestBed.configureTestingModule({imports: [HostComponent]});
        fixture = TestBed.createComponent(HostComponent);
        host = fixture.componentInstance;
        fixture.detectChanges();
    });

    function chip(): HTMLElement {
        return fixture.nativeElement.querySelector('span');
    }

    it('treats the servers #000000 default as no colour rather than as black', () => {
        expect(chip().style.background).toBe('transparent');
    });

    it('fills a no-colour chip with the hover token once selected', () => {
        host.selected.set(true);
        fixture.detectChanges();

        expect(chip().style.background).toBe('var(--color-hover)');
    });

    it('mixes a real colour into the surface rather than painting it flat', () => {
        host.tag.set({name: 'ashfall', color: '#ff5522'});
        fixture.detectChanges();

        // jsdom normalises the hex the component writes into rgb(), so match on that.
        expect(chip().style.background).toContain('color-mix');
        expect(chip().style.background).toContain('rgb(255, 85, 34)');
    });

    it('lifts a real colour toward white so a dark pick stays legible', () => {
        host.tag.set({name: 'ashfall', color: '#221100'});
        fixture.detectChanges();

        expect(chip().style.color).toContain('rgb(255, 255, 255)');
    });

    it('renders a unicode emoji inline and no image', () => {
        host.tag.set({name: 'ashfall', color: '#000000', emojiName: '\u{1F5E1}'});
        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).toContain('\u{1F5E1}');
        expect(fixture.nativeElement.querySelector('img')).toBeNull();
    });

    it('renders a guild emoji as an image when its url is resolved', () => {
        host.tag.set({name: 'ashfall', color: '#000000', emojiId: 'emj_1'});
        host.emojiUrl.set('https://example.test/emoji.png');
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('img')?.getAttribute('src')).toBe(
            'https://example.test/emoji.png',
        );
    });

    it('shows a count only when one is given', () => {
        expect(fixture.nativeElement.textContent).not.toContain('7');

        host.count.set(7);
        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).toContain('7');
    });

    it('shows a zero count, which is a real number and not an absent one', () => {
        host.count.set(0);
        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).toContain('0');
    });

    it('marks itself clickable only when interactive', () => {
        expect(chip().className).not.toContain('cursor-pointer');

        host.interactive.set(true);
        fixture.detectChanges();

        expect(chip().className).toContain('cursor-pointer');
    });

    it('shows the remove affordance only when removable', () => {
        expect(fixture.nativeElement.querySelector('i.pi-times')).toBeNull();

        host.removable.set(true);
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('i.pi-times')).not.toBeNull();
    });

    it('tightens its padding at the smaller size', () => {
        const atSm = chip().className;

        host.size.set('xs');
        fixture.detectChanges();

        expect(chip().className).not.toBe(atSm);
        expect(chip().className).toContain('text-[0.625rem]');
    });
});
