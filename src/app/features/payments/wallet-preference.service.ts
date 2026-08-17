import {Injectable, signal} from '@angular/core';
import {PaymentHandleKind} from './payment-handle.model';

/** Which wallet this person actually uses, asked once and remembered. */
const STORAGE_KEY = 'alpine.payments.wallet';

@Injectable({providedIn: 'root'})
export class WalletPreferenceService {
    private readonly _preferred = signal<PaymentHandleKind | null>(read());

    /** The wallet to offer first, or null when the user has never said. */
    readonly preferred = this._preferred.asReadonly();

    /** Records a choice. Passing null clears it, which puts the sheet back in its default order. */
    setPreferred(kind: PaymentHandleKind | null): void {
        this._preferred.set(kind);
        try {
            if (kind === null) localStorage.removeItem(STORAGE_KEY);
            else localStorage.setItem(STORAGE_KEY, kind);
        } catch {
            // Not persisting is survivable: the choice still applies for this session.
        }
    }

    /** Orders a housemate's handles so the viewer's own wallet comes first. */
    order<T extends {kind: PaymentHandleKind}>(handles: readonly T[]): T[] {
        const preferred = this._preferred();
        if (!preferred) return [...handles];
        return [...handles].sort((a, b) =>
            Number(b.kind === preferred) - Number(a.kind === preferred));
    }
}

function read(): PaymentHandleKind | null {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        return isKind(stored) ? stored : null;
    } catch {
        return null;
    }
}

function isKind(value: string | null): value is PaymentHandleKind {
    return !!value && (Object.values(PaymentHandleKind) as string[]).includes(value);
}
