/**
 * Canonical context-shift task suite.
 *
 * Design constraints (enforced by context-shift-benchmark.test.ts):
 *   1. expectedKeywords must NOT appear in readContext — otherwise regex-tier
 *      {{context}} substitution scores them without any LM reasoning.
 *   2. expectedKeywords must NOT appear in the interpreterTemplate text —
 *      same reason: the template is already in the resolved output.
 *   3. rawPayloadScore < 1.0 — there must be room for an LM to add value.
 *
 * The expectedKeywords are domain-specific terms a knowledgeable LM should
 * produce when reasoning about the payload in the shifted context. They will
 * be absent from the raw payload and from the regex-resolved template, so
 * contextShiftGain ≈ 0 for the regex tier and > 0 for LM tiers.
 */

import type { ContextShiftTask } from './context-shift-benchmark.js';

export const CONTEXT_SHIFT_TASKS: ContextShiftTask[] = [
  {
    id: 'tech-stack-change',
    description: 'Backend runtime shifts from Node/Express to Python; stored API notes must transfer',
    payload: 'We are using Express.js with TypeScript for the API layer.',
    writeContext: 'building a Node.js microservice',
    readContext: 'a service rewrite moving away from Node.js',
    // expectedKeywords are Python-ecosystem terms absent from readContext and template
    expectedKeywords: ['fastapi', 'uvicorn', 'asyncio', 'migration'],
    interpreterTemplate:
      'Earlier note: "{{payload}}". New environment: {{context}}. What changes?',
  },
  {
    id: 'audience-shift',
    description: 'Audience shifts from on-call engineers to executives; jargon must be translated',
    payload: 'The p99 latency SLO is 200ms enforced via nginx rate-limiting.',
    writeContext: 'writing a technical runbook for on-call engineers',
    readContext: 'a board-level presentation to executives',
    // expectedKeywords are business-register terms absent from readContext and template
    expectedKeywords: ['reliability', 'cost', 'uptime', 'budget'],
    interpreterTemplate:
      'Earlier note: "{{payload}}". New context: {{context}}. Reframe for this audience.',
  },
  {
    id: 'scale-shift',
    description: 'System scale grows 100x; single-instance assumptions become bottlenecks',
    payload: 'Postgres runs on a single m5.large with in-process connection pooling.',
    writeContext: 'prototype serving 100 users',
    readContext: 'a high-traffic launch targeting thousands of simultaneous users',
    // expectedKeywords are scaling-specific terms absent from readContext and template
    expectedKeywords: ['bottleneck', 'replication', 'pgbouncer', 'horizontal'],
    interpreterTemplate:
      'Earlier note: "{{payload}}". New context: {{context}}. What are the risks?',
  },
  {
    id: 'framework-migration',
    description: 'Frontend framework migrates from React/Redux to SvelteKit; state patterns change',
    payload: 'State management is handled by Redux Toolkit with RTK Query for data fetching.',
    writeContext: 'building the dashboard in React 18',
    readContext: 'a complete rewrite of the frontend in a new framework',
    // expectedKeywords are Svelte-specific terms absent from readContext and template
    expectedKeywords: ['svelte', 'store', 'writable', 'derived'],
    interpreterTemplate:
      'Earlier note: "{{payload}}". New context: {{context}}. Map to the new environment.',
  },
  {
    id: 'security-context',
    description: 'Service transitions from internal VPN tool to externally exposed API',
    payload: 'Authentication is skipped for internal services on the VPC.',
    writeContext: 'building internal admin tooling behind a VPN',
    readContext: 'an externally accessible service for third-party developers',
    // expectedKeywords are auth-protocol terms absent from readContext and template
    expectedKeywords: ['oauth', 'token', 'zero trust', 'authorization'],
    interpreterTemplate:
      'Earlier note: "{{payload}}". New context: {{context}}. What must change?',
  },
  {
    id: 'cloud-provider-migration',
    description: 'Infrastructure migrates from AWS to GCP; service names change completely',
    payload: 'We use S3 for blob storage, SQS for message queues, and Lambda for event processing.',
    writeContext: 'AWS-native deployment on us-east-1',
    readContext: 'a migration away from AWS to an alternative cloud',
    // expectedKeywords are GCP-specific terms absent from readContext and template
    expectedKeywords: ['gcs', 'pub/sub', 'cloud run', 'bigquery'],
    interpreterTemplate:
      'Earlier note: "{{payload}}". New context: {{context}}. The target is Google Cloud Platform. List the service equivalents.',
  },
];
