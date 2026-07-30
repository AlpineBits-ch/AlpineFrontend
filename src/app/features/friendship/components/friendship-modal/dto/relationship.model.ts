export interface RelationshipModel {
    id: string;
    ownerId: string;
    owner: MinimalProfileId;
    targetId: string;
    target: MinimalProfileId;
    status: RelationshipStatus;
}

export interface MinimalProfileId {
    id: string;
    userName: string;
    userId: string;
}

export enum RelationshipStatus {
    // String-valued, not the implicit 0: the `social.*` realtime events send the literal
    // "None" on the wire, which would never have matched a numeric member.
    None = 'None',
    PendingIncoming = 'PendingIncoming',
    PendingOutgoing = 'PendingOutgoing',
    Friends = 'Friends',
    Blocked = 'Blocked',
}

/**
 * What every consumer actually wants out of a relationship: the row id, your own view of
 * its status, and the *other* party.
 *
 * `RelationshipModel` is owner/target-shaped, so working out who the other person is means
 * knowing which side you are - a check several call sites used to get wrong by always
 * reading `target`. {@link RelationshipStore} resolves it once and hands out this shape,
 * which is also exactly what the realtime payload carries.
 */
export interface RelationshipView {
    id: string;
    status: RelationshipStatus;
    other: MinimalProfileId;
}