<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import type { LichenNoteWithContent } from '@/types/lichen'
import type { Backlink } from '@/lib/lichen/backlinks'
import { categorySlug, parseNoteContent } from '@/lib/lichen/content-meta'
import { extractWikilinks } from '@/lib/lichen/wikilinks'
import {
  collectWikiRelations,
  formatRelationType,
  relationsForNote,
} from '@/lib/lichen/relations'

const props = defineProps<{
  note: LichenNoteWithContent
  ownerHandle: string
  wikiSlug: string
  wikiNotes?: LichenNoteWithContent[]
  backlinks: Backlink[]
}>()

const router = useRouter()

type NodeKind = 'article' | 'link' | 'backlink' | 'relation'

interface GraphNode {
  slug: string
  label: string
  kind: NodeKind
  detail?: string
  x: number
  y: number
  labelAnchor: 'start' | 'middle' | 'end'
  labelDy: number
}

const VIEW_W = 720
const VIEW_H = 360
const CENTER_X = VIEW_W / 2
const CENTER_Y = VIEW_H / 2
const MAX_NODES = 8

const titles = computed(() => {
  const map = new Map<string, string>()
  for (const note of props.wikiNotes ?? []) map.set(note.slug, note.title)
  return map
})

const parsed = computed(() => parseNoteContent(props.note.content))

const categories = computed(() => parsed.value.categories.slice(0, 8))

/**
 * The graph is the article's place in the wiki: outbound links, pages that
 * link here, typed relationships, and its categories. Wikipedia exposes the
 * same facts as "What links here" and the category bar; this draws them as one
 * connected picture and keeps every node a real navigation target.
 */
const connections = computed(() => {
  const bySlug = new Map<string, GraphNode>()
  const push = (node: Omit<GraphNode, 'x' | 'y' | 'labelAnchor' | 'labelDy'>) => {
    if (!node.slug || node.slug === props.note.slug || node.slug.startsWith('rel:')) return
    if (node.slug.startsWith('Category:') || node.slug.startsWith('talk:')) return
    const existing = bySlug.get(node.slug)
    if (!existing) {
      bySlug.set(node.slug, {
        ...node,
        x: 0,
        y: 0,
        labelAnchor: 'middle',
        labelDy: 0,
      })
      return
    }
    // A typed relationship is the most informative edge; keep its label.
    if (node.kind === 'relation' && existing.kind !== 'relation') {
      existing.kind = node.kind
      existing.detail = node.detail
      if (node.label) existing.label = node.label
    }
  }

  for (const link of extractWikilinks(props.note.content, props.wikiSlug)) {
    if (link.wikiSlug && link.wikiSlug !== props.wikiSlug) continue
    if (link.relationType) continue
    const slug = link.noteSlug
    push({
      slug,
      label: titles.value.get(slug) ?? link.label ?? slug,
      kind: 'link',
      detail: 'Links to',
    })
  }

  for (const backlink of props.backlinks) {
    if (!backlink.targetNoteSlug) continue
    push({
      slug: backlink.sourceSlug,
      label: backlink.sourceTitle || titles.value.get(backlink.sourceSlug) || backlink.sourceSlug,
      kind: 'backlink',
      detail: 'Links here',
    })
  }

  const relations = relationsForNote(
    collectWikiRelations(props.wikiNotes ?? [props.note]),
    props.note.slug,
  )
  for (const edge of relations.outgoing) {
    push({
      slug: edge.targetSlug,
      label: titles.value.get(edge.targetSlug) ?? edge.label,
      kind: 'relation',
      detail: formatRelationType(edge.type),
    })
  }
  for (const edge of relations.incoming) {
    push({
      slug: edge.sourceSlug,
      label: titles.value.get(edge.sourceSlug) ?? edge.sourceSlug,
      kind: 'relation',
      detail: formatRelationType(edge.type),
    })
  }

  return [...bySlug.values()].slice(0, MAX_NODES)
})

/** Stable radial layout — wide ellipse so labels have room. */
const nodes = computed<GraphNode[]>(() => {
  const list = connections.value
  const radiusX = 205
  const radiusY = 120
  return list.map((node, index) => {
    const angle = -Math.PI / 2 + (index / Math.max(list.length, 1)) * Math.PI * 2
    const x = CENTER_X + Math.cos(angle) * radiusX
    const y = CENTER_Y + Math.sin(angle) * radiusY
    const labelAnchor =
      x < CENTER_X - 12 ? 'end' : x > CENTER_X + 12 ? 'start' : 'middle'
    const labelDy = Math.abs(y - CENTER_Y) < 10 ? -12 : y < CENTER_Y ? -12 : 20
    return { ...node, x, y, labelAnchor, labelDy }
  })
})

const showGraph = computed(() => nodes.value.length > 0 || categories.value.length > 0)
const centerLabel = computed(() =>
  props.note.title.length > 26 ? `${props.note.title.slice(0, 25)}…` : props.note.title,
)

const KIND_LABEL: Record<NodeKind, string> = {
  article: 'This article',
  link: 'Linked page',
  backlink: 'Links here',
  relation: 'Relationship',
}

function open(slug: string) {
  if (!slug) return
  void router.push(`/@${props.ownerHandle}/${props.wikiSlug}/${slug}`)
}

function onNodeKey(event: KeyboardEvent, slug: string) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    open(slug)
  }
}

function nodeHref(slug: string): string {
  return `/@${props.ownerHandle}/${props.wikiSlug}/${encodeURIComponent(slug)}`
}
</script>

<template>
  <section v-if="showGraph" class="knowledge-graph card" aria-labelledby="knowledge-graph-title">
    <header class="kg-head">
      <div>
        <h2 id="knowledge-graph-title">Knowledge graph</h2>
        <p class="muted kg-sub">
          How this article sits in the wiki — links out, backlinks, relationships, and
          categories.
        </p>
      </div>
      <RouterLink
        v-if="wikiNotes && wikiNotes.length > 1"
        class="kg-open-full"
        :to="`/@${ownerHandle}/${wikiSlug}/special/graph`"
      >
        Full graph
      </RouterLink>
    </header>

    <div class="kg-canvas">
      <svg
        :viewBox="`0 0 ${VIEW_W} ${VIEW_H}`"
        role="img"
        :aria-label="`Knowledge graph for ${note.title}`"
      >
        <g class="kg-edges" aria-hidden="true">
          <line
            v-for="node in nodes"
            :key="`edge-${node.slug}`"
            :x1="CENTER_X"
            :y1="CENTER_Y"
            :x2="node.x"
            :y2="node.y"
            :class="`kg-edge kg-edge--${node.kind}`"
          />
        </g>

        <g
          class="kg-center"
          :transform="`translate(${CENTER_X} ${CENTER_Y})`"
          aria-hidden="true"
        >
          <circle r="38" />
          <text text-anchor="middle" dy="4">{{ centerLabel }}</text>
        </g>

        <g
          v-for="node in nodes"
          :key="node.slug"
          class="kg-node"
          :class="`kg-node--${node.kind}`"
          role="link"
          tabindex="0"
          :aria-label="`${KIND_LABEL[node.kind]}: ${node.label}`"
          :transform="`translate(${node.x} ${node.y})`"
          @click="open(node.slug)"
          @keydown="onNodeKey($event, node.slug)"
        >
          <circle r="9" />
          <text :text-anchor="node.labelAnchor" :dy="node.labelDy">
            {{ node.label.length > 22 ? `${node.label.slice(0, 21)}…` : node.label }}
          </text>
        </g>
      </svg>
    </div>

    <div class="kg-columns">
      <div v-if="nodes.length" class="kg-list">
        <h3>Connected pages</h3>
        <ul>
          <li v-for="node in nodes" :key="`list-${node.slug}`">
            <span class="kg-dot" :class="`kg-dot--${node.kind}`" aria-hidden="true" />
            <a
              :href="nodeHref(node.slug)"
              @click.prevent="open(node.slug)"
            >{{ node.label }}</a>
            <span class="kg-detail">{{ node.detail }}</span>
          </li>
        </ul>
      </div>

      <div v-if="categories.length" class="kg-list">
        <h3>Categories</h3>
        <ul class="kg-categories">
          <li v-for="category in categories" :key="category">
            <RouterLink
              :to="`/@${ownerHandle}/${wikiSlug}/category/${categorySlug(category)}`"
            >
              {{ category }}
            </RouterLink>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.knowledge-graph {
  margin-top: 2rem;
  padding: 1rem 1.25rem 1.25rem;
}

.kg-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem 1rem;
}

.kg-head h2 {
  margin: 0;
  font-size: 0.875rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--pckt-text-muted);
}

.kg-sub {
  margin: 0.25rem 0 0;
  font-size: 0.8125rem;
}

.kg-open-full {
  flex-shrink: 0;
  font-size: 0.8125rem;
}

.kg-canvas {
  margin-top: 0.5rem;
  overflow: hidden;
}

.kg-canvas svg {
  display: block;
  width: 100%;
  height: auto;
  max-height: 21rem;
}

.kg-edge {
  stroke: var(--pckt-border);
  stroke-width: 1.25;
  stroke-dasharray: 3 3;
}

.kg-edge--backlink {
  stroke: color-mix(in srgb, var(--pckt-green) 60%, var(--pckt-border));
}

.kg-edge--relation {
  stroke: color-mix(in srgb, #8b5cf6 60%, var(--pckt-border));
}

.kg-center circle {
  fill: var(--pckt-bg-muted);
  stroke: var(--pckt-accent);
  stroke-width: 2;
}

.kg-center text {
  fill: var(--pckt-text);
  font-size: 12px;
  font-weight: 700;
}

.kg-node {
  cursor: pointer;
  outline: none;
}

.kg-node circle {
  fill: var(--pckt-bg-elevated);
  stroke: var(--pckt-accent);
  stroke-width: 2;
  transition: fill 0.15s ease;
}

.kg-node--backlink circle {
  stroke: var(--pckt-green-active);
}

.kg-node--relation circle {
  stroke: #8b5cf6;
}

.kg-node text {
  fill: var(--pckt-text);
  font-size: 11px;
  pointer-events: none;
}

.kg-node:hover circle,
.kg-node:focus-visible circle {
  fill: var(--pckt-accent-soft);
}

.kg-node:focus-visible circle {
  stroke-width: 3;
}

.kg-columns {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: 0.75rem 1.5rem;
  margin-top: 0.5rem;
}

.kg-list h3 {
  margin: 0 0 0.375rem;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--pckt-text-muted);
}

.kg-list ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

.kg-list li {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  margin: 0.3rem 0;
  font-size: 0.875rem;
}

.kg-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--pckt-accent);
}

.kg-dot--backlink {
  background: var(--pckt-green-active);
}

.kg-dot--relation {
  background: #8b5cf6;
}

.kg-detail {
  color: var(--pckt-text-muted);
  font-size: 0.75rem;
}

.kg-categories {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.kg-categories li {
  margin: 0;
}

.kg-categories a {
  display: inline-block;
  padding: 0.15rem 0.55rem;
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-pill);
  background: var(--pckt-bg-muted);
  font-size: 0.8125rem;
}
</style>
