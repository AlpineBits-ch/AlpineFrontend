import {GuildPersonaDto, PersonaApprovalState} from '../../../dtos/response/persona.dto';

export interface ApprovalMeta {
    state: PersonaApprovalState;
    icon: string;
    labelKey: string;
    /** Tailwind classes for the chip. Kept here so six surfaces cannot drift apart. */
    chipClass: string;
}

const META: Readonly<Record<PersonaApprovalState, ApprovalMeta>> = {
    [PersonaApprovalState.Draft]: {
        state: PersonaApprovalState.Draft,
        icon: 'pi pi-pencil',
        labelKey: 'PERSONA.APPROVAL.DRAFT',
        chipClass: 'bg-white/[0.06] text-text-muted',
    },
    [PersonaApprovalState.Submitted]: {
        state: PersonaApprovalState.Submitted,
        icon: 'pi pi-hourglass',
        labelKey: 'PERSONA.APPROVAL.SUBMITTED',
        chipClass: 'bg-connecting/15 text-connecting',
    },
    [PersonaApprovalState.Approved]: {
        state: PersonaApprovalState.Approved,
        icon: 'pi pi-check-circle',
        labelKey: 'PERSONA.APPROVAL.APPROVED',
        chipClass: 'bg-online/15 text-online',
    },
    [PersonaApprovalState.ChangesRequested]: {
        state: PersonaApprovalState.ChangesRequested,
        icon: 'pi pi-comment',
        labelKey: 'PERSONA.APPROVAL.CHANGES_REQUESTED',
        chipClass: 'bg-brand/20 text-brand-dim',
    },
};

export function approvalMeta(state: PersonaApprovalState): ApprovalMeta {
    return META[state] ?? META[PersonaApprovalState.Draft];
}

/** Every state a character can be handed back in, in the order the queue works through them. */
export const APPROVAL_STATES: readonly PersonaApprovalState[] = [
    PersonaApprovalState.Submitted,
    PersonaApprovalState.ChangesRequested,
    PersonaApprovalState.Draft,
    PersonaApprovalState.Approved,
];

/** The owner can send it to the reviewers from these two states and no others. */
export function canSubmit(entry: GuildPersonaDto): boolean {
    const state = entry.approvalState;
    return state === PersonaApprovalState.Draft || state === PersonaApprovalState.ChangesRequested;
}

export function isAwaitingReview(entry: GuildPersonaDto): boolean {
    return entry.approvalState === PersonaApprovalState.Submitted;
}

/**
 * Approval never gates editing, only speaking, and only where the guild asks for it. `canSpeak` is
 * the server's answer to that question, so a chip saying "waiting" must not imply the character
 * has gone quiet.
 */
export function isBlockedFromSpeaking(entry: GuildPersonaDto): boolean {
    return !entry.persona.isRetired && !entry.canSpeak;
}
