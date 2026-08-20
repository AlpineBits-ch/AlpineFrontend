import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {Editor} from '@tiptap/core';
import {KeybindsService} from '../../../../../services/keybinds.service';
import {WIKI_EDITOR_KEYBINDS} from '../../../../../models/keybind-action.model';
import {WikiToolbarComponent} from './wiki-toolbar.component';
import {wikiExtensions} from './wiki-extensions';
import {WIKI_SLASH_ITEMS} from './wiki-slash-menu.component';
import {WIKI_FORMAT_ACTIONS} from './wiki-format-actions';

/** One table behind the toolbar, the bubble menu and the keymap: bold used to be three closures. */
describe('WIKI_FORMAT_ACTIONS', () => {
    it('covers every configurable editor keybind', () => {
        for (const action of WIKI_EDITOR_KEYBINDS) {
            expect(WIKI_FORMAT_ACTIONS[action.id as keyof typeof WIKI_FORMAT_ACTIONS]).toBeTruthy();
        }
    });

    it('gives the two host actions a discriminator instead of a command', () => {
        expect(WIKI_FORMAT_ACTIONS['wiki-link'].host).toBe('link');
        expect(WIKI_FORMAT_ACTIONS['wiki-toggle-markdown'].host).toBe('toggle-markdown');
        expect(WIKI_FORMAT_ACTIONS['wiki-link'].run).toBeUndefined();
    });
});

describe('WikiToolbarComponent', () => {
    let fixture: ComponentFixture<WikiToolbarComponent>;
    let editor: Editor;

    function buttons(): HTMLButtonElement[] {
        return Array.from(fixture.nativeElement.querySelectorAll('[role="toolbar"] button'));
    }

    beforeEach(async () => {
        Element.prototype.scrollIntoView = () => undefined;
        editor = new Editor({extensions: wikiExtensions(''), content: ''});

        await TestBed.configureTestingModule({
            imports: [WikiToolbarComponent],
            providers: [
                provideTranslateService({defaultLanguage: 'en'}),
                {provide: KeybindsService, useValue: {getBinding: () => 'Control+KeyB'}},
            ],
        }).compileComponents();

        fixture = TestBed.createComponent(WikiToolbarComponent);
        fixture.componentRef.setInput('editor', editor);
        fixture.detectChanges();
    });

    afterEach(() => editor.destroy());

    it('is one tab stop, not one per control', () => {
        const reachable = buttons().filter(b => b.getAttribute('tabindex') === '0');
        expect(buttons().length).toBeGreaterThan(5);
        expect(reachable).toHaveLength(1);
    });

    it('announces the toolbar and every toggle state', () => {
        expect(fixture.nativeElement.querySelector('[role="toolbar"]')).toBeTruthy();
        const pressed = buttons().filter(b => b.hasAttribute('aria-pressed'));
        // Five marks, the link button and the markdown toggle.
        expect(pressed.length).toBe(7);
    });

    // Colour alone used to carry it, which no screen reader reads.
    it('flips aria-pressed with the mark under the caret', () => {
        const bold = () => buttons().find(b => b.textContent?.trim() === 'B')!;
        expect(bold().getAttribute('aria-pressed')).toBe('false');

        editor.commands.setContent('**loud**', {contentType: 'markdown'});
        editor.commands.setTextSelection({from: 1, to: 5});
        fixture.detectChanges();

        expect(bold().getAttribute('aria-pressed')).toBe('true');
    });

    // No locale is loaded here, so the pipe renders the key; the key is what identifies the block.
    it('names the block the caret is in on the Turn into control', () => {
        expect(buttons()[0].textContent).toContain('WIKI.BLOCK.TEXT');

        editor.commands.setContent('# Setup', {contentType: 'markdown'});
        editor.commands.setTextSelection(2);
        fixture.detectChanges();

        expect(buttons()[0].textContent).toContain('WIKI.BLOCK.HEADING_1');
    });

    it('offers the slash menu s own list rather than a second copy', () => {
        const insert = buttons().find(b => b.querySelector('.pi-plus'))!;
        insert.click();
        fixture.detectChanges();

        const rows = fixture.nativeElement.querySelectorAll('app-wiki-slash-menu button');
        expect(rows.length).toBe(WIKI_SLASH_ITEMS.length);
    });

    it('turns a block into what Turn into offers, and only offers blocks it can apply', () => {
        const chosen: string[] = [];
        fixture.componentInstance.insertItem.subscribe(item => chosen.push(item.labelKey));
        buttons()[0].click();
        fixture.detectChanges();

        const rows: HTMLButtonElement[] = Array.from(
            fixture.nativeElement.querySelectorAll('app-wiki-slash-menu button'),
        );
        expect(rows.length).toBe(WIKI_SLASH_ITEMS.filter(item => item.run).length);

        rows[1].click();
        expect(chosen).toHaveLength(1);
    });
});
