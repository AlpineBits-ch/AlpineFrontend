/**
 * TWINT, which cannot be deep-linked, prefilled or scanned into by anybody outside a merchant
 * contract - and the seam for the phone number that makes the manual assist work.
 *
 * <p><b>Read this before adding anything here.</b> The ceiling for TWINT is: show the number large,
 * offer a copy button, offer a button that launches the app cold, and stop. Every richer option was
 * investigated and closed off:</p>
 *
 * <ul>
 *   <li><b>No API.</b> TWINT states its API "is not publicly accessible and is also not made
 *       available on request".</li>
 *   <li><b>No constructible link.</b> The app-switch surface is `twint-issuerN://` on iOS and the
 *       `ch.twint.action.TWINT_PAYMENT` intent on Android, and every one of them carries a
 *       server-issued pairing token and nothing else. There is no recipient field and no amount
 *       field anywhere in it. TWINT's own certified SDK cannot construct a QR payload either - it
 *       models the QR as an opaque PNG returned by TWINT's servers.</li>
 *   <li><b>No universal links.</b> `www.twint.ch`'s apple-app-site-association carries a
 *       `webcredentials` key only, with no `applinks` key at all, and `assetlinks.json` is a 404 on
 *       every host tested.</li>
 *   <li><b>No stored QR, and this one is a terms problem rather than a technical one.</b> The
 *       variable-amount QR sticker is a business product private individuals cannot obtain, and
 *       TWINT's own FAQ states the stickers "dürfen nicht online (z.B. auf einer Website, per
 *       WhatsApp oder mit einer E-Mail) eingesetzt werden" - naming messaging specifically, which
 *       is exactly what a household app is. <b>Do not build a "store your TWINT QR" feature.</b>
 *       If it is proposed again, that sentence is the reason it was rejected.</li>
 * </ul>
 *
 * <p><b>The number is not in the sealed blob and must not be put there.</b> Identity owns the
 * account's `phoneNumber` behind a per-household opt-in, and that work is in flight elsewhere. This
 * module takes a number as an argument and stores nothing, which is the seam: when the Identity
 * field lands, the pay sheet passes it in and nothing else changes.</p>
 *
 * <p><b>It is not SMS-verified, and nothing here may say it is.</b> There is no SMS budget, so
 * nothing proves the number belongs to the person who typed it. The check that actually catches a
 * typo is free and already trusted: TWINT shows the recipient's name once a number is entered, and
 * the payer confirms that name before sending. That is what {@link TWINT_CONFIRM_NAME_ADVICE} says,
 * and it is the only assurance wording this feature is entitled to.</p>
 */

/**
 * The one instruction that makes a TWINT hand-off safe, and the only claim we may make about it.
 *
 * <p>Deliberately phrased as something the payer does, not as something the app has established.
 * "Verified", "confirmed" and any variation on them are wrong here, in every language.</p>
 */
export const TWINT_CONFIRM_NAME_ADVICE =
    'TWINT shows the recipient\'s name once you enter the number. Check that it is the person you '
    + 'mean before you send anything - that check is what catches a mistyped number, and nothing '
    + 'in this app has confirmed the number belongs to them.';

/** Whether a TWINT assist can be offered at all. Purely "is there a number to show". */
export function canOfferTwintAssist(phoneNumber: string | null | undefined): boolean {
    return normalizeSwissPhoneNumber(phoneNumber ?? '') !== null;
}

/**
 * A Swiss mobile number in the form TWINT expects it typed, or null.
 *
 * <p>Accepts the three ways people write one - `079 123 45 67`, `+41 79 123 45 67`,
 * `0041791234567` - and produces the international form, because that is the one that is
 * unambiguous when it is read off a screen and typed into another app.</p>
 *
 * <p>Nothing about this is a verification. It establishes that a string is shaped like a number,
 * which is all it can do and all the UI may claim.</p>
 */
export function normalizeSwissPhoneNumber(input: string): string | null {
    const digits = (input ?? '').replace(/[^\d+]/g, '');
    if (!digits) return null;

    const national = digits.startsWith('+41') ? digits.slice(3)
        : digits.startsWith('0041') ? digits.slice(4)
            : digits.startsWith('41') && digits.length === 11 ? digits.slice(2)
                : digits.startsWith('0') ? digits.slice(1)
                    : null;

    // Swiss subscriber numbers are nine digits after the country code, and a mobile one starts 7.
    return national && /^\d{9}$/.test(national) ? `+41${national}` : null;
}

/** `+41791234567` -> `+41 79 123 45 67`, which is how it is read aloud and checked. */
export function formatSwissPhoneNumber(e164: string): string {
    const match = /^\+41(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(e164);
    return match ? `+41 ${match[1]} ${match[2]} ${match[3]} ${match[4]}` : e164;
}
