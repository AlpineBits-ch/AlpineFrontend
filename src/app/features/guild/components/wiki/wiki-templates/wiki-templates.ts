import {WikiTemplate} from './wiki-template.model';

/**
 * The template catalogue: the shapes community wikis actually repeat, all starting as blank
 * documents. Blank is first on purpose, as the escape hatch; burying it behind other cards would
 * make the picker feel like a toll gate on page creation.
 */
export const WIKI_TEMPLATES: readonly WikiTemplate[] = [
    {
        id: 'blank',
        icon: 'pi-file',
        nameKey: 'WIKI.TEMPLATE.BLANK.NAME',
        descriptionKey: 'WIKI.TEMPLATE.BLANK.DESC',
        blocks: [],
    },
    {
        id: 'meeting',
        icon: 'pi-calendar',
        nameKey: 'WIKI.TEMPLATE.MEETING.NAME',
        descriptionKey: 'WIKI.TEMPLATE.MEETING.DESC',
        blocks: [
            {
                kind: 'table',
                headerKeys: ['WIKI.TEMPLATE.COMMON.FIELD', 'WIKI.TEMPLATE.COMMON.VALUE'],
                rowKeys: [
                    ['WIKI.TEMPLATE.MEETING.DATE', ''],
                    ['WIKI.TEMPLATE.MEETING.ATTENDEES', ''],
                    ['WIKI.TEMPLATE.MEETING.FACILITATOR', ''],
                ],
            },
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.MEETING.AGENDA'},
            {
                kind: 'bullets',
                itemKeys: [
                    'WIKI.TEMPLATE.MEETING.AGENDA_1',
                    'WIKI.TEMPLATE.MEETING.AGENDA_2',
                    'WIKI.TEMPLATE.MEETING.AGENDA_3',
                ],
            },
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.MEETING.DISCUSSION'},
            {kind: 'paragraph', textKey: 'WIKI.TEMPLATE.MEETING.DISCUSSION_HINT'},
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.MEETING.DECISIONS'},
            {kind: 'bullets', itemKeys: ['WIKI.TEMPLATE.MEETING.DECISION_1']},
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.MEETING.ACTIONS'},
            {
                kind: 'table',
                headerKeys: [
                    'WIKI.TEMPLATE.MEETING.ACTION',
                    'WIKI.TEMPLATE.MEETING.OWNER',
                    'WIKI.TEMPLATE.MEETING.DUE',
                ],
                rowKeys: [['', '', ''], ['', '', '']],
            },
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.MEETING.NEXT'},
            {kind: 'paragraph', textKey: 'WIKI.TEMPLATE.MEETING.NEXT_HINT'},
        ],
    },
    {
        id: 'runbook',
        icon: 'pi-wrench',
        nameKey: 'WIKI.TEMPLATE.RUNBOOK.NAME',
        descriptionKey: 'WIKI.TEMPLATE.RUNBOOK.DESC',
        blocks: [
            {kind: 'callout', variant: 'NOTE', textKey: 'WIKI.TEMPLATE.RUNBOOK.SUMMARY'},
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.RUNBOOK.BEFORE'},
            {
                kind: 'bullets',
                itemKeys: ['WIKI.TEMPLATE.RUNBOOK.BEFORE_1', 'WIKI.TEMPLATE.RUNBOOK.BEFORE_2'],
            },
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.RUNBOOK.STEPS'},
            {
                kind: 'ordered',
                itemKeys: [
                    'WIKI.TEMPLATE.RUNBOOK.STEP_1',
                    'WIKI.TEMPLATE.RUNBOOK.STEP_2',
                    'WIKI.TEMPLATE.RUNBOOK.STEP_3',
                ],
            },
            {kind: 'code', language: 'bash', lines: ['# the exact command, so nobody guesses']},
            {kind: 'callout', variant: 'WARNING', textKey: 'WIKI.TEMPLATE.RUNBOOK.WARNING'},
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.RUNBOOK.VERIFY'},
            {
                kind: 'tasks',
                itemKeys: ['WIKI.TEMPLATE.RUNBOOK.VERIFY_1', 'WIKI.TEMPLATE.RUNBOOK.VERIFY_2'],
            },
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.RUNBOOK.ROLLBACK'},
            {kind: 'paragraph', textKey: 'WIKI.TEMPLATE.RUNBOOK.ROLLBACK_HINT'},
        ],
    },
    {
        id: 'decision',
        icon: 'pi-flag',
        nameKey: 'WIKI.TEMPLATE.DECISION.NAME',
        descriptionKey: 'WIKI.TEMPLATE.DECISION.DESC',
        blocks: [
            {
                kind: 'table',
                headerKeys: ['WIKI.TEMPLATE.COMMON.FIELD', 'WIKI.TEMPLATE.COMMON.VALUE'],
                rowKeys: [
                    ['WIKI.TEMPLATE.DECISION.STATUS', 'WIKI.TEMPLATE.DECISION.STATUS_VALUE'],
                    ['WIKI.TEMPLATE.DECISION.DATE', ''],
                    ['WIKI.TEMPLATE.DECISION.DECIDERS', ''],
                ],
            },
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.DECISION.CONTEXT'},
            {kind: 'paragraph', textKey: 'WIKI.TEMPLATE.DECISION.CONTEXT_HINT'},
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.DECISION.OPTIONS'},
            {
                kind: 'table',
                headerKeys: [
                    'WIKI.TEMPLATE.DECISION.OPTION',
                    'WIKI.TEMPLATE.DECISION.PROS',
                    'WIKI.TEMPLATE.DECISION.CONS',
                ],
                rowKeys: [['', '', ''], ['', '', '']],
            },
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.DECISION.DECISION'},
            {kind: 'callout', variant: 'IMPORTANT', textKey: 'WIKI.TEMPLATE.DECISION.DECISION_HINT'},
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.DECISION.CONSEQUENCES'},
            {
                kind: 'bullets',
                itemKeys: [
                    'WIKI.TEMPLATE.DECISION.CONSEQUENCE_1',
                    'WIKI.TEMPLATE.DECISION.CONSEQUENCE_2',
                ],
            },
        ],
    },
    {
        id: 'profile',
        icon: 'pi-user',
        nameKey: 'WIKI.TEMPLATE.PROFILE.NAME',
        descriptionKey: 'WIKI.TEMPLATE.PROFILE.DESC',
        blocks: [
            {
                kind: 'table',
                headerKeys: ['WIKI.TEMPLATE.COMMON.FIELD', 'WIKI.TEMPLATE.COMMON.VALUE'],
                rowKeys: [
                    ['WIKI.TEMPLATE.PROFILE.NAME_ROW', ''],
                    ['WIKI.TEMPLATE.PROFILE.ROLE', ''],
                    ['WIKI.TEMPLATE.PROFILE.PRONOUNS', ''],
                    ['WIKI.TEMPLATE.PROFILE.STATUS', ''],
                    ['WIKI.TEMPLATE.PROFILE.FIRST_SEEN', ''],
                ],
            },
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.PROFILE.OVERVIEW'},
            {kind: 'paragraph', textKey: 'WIKI.TEMPLATE.PROFILE.OVERVIEW_HINT'},
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.PROFILE.APPEARANCE'},
            {kind: 'paragraph', textKey: 'WIKI.TEMPLATE.PROFILE.APPEARANCE_HINT'},
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.PROFILE.BACKGROUND'},
            {kind: 'paragraph', textKey: 'WIKI.TEMPLATE.PROFILE.BACKGROUND_HINT'},
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.PROFILE.RELATIONSHIPS'},
            {kind: 'bullets', itemKeys: ['WIKI.TEMPLATE.PROFILE.RELATIONSHIP_1']},
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.PROFILE.NOTABLE'},
            {kind: 'bullets', itemKeys: ['WIKI.TEMPLATE.PROFILE.NOTABLE_1']},
        ],
    },
    {
        id: 'faq',
        icon: 'pi-question-circle',
        nameKey: 'WIKI.TEMPLATE.FAQ.NAME',
        descriptionKey: 'WIKI.TEMPLATE.FAQ.DESC',
        blocks: [
            {kind: 'paragraph', textKey: 'WIKI.TEMPLATE.FAQ.INTRO'},
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.FAQ.Q1'},
            {kind: 'paragraph', textKey: 'WIKI.TEMPLATE.FAQ.A1'},
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.FAQ.Q2'},
            {kind: 'paragraph', textKey: 'WIKI.TEMPLATE.FAQ.A2'},
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.FAQ.Q3'},
            {kind: 'paragraph', textKey: 'WIKI.TEMPLATE.FAQ.A3'},
            {kind: 'divider'},
            {kind: 'callout', variant: 'TIP', textKey: 'WIKI.TEMPLATE.FAQ.TIP'},
        ],
    },
    {
        id: 'project',
        icon: 'pi-compass',
        nameKey: 'WIKI.TEMPLATE.PROJECT.NAME',
        descriptionKey: 'WIKI.TEMPLATE.PROJECT.DESC',
        blocks: [
            {kind: 'callout', variant: 'NOTE', textKey: 'WIKI.TEMPLATE.PROJECT.SUMMARY'},
            {
                kind: 'table',
                headerKeys: ['WIKI.TEMPLATE.COMMON.FIELD', 'WIKI.TEMPLATE.COMMON.VALUE'],
                rowKeys: [
                    ['WIKI.TEMPLATE.PROJECT.STATUS', ''],
                    ['WIKI.TEMPLATE.PROJECT.LEAD', ''],
                    ['WIKI.TEMPLATE.PROJECT.TARGET', ''],
                ],
            },
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.PROJECT.GOALS'},
            {
                kind: 'bullets',
                itemKeys: ['WIKI.TEMPLATE.PROJECT.GOAL_1', 'WIKI.TEMPLATE.PROJECT.GOAL_2'],
            },
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.PROJECT.NON_GOALS'},
            {kind: 'bullets', itemKeys: ['WIKI.TEMPLATE.PROJECT.NON_GOAL_1']},
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.PROJECT.MILESTONES'},
            {
                kind: 'table',
                headerKeys: [
                    'WIKI.TEMPLATE.PROJECT.MILESTONE',
                    'WIKI.TEMPLATE.PROJECT.TARGET_COL',
                    'WIKI.TEMPLATE.PROJECT.STATUS_COL',
                ],
                rowKeys: [['', '', ''], ['', '', '']],
            },
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.PROJECT.LINKS'},
            {kind: 'bullets', itemKeys: ['WIKI.TEMPLATE.PROJECT.LINK_1']},
        ],
    },
    {
        id: 'changelog',
        icon: 'pi-history',
        nameKey: 'WIKI.TEMPLATE.CHANGELOG.NAME',
        descriptionKey: 'WIKI.TEMPLATE.CHANGELOG.DESC',
        blocks: [
            {kind: 'paragraph', textKey: 'WIKI.TEMPLATE.CHANGELOG.INTRO'},
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.CHANGELOG.UNRELEASED'},
            {kind: 'heading', level: 3, textKey: 'WIKI.TEMPLATE.CHANGELOG.ADDED'},
            {kind: 'bullets', itemKeys: ['WIKI.TEMPLATE.CHANGELOG.ADDED_1']},
            {kind: 'heading', level: 3, textKey: 'WIKI.TEMPLATE.CHANGELOG.CHANGED'},
            {kind: 'bullets', itemKeys: ['WIKI.TEMPLATE.CHANGELOG.CHANGED_1']},
            {kind: 'heading', level: 3, textKey: 'WIKI.TEMPLATE.CHANGELOG.FIXED'},
            {kind: 'bullets', itemKeys: ['WIKI.TEMPLATE.CHANGELOG.FIXED_1']},
            {kind: 'divider'},
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.CHANGELOG.RELEASE_EXAMPLE'},
            {kind: 'bullets', itemKeys: ['WIKI.TEMPLATE.CHANGELOG.RELEASE_1']},
        ],
    },
    {
        id: 'rules',
        icon: 'pi-shield',
        nameKey: 'WIKI.TEMPLATE.RULES.NAME',
        descriptionKey: 'WIKI.TEMPLATE.RULES.DESC',
        blocks: [
            {kind: 'callout', variant: 'IMPORTANT', textKey: 'WIKI.TEMPLATE.RULES.SCOPE'},
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.RULES.RULES'},
            {
                kind: 'ordered',
                itemKeys: [
                    'WIKI.TEMPLATE.RULES.RULE_1',
                    'WIKI.TEMPLATE.RULES.RULE_2',
                    'WIKI.TEMPLATE.RULES.RULE_3',
                    'WIKI.TEMPLATE.RULES.RULE_4',
                    'WIKI.TEMPLATE.RULES.RULE_5',
                ],
            },
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.RULES.ENFORCEMENT'},
            {
                kind: 'table',
                headerKeys: ['WIKI.TEMPLATE.RULES.LEVEL', 'WIKI.TEMPLATE.RULES.WHAT_HAPPENS'],
                rowKeys: [
                    ['WIKI.TEMPLATE.RULES.LEVEL_WARNING', ''],
                    ['WIKI.TEMPLATE.RULES.LEVEL_TIMEOUT', ''],
                    ['WIKI.TEMPLATE.RULES.LEVEL_BAN', ''],
                ],
            },
            {kind: 'heading', level: 2, textKey: 'WIKI.TEMPLATE.RULES.APPEALS'},
            {kind: 'paragraph', textKey: 'WIKI.TEMPLATE.RULES.APPEALS_HINT'},
        ],
    },
];
