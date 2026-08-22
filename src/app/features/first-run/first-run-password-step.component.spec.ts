import {ComponentFixture, TestBed} from '@angular/core/testing';
import {TranslateModule} from '@ngx-translate/core';
import {FirstRunPasswordStepComponent} from './first-run-password-step.component';

function setup(): {
    fixture: ComponentFixture<FirstRunPasswordStepComponent>;
    emitted: string[];
} {
    TestBed.configureTestingModule({
        imports: [FirstRunPasswordStepComponent, TranslateModule.forRoot()],
    });

    const fixture = TestBed.createComponent(FirstRunPasswordStepComponent);

    const emitted: string[] = [];
    fixture.componentInstance.submitted.subscribe(p => emitted.push(p));
    fixture.detectChanges();

    return {fixture, emitted};
}

function field(fixture: ComponentFixture<FirstRunPasswordStepComponent>): HTMLInputElement {
    const el = fixture.nativeElement.querySelector('[data-testid="first-run-password"]');
    expect(el).toBeTruthy();
    return el as HTMLInputElement;
}

function type(fixture: ComponentFixture<FirstRunPasswordStepComponent>, value: string): HTMLInputElement {
    const input = field(fixture);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    return input;
}

describe('FirstRunPasswordStepComponent', () => {
    it('emits the typed password when the shell submits', () => {
        const {fixture, emitted} = setup();

        type(fixture, ' hunter2 ');
        fixture.componentInstance.submit();

        // Not trimmed: a space is a legal password character.
        expect(emitted).toEqual([' hunter2 ']);
    });

    it('does not emit while the field is empty', () => {
        const {fixture, emitted} = setup();

        fixture.componentInstance.submit();
        type(fixture, 'x');
        type(fixture, '');
        fixture.componentInstance.submit();

        expect(emitted).toEqual([]);
    });

    it('submits on Enter in the field', () => {
        const {fixture, emitted} = setup();

        const input = type(fixture, 'hunter2');
        input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));

        expect(emitted).toEqual(['hunter2']);
    });

    it('disables the field while busy', () => {
        const {fixture} = setup();

        expect(field(fixture).disabled).toBe(false);

        fixture.componentRef.setInput('busy', true);
        fixture.detectChanges();

        expect(field(fixture).disabled).toBe(true);
    });

    it('shows the error it is given and nothing when there is none', () => {
        const {fixture} = setup();

        expect(fixture.nativeElement.querySelector('[data-testid="first-run-password-error"]')).toBeNull();

        fixture.componentRef.setInput('error', 'FIRST_RUN.PASSWORD.WRONG');
        fixture.detectChanges();

        const err = fixture.nativeElement.querySelector('[data-testid="first-run-password-error"]');
        expect(err.textContent).toContain('FIRST_RUN.PASSWORD.WRONG');
    });
});
