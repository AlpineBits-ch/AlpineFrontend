import {isTypingTarget} from './wiki-shortcut-keys.directive';
import {shortcutKeyLabel, WIKI_SHORTCUTS} from './wiki-shortcuts';

describe('isTypingTarget', () => {
    it('is false for a plain element', () => {
        expect(isTypingTarget(document.createElement('div'))).toBe(false);
    });

    it('is false for a non-element target', () => {
        expect(isTypingTarget(null)).toBe(false);
        expect(isTypingTarget(document)).toBe(false);
    });

    it('is true for text fields', () => {
        expect(isTypingTarget(document.createElement('input'))).toBe(true);
        expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
        expect(isTypingTarget(document.createElement('select'))).toBe(true);
    });

    it('is true inside a contenteditable host', () => {
        const host = document.createElement('div');
        host.setAttribute('contenteditable', 'true');
        const child = document.createElement('p');
        host.appendChild(child);
        expect(isTypingTarget(child)).toBe(true);
    });

    // Read mode is the same ProseMirror element with contenteditable="false", and it is exactly
    // where `e` has to work - so a check for "is the editor" instead of "is editable" would make
    // the shortcut it exists for impossible.
    it('is false for an editor that is not editable', () => {
        const el = document.createElement('div');
        el.className = 'ProseMirror';
        el.setAttribute('contenteditable', 'false');
        expect(isTypingTarget(el)).toBe(false);
    });
});

describe('shortcutKeyLabel', () => {
    it('renders mod per platform', () => {
        expect(shortcutKeyLabel('mod', true)).toBe('⌘');
        expect(shortcutKeyLabel('mod', false)).toBe('Ctrl');
    });

    it('passes other tokens through', () => {
        expect(shortcutKeyLabel('[[', false)).toBe('[[');
        expect(shortcutKeyLabel('Tab', true)).toBe('Tab');
    });
});

describe('WIKI_SHORTCUTS', () => {
    it('gives every shortcut at least one key and a label', () => {
        for (const shortcut of WIKI_SHORTCUTS) {
            expect(shortcut.keys.length).toBeGreaterThan(0);
            expect(shortcut.labelKey).toBeTruthy();
        }
    });
});
