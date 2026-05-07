/**
 * Six starter context-shift fixtures.
 *
 * Five are non-baseline: writeContext and readContext disagree along the
 * shiftType axis, and the interpreterTemplate is structured so a regex-tier
 * substitution surfaces read-context-relevant terms that a raw payload-dump
 * does not.
 *
 * One (baseline-raw-wins-01) is a calibration fixture: payload is a precise
 * verbatim string, the question requires that exact string, and the
 * interpreter cannot win without making things up. Excluded from win-rate
 * aggregation; raw is expected to win.
 */
import type { BenchmarkFixture } from './types.js';

export const STARTER_FIXTURES: BenchmarkFixture[] = [
  {
    id: 'tech-stack-shift-01',
    shiftType: 'tech-stack',
    payload: 'user prefers CLI tools',
    interpreterTemplate:
      'Given that we are now building {{context}}, restate the user preference: {{payload}}. So for this context, lean on keyboard-driven flows and power-user shortcuts.',
    writeContext: 'a command-line utility',
    readContext: 'a web dashboard for non-technical operators',
    task: {
      question:
        'When recommending interaction patterns for the dashboard, should we lean on power-user keyboard flows?',
      expectedAnswer:
        'yes prefer keyboard-driven flows because the user prefers CLI tools',
    },
  },
  {
    id: 'audience-shift-01',
    shiftType: 'audience',
    payload: 'explain the design like the audience is junior engineers',
    interpreterTemplate:
      'Audience reminder for {{context}}: {{payload}}. Use plain language; define jargon; avoid acronym soup; lead with the concrete example before the abstraction.',
    writeContext: 'an internal RFC for senior staff',
    readContext: 'a blog post for executives without engineering background',
    task: {
      question: 'Should the blog post use heavy engineering jargon and acronyms?',
      expectedAnswer:
        'no use plain language define jargon lead with concrete example for executives',
    },
  },
  {
    id: 'tone-shift-01',
    shiftType: 'tone',
    payload: 'always sign off with a warm note',
    interpreterTemplate:
      'Tone for {{context}}: {{payload}}. Even in serious or technical writing, close with appreciation, gratitude, or a forward-looking warm sentence.',
    writeContext: 'a customer support reply',
    readContext: 'an incident postmortem read by partner teams',
    task: {
      question:
        'How should the postmortem close out at the end of the document?',
      expectedAnswer:
        'close with a warm note appreciation gratitude or forward-looking sentence',
    },
  },
  {
    id: 'time-frame-shift-01',
    shiftType: 'time-frame',
    payload: 'the Q3 deadline is August 15',
    interpreterTemplate:
      'Time check for {{context}}: {{payload}}. Note that this deadline has already passed by the time of the current context, so frame it as a retrospective fact, not a future commitment.',
    writeContext: 'July sprint planning',
    readContext: 'mid-September Q3 retrospective and Q4 planning',
    task: {
      question:
        'When discussing the August 15 deadline now, is it a future commitment or a past event?',
      expectedAnswer:
        'past event already passed retrospective fact not future commitment',
    },
  },
  {
    id: 'scope-expansion-01',
    shiftType: 'scope-expansion',
    payload: 'auth uses JWT signed with HS256',
    interpreterTemplate:
      'Auth note for {{context}}: {{payload}}. Caveat: HS256 uses a shared secret, which does not scale across multiple tenants or independent services; the design needs revisiting at this scope.',
    writeContext: 'a single-service prototype',
    readContext: 'a multi-tenant federated platform',
    task: {
      question:
        'For multi-tenant federation, is the existing HS256 JWT setup sufficient, or does it need revisiting?',
      expectedAnswer:
        'needs revisiting HS256 shared secret does not scale across tenants',
    },
  },
  {
    id: 'terminology-shift-01',
    shiftType: 'terminology',
    payload: 'the customer needs reporting',
    interpreterTemplate:
      'Terminology note for {{context}}: {{payload}}. In this context the word "customer" maps to a tenant organization, not an individual end-user, and reporting means tenant-scoped analytics.',
    writeContext: 'a B2C product spec',
    readContext: 'an enterprise sales deck where "customer" means a tenant org',
    task: {
      question:
        'In the enterprise deck, what does "customer needs reporting" actually mean — what kind of customer and what kind of reporting?',
      expectedAnswer:
        'tenant organization scoped analytics not individual end-user',
    },
  },
  {
    id: 'baseline-raw-wins-01',
    shiftType: 'baseline',
    expectRawWins: true,
    payload: 'the deploy key fingerprint is SHA256:9f2b3c5d7e1a',
    interpreterTemplate:
      'In the context of {{context}}, recall: {{payload}}',
    writeContext: 'rotating deploy keys',
    readContext: 'verifying CI access during an outage',
    task: {
      question: 'What is the deploy key fingerprint?',
      expectedAnswer: 'SHA256:9f2b3c5d7e1a',
    },
  },
];
