import {ChangeDetectionStrategy, Component} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {ProfileFont} from '../dtos/response/profile.dto';
import {UserNameStyleDirective} from './user-name-style.directive';

@Component({
    imports: [UserNameStyleDirective],
    template: `<span [appUserNameStyle]="profile">Name</span>`,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
class HostComponent {
    profile: {accentColor?: string | null; font?: ProfileFont} | null = null;
}

describe('UserNameStyleDirective', () => {
    let fixture: ComponentFixture<HostComponent>;

    beforeEach(() => {
        fixture = TestBed.createComponent(HostComponent);
    });

    function span(): HTMLElement {
        return fixture.nativeElement.querySelector('span');
    }

    it('applies no inline style when profile is null', () => {
        fixture.componentInstance.profile = null;
        fixture.detectChanges();
        expect(span().style.color).toBe('');
        expect(span().style.fontFamily).toBe('');
    });

    it('applies color and font-family from the profile', () => {
        fixture.componentInstance.profile = {accentColor: '#ff0000', font: ProfileFont.Serif};
        fixture.detectChanges();
        expect(span().style.color).toBe('rgb(255, 0, 0)');
        expect(span().style.fontFamily).toContain('Lora Variable');
        expect(span().style.fontSizeAdjust).toBe('');
    });

    it('applies fontSizeAdjust for the handwritten font so it does not render too small', () => {
        fixture.componentInstance.profile = {accentColor: null, font: ProfileFont.Handwritten};
        fixture.detectChanges();
        expect(span().style.fontFamily).toContain('Caveat Variable');
        expect(span().style.fontSizeAdjust).toBe('0.5');
    });
});
