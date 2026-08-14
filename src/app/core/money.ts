/**
 * The money surface for billing. One implementation, re-exported rather than rewritten.
 *
 * <p>Every amount in `billing-checkout-api-contract.md` is an integer number of minor units paired
 * with a lowercase ISO 4217 code from the same payload - `2900` and `"usd"` is $29.00. The
 * household ledger has been sending exactly that shape since it shipped, so the formatter for it
 * already exists in `helpers/money.helper.ts` and this file is a re-export of the two functions
 * billing needs rather than a second one.</p>
 *
 * <p><b>That is the point of the file.</b> A second formatter would agree with the first on $29.00
 * and disagree somewhere no test looks - the currencies with no minor unit, the three-digit ones,
 * the negative case - and a proration credit rendered as a charge is a support ticket that starts
 * with the customer believing they were billed twice. The contract makes the same argument about
 * entitlement values in section 1.</p>
 *
 * <p>Two rules for callers, both of which {@link formatMinor} already keeps:</p>
 *
 * <ul>
 *   <li>The currency comes from the payload being rendered, never a hardcoded symbol. This client
 *       is pointed at instances that sell in their own currency.</li>
 *   <li>The exponent comes from `Intl`, never from a division by 100. JPY has no minor unit at all,
 *       and 2900 JPY formatted as "¥29.00" is off by two orders of magnitude.</li>
 * </ul>
 *
 * <p>Negative amounts are ordinary here: `immediateChargeMinorUnits` and a preview line are both
 * credits when the change is a downgrade.</p>
 */
export {formatMinor, minorUnitDigits} from '../helpers/money.helper';
