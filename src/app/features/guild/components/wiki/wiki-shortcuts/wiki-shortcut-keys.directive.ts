import {Directive, HostListener, input, output} from '@angular/core';

/**
 * The two single-key shortcuts the wiki owns: `?` opens the cheat sheet, `e` starts editing the
 * page you are reading. Listens on the document, matching the ⌘K listener the wiki host already
 * has, since these keys must work whether focus is on the page body, the nav tree, or nothing at
 * all; scoping comes from the directive's lifetime.
 */
@Directive({selector: '[appWikiShortcutKeys]'})
export class WikiShortcutKeysDirective {
    /** Set false while a modal owns the keyboard: the typing guard covers fields, but a dialog whose focus is on a button is still somewhere `e` has no business acting. */
    readonly shortcutsEnabled = input(true);
    /** Set false while already editing, so `e` does not re-enter the editor it is already in. */
    readonly editShortcutEnabled = input(true);

    readonly helpRequested = output<void>();
    readonly editRequested = output<void>();

    @HostListener('document:keydown', ['$event'])
    protected onKeydown(event: KeyboardEvent): void {
        if (!this.shortcutsEnabled() || event.defaultPrevented) return;
        // A dead key or an in-flight IME composition emits keydown with the composed letter; acting on it steals the character mid-word.
        if (event.isComposing || event.keyCode === 229) return;
        // Shift is allowed: `?` is Shift+/ on most layouts. The rest would be a different binding.
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (isTypingTarget(event.target)) return;

        if (event.key === '?') {
            event.preventDefault();
            this.helpRequested.emit();
            return;
        }
        if (event.key === 'e' && this.editShortcutEnabled()) {
            event.preventDefault();
            this.editRequested.emit();
        }
    }
}

/**
 * Whether the keystroke belongs to something the user is typing into. Note what is *not* here: the
 * ProseMirror surface itself; in read mode it is `setEditable(false)` but still present, so keying
 * off "editable" rather than "is the editor" gets both modes right for free.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    // Covers descendants of a contenteditable host as well as the host itself.
    if (target.isContentEditable) return true;
    // `isContentEditable` is unset in some test environments; the attribute is the fallback.
    return !!target.closest('[contenteditable="true"], [contenteditable=""]');
}
