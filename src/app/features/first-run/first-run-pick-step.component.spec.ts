import {ComponentFixture, TestBed} from '@angular/core/testing';
import {TranslateModule} from '@ngx-translate/core';
import {FirstRunPickStepComponent} from './first-run-pick-step.component';
import {UserInterest} from '../../dtos/response/UserDto';

function setup(selected: UserInterest[] = []): {
    fixture: ComponentFixture<FirstRunPickStepComponent>;
    emitted: UserInterest[];
} {
    TestBed.configureTestingModule({
        imports: [FirstRunPickStepComponent, TranslateModule.forRoot()],
    });

    const fixture = TestBed.createComponent(FirstRunPickStepComponent);
    fixture.componentRef.setInput('selected', selected);

    const emitted: UserInterest[] = [];
    fixture.componentInstance.toggled.subscribe(i => emitted.push(i));
    fixture.detectChanges();

    return {fixture, emitted};
}

function card(fixture: ComponentFixture<FirstRunPickStepComponent>, interest: UserInterest): HTMLElement {
    const el = fixture.nativeElement.querySelector(
        `[data-testid="onboarding-choice"][data-interest="${interest}"]`,
    );
    expect(el).toBeTruthy();
    return el as HTMLElement;
}

describe('FirstRunPickStepComponent', () => {
    it('emits the interest of the card that was clicked', () => {
        const {fixture, emitted} = setup();

        card(fixture, UserInterest.Social).click();

        expect(emitted).toEqual([UserInterest.Social]);
    });

    it('emits an already-selected interest again rather than deciding for the parent', () => {
        const {fixture, emitted} = setup([UserInterest.Isle]);

        card(fixture, UserInterest.Isle).click();
        fixture.detectChanges();

        expect(emitted).toEqual([UserInterest.Isle]);
        // No internal flag: the input still says selected, so the card must still read selected.
        expect(card(fixture, UserInterest.Isle).getAttribute('aria-pressed')).toBe('true');
    });

    it('marks a card selected from the input alone', () => {
        const {fixture} = setup([UserInterest.Isle]);

        const isle = card(fixture, UserInterest.Isle);
        const social = card(fixture, UserInterest.Social);

        expect(isle.getAttribute('aria-pressed')).toBe('true');
        expect(isle.className).toContain('border-brand');
        expect(social.getAttribute('aria-pressed')).toBe('false');
        expect(social.className).not.toContain('border-brand');

        fixture.componentRef.setInput('selected', [UserInterest.Social]);
        fixture.detectChanges();

        expect(card(fixture, UserInterest.Isle).getAttribute('aria-pressed')).toBe('false');
        expect(card(fixture, UserInterest.Social).getAttribute('aria-pressed')).toBe('true');
    });
});
