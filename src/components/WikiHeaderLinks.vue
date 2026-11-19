<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useWikiEditMode } from '@/composables/useWikiEditMode'
import { useLichenStore } from '@/stores/lichen'
import { blobRefToJson, resolveBlobDisplayUrl, uploadBlob } from '@/lib/atproto/blobs'
import { prepareImageUpload } from '@/lib/media/prepare-image-upload'
import { isBranchSlug } from '@/lib/lichen/branches'
import { isTalkSlug } from '@/lib/lichen/content-meta'
import { rankSuggestions, type SuggestCandidate } from '@/lib/editor/suggest'
import { normalizeArticleSlug } from '@/lib/atproto/lichen'
import { useComboboxKeyboard } from '@/composables/useComboboxKeyboard'
import {
  headerLinkHasDestination,
  headerLinkHref,
  isExternalHeaderLink,
} from '@/lib/lichen/header-links'
import type { LichenBlobRef, LichenHeaderLink, LichenNoteWithContent } from '@/types/lichen'

const props = withDefaults(
  defineProps<{
    links: LichenHeaderLink[]
    ownerDid?: string
    ownerHandle: string
    wikiSlug: string
    /** Wiki-wide header links vs page subheader links. */
    kind?: 'header' | 'subheader'
    /** Top-bar text links vs in-page illustrated row. */
    variant?: 'navbar' | 'illustrated'
    /** WYSIWYG inline editing — layout stays, fields sit where labels are. */
    editing?: boolean
    /** When editing note subheader links, the note to write to. */
    note?: LichenNoteWithContent | null
    /**
     * Hide the built-in Save/Cancel because an enclosing editor owns the commit
     * — it calls `commit()` as part of its own save. Avoids two rival save
     * buttons when this row is edited inside the page editor.
     */
    deferCommit?: boolean
  }>(),
  {
    kind: 'header',
    variant: 'illustrated',
    ownerDid: '',
    editing: false,
    note: null,
    deferCommit: false,
  },
)

const emit = defineEmits<{
  saved: []
  cancel: []
}>()

const auth = useAuthStore()
const lichen = useLichenStore()
const editMode = useWikiEditMode()

interface DraftLink {
  id: number
  label: string
  url: string
  image?: LichenBlobRef
  previewUrl?: string
}

let draftIdSeq = 0
function nextDraftId() {
  draftIdSeq += 1
  return draftIdSeq
}

const draft = ref<DraftLink[]>([])
const saving = ref(false)
const uploadingIndex = ref<number | null>(null)
const error = ref('')
const iconUrls = ref<Record<number, string>>({})
/** Slug currently being created from the URL field, for the pending state. */
const creatingSlug = ref<string | null>(null)
const rootRef = ref<HTMLElement | null>(null)

const suggestForIndex = ref<number | null>(null)
const suggestItems = ref<SuggestCandidate[]>([])
const suggestActive = ref(-1)
/** Which navbar link shows its URL popover (in-place under the label). */
const urlEditorIndex = ref<number | null>(null)
let urlBlurTimer: ReturnType<typeof setTimeout> | undefined

const suggestOpen = computed(
  () => suggestForIndex.value !== null && suggestItems.value.length > 0,
)
const suggestCount = computed(() => suggestItems.value.length)

/** One entry per slug — duplicate note records would otherwise repeat a target. */
const noteCandidates = computed(() => {
  const bySlug = new Map<string, { slug: string; title: string }>()
  for (const note of lichen.notes) {
    if (isTalkSlug(note.slug) || isBranchSlug(note.slug)) continue
    if (bySlug.has(note.slug)) continue
    bySlug.set(note.slug, { slug: note.slug, title: note.title || note.slug })
  }
  return [...bySlug.values()]
})

const basePath = computed(() => `/@${props.ownerHandle}/${props.wikiSlug}`)
const navLabel = computed(() => {
  if (props.variant === 'navbar') return 'Wiki navigation'
  return props.kind === 'subheader' ? 'Page subheader links' : 'Wiki header links'
})
const showIcons = computed(() => props.variant === 'illustrated')
const hasAnyImage = computed(() => {
  if (!showIcons.value) return false
  // Editing always reserves the icon column so labels sit where they will once
  // images are added, instead of jumping down when the first icon appears.
  if (props.editing) return true
  return Object.keys(iconUrls.value).length > 0
})

const hasDestination = headerLinkHasDestination
const isExternal = isExternalHeaderLink

function internalTo(url: string): string {
  return headerLinkHref(url, basePath.value)
}

function destinationSuggestions(query: string): SuggestCandidate[] {
  const trimmed = query.trim()
  if (isExternal(trimmed)) return []

  const ranked = rankSuggestions(noteCandidates.value, trimmed, 5)

  // Always offer wiki home when the query is empty or looks like "home".
  const homeQuery = !trimmed || trimmed === '.' || 'home'.startsWith(trimmed.toLowerCase())
  if (homeQuery && !ranked.some((item) => item.value === 'home' || item.value === '.')) {
    ranked.unshift({
      value: 'home',
      label: 'Wiki home',
      detail: 'home',
    })
  }

  const existingSlugs = new Set(noteCandidates.value.map((note) => note.slug))

  // Five keeps the popover short enough not to bury the content below it.
  return ranked
    .slice(0, 5)
    .map((item): SuggestCandidate | null => {
      if (!item.isNew) return { ...item, detail: suggestionPath(item.value) }

      // Linking to a page that does not exist yet is how a wiki grows, so offer
      // to create it here rather than making the author leave the row first.
      const slug = normalizeArticleSlug(item.value)
      if (!slug || existingSlugs.has(slug)) return null
      return {
        value: slug,
        label: `Create page “${slug}”`,
        detail: suggestionPath(slug),
        isNew: true,
      }
    })
    .filter((item): item is SuggestCandidate => item !== null)
}

/** Title for a page created from a link, when the link has no label yet. */
function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * Create the page a link points at. Left empty so opening it lands on the
 * "start writing" prompt rather than boilerplate the author has to clear.
 */
async function createLinkedPage(slug: string, linkLabel: string): Promise<boolean> {
  if (!auth.agent) {
    error.value = 'Sign in to create a page'
    return false
  }
  error.value = ''
  creatingSlug.value = slug
  try {
    await lichen.createNoteWithSlug(
      auth.agent,
      slug,
      linkLabel.trim() || titleFromSlug(slug),
      '',
      'Created from a link',
    )
    return true
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not create that page'
    return false
  } finally {
    creatingSlug.value = null
  }
}

/** Path shown under a suggestion title (where the link will go). */
function suggestionPath(slug: string): string {
  if (!slug || slug === '.') return `/@${props.ownerHandle}/${props.wikiSlug}`
  return `/@${props.ownerHandle}/${props.wikiSlug}/${slug}`
}

function refreshSuggestions(index: number) {
  const item = draft.value[index]
  if (!item) {
    closeSuggestions()
    return
  }
  suggestForIndex.value = index
  suggestItems.value = destinationSuggestions(item.url)
  suggestActive.value = suggestItems.value.length > 0 ? 0 : -1
}

function closeSuggestions() {
  suggestForIndex.value = null
  suggestItems.value = []
  suggestActive.value = -1
}

function openUrlEditor(index: number) {
  clearTimeout(urlBlurTimer)
  urlEditorIndex.value = index
  refreshSuggestions(index)
}

/** Keep focus when clicking popover chrome/suggestions; allow the URL input to focus. */
function onPopoverMouseDown(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element)) return
  if (target.closest('input, textarea, select, [contenteditable="true"]')) return
  event.preventDefault()
}

function scheduleCloseUrlEditor() {
  clearTimeout(urlBlurTimer)
  urlBlurTimer = setTimeout(() => {
    if (urlEditorIndex.value !== null) {
      closeSuggestions()
      urlEditorIndex.value = null
    }
  }, 150)
}

async function selectSuggestion(index: number) {
  const linkIndex = suggestForIndex.value
  const pick = suggestItems.value[index]
  if (linkIndex == null || !pick) return
  const item = draft.value[linkIndex]

  if (pick.isNew) {
    // Keep the row open on failure so the error is visible next to the field.
    const created = await createLinkedPage(pick.value, item.label)
    if (!created) return
    if (!item.label.trim()) item.label = titleFromSlug(pick.value)
  } else if (!item.label.trim()) {
    item.label = pick.label === 'Wiki home' ? 'Home' : pick.label
  }

  item.url = pick.value
  closeSuggestions()
}

function onUrlInput(index: number) {
  refreshSuggestions(index)
}

function onUrlFocus(index: number) {
  openUrlEditor(index)
}

const { onKeydown: onUrlKeydown } = useComboboxKeyboard(
  suggestOpen,
  suggestActive,
  suggestCount,
  {
    onSelect: (i: number) => void selectSuggestion(i),
    onClose: closeSuggestions,
    onEnterWithoutSelection: () => false,
  },
  (i) => `header-link-suggest-${suggestForIndex.value ?? 0}-${i}`,
)

async function resolveIcons(links: LichenHeaderLink[], did: string) {
  const next: Record<number, string> = {}
  await Promise.all(
    links.map(async (link, index) => {
      if (!link.image) return
      try {
        const url = await resolveBlobDisplayUrl(did, link.image)
        if (url) next[index] = url
      } catch {
        // ignore
      }
    }),
  )
  iconUrls.value = next
}

async function loadDraft(links: LichenHeaderLink[]) {
  const did = props.ownerDid || lichen.currentWiki?.ownerDid
  draft.value = links.map((link, index) => ({
    id: nextDraftId(),
    label: link.label,
    url: link.url,
    image: link.image ? blobRefToJson(link.image) ?? link.image : undefined,
    // Carry over the URL the read view already resolved. Without this the draft
    // renders with no image while the identical lookup repeats, so entering edit
    // mode blinks every icon out and back in.
    previewUrl: iconUrls.value[index],
  }))
  // Start with one blank row so “add subheader links” is immediately editable.
  if (draft.value.length === 0) {
    draft.value.push({ id: nextDraftId(), label: '', url: '' })
  }
  if (!did) return
  await Promise.all(
    draft.value.map(async (item) => {
      if (!item.image) return
      try {
        item.previewUrl = (await resolveBlobDisplayUrl(did, item.image)) ?? undefined
      } catch {
        // leave empty
      }
    }),
  )
}

watch(
  () => [props.editing, props.links, props.ownerDid, showIcons.value] as const,
  async ([editing, links, did, icons]) => {
    if (editing) {
      await loadDraft(links)
      return
    }
    if (!icons || !did) {
      iconUrls.value = {}
      return
    }
    await resolveIcons(links, did)
  },
  { immediate: true, deep: true },
)

function addLink() {
  draft.value.push({ id: nextDraftId(), label: '', url: '' })
  const index = draft.value.length - 1
  void nextTick(() => {
    openUrlEditor(index)
    const inputs = rootRef.value?.querySelectorAll<HTMLInputElement>('.header-link-label-input')
    inputs?.[index]?.focus()
  })
}

function removeLink(index: number) {
  draft.value.splice(index, 1)
  if (urlEditorIndex.value === index) {
    closeSuggestions()
    urlEditorIndex.value = null
  } else if (urlEditorIndex.value !== null && urlEditorIndex.value > index) {
    urlEditorIndex.value -= 1
  }
  if (suggestForIndex.value !== null && suggestForIndex.value > index) {
    suggestForIndex.value -= 1
  }
}

/** Remap an open-editor index after moving an item from `from` to `to`. */
function remapIndexAfterMove(current: number, from: number, to: number): number {
  if (current === from) return to
  if (from < to && current > from && current <= to) return current - 1
  if (from > to && current >= to && current < from) return current + 1
  return current
}

function moveLink(index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= draft.value.length) return
  const [item] = draft.value.splice(index, 1)
  draft.value.splice(target, 0, item)
  if (urlEditorIndex.value !== null) {
    urlEditorIndex.value = remapIndexAfterMove(urlEditorIndex.value, index, target)
  }
  if (suggestForIndex.value !== null) {
    suggestForIndex.value = remapIndexAfterMove(suggestForIndex.value, index, target)
  }
}

async function onPickImage(index: number, event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !auth.agent) return
  error.value = ''
  uploadingIndex.value = index
  try {
    const prepared = await prepareImageUpload(file, 'icon')
    const { blob } = await uploadBlob(auth.agent, prepared)
    const item = draft.value[index]
    item.image = blobRefToJson(blob) ?? blob
    item.previewUrl = URL.createObjectURL(prepared)
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to upload image'
  } finally {
    uploadingIndex.value = null
  }
}

function collectLinks(): LichenHeaderLink[] {
  return draft.value
    .map((item) => ({
      label: item.label.trim(),
      url: item.url.trim(),
      image: item.image ? blobRefToJson(item.image) ?? item.image : undefined,
    }))
    .filter((item) => item.label)
}

async function writeLinks(links: LichenHeaderLink[]): Promise<void> {
  const agent = auth.agent
  if (!agent) throw new Error('Sign in to save links')
  if (props.kind === 'subheader') {
    if (!props.note) {
      // New/unsaved page: parent creates the note then applies these links.
      if (props.deferCommit) return
      throw new Error('Note is still loading')
    }
    await lichen.setNoteSubheaderLinks(agent, props.note, links)
  } else if (props.variant === 'navbar') {
    await lichen.setWikiNavbarLinks(agent, links)
  } else {
    await lichen.setWikiHeaderLinks(agent, links)
  }
}

/**
 * Current draft rows (labels required). Used by parents that create the note
 * first, then apply staged subheader links in the same publish gesture.
 */
function getLinks(): LichenHeaderLink[] {
  return collectLinks()
}

/**
 * Save without emitting `saved`, for a parent that folds this into its own
 * commit. Returns false (leaving the error visible) so the parent can abort.
 */
async function commit(): Promise<boolean> {
  if (!props.editing) return true
  // Staging for a not-yet-created note does not need an agent write.
  if (!auth.agent && !(props.kind === 'subheader' && props.deferCommit && !props.note)) {
    error.value = 'Sign in to save links'
    return false
  }
  error.value = ''
  const links = collectLinks()
  saving.value = true
  try {
    await writeLinks(links)
    return true
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to save links'
    return false
  } finally {
    saving.value = false
  }
}

/**
 * While this row is being edited it joins the edit-mode commit set, so any Save
 * in the app writes it — no per-row save button required.
 */
const commitId = `header-links-${props.kind}-${props.variant}-${nextDraftId()}`

watch(
  () => props.editing,
  (editing) => {
    if (editing) editMode.registerCommit(commitId, commit)
    else editMode.unregisterCommit(commitId)
  },
  { immediate: true },
)

onUnmounted(() => editMode.unregisterCommit(commitId))

defineExpose({ commit, getLinks })
</script>

<template>
  <nav
    v-if="editing || links.length"
    ref="rootRef"
    class="wiki-header-links"
    :class="{
      'has-images': hasAnyImage,
      'is-subheader': kind === 'subheader',
      'is-navbar': variant === 'navbar',
      'is-editing': editing,
      'is-deferred': editing && deferCommit,
    }"
    :aria-label="navLabel"
  >
    <template v-if="editing">
      <div
        v-for="(item, index) in draft"
        :key="item.id"
        class="header-link header-link--edit"
        :class="{ 'header-link--url-open': urlEditorIndex === index }"
      >
        <label
          v-if="showIcons"
          class="header-link-icon-edit"
          :class="{ 'has-preview': !!item.previewUrl }"
          :title="item.previewUrl ? 'Change image' : 'Add image'"
        >
          <img
            v-if="item.previewUrl"
            :src="item.previewUrl"
            alt=""
            class="header-link-icon"
            width="140"
            height="140"
            loading="lazy"
            decoding="async"
          />
          <span v-else class="header-link-icon header-link-icon--empty" aria-hidden="true" />
          <input
            type="file"
            accept="image/*"
            class="visually-hidden"
            :disabled="uploadingIndex !== null || saving"
            @change="(e) => onPickImage(index, e)"
          />
        </label>

        <input
          v-model="item.label"
          class="header-link-label-input"
          type="text"
          placeholder="Name"
          :size="Math.max((item.label || 'Name').length, 1)"
          :aria-label="`Link ${index + 1} name`"
          @focus="openUrlEditor(index)"
        />

        <div
          v-if="urlEditorIndex === index"
          class="header-link-url-popover"
          @mousedown="onPopoverMouseDown"
        >
          <label class="header-link-url-field">
            <span class="header-link-url-label">URL</span>
            <input
              v-model="item.url"
              class="header-link-url-input"
              type="text"
              role="combobox"
              autocomplete="off"
              :aria-expanded="suggestForIndex === index && suggestOpen"
              :aria-controls="`header-link-suggest-list-${index}`"
              :aria-activedescendant="
                suggestForIndex === index && suggestActive >= 0
                  ? `header-link-suggest-${index}-${suggestActive}`
                  : undefined
              "
              placeholder="page slug or https://…"
              :aria-label="`Link ${index + 1} URL`"
              @focus="onUrlFocus(index)"
              @input="onUrlInput(index)"
              @keydown="onUrlKeydown"
              @blur="scheduleCloseUrlEditor"
            />
          </label>
          <ul
            v-if="suggestForIndex === index && suggestOpen"
            :id="`header-link-suggest-list-${index}`"
            class="header-link-suggest"
            role="listbox"
          >
            <li
              v-for="(suggestion, sIndex) in suggestItems"
              :id="`header-link-suggest-${index}-${sIndex}`"
              :key="`${suggestion.value}-${sIndex}`"
              class="header-link-suggest-item"
              :class="{ active: suggestActive === sIndex }"
              role="option"
              :aria-selected="suggestActive === sIndex"
              @mousedown.prevent="selectSuggestion(sIndex)"
            >
              <span class="header-link-suggest-title">
                {{
                  suggestion.isNew && creatingSlug === suggestion.value
                    ? 'Creating page…'
                    : suggestion.label
                }}
              </span>
              <span class="header-link-suggest-detail">{{ suggestion.detail }}</span>
            </li>
          </ul>
        </div>

        <div class="header-link-reorder" role="group" :aria-label="`Reorder link ${index + 1}`">
          <button
            type="button"
            class="header-link-move"
            title="Move left"
            aria-label="Move left"
            :disabled="index === 0 || saving"
            @click="moveLink(index, -1)"
          >
            ‹
          </button>
          <button
            type="button"
            class="header-link-move"
            title="Move right"
            aria-label="Move right"
            :disabled="index === draft.length - 1 || saving"
            @click="moveLink(index, 1)"
          >
            ›
          </button>
        </div>

        <button
          type="button"
          class="header-link-remove"
          title="Remove link"
          @click="removeLink(index)"
        >
          ×
        </button>
      </div>

      <!-- Navbar: compact in-flow +. Illustrated: float so it doesn’t reserve a tile. -->
      <button
        v-if="variant === 'navbar'"
        type="button"
        class="header-link header-link--add"
        title="Add link"
        aria-label="Add link"
        @click="addLink"
      >
        <span class="header-link-label">+</span>
      </button>
      <div v-else class="header-link-add-anchor">
        <button
          type="button"
          class="header-link-add-float"
          title="Add link"
          aria-label="Add link"
          @click="addLink"
        >
          +
        </button>
      </div>

      <!--
        No per-row Save/Cancel: this row registers with the edit-mode commit set,
        so the header's Save writes it. The pill also sat directly under the row,
        which is where the URL popover opens.
      -->
      <p v-if="error" class="header-links-error">{{ error }}</p>
    </template>

    <template v-else>
      <template v-for="(link, index) in links" :key="index">
        <!-- No destination yet: show it, but do not navigate. Routing an empty
             url would quietly land on the wiki home. -->
        <span v-if="!hasDestination(link)" class="header-link header-link--inert">
          <img
            v-if="showIcons && iconUrls[index]"
            :src="iconUrls[index]"
            :alt="''"
            class="header-link-icon"
            width="140"
            height="140"
            loading="lazy"
            decoding="async"
          />
          <!-- Keep labels aligned with image-bearing siblings. -->
          <span
            v-else-if="showIcons && hasAnyImage"
            class="header-link-icon header-link-icon--spacer"
            aria-hidden="true"
          />
          <span class="header-link-label">{{ link.label }}</span>
        </span>
        <a
          v-else-if="isExternal(link.url)"
          class="header-link"
          :href="link.url"
          target="_blank"
          rel="noopener noreferrer"
        >
          <img
            v-if="showIcons && iconUrls[index]"
            :src="iconUrls[index]"
            :alt="''"
            class="header-link-icon"
            width="140"
            height="140"
            loading="lazy"
            decoding="async"
          />
          <span
            v-else-if="showIcons && hasAnyImage"
            class="header-link-icon header-link-icon--spacer"
            aria-hidden="true"
          />
          <span class="header-link-label">{{ link.label }}</span>
        </a>
        <RouterLink v-else class="header-link" :to="internalTo(link.url)">
          <img
            v-if="showIcons && iconUrls[index]"
            :src="iconUrls[index]"
            :alt="''"
            class="header-link-icon"
            width="140"
            height="140"
            loading="lazy"
            decoding="async"
          />
          <span
            v-else-if="showIcons && hasAnyImage"
            class="header-link-icon header-link-icon--spacer"
            aria-hidden="true"
          />
          <span class="header-link-label">{{ link.label }}</span>
        </RouterLink>
      </template>
    </template>
  </nav>
</template>

<style scoped>
.wiki-header-links {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.75rem 1rem;
  align-items: flex-start;
  margin: 0 0 1.75rem;
  padding: 0.75rem 0 1.25rem;
  border-bottom: 1px solid var(--pckt-border);
}

.wiki-header-links.is-navbar {
  flex-wrap: nowrap;
  justify-content: center;
  align-items: center;
  gap: 0.125rem 0.25rem;
  margin: 0;
  padding: 0;
  border-bottom: none;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.wiki-header-links.is-navbar::-webkit-scrollbar {
  display: none;
}

.wiki-header-links.is-editing {
  position: relative;
  align-items: flex-start;
}

.wiki-header-links.is-navbar.is-editing {
  flex-wrap: nowrap;
  align-items: center;
  overflow: visible;
  gap: 0.125rem 0.25rem;
}

.header-link {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  width: 5.5rem;
  text-decoration: none;
  color: var(--pckt-text);
  font-family: var(--pckt-font-ui);
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.25;
  padding: 0.25rem;
  border-radius: var(--pckt-radius-btn);
}

.wiki-header-links.is-navbar .header-link {
  flex-direction: row;
  flex: 0 0 auto;
  width: auto;
  min-width: 0;
  gap: 0;
  padding: 0.375rem 0.625rem;
  font-size: 0.8125rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  white-space: nowrap;
  color: var(--pckt-text-muted);
}

.wiki-header-links.has-images:not(.is-navbar) .header-link {
  width: 7.5rem;
}

.wiki-header-links a.header-link,
.wiki-header-links a.header-link:hover,
.wiki-header-links a.header-link:focus-visible {
  color: var(--pckt-text);
  text-decoration: none;
  transform: none;
}

.wiki-header-links.is-navbar a.header-link {
  color: var(--pckt-text-muted);
}

.wiki-header-links.is-navbar a.header-link:hover,
.wiki-header-links.is-navbar a.header-link:focus-visible {
  color: var(--pckt-text);
  background: var(--pckt-accent-soft);
}

.wiki-header-links a.header-link:hover .header-link-label,
.wiki-header-links a.header-link:focus-visible .header-link-label {
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

.wiki-header-links.is-navbar a.header-link:hover .header-link-label,
.wiki-header-links.is-navbar a.header-link:focus-visible .header-link-label {
  text-decoration: none;
}

.wiki-header-links.is-navbar a.header-link.router-link-active {
  color: var(--pckt-text);
}

/* Reads as a label, not a dead link. */
.header-link--inert {
  cursor: default;
  color: var(--pckt-text-muted);
}

.header-link--edit {
  border: none;
  background: transparent;
}

.wiki-header-links.is-navbar .header-link--edit {
  flex-direction: row;
  align-items: center;
}

.header-link--add {
  position: static;
  border: 1.5px dashed color-mix(in srgb, var(--pckt-blue) 45%, transparent);
  background: color-mix(in srgb, var(--pckt-blue) 4%, transparent);
  color: var(--pckt-text-muted);
  cursor: pointer;
  font: inherit;
  opacity: 1;
  pointer-events: auto;
  z-index: auto;
}

.wiki-header-links.is-navbar .header-link--add {
  width: auto;
  min-width: 2rem;
  padding: 0.375rem 0.5rem;
  justify-content: center;
}

.header-link--add:hover,
.header-link--add:focus-visible {
  opacity: 1;
  color: var(--pckt-text);
  border-color: color-mix(in srgb, var(--pckt-blue) 70%, transparent);
  background: color-mix(in srgb, var(--pckt-blue) 8%, transparent);
  outline: none;
}

/* Zero-width flex slot — the + floats beside the last link without shifting layout.
   The negative margin cancels the column gap this slot would otherwise claim,
   which on a centered row would nudge every link half a gap to the left. */
.header-link-add-anchor {
  position: relative;
  flex: 0 0 0;
  width: 0;
  height: 0;
  margin-left: -1rem;
  align-self: center;
  overflow: visible;
  z-index: 4;
}

.header-link-add-float {
  position: absolute;
  left: 0.5rem;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: 1.5px dashed color-mix(in srgb, var(--pckt-blue) 45%, transparent);
  border-radius: 999px;
  background: var(--pckt-bg-elevated);
  box-shadow: 0 4px 14px rgba(17, 24, 39, 0.12);
  color: var(--pckt-text-muted);
  font-family: var(--pckt-font-ui);
  font-size: 1.125rem;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  transition:
    border-color 0.12s ease,
    color 0.12s ease,
    background 0.12s ease;
}

.header-link-add-float:hover,
.header-link-add-float:focus-visible {
  color: var(--pckt-text);
  border-color: color-mix(in srgb, var(--pckt-blue) 70%, transparent);
  background: color-mix(in srgb, var(--pckt-blue) 8%, var(--pckt-bg-elevated));
  outline: none;
}

.header-link-icon-edit {
  display: block;
  width: 100%;
  cursor: pointer;
}

.header-link-icon {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 1;
  object-fit: contain;
}

.header-link-icon--empty {
  display: block;
  aspect-ratio: 1;
  box-sizing: border-box;
  background: color-mix(in srgb, var(--pckt-border) 18%, transparent);
  border: 1.5px dashed color-mix(in srgb, var(--pckt-blue) 40%, transparent);
  border-radius: var(--pckt-radius-btn);
  opacity: 0.7;
}

/* Invisible stand-in so text-only tiles share the same label baseline. */
.header-link-icon--spacer {
  visibility: hidden;
  pointer-events: none;
}

.header-link--edit:hover .header-link-icon--empty,
.header-link--edit:focus-within .header-link-icon--empty {
  opacity: 0.85;
}

.header-link-label {
  text-align: center;
}

.wiki-header-links.is-navbar .header-link-label {
  text-align: left;
}

.header-link-label-input {
  box-sizing: border-box;
  margin: 0;
  border: 1.5px dashed color-mix(in srgb, var(--pckt-blue) 45%, transparent);
  border-radius: var(--pckt-radius-btn);
  background: color-mix(in srgb, var(--pckt-blue) 4%, transparent);
  color: inherit;
  font: inherit;
  font-weight: inherit;
  letter-spacing: inherit;
  text-transform: inherit;
  text-align: center;
  padding: 0.15rem 0.35rem;
  line-height: inherit;
  /* Shrink to label text — bare inputs default to ~20ch wide. */
  field-sizing: content;
  width: auto;
  min-width: 0;
}

/* Illustrated rows sit directly under the read view, so the field must not
   change the label's metrics: an outline costs no layout and zero padding keeps
   the line box the same height as the plain <span>. Width stays 100% rather
   than shrink-to-fit because field-sizing isn't in Safari/Firefox yet. */
.wiki-header-links:not(.is-navbar) .header-link-label-input {
  width: 100%;
  padding: 0;
  border: none;
  outline: var(--pckt-edit-dash);
  outline-offset: var(--pckt-edit-dash-offset);
}

.wiki-header-links:not(.is-navbar) .header-link-label-input:hover,
.wiki-header-links:not(.is-navbar) .header-link-label-input:focus {
  outline: var(--pckt-edit-dash-strong);
  outline-offset: var(--pckt-edit-dash-offset);
}

.wiki-header-links.is-navbar .header-link-label-input {
  width: auto;
  max-width: 12rem;
  text-align: left;
  color: var(--pckt-text-muted);
}

.wiki-header-links.is-navbar .header-link-label-input:focus {
  color: var(--pckt-text);
}

.header-link-label-input:hover,
.header-link-label-input:focus {
  border-color: color-mix(in srgb, var(--pckt-blue) 70%, transparent);
  outline: none;
}

.header-link-label-input:focus {
  background: color-mix(in srgb, var(--pckt-blue) 8%, transparent);
}

.header-link-reorder {
  position: absolute;
  left: 50%;
  top: -0.35rem;
  transform: translateX(-50%);
  display: flex;
  gap: 0.125rem;
  opacity: 0;
  transition: opacity 0.12s ease;
  z-index: 2;
}

.header-link-move {
  width: 1.125rem;
  height: 1.125rem;
  border: none;
  border-radius: 999px;
  background: var(--pckt-bg-elevated);
  color: var(--pckt-text-muted);
  font-size: 0.8125rem;
  line-height: 1;
  cursor: pointer;
  padding: 0;
  box-shadow: 0 0 0 1px var(--pckt-border);
}

.header-link-move:disabled {
  opacity: 0.35;
  cursor: default;
}

.header-link-move:not(:disabled):hover,
.header-link-move:not(:disabled):focus-visible {
  color: var(--pckt-text);
  outline: none;
}

.header-link-remove {
  position: absolute;
  top: -0.35rem;
  right: -0.35rem;
  width: 1.125rem;
  height: 1.125rem;
  border: none;
  border-radius: 999px;
  background: var(--pckt-bg-elevated);
  color: var(--pckt-text-muted);
  font-size: 0.75rem;
  line-height: 1;
  cursor: pointer;
  padding: 0;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.header-link--edit:hover .header-link-remove,
.header-link--edit:focus-within .header-link-remove,
.header-link--edit:hover .header-link-reorder,
.header-link--edit:focus-within .header-link-reorder {
  opacity: 1;
}

/* Float Save/Cancel so editing never shifts surrounding content. */
.header-links-actions {
  position: absolute;
  top: calc(100% + 0.4rem);
  right: 0;
  z-index: 30;
  display: flex;
  justify-content: flex-end;
  gap: 0.35rem;
  width: max-content;
  padding: 0.35rem;
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-btn);
  background: var(--pckt-bg-elevated);
  box-shadow: 0 8px 24px rgba(17, 24, 39, 0.14);
}

.header-links-error {
  position: absolute;
  top: calc(100% + 3rem);
  right: 0;
  z-index: 30;
  margin: 0;
  width: max-content;
  text-align: right;
  color: var(--pckt-red);
  font-size: 0.8125rem;
}

/* No Save pill below the row to clear when a parent owns the commit. */
.wiki-header-links.is-deferred .header-links-error {
  top: calc(100% + 0.4rem);
}

.header-link-url-field {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.2rem;
  width: 100%;
}

.header-link-url-label {
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--pckt-text-muted);
  text-align: left;
}

.header-link-url-input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--pckt-border);
  border-radius: 4px;
  background: var(--pckt-bg);
  color: var(--pckt-text);
  font-size: 0.75rem;
  font-weight: 500;
  padding: 0.35rem 0.4rem;
}

.header-link-url-input:focus {
  outline: 2px solid var(--pckt-blue);
  outline-offset: 1px;
  border-color: transparent;
}

.header-link-url-popover {
  position: absolute;
  left: 50%;
  top: calc(100% + 0.4rem);
  transform: translateX(-50%);
  z-index: 40;
  width: min(16rem, 70vw);
  padding: 0.5rem;
  border: 1px solid var(--pckt-border);
  border-radius: 8px;
  background: var(--pckt-bg-elevated);
  box-shadow: 0 10px 28px rgba(17, 24, 39, 0.16);
}

.header-link-url-popover .header-link-suggest {
  position: static;
  margin-top: 0.35rem;
  box-shadow: none;
  max-height: 7.5rem;
}

.header-link-suggest {
  margin: 0;
  padding: 0.25rem;
  list-style: none;
  max-height: 12rem;
  overflow-y: auto;
  border: 1px solid var(--pckt-border);
  border-radius: 6px;
  background: var(--pckt-bg-elevated);
}

.header-link-suggest-item {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  padding: 0.4rem 0.5rem;
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
}

.header-link-suggest-item:hover,
.header-link-suggest-item.active {
  background: var(--pckt-accent-soft);
}

.header-link-suggest-title {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--pckt-text);
  line-height: 1.25;
}

/* One line per path. Wrapping made each suggestion three rows tall, which is
   what pushed this popover over the content below it. The title carries the
   meaning; the path only needs to be recognisable. */
.header-link-suggest-detail {
  font-size: 0.625rem;
  color: var(--pckt-text-muted);
  font-family: var(--pckt-font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
  line-height: 1.3;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  border: 0;
}

@media (max-width: 720px) {
  .wiki-header-links.is-navbar .header-link {
    padding: 0.5rem 0.4rem;
    font-size: 0.75rem;
    letter-spacing: 0.01em;
    min-height: 2.75rem;
    box-sizing: border-box;
  }
}

@media (max-width: 640px) {
  .wiki-header-links:not(.is-navbar) {
    gap: 0.5rem 0.625rem;
  }

  .wiki-header-links:not(.is-navbar) .header-link {
    width: 4.5rem;
    font-size: 0.8125rem;
  }

  .wiki-header-links.has-images:not(.is-navbar) .header-link {
    width: 5.25rem;
  }
}
</style>
