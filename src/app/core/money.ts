/**
 * The money surface for billing. One implementation, re-exported rather than rewritten: never add
 * a second formatter here. The currency always comes from the payload, and the exponent from
 * `Intl` rather than a division by 100.
 */
export {formatMinor, minorUnitDigits} from '../helpers/money.helper';
