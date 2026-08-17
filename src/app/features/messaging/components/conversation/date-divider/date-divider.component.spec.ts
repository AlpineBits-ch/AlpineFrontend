import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService, TranslateService} from '@ngx-translate/core';
import {beforeEach, describe, expect, it} from 'vitest';
import {DateDividerComponent} from './date-divider.component';
import {DaySeparator} from '../message-utils';

async function setup(separator: DaySeparator) {
    // configureTestingModule must not run against a TestBed another spec file left instantiated.
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
        imports: [DateDividerComponent],
        providers: [provideTranslateService({lang: 'en', fallbackLang: 'en'})],
    }).compileComponents();

    // Flat keys, matching the locale files.
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', {'COMMON.TODAY': 'Today', 'COMMON.YESTERDAY': 'Yesterday'});
    translate.use('en');

    const fixture: ComponentFixture<DateDividerComponent> = TestBed.createComponent(DateDividerComponent);
    fixture.componentRef.setInput('separator', separator);
    fixture.detectChanges();
    return fixture;
}

function label(fixture: ComponentFixture<DateDividerComponent>): string {
    return (fixture.nativeElement.querySelector('span')?.textContent ?? '').trim();
}

describe('DateDividerComponent', () => {
    let separator: DaySeparator;

    beforeEach(() => {
        separator = {key: '2026-03-14', date: new Date(2026, 2, 14, 9, 0), relation: null};
    });

    it('names today', async () => {
        const fixture = await setup({...separator, relation: 'today'});
        expect(label(fixture)).toBe('Today');
    });

    it('names yesterday', async () => {
        const fixture = await setup({...separator, relation: 'yesterday'});
        expect(label(fixture)).toBe('Yesterday');
    });

    it('falls back to the formatted date for an older day', async () => {
        const fixture = await setup(separator);
        expect(label(fixture)).toContain('2026');
        expect(label(fixture)).not.toBe('Today');
    });
});
