import {Component, HostListener, input, output} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {isMacKeyboard, shortcutKeyLabel, shortcutsIn, WIKI_SHORTCUT_GROUPS} from './wiki-shortcuts';

/**
 * The `?` cheat sheet.
 *
 * Content comes entirely from `WIKI_SHORTCUTS`, so documenting a new binding is a one-line edit
 * in that file and never a layout change here.
 */
@Component({
    selector: 'app-wiki-shortcuts-overlay',
    imports: [TranslateModule],
    templateUrl: './wiki-shortcuts-overlay.component.html',
})
export class WikiShortcutsOverlayComponent {
    readonly open = input(false);

    readonly closed = output<void>();

    protected readonly groups = WIKI_SHORTCUT_GROUPS.map(group => ({
        ...group,
        shortcuts: shortcutsIn(group.id).map(shortcut => ({
            ...shortcut,
            // Resolved once at construction: the keyboard does not change under the user.
            labels: shortcut.keys.map(key => shortcutKeyLabel(key, isMacKeyboard())),
        })),
    }));

    /**
     * `?` closes as well as opens, so the key that summoned the sheet also dismisses it - the
     * alternative is a panel you have to aim at to get rid of.
     */
    @HostListener('document:keydown', ['$event'])
    protected onKeydown(event: KeyboardEvent): void {
        if (!this.open()) return;
        if (event.key === 'Escape' || event.key === '?') {
            event.preventDefault();
            this.closed.emit();
        }
    }
}
