import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {provideTranslateService} from '@ngx-translate/core';
import {WidgetPropertiesComponent} from './widget-properties.component';
import {CanvasEditorService} from '../../../../../../services/canvas-editor.service';
import {ProfileCanvasApiService} from '../../../../../../services/profile-canvas-api.service';
import {emptyCanvas} from '../../../../../../models/profile-canvas';

function setup(type: string) {
    TestBed.configureTestingModule({
        providers: [provideTranslateService(), {provide: ProfileCanvasApiService, useValue: {}}],
    });
    const editor = TestBed.inject(CanvasEditorService);
    editor.begin(emptyCanvas('p1'));
    editor.insert(type);

    const fixture = TestBed.createComponent(WidgetPropertiesComponent);
    fixture.componentRef.setInput('widget', editor.draft()!.widgets[0]);
    fixture.detectChanges();
    return {fixture, editor};
}

describe('WidgetPropertiesComponent', () => {
    it('draws one control per declared field', () => {
        const {fixture} = setup('quote');
        expect(fixture.nativeElement.querySelectorAll('[data-testid="field"]')).toHaveLength(2);
    });

    it('typing into a text field patches the config', () => {
        const {fixture, editor} = setup('quote');
        const input: HTMLTextAreaElement = fixture.nativeElement.querySelector('textarea');
        input.value = 'a new line';
        input.dispatchEvent(new Event('input'));

        expect((editor.draft()!.widgets[0].config as {text: string}).text).toBe('a new line');
    });

    it('offers every footprint the registry allows for the type', () => {
        const {fixture} = setup('quote');
        expect(fixture.nativeElement.querySelectorAll('[data-testid="footprint"]')).toHaveLength(3);
    });

    it('draws the three visibility choices', () => {
        const {fixture} = setup('quote');
        expect(fixture.nativeElement.querySelectorAll('[data-testid="visibility"]')).toHaveLength(3);
    });

    it('draws no field controls for a widget that declares none', () => {
        const {fixture} = setup('mutuals');
        expect(fixture.nativeElement.querySelectorAll('[data-testid="field"]')).toHaveLength(0);
    });
});
