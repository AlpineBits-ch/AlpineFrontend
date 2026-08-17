/**
 * TWINT, which cannot be deep-linked, prefilled or scanned into by anybody outside a merchant
 * contract - and the seam for the phone number that makes the manual assist work.
 */

/** The one instruction that makes a TWINT hand-off safe, and the only claim we may make about it. */
export const TWINT_CONFIRM_NAME_ADVICE =
    "TWINT shows the recipient's name once you enter the number. Check that it is the person you " +
    'mean before you send anything - that check is what catches a mistyped number, and nothing ' +
    'in this app has confirmed the number belongs to them.';

/** Whether a TWINT assist can be offered at all. Purely "is there a number to show". */
export function canOfferTwintAssist(phoneNumber: string | null | undefined): boolean {
    return normalizeSwissPhoneNumber(phoneNumber ?? '') !== null;
}

/** A Swiss mobile number in the form TWINT expects it typed, or null. */
export function normalizeSwissPhoneNumber(input: string): string | null {
    const digits = (input ?? '').replace(/[^\d+]/g, '');
    if (!digits) return null;

    const national = digits.startsWith('+41')
        ? digits.slice(3)
        : digits.startsWith('0041')
          ? digits.slice(4)
          : digits.startsWith('41') && digits.length === 11
            ? digits.slice(2)
            : digits.startsWith('0')
              ? digits.slice(1)
              : null;

    // Swiss subscriber numbers are nine digits after the country code, and a mobile one starts 7.
    return national && /^\d{9}$/.test(national) ? `+41${national}` : null;
}

/** `+41791234567` -> `+41 79 123 45 67`, which is how it is read aloud and checked. */
export function formatSwissPhoneNumber(e164: string): string {
    const match = /^\+41(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(e164);
    return match ? `+41 ${match[1]} ${match[2]} ${match[3]} ${match[4]}` : e164;
}
