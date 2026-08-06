import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {Editor} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {Markdown} from '@tiptap/markdown';
import {WikiAiInlineComponent} from './wiki-ai-inline.component';
import {WikiAiService} from '../wiki-ai.service';

/**
 * The inline bar as every entry point actually reaches it.
 *
 * Written for a bug with one symptom and several causes: picking an AI row in the slash menu made
 * the menu vanish and produced nothing at all - no bar, no error, no request. A surface that can
 * fail by rendering nothing needs its openings asserted, because "nothing happened" is exactly
 * what a silent early return looks like from the outside.
 */
describe('WikiAiInlineComponent entry points', () => {
    let fixture: ComponentFixture<WikiAiInlineComponent>;
    let editor: Editor;
    let asked: unknown[];

    /** Never resolves on its own, so the bar stays in whatever phase the entry point left it. */
    async function* pending(): AsyncIterable<string> {
        yield 'ok';
        await new Promise(() => undefined);
    }

    const ai = {
        available: () => true,
        activeProvider: () => 'anthropic',
        ghostTextEnabled: () => false,
        refresh: async () => undefined,
        draft: (req: unknown) => {
            asked.push({kind: 'draft', req});
            return pending();
        },
        transform: (req: unknown) => {
            asked.push({kind: 'transform', req});
            return pending();
        },
    };

    function barVisible(): boolean {
        return !!fixture.nativeElement.querySelector('div.fixed');
    }

    beforeEach(async () => {
        asked = [];
        await TestBed.configureTestingModule({
            imports: [WikiAiInlineComponent],
            providers: [
                provideTranslateService({defaultLanguage: 'en'}),
                {provide: WikiAiService, useValue: ai},
            ],
        }).compileComponents();

        editor = new Editor({
            element: document.createElement('div'),
            extensions: [StarterKit, Markdown],
            content: '<p>The on-call rota rotates weekly.</p>',
            editable: true,
        });

        fixture = TestBed.createComponent(WikiAiInlineComponent);
        fixture.componentRef.setInput('editor', editor);
        fixture.componentRef.setInput('editable', true);
        fixture.detectChanges();
    });

    // The component first: a stream still coalescing chunks would otherwise flush into an editor
    // whose view has already gone, which is the same order a real teardown mid-generation takes.
    afterEach(() => {
        fixture.destroy();
        editor.destroy();
    });

    it('starts closed', () => {
        expect(barVisible()).toBe(false);
    });

    it('opens a prompt at a collapsed caret', () => {
        editor.commands.setTextSelection(5);
        fixture.componentInstance.askAtCaret();
        fixture.detectChanges();
        expect(barVisible()).toBe(true);
    });

    // The reported bug. Slash-menu AI rows run against a caret, never a selection - the trigger
    // text has just been deleted and nothing is highlighted - and the action used to require one,
    // so every one of them returned silently.
    it('runs a transform from a collapsed caret rather than doing nothing', () => {
        editor.commands.setTextSelection(5);
        fixture.componentInstance.runTransform({op: 'summarize', labelKey: 'WIKI.AI.OP.SHORTEN'});
        fixture.detectChanges();
        expect(barVisible()).toBe(true);
        expect(asked.length).toBe(1);
    });

    it('sends the surrounding text when a transform runs without a selection', () => {
        editor.commands.setTextSelection(5);
        fixture.componentInstance.runTransform({op: 'summarize'});
        const sent = asked[0] as {req: {text: string}};
        expect(sent.req.text).toContain('on-call rota');
    });

    it('still uses the selection when there is one', () => {
        editor.commands.setTextSelection({from: 1, to: 12});
        fixture.componentInstance.runTransform({op: 'improve'});
        const sent = asked[0] as {req: {text: string}};
        expect(sent.req.text.length).toBeLessThan('The on-call rota rotates weekly.'.length);
    });

    // A summary that replaced the page it summarised would be a data-loss button on a menu.
    it('adds a summary rather than replacing what it read', () => {
        editor.commands.setTextSelection(5);
        fixture.componentInstance.runTransform({op: 'summarize'});
        expect(editor.state.doc.textContent).toContain('rotates weekly');
    });

    // Nothing to work on is a thing to say, not a reason to do nothing.
    it('opens with a message when the page is empty', () => {
        editor.commands.setContent('');
        fixture.componentInstance.runTransform({op: 'improve'});
        fixture.detectChanges();
        expect(barVisible()).toBe(true);
        expect(asked.length).toBe(0);
        expect(fixture.nativeElement.textContent).toContain('NOTHING_TO_TRANSFORM');
    });

    it('opens and streams for a whole-page draft', () => {
        fixture.componentInstance.draftIntoPage('write the rota page');
        fixture.detectChanges();
        expect(barVisible()).toBe(true);
        expect(asked.length).toBe(1);
    });

    // The commonest use of the draft dialog: a page that does not exist yet. An empty document
    // hands over its whole body rather than taking an insertion, which is a different range and
    // therefore a different chance to fail.
    it('opens and streams for a whole-page draft on an empty page', () => {
        editor.commands.setContent('');
        fixture.componentInstance.draftIntoPage('write the rota page');
        fixture.detectChanges();
        expect(barVisible()).toBe(true);
        expect(asked.length).toBe(1);
    });

    it('generates from the prompt typed into the bar', () => {
        editor.commands.setTextSelection(5);
        fixture.componentInstance.askAtCaret();
        fixture.detectChanges();
        const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
        input.value = 'write about the rota';
        input.dispatchEvent(new Event('input'));
        fixture.detectChanges();
        // By its icon: the first button in the bar is the provider label, not Generate.
        const send = Array.from(fixture.nativeElement.querySelectorAll('button'))
            .find(b => (b as HTMLElement).querySelector('.pi-arrow-up')) as HTMLElement;
        send.click();
        fixture.detectChanges();
        expect(asked.length).toBe(1);
    });
});
