import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection} from '@angular/core';
import {By} from '@angular/platform-browser';
import {provideTranslateService} from '@ngx-translate/core';
import {Select} from 'primeng/select';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ProfileAppearanceBarComponent} from './profile-appearance-bar.component';
import {ProfileFont} from '../../../dtos/response/profile.dto';

function setup(inputs: Partial<{accentColor: string; font: ProfileFont}> = {}) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [ProfileAppearanceBarComponent],
        providers: [provideZonelessChangeDetection(), provideTranslateService()],
    });

    const fixture: ComponentFixture<ProfileAppearanceBarComponent> =
        TestBed.createComponent(ProfileAppearanceBarComponent);
    fixture.componentRef.setInput('accentColor', inputs.accentColor ?? '');
    fixture.componentRef.setInput('font', inputs.font ?? ProfileFont.Default);
    fixture.detectChanges();
    return fixture;
}

function el(fixture: ComponentFixture<unknown>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
}

function testId(fixture: ComponentFixture<unknown>, id: string): HTMLElement | null {
    return el(fixture).querySelector(`[data-testid="${id}"]`);
}

describe('ProfileAppearanceBarComponent', () => {
    beforeEach(() => {
        // jsdom implements no `matchMedia`, and PrimeNG's Select reads it.
        if (!window.matchMedia) {
            window.matchMedia = ((query: string) => ({
                matches: false,
                media: query,
                onchange: null,
                addEventListener: () => undefined,
                removeEventListener: () => undefined,
                addListener: () => undefined,
                removeListener: () => undefined,
                dispatchEvent: () => false,
            })) as unknown as typeof window.matchMedia;
        }
    });

    it('renders the accent swatch and the font select', () => {
        const fixture = setup();

        expect(el(fixture).querySelector('input[type="color"]')).not.toBeNull();
        expect(testId(fixture, 'font-select')).not.toBeNull();
    });

    it('the accent colour input emits accentColorChanged, and reset emits an empty string', () => {
        const fixture = setup({accentColor: '#123456'});
        const accentColorChanged = vi.fn();
        fixture.componentInstance.accentColorChanged.subscribe(accentColorChanged);

        const input: HTMLInputElement = el(fixture).querySelector('input[type="color"]')!;
        input.value = '#abcdef';
        input.dispatchEvent(new Event('input'));
        expect(accentColorChanged).toHaveBeenCalledWith('#abcdef');

        testId(fixture, 'accent-reset')!.click();
        expect(accentColorChanged).toHaveBeenCalledWith('');
    });

    it('the reset control only shows once an accent colour is set', () => {
        expect(testId(setup({accentColor: ''}), 'accent-reset')).toBeNull();
        expect(testId(setup({accentColor: '#123456'}), 'accent-reset')).not.toBeNull();
    });

    it('the font select emits fontChanged', () => {
        const fixture = setup();
        const fontChanged = vi.fn();
        fixture.componentInstance.fontChanged.subscribe(fontChanged);

        const select = fixture.debugElement.query(By.directive(Select)).componentInstance as Select;
        select.show();
        fixture.detectChanges();

        const option = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(
            '.p-select-option',
        )[1];
        option.click();
        fixture.detectChanges();

        expect(fontChanged).toHaveBeenCalledOnce();
        expect(fontChanged.mock.calls[0][0]).not.toBe(ProfileFont.Default);
    });

    it('previews the selected font on the sample line', () => {
        const withFont = setup({font: ProfileFont.Monospace});
        const withoutFont = setup({font: ProfileFont.Default});

        const previewLine = (fixture: ComponentFixture<unknown>) => el(fixture).querySelector<HTMLElement>('p');

        expect(previewLine(withFont)?.style.fontFamily).not.toBe('');
        expect(previewLine(withoutFont)?.style.fontFamily).toBe('');
    });
});
