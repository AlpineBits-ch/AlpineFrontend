/**
 * The payments module's public surface.
 *
 * <p>A barrel local to this feature, not an entry in a shared type barrel: everything below is
 * consumed by the ledger screens and the settings modal, and nothing outside those has any business
 * with a decrypted payment handle. Importing from here rather than from the individual files means
 * the split between the pure generators, the crypto and the components stays an implementation
 * detail.</p>
 */

export {PaySheetComponent} from './components/pay-sheet.component';
export {PaymentHandlesEditorComponent} from './components/payment-handles-editor.component';
export {RecipientTrustReviewComponent} from './components/recipient-trust-review.component';
export {SwissQrBillComponent} from './components/swiss-qr-bill.component';
export {WalletPreferenceSettingComponent} from './components/wallet-preference-setting.component';

export {PaymentHandleService, hasHandles} from './payment-handle.service';
export type {MemberHandleState} from './payment-handle.service';
export type {SharedPhoneNumber} from './payment-handle.dto';
export {PaymentHandleApiService} from './payment-handle-api.service';
export {WalletPreferenceService} from './wallet-preference.service';

export {
    capabilitiesOf,
    checkHandleValue,
    displayHandleValue,
    normalizeHandleValue,
    PaymentHandleKind,
    PAYMENT_HANDLE_KINDS,
} from './payment-handle.model';
export type {
    CreditorAddress,
    HandleCapabilities,
    PaymentHandle,
    PaymentHandlePayload,
} from './payment-handle.model';

export {checkIban, formatIban, isSwissQrEligibleIban, isValidIban, normalizeIban} from './iban';
export {
    buildSwissQrBillPayload,
    SPC_CURRENCIES,
    SwissQrBillError,
    swissQrUnavailableReason,
} from './swiss-qr-bill';
export type {SpcCurrency, SwissQrBillInput} from './swiss-qr-bill';
export {buildPaymentLink, isLinkable, payPalLink, revolutLink} from './payment-links';
export type {PaymentLink, PaymentLinkWarning} from './payment-links';
export {
    canOfferTwintAssist,
    formatSwissPhoneNumber,
    normalizeSwissPhoneNumber,
    TWINT_CONFIRM_NAME_ADVICE,
} from './twint-assist';
