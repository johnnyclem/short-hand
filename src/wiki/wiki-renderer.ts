/**
 * WikiRenderer — materializes CompactedState as a set of interlinked markdown pages.
 *
 * Takes the LSM-tree's compacted knowledge and renders it as a Karpathy-style
 * wiki: entity pages, topic pages, an index, and an append-only log.
 */

import type {
  CompactedState,
  Entity,
  Edge,
  IngestionEvent,
  TopicSummary,
  WikiPage,
  WikiRenderConfig,
} from '../types.js';
import { DEFAULT_WIKI_RENDER_CONFIG } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert an entity name to a valid markdown filename slug. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Create a wiki-internal markdown link. */
function wikiLink(targetPath: string, label: string): string {
  return `[${label}](${targetPath})`;
}

/** Group entities by their type. */
function groupByType(entities: Entity[]): Map<string, Entity[]> {
  const groups = new Map<string, Entity[]>();
  for (const entity of entities) {
    const group = groups.get(entity.type) ?? [];
    group.push(entity);
    groups.set(entity.type, group);
  }
  return groups;
}

/** Find all edges where this entity is the source or target. */
function findRelatedEdges(entityName: string, edges: Edge[]): Edge[] {
  return edges.filter((e) => e.source === entityName || e.target === entityName);
}

/** Find topic summaries that reference an entity. */
function findTopicsForEntity(entityName: string, summaries: TopicSummary[]): TopicSummary[] {
  return summaries.filter(
    (s) =>
      s.entityNames.includes(entityName) ||
      s.summary.toLowerCase().includes(entityName.toLowerCase()),
  );
}

// ---------------------------------------------------------------------------
// WikiRenderer
// ---------------------------------------------------------------------------

export class WikiRenderer {
  private config: WikiRenderConfig;

  constructor(config: Partial<WikiRenderConfig> = {}) {
    this.config = { ...DEFAULT_WIKI_RENDER_CONFIG, ...config };
  }

  /**
   * Render a complete wiki from compacted state.
   * Returns all pages — caller decides how to persist (fs, memory, etc.).
   */
  render(state: CompactedState, events?: IngestionEvent[]): WikiPage[] {
    const pages: WikiPage[] = [];

    // Entity pages from L3 graph
    for (const [, entity] of state.l3_graph.entities) {
      pages.push(this.renderEntityPage(entity, state));
    }

    // Topic pages from L2 summaries
    for (const summary of state.l2_summaries) {
      pages.push(this.renderTopicPage(summary, state));
    }

    // Index page
    pages.push(this.renderIndexPage(state, pages));

    // Log page
    if (this.config.generateLog && events && events.length > 0) {
      pages.push(this.renderLogPage(events));
    }

    return pages;
  }

  // -----------------------------------------------------------------------
  // Entity pages
  // -----------------------------------------------------------------------

  private renderEntityPage(entity: Entity, state: CompactedState): WikiPage {
    const slug = slugify(entity.name);
    const lines: string[] = [];

    lines.push(`# ${entity.name}`);
    lines.push('');
    lines.push(`**Type:** ${entity.type}`);
    lines.push('');

    // Properties
    const propEntries = Object.entries(entity.properties);
    if (propEntries.length > 0) {
      lines.push('## Properties');
      lines.push('');
      for (const [key, value] of propEntries) {
        lines.push(`- **${key}:** ${value}`);
      }
      lines.push('');
    }

    // Relationships (from edges)
    if (this.config.includeBacklinks) {
      const related = findRelatedEdges(entity.name, state.l3_graph.edges);
      if (related.length > 0) {
        lines.push('## Relationships');
        lines.push('');
        for (const edge of related) {
          const isSource = edge.source === entity.name;
          const otherName = isSource ? edge.target : edge.source;
          const otherSlug = slugify(otherName);
          const direction = isSource ? '→' : '←';
          const linkedName = wikiLink(`entities/${otherSlug}.md`, otherName);
          lines.push(`- ${direction} **${edge.relation}** ${linkedName}`);
          if (edge.properties.reason) {
            lines.push(`  - _${edge.properties.reason}_`);
          }
        }
        lines.push('');
      }

      // Backlinks from topic summaries
      const topics = findTopicsForEntity(entity.name, state.l2_summaries);
      if (topics.length > 0) {
        lines.push('## Referenced In');
        lines.push('');
        for (const topic of topics) {
          const topicSlug = slugify(topic.topic);
          lines.push(`- ${wikiLink(`topics/${topicSlug}.md`, topic.topic)}`);
        }
        lines.push('');
      }
    }

    // Relevant invariants
    const relatedInvariants = state.l4_invariants.filter(
      (inv) =>
        inv.key.toLowerCase().includes(entity.name.toLowerCase()) ||
        inv.value.toLowerCase().includes(entity.name.toLowerCase()),
    );
    if (relatedInvariants.length > 0) {
      lines.push('## Invariants');
      lines.push('');
      for (const inv of relatedInvariants) {
        lines.push(`- **${inv.key}:** ${inv.value}`);
      }
      lines.push('');
    }

    // Corrections (tombstones)
    const relatedTombstones = state.tombstones.filter(
      (t) =>
        (t.key && t.key.toLowerCase().includes(entity.name.toLowerCase())) ||
        t.supersededContent.toLowerCase().includes(entity.name.toLowerCase()),
    );
    if (relatedTombstones.length > 0) {
      lines.push('## Corrections');
      lines.push('');
      for (const t of relatedTombstones) {
        lines.push(
          `- ~~${t.supersededContent}~~ → ${t.correctedValue ?? '(removed)'} — _${t.reason}_`,
        );
      }
      lines.push('');
    }

    return {
      path: `entities/${slug}.md`,
      content: lines.join('\n'),
      title: entity.name,
      category: 'entity',
    };
  }

  // -----------------------------------------------------------------------
  // Topic pages
  // -----------------------------------------------------------------------

  private renderTopicPage(summary: TopicSummary, state: CompactedState): WikiPage {
    const slug = slugify(summary.topic);
    const lines: string[] = [];

    lines.push(`# ${summary.topic}`);
    lines.push('');
    lines.push(summary.summary);
    lines.push('');

    // Decisions made in this topic
    if (summary.decisions.length > 0) {
      lines.push('## Decisions');
      lines.push('');
      for (const decision of summary.decisions) {
        const status = decision.superseded ? '~~' : '';
        lines.push(`- ${status}**${decision.chosen}**${status}: ${decision.description}`);
        for (const alt of decision.alternatives) {
          lines.push(`  - Rejected: ${alt.option}${alt.reason ? ` — _${alt.reason}_` : ''}`);
        }
      }
      lines.push('');
    }

    // Linked entities
    if (summary.entityNames.length > 0) {
      lines.push('## Related Entities');
      lines.push('');
      for (const name of summary.entityNames) {
        const entitySlug = slugify(name);
        lines.push(`- ${wikiLink(`entities/${entitySlug}.md`, name)}`);
      }
      lines.push('');
    }

    return {
      path: `topics/${slug}.md`,
      content: lines.join('\n'),
      title: summary.topic,
      category: 'topic',
    };
  }

  // -----------------------------------------------------------------------
  // Index page
  // -----------------------------------------------------------------------

  private renderIndexPage(state: CompactedState, pages: WikiPage[]): WikiPage {
    const lines: string[] = [];

    lines.push(`# ${this.config.wikiTitle}`);
    lines.push('');
    lines.push('_Auto-generated knowledge base. Cross-references maintained by short-hand._');
    lines.push('');

    // Entity index grouped by type
    const entities = Array.from(state.l3_graph.entities.values());
    if (entities.length > 0) {
      lines.push('## Entities');
      lines.push('');
      const grouped = groupByType(entities);
      const sortedTypes = Array.from(grouped.keys()).sort();
      for (const type of sortedTypes) {
        const group = grouped.get(type)!;
        lines.push(`### ${type.charAt(0).toUpperCase() + type.slice(1)}`);
        lines.push('');
        for (const entity of group.sort((a, b) => a.name.localeCompare(b.name))) {
          const slug = slugify(entity.name);
          const propSummary = Object.values(entity.properties).join(', ');
          const desc = propSummary ? ` — ${propSummary}` : '';
          lines.push(`- ${wikiLink(`entities/${slug}.md`, entity.name)}${desc}`);
        }
        lines.push('');
      }
    }

    // Topic index
    const topicPages = pages.filter((p) => p.category === 'topic');
    if (topicPages.length > 0) {
      lines.push('## Topics');
      lines.push('');
      for (const page of topicPages) {
        lines.push(`- ${wikiLink(page.path, page.title)}`);
      }
      lines.push('');
    }

    // Invariants summary
    if (state.l4_invariants.length > 0) {
      lines.push('## Core Invariants');
      lines.push('');
      for (const inv of state.l4_invariants) {
        lines.push(`- **${inv.key}:** ${inv.value}`);
      }
      lines.push('');
    }

    // Stats
    lines.push('---');
    lines.push('');
    lines.push(
      `_${entities.length} entities · ${state.l2_summaries.length} topics · ${state.l4_invariants.length} invariants · ${state.tombstones.length} corrections_`,
    );
    lines.push('');

    return {
      path: 'index.md',
      content: lines.join('\n'),
      title: this.config.wikiTitle,
      category: 'index',
    };
  }

  // -----------------------------------------------------------------------
  // Log page
  // -----------------------------------------------------------------------

  private renderLogPage(events: IngestionEvent[]): WikiPage {
    const lines: string[] = [];

    lines.push('# Ingestion Log');
    lines.push('');
    lines.push('_Chronological record of source ingestions._');
    lines.push('');

    for (const event of events) {
      const date = new Date(event.timestamp).toISOString();
      lines.push(`## [INGEST] ${date}`);
      lines.push('');
      lines.push(`- **Source:** ${event.sourceTitle} (\`${event.sourceId}\`)`);
      lines.push(`- **Chunks:** ${event.chunkCount}`);
      if (event.entitiesDiscovered.length > 0) {
        lines.push(`- **Entities discovered:** ${event.entitiesDiscovered.join(', ')}`);
      }
      lines.push('');
    }

    return {
      path: 'log.md',
      content: lines.join('\n'),
      title: 'Ingestion Log',
      category: 'log',
    };
  }
}
