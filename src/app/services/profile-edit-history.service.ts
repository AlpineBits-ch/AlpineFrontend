import {computed, Injectable, signal} from '@angular/core';
import {CanvasWidgetDto} from '../dtos/response/profile-canvas.dto';
import {ProfileFont} from '../dtos/response/profile.dto';

export type TextHistoryKind = 'bio' | 'accentColor' | 'font';
export type CanvasHistoryKind = 'add' | 'remove' | 'move' | 'resize' | 'visibility' | 'card' | 'config';

export interface TextHistoryEntry {
    domain: 'text';
    kind: TextHistoryKind;
    before: string | ProfileFont;
    after: string | ProfileFont;
}

export interface CanvasHistoryEntry {
    domain: 'canvas';
    kind: CanvasHistoryKind;
    widgetType: string;
    before: CanvasWidgetDto[];
    after: CanvasWidgetDto[];
}

export type ProfileHistoryEntry = TextHistoryEntry | CanvasHistoryEntry;

/** A canvas entry carries two widget-array snapshots, so this stays generous rather than tight;
 * 50 steps back covers any realistic run of mistakes without an unbounded stack on a long session. */
export const PROFILE_HISTORY_DEPTH = 50;

interface TextFieldValues {
    bio: string;
    accentColor: string;
    font: ProfileFont;
}

const TEXT_KINDS: readonly TextHistoryKind[] = ['bio', 'accentColor', 'font'];

/**
 * One undo/redo stack for the whole editable profile: canvas arrangement, widget config, bio,
 * accent and font. `CanvasEditorService` pushes a canvas entry as it mutates; `ProfilePageComponent`
 * pushes a text entry once a pause commits it. Applying an entry back onto the drafts is the
 * caller's job; this only tracks what happened.
 */
@Injectable({providedIn: 'root'})
export class ProfileEditHistoryService {
    private readonly undoStack = signal<ProfileHistoryEntry[]>([]);
    private readonly redoStack = signal<ProfileHistoryEntry[]>([]);
    private readonly pendingBursts = new Map<string, unknown>();

    readonly canUndo = computed(() => this.undoStack().length > 0);
    readonly canRedo = computed(() => this.redoStack().length > 0);
    readonly nextUndo = computed<ProfileHistoryEntry | null>(() => this.undoStack().at(-1) ?? null);
    readonly nextRedo = computed<ProfileHistoryEntry | null>(() => this.redoStack().at(-1) ?? null);

    /** Undo does not survive leaving the page or switching to a different profile. */
    reset(): void {
        this.undoStack.set([]);
        this.redoStack.set([]);
        this.pendingBursts.clear();
    }

    /** Captures the value a key held before the first edit in the burst still in progress for it.
     * A later call for the same key before the burst commits is a no-op: the burst's start is
     * what matters. */
    noteBurst(key: string, before: unknown): void {
        if (!this.pendingBursts.has(key)) this.pendingBursts.set(key, before);
    }

    /** Drops a burst without pushing an entry for it: for a profile switch that discards
     * whatever was mid-pause rather than committing it. */
    discardBurst(key: string): void {
        this.pendingBursts.delete(key);
    }

    /** Closes the burst for `key` and, when one was open, pushes whatever `toEntry` builds from
     * its noted `before` and `current`. A no-op when no burst is open for `key`, and `toEntry`
     * returning null pushes nothing, either of which the caller uses to mean "no real change". */
    commitBurst<TBefore, TCurrent = TBefore>(
        key: string,
        current: TCurrent,
        toEntry: (before: TBefore, current: TCurrent) => ProfileHistoryEntry | null,
    ): void {
        const before = this.pendingBursts.get(key);
        this.pendingBursts.delete(key);
        if (before === undefined) return;
        const entry = toEntry(before as TBefore, current);
        if (entry) this.push(entry);
    }

    noteTextField(kind: TextHistoryKind, before: string | ProfileFont): void {
        this.noteBurst(kind, before);
    }

    /** Closes the current pause: one entry per field that actually changed since its `noteTextField`. */
    commitText(current: TextFieldValues): void {
        for (const kind of TEXT_KINDS) {
            this.commitBurst<string | ProfileFont>(kind, current[kind], (before, after) =>
                before === after ? null : {domain: 'text', kind, before, after},
            );
        }
    }

    pushCanvas(
        kind: CanvasHistoryKind,
        widgetType: string,
        before: CanvasWidgetDto[],
        after: CanvasWidgetDto[],
    ): void {
        this.push({domain: 'canvas', kind, widgetType, before, after});
    }

    /** Pops the top undo entry onto the redo stack and hands it back for the caller to apply. */
    undo(): ProfileHistoryEntry | null {
        const stack = this.undoStack();
        const entry = stack.at(-1);
        if (!entry) return null;
        this.undoStack.set(stack.slice(0, -1));
        this.redoStack.update(r => [...r, entry].slice(-PROFILE_HISTORY_DEPTH));
        return entry;
    }

    redo(): ProfileHistoryEntry | null {
        const stack = this.redoStack();
        const entry = stack.at(-1);
        if (!entry) return null;
        this.redoStack.set(stack.slice(0, -1));
        this.undoStack.update(u => [...u, entry].slice(-PROFILE_HISTORY_DEPTH));
        return entry;
    }

    private push(entry: ProfileHistoryEntry): void {
        this.undoStack.update(stack => [...stack, entry].slice(-PROFILE_HISTORY_DEPTH));
        this.redoStack.set([]);
    }
}
