/**
 * Task 18: the invite card that fills the stage beside a lone participant. Layout only - see the
 * component's own class doc for why `invite` is not wired to anything yet. These specs cover the
 * three things the brief actually asked for: the tile shape matches a participant tile so it sits
 * in the grid as a peer, the one action emits rather than silently doing nothing, and "Choose
 * Activity" - present in the reference screenshot - was deliberately left out.
 */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallInviteCardComponent} from './call-invite-card.component';

function render(): ComponentFixture<CallInviteCardComponent> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({imports: [CallInviteCardComponent, TranslateModule.forRoot()]});
    const fixture = TestBed.createComponent(CallInviteCardComponent);
    fixture.detectChanges();
    return fixture;
}

describe('CallInviteCardComponent', () => {
    it('is shaped like a participant tile so it sits in the grid as a peer', () => {
        const fixture = render();

        const root: HTMLElement = fixture.nativeElement.querySelector('div');
        expect(root.className).toContain('aspect-video');
        expect(root.className).toContain('w-full');
        expect(root.className).toContain('rounded-2xl');
        expect(root.className).toContain('border-border-subtle');
    });

    it('decorates with a low-contrast PrimeIcon rather than the reference artwork', () => {
        const fixture = render();

        const icon: HTMLElement = fixture.nativeElement.querySelector('i.pi-users');
        expect(icon).not.toBeNull();
        // No <img> or background-image asset anywhere in the card - the decoration is the icon plus
        // the inline gradient, both built from existing tokens, never a downloaded illustration.
        expect(fixture.nativeElement.querySelector('img')).toBeNull();
    });

    it('offers exactly one action, not a second "Choose Activity" button', () => {
        const fixture = render();

        const buttons = fixture.nativeElement.querySelectorAll('button');
        expect(buttons.length).toBe(1);
        expect(buttons[0].textContent?.trim()).toBe('CALL.INVITE_TO_VOICE');
    });

    it('emits invite when the action is pressed', () => {
        const fixture = render();
        let emitted = false;
        fixture.componentInstance.invite.subscribe(() => emitted = true);

        (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();

        expect(emitted).toBe(true);
    });
});
