import {ComponentFixture, TestBed} from '@angular/core/testing';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {FirstRunCodeStepComponent} from './first-run-code-step.component';

// The locales submodule carries these keys under a separate commit; the prompt is set here so the
// test does not depend on that landing first.
const TRANSLATIONS = {
    'FIRST_RUN.CODE.CONFIRM_PROMPT': 'Type the {{ordinal}} word to confirm you have it',
};

const CODE = 'anchor breeze cinder dapple ember fathom';

function setup(wordIndex: number): {
    fixture: ComponentFixture<FirstRunCodeStepComponent>;
    confirmations: number;
} {
    TestBed.configureTestingModule({
        imports: [FirstRunCodeStepComponent, TranslateModule.forRoot()],
    });

    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', TRANSLATIONS);
    translate.use('en');

    const fixture = TestBed.createComponent(FirstRunCodeStepComponent);
    fixture.componentRef.setInput('code', CODE);
    fixture.componentRef.setInput('wordIndex', wordIndex);

    let confirmations = 0;
    fixture.componentInstance.confirmed.subscribe(() => confirmations++);
    fixture.detectChanges();

    return {
        fixture,
        get confirmations() {
            return confirmations;
        },
    };
}

function type(fixture: ComponentFixture<FirstRunCodeStepComponent>, value: string): void {
    const input = fixture.nativeElement.querySelector(
        '[data-testid="first-run-confirm-input"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
}

describe('FirstRunCodeStepComponent', () => {
    it('asks for the word at the given index, as a one-based ordinal', () => {
        const {fixture} = setup(3);

        const prompt = fixture.nativeElement.querySelector(
            '[data-testid="first-run-confirm-prompt"]',
        ) as HTMLElement;

        expect(prompt.textContent?.trim()).toBe('Type the 4th word to confirm you have it');
    });

    it('emits confirmed once the demanded word is typed', () => {
        const result = setup(3);

        type(result.fixture, 'dapple');

        expect(result.confirmations).toBe(1);
    });

    it('stays silent for a word from another position', () => {
        const result = setup(3);

        type(result.fixture, 'ember');
        type(result.fixture, 'anchor');

        expect(result.confirmations).toBe(0);
    });

    it('accepts the word with surrounding whitespace and any casing', () => {
        const result = setup(0);

        type(result.fixture, '  AnChOr ');

        expect(result.confirmations).toBe(1);
    });
});
