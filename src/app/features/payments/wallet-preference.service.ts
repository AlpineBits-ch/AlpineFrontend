import {Injectable, signal} from '@angular/core';
import {PaymentHandleKind} from './payment-handle.model';

/**
 * Which wallet this person actually uses, asked once and remembered.
 *
 * <p><b>Chosen rather than detected, and the alternative is genuinely dead.</b> The obvious design
 * is to probe for installed wallets and show only those. On iOS that means `canOpenURL`, which is
 * <b>deprecated as of iOS 27</b> and whose `LSApplicationQueriesSchemes` budget drops from fifty
 * entries to twenty-five for anything linked against the iOS 27 SDK - and TWINT alone wants around
 * forty, one scheme per bank-issued app, before a single other wallet is considered. It never
 * worked for `https` links in any case: the answer reflects whether a browser is registered for the
 * scheme, so it is effectively always true and says nothing about the payment app. Apple's own
 * remediation is to attempt the open and handle the failure.</p>
 *
 * <p>So the user picks, once, and we honour it: their choice sorts to the top of the pay sheet and
 * is offered first. Nothing is ever hidden on the basis of a guess, because a guess that hides the
 * wallet somebody actually has is worse than a list one item too long.</p>
 *
 * <p>Local to the installation, not synced. Which app is installed is a property of this device,
 * and a phone and a desktop can legitimately disagree.</p>
 */
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

    /**
     * Orders a housemate's handles so the viewer's own wallet comes first.
     *
     * <p>A stable sort over one key, so everything else keeps the order the owner listed it in -
     * which is the order they thought about, and is not ours to shuffle.</p>
     */
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
