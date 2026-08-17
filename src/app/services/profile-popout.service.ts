import {Injectable, signal} from '@angular/core';

/** Which panel the full profile modal opens on. */
export type ProfileModalTab = 'activity' | 'friends' | 'servers';

export interface PopoutTarget {
    userId: string;
    /** The row the card points at. Null asks for the centered fallback. */
    anchor: HTMLElement | null;
}

export interface ModalTarget {
    userId: string;
    tab: ProfileModalTab;
}

/** Whose profile is on screen, and in which of the two surfaces. */
@Injectable({providedIn: 'root'})
export class ProfilePopoutService {
    readonly popout = signal<PopoutTarget | null>(null);
    readonly modal = signal<ModalTarget | null>(null);

    open(userId: string, anchor?: HTMLElement | null): void {
        this.popout.set({userId, anchor: anchor ?? null});
    }

    close(): void {
        this.popout.set(null);
    }

    /** The popout hands over to the modal, so opening one closes the other. */
    openModal(userId: string, tab: ProfileModalTab = 'activity'): void {
        this.popout.set(null);
        this.modal.set({userId, tab});
    }

    closeModal(): void {
        this.modal.set(null);
    }
}
