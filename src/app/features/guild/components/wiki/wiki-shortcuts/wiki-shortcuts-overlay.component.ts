import {Component, computed, HostListener, inject, input, output} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {
    isMacKeyboard,
    shortcutKeyLabel,
    shortcutsIn,
    WIKI_SHORTCUT_GROUPS,
    wikiFormattingShortcuts,
} from './wiki-shortcuts';
import {KeybindsService} from '../../../../../services/keybinds.service';

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

    private readonly keybinds = inject(KeybindsService);

    /**
     * A computed rather than a constant: the formatting rows come from the user's own bindings
     * now, and a sheet still showing the key you rebound away from is worse than no sheet.
     */
    protected readonly groups = computed(() => {
        const mac = isMacKeyboard();
        // Read so this recomputes when a binding changes.
        this.keybinds.bindings();
        return WIKI_SHORTCUT_GROUPS.map(group => ({
            ...group,
            shortcuts: (group.id === 'formatting'
                ? wikiFormattingShortcuts(id => this.keybinds.getBinding(id))
                : shortcutsIn(group.id)
            ).map(shortcut => ({
                ...shortcut,
                labels: shortcut.keys.map(key => shortcutKeyLabel(key, mac)),
            })),
        }));
    });

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
