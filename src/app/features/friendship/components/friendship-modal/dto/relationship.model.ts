export interface RelationshipModel {
    id: string;
    owner: string;
    target: string;
    status: RelationshipStatus;
}

export enum RelationshipStatus {
    None,
    PendingIncoming,
    PendingOutgoing,
    Friends,
    Blocked,
}