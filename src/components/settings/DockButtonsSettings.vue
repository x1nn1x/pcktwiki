<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useLichenStore } from '@/stores/lichen'
import { getPublicAgent } from '@/lib/atproto/auth'
import { uploadBlob } from '@/lib/atproto/blobs'
import { prepareImageUpload } from '@/lib/media/prepare-image-upload'
import { getWatchlist } from '@/lib/watchlist'
import {
  createDockButton,
  deleteRecord,
  forkDockButton,
  getDockButton,
  linkDockItem,
  listDockButtonsForWiki,
  listDockItems,
  resolveDockButtonArt,
  type DockButtonRecord,
  type DockItemRecord,
  type ResolvedDockButton,
} from '@/lib/pckt-records'

/**
 * Dock button manager: create shareable buttons, browse buttons from wikis
 * you follow, and add any of them to this wiki — linked (live from the
 * creator) or forked (copied, then yours to edit). Text-only navbar links
 * stay in the header chrome editor; everything here is the bubble layer.
 */
const auth = useAuthStore()
const lichen = useLichenStore()

const wiki = computed(() => lichen.currentWiki)
const canManage = computed(
  () => !!auth.did && !!wiki.value && wiki.value.ownerDid === auth.did,
)

const items = ref<DockItemRecord[]>([])
const linkedButtons = ref<Record<string, ResolvedDockButton>>({})
const loading = ref(true)
const listError = ref('')

/** Display rows for the current dock buttons, with art URLs resolved. */
const rows = computed(() =>
  items.value.map((item) => {
    if (item.buttonRef) {
      const resolved = linkedButtons.value[item.buttonRef]
      return {
        item,
        kind: 'linked' as const,
        label: resolved?.label ?? item.buttonRef,
        detail: 'linked',
        artUrl: resolved?.artUrl ?? null,
      }
    }
    return {
      item,
      kind: 'forked' as const,
      label: item.label ?? '?',
      detail: `→ ${item.href ?? ''} · forked`,
      artUrl: null,
    }
  }),
)

async function refresh() {
  if (!wiki.value) return
  loading.value = true
  listError.value = ''
  try {
    items.value = (await listDockItems(wiki.value.ownerDid)).filter(
      (i) => i.wikiRef === wiki.value!.uri,
    )
    const agent = auth.agent ?? getPublicAgent()
    for (const item of items.value) {
      if (item.buttonRef && !linkedButtons.value[item.buttonRef]) {
        const button = await getDockButton(agent, item.buttonRef)
        if (button) {
          linkedButtons.value = {
            ...linkedButtons.value,
            [item.buttonRef]: await resolveDockButtonArt(button),
          }
        }
      }
    }
  } catch (err) {
    listError.value = err instanceof Error ? err.message : 'Could not load dock buttons'
  } finally {
    loading.value = false
  }
}

async function removeItem(item: DockItemRecord) {
  if (!auth.agent) return
  if (!confirm('Remove this button from the dock?')) return
  await deleteRecord(auth.agent, item.uri)
  items.value = items.value.filter((i) => i.uri !== item.uri)
}

// --- create a shareable button -------------------------------------------

const createOpen = ref(false)
const createLabel = ref('')
const createTarget = ref('')
const createFile = ref<File | null>(null)
const creating = ref(false)
const createError = ref('')
const createdShare = ref('')
const artInput = ref<HTMLInputElement | null>(null)

function pickArt() {
  artInput.value?.click()
}

function onArtPicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  createFile.value = file ?? null
  input.value = ''
}

async function createButton() {
  if (!auth.agent || !wiki.value || !createLabel.value.trim() || !createTarget.value.trim()) return
  creating.value = true
  createError.value = ''
  createdShare.value = ''
  try {
    let art: Record<string, unknown>
    if (createFile.value) {
      const prepared = await prepareImageUpload(createFile.value, 'icon')
      const uploaded = await uploadBlob(auth.agent, prepared)
      art = uploaded.blob as Record<string, unknown>
    } else {
      throw new Error('Pick bubble art first (a square-ish image works best).')
    }
    const target = createTarget.value.trim()
    const href = /^(https?:|mailto:|tel:)/i.test(target)
      ? target
      : `/@${lichen.ownerHandle}/${wiki.value.slug}/${target.replace(/^\/+/, '')}`
    const button = await createDockButton(auth.agent, {
      label: createLabel.value.trim(),
      href,
      art,
      wikiRef: wiki.value.uri,
    })
    // Add it to this wiki's dock as a linked item so updates flow.
    await linkDockItem(auth.agent, wiki.value.uri, button.uri)
    const origin = typeof window === 'undefined' ? '' : window.location.origin
    createdShare.value = `${origin}/dock-button?at=${button.uri}`
    createLabel.value = ''
    createTarget.value = ''
    createFile.value = null
    await refresh()
  } catch (err) {
    createError.value = err instanceof Error ? err.message : 'Could not create the button'
  } finally {
    creating.value = false
  }
}

// --- add from a share link ------------------------------------------------

const addUri = ref('')
const addPreview = ref<ResolvedDockButton | null>(null)
const addError = ref('')
const adding = ref(false)

async function previewAdd() {
  addError.value = ''
  addPreview.value = null
  const raw = addUri.value.trim()
  if (!raw) return
  let uri = raw
  const fromQuery = /[?&]at=(at:\/\/[^&]+)/.exec(raw)
  if (fromQuery) uri = decodeURIComponent(fromQuery[1])
  if (!uri.startsWith('at://')) {
    addError.value = 'Paste a button link (…/dock-button?at=at://…) or an at-uri.'
    return
  }
  try {
    const button = await getDockButton(auth.agent ?? getPublicAgent(), uri)
    if (!button) {
      addError.value = 'That button does not exist.'
      return
    }
    addPreview.value = await resolveDockButtonArt(button)
  } catch (err) {
    addError.value = err instanceof Error ? err.message : 'Could not load that button'
  }
}

async function addPreviewButton(mode: 'link' | 'fork') {
  if (!auth.agent || !wiki.value || !addPreview.value || adding.value) return
  adding.value = true
  addError.value = ''
  try {
    if (mode === 'link') {
      await linkDockItem(auth.agent, wiki.value.uri, addPreview.value.uri)
    } else {
      await forkDockButton(auth.agent, wiki.value.uri, addPreview.value)
    }
    addUri.value = ''
    addPreview.value = null
    await refresh()
  } catch (err) {
    addError.value = err instanceof Error ? err.message : 'Could not add the button'
  } finally {
    adding.value = false
  }
}

// --- browse buttons from followed wikis -----------------------------------

const browse = ref<Array<{ owner: string; button: ResolvedDockButton }>>([])
const browsing = ref(false)
const browseLoaded = ref(false)

async function loadBrowse() {
  browsing.value = true
  browseLoaded.value = true
  try {
    const agent = auth.agent ?? getPublicAgent()
    const followed = getWatchlist().map((entry) => ({
      did: entry.wikiUri.replace(/^at:\/\//, '').split('/')[0] ?? '',
      label: entry.handle,
    }))
    const seen = new Set<string>()
    const out: Array<{ owner: string; button: ResolvedDockButton }> = []
    for (const owner of followed) {
      if (!owner.did) continue
      const wikis = await import('@/lib/atproto/lichen').then((m) =>
        m.listRecords(agent, owner.did, 'wiki.lichen.wiki', (uri, _cid, _rkey, value) => ({
          uri,
          value: value as Record<string, unknown>,
        })),
      )
      for (const w of wikis) {
        if (w.value.deletedAt || w.value.redirectSlug) continue
        const buttons: DockButtonRecord[] = await listDockButtonsForWiki(
          agent,
          owner.did,
          w.uri,
        )
        for (const button of buttons) {
          if (seen.has(button.uri)) continue
          seen.add(button.uri)
          out.push({ owner: owner.label, button: await resolveDockButtonArt(button) })
        }
      }
    }
    browse.value = out
  } catch (err) {
    listError.value = err instanceof Error ? err.message : 'Could not load shared buttons'
  } finally {
    browsing.value = false
  }
}

async function addFromBrowse(button: ResolvedDockButton, mode: 'link' | 'fork') {
  if (!auth.agent || !wiki.value || adding.value) return
  adding.value = true
  try {
    if (mode === 'link') await linkDockItem(auth.agent, wiki.value.uri, button.uri)
    else await forkDockButton(auth.agent, wiki.value.uri, button)
    await refresh()
  } catch (err) {
    listError.value = err instanceof Error ? err.message : 'Could not add the button'
  } finally {
    adding.value = false
  }
}

onMounted(refresh)
</script>

<template>
  <section v-if="canManage && wiki" class="card section">
    <h2>Dock buttons</h2>
    <p class="muted">
      Bubble buttons on this wiki's bottom dock. Text-only links live in the header editor;
      these are the shareable art buttons — create your own, or add buttons other creators
      have shared (linked stays synced with them; forked is a copy you own).
    </p>

    <p v-if="loading" class="muted">Loading…</p>
    <template v-else>
      <ul v-if="rows.length" class="dock-list">
        <li v-for="row in rows" :key="row.item.uri">
          <img v-if="row.artUrl" :src="row.artUrl" alt="" class="dock-art" />
          <span v-else class="dock-art dock-art--letter">{{ row.label.charAt(0).toUpperCase() }}</span>
          <span class="dock-name">
            {{ row.label }} <span class="muted">· {{ row.detail }}</span>
          </span>
          <button type="button" class="btn btn-ghost btn-sm" @click="removeItem(row.item)">
            Remove
          </button>
        </li>
      </ul>
      <p v-else class="muted">
        No bubble buttons yet — create one below or add a shared button.
      </p>

      <div class="dock-actions">
        <button type="button" class="btn btn-secondary btn-sm" @click="createOpen = !createOpen">
          {{ createOpen ? 'Close' : 'Create a button' }}
        </button>
      </div>

      <div v-if="createOpen" class="dock-create">
        <div class="field">
          <label class="label" for="dock-label">Label</label>
          <input id="dock-label" v-model="createLabel" class="input" type="text" placeholder="Games" />
        </div>
        <div class="field">
          <label class="label" for="dock-target">Leads to (article slug or full URL)</label>
          <input
            id="dock-target"
            v-model="createTarget"
            class="input"
            type="text"
            list="dock-article-slugs"
            placeholder="games  ·  or  https://…"
          />
          <datalist id="dock-article-slugs">
            <option v-for="note in lichen.notes.filter((n) => !n.slug.startsWith('branch:'))" :key="note.uri" :value="note.slug" />
          </datalist>
        </div>
        <div class="field">
          <span class="label">Bubble art</span>
          <input ref="artInput" type="file" accept="image/*" class="dock-file" @change="onArtPicked" />
          <button type="button" class="btn btn-ghost btn-sm" @click="pickArt">
            {{ createFile ? createFile.name : 'Choose image…' }}
          </button>
        </div>
        <button type="button" class="btn btn-primary" :disabled="creating" @click="createButton">
          {{ creating ? 'Creating…' : 'Create & add to dock' }}
        </button>
        <p v-if="createdShare" class="dock-created">
          Created! Share it with:
          <code>{{ createdShare }}</code>
        </p>
        <p v-if="createError" class="error-text">{{ createError }}</p>
      </div>

      <div class="dock-add">
        <h3>Add a shared button</h3>
        <div class="dock-add-row">
          <input
            v-model="addUri"
            class="input"
            type="text"
            placeholder="Paste a button link or at-uri…"
            @keydown.enter="previewAdd"
          />
          <button type="button" class="btn btn-secondary btn-sm" @click="previewAdd">Preview</button>
        </div>
        <div v-if="addPreview" class="dock-preview">
          <img v-if="addPreview.artUrl" :src="addPreview.artUrl" alt="" width="48" height="48" />
          <span class="dock-name">{{ addPreview.label }} → {{ addPreview.href }}</span>
          <button type="button" class="btn btn-ghost btn-sm" :disabled="adding" @click="addPreviewButton('link')">
            Link
          </button>
          <button type="button" class="btn btn-secondary btn-sm" :disabled="adding" @click="addPreviewButton('fork')">
            Fork
          </button>
        </div>
        <p v-if="addError" class="error-text">{{ addError }}</p>
      </div>

      <div class="dock-browse">
        <button type="button" class="btn btn-ghost btn-sm" @click="loadBrowse">
          {{ browsing ? 'Looking…' : browseLoaded ? 'Refresh shared buttons from wikis you follow' : 'Browse shared buttons from wikis you follow' }}
        </button>
        <ul v-if="browse.length" class="dock-list">
          <li v-for="entry in browse" :key="entry.button.uri">
            <img v-if="entry.button.artUrl" :src="entry.button.artUrl" alt="" class="dock-art" />
            <span class="dock-name">
              {{ entry.button.label }} <span class="muted">· shared by @{{ entry.owner }}</span>
            </span>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="adding"
              @click="addFromBrowse(entry.button, 'link')"
            >
              Link
            </button>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              :disabled="adding"
              @click="addFromBrowse(entry.button, 'fork')"
            >
              Fork
            </button>
          </li>
        </ul>
        <p v-else-if="browseLoaded && !browsing" class="muted">
          No shared buttons from the wikis you follow yet — creators make them in Settings → Dock buttons.
        </p>
      </div>

      <p v-if="listError" class="error-text">{{ listError }}</p>
    </template>
  </section>
</template>

<style scoped>
.section {
  padding: 1.25rem;
}

.section h2 {
  margin: 0 0 0.5rem;
  font-size: 1rem;
}

.section > p {
  margin: 0 0 1rem;
  font-size: 0.875rem;
}

.dock-list {
  list-style: none;
  margin: 0 0 0.75rem;
  padding: 0;
}

.dock-list li {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.4rem 0;
  border-bottom: 1px solid var(--pckt-border);
  font-size: 0.875rem;
}

.dock-art {
  width: 32px;
  height: 32px;
  object-fit: contain;
  flex: none;
}

.dock-art--hidden {
  visibility: hidden;
}

.dock-name {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.dock-actions {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.dock-create,
.dock-add {
  display: grid;
  gap: 0.625rem;
  padding: 0.75rem;
  border: 1px dashed var(--pckt-border);
  border-radius: var(--pckt-radius-sm);
  margin-bottom: 0.875rem;
}

.dock-add h3 {
  margin: 0;
  font-size: 0.9375rem;
}

.dock-add-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.dock-add-row .input {
  flex: 1 1 16rem;
  min-width: 0;
}

.dock-file {
  display: none;
}

.dock-preview {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  flex-wrap: wrap;
  font-size: 0.875rem;
}

.dock-created {
  margin: 0;
  font-size: 0.8125rem;
  overflow-wrap: anywhere;
}

.dock-browse {
  display: grid;
  gap: 0.5rem;
}

.field {
  display: grid;
  gap: 0.25rem;
}

.label {
  font-size: 0.8125rem;
  font-weight: 600;
}

code {
  font-family: var(--pckt-font-mono);
  font-size: 0.8125em;
  overflow-wrap: anywhere;
}
</style>
