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
    hash: string;
}

export enum RelationshipStatus {
    None,
    PendingIncoming = 'PendingIncoming',
    PendingOutgoing= 'PendingOutgoing',
    Friends = 'Friends',
    Blocked = 'Blocked',
}