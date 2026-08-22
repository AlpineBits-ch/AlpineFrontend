import {JoinPolicy, TopicDto} from '../response/discovery.dto';

/** `"game:<id>"` or `"tag:<id>"`, the wire grammar `TopicRef.TryParse` requires server-side. */
export function topicRefWire(topic: Pick<TopicDto, 'kind' | 'id'>): string {
    return `${topic.kind}:${topic.id}`;
}

export interface ListingWriteDto {
    headline: string;
    pitch: string;
    topics: string[];
    language: string;
    joinPolicy: JoinPolicy;
    links: string[];
}

export interface SaveInterestsDto {
    topics: string[];
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
