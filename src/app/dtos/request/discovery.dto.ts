import {JoinPolicy, TopicKind} from '../response/discovery.dto';

export interface TopicRefDto {
    kind: TopicKind;
    id: string;
}

export interface ListingWriteDto {
    headline: string;
    pitch: string;
    topics: TopicRefDto[];
    language: string;
    joinPolicy: JoinPolicy;
    links: string[];
}

export interface SaveInterestsDto {
    topics: TopicRefDto[];
    visible: boolean;
}

export interface DiscoveryFeedQuery {
    q?: string;
    topics?: string[];
    language?: string;
    limit?: number;
}

export interface TopicSearchQuery {
    q?: string;
    limit?: number;
}
