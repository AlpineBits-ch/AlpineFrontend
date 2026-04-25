export interface RelationshipModel {
    id: string;
    owner: string;
    target: string;
    status: RelationshipStatus;
}

export enum RelationshipStatus {
    None,
    PendingIncoming = 'PendingIncoming',
    PendingOutgoing= 'PendingOutgoing',
    Friends = 'Friends',
    Blocked = 'Blocked',
}