import {describe, expect, it} from 'vitest';
import {TestBed} from '@angular/core/testing';
import {Component, signal} from '@angular/core';
import type {IconNode} from 'lucide';
import {LucideIconComponent} from './lucide-icon.component';

const TWO_PATHS: IconNode = [
    ['path', {d: 'M1 1h10'}],
    ['circle', {cx: '5', cy: '5', r: '3'}],
];

@Component({
    imports: [LucideIconComponent],
    template: '<app-lucide-icon [icon]="icon()" />',
})
class HostComponent {
    readonly icon = signal<IconNode>(TWO_PATHS);
}

describe('LucideIconComponent', () => {
    function render() {
        const fixture = TestBed.createComponent(HostComponent);
        fixture.detectChanges();
        return fixture;
    }

    it('renders one element per icon node, in order', () => {
        const svg = render().nativeElement.querySelector('svg');
        expect([...svg.children].map((c: Element) => c.tagName)).toEqual(['path', 'circle']);
    });

    it('applies every attribute from the node', () => {
        const path = render().nativeElement.querySelector('path');
        expect(path.getAttribute('d')).toBe('M1 1h10');
    });

    it('strokes with currentColor so css can tint it', () => {
        const svg = render().nativeElement.querySelector('svg');
        expect(svg.getAttribute('stroke')).toBe('currentColor');
    });

    it('is hidden from assistive tech', () => {
        const svg = render().nativeElement.querySelector('svg');
        expect(svg.getAttribute('aria-hidden')).toBe('true');
    });

    it('replaces the children when the icon changes', () => {
        const fixture = render();
        fixture.componentInstance.icon.set([['rect', {x: '0', y: '0'}]]);
        fixture.detectChanges();
        const svg = fixture.nativeElement.querySelector('svg');
        expect([...svg.children].map((c: Element) => c.tagName)).toEqual(['rect']);
    });
});
