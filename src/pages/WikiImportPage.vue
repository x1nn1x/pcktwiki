<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import { loadWikiByHandle } from '@/lib/atproto/wiki-loader'
import { normalizeHandle } from '@/lib/config'
import { slugifyHeading } from '@/lib/lichen/wikilinks'
import { convertHtmlText, convertWikipediaInput, type WikipediaImportResult } from '@/lib/import/wikipedia'
import { openZim, type ZimArchive, type ZimArticle } from '@/lib/import/zim'
import { convertZimArticle } from '@/lib/import/zim-import'
import { useAuthStore } from '@/stores/auth'
import { useLichenStore } from '@/stores/lichen'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const lichen = useLichenStore()

const handle = computed(() => normalizeHandle(route.params.handle as string))
const wikiSlug = computed(() => route.params.wikiSlug as string)

const input = ref('')
const converting = ref(false)
const convertError = ref('')
const result = ref<WikipediaImportResult | null>(null)
const title = ref('')
const publishing = ref(false)
const publishError = ref('')
const copied = ref(false)

const fileInput = ref<HTMLInputElement | null>(null)
const dragging = ref(false)
const readingFile = ref(false)
const fileError = ref('')

const zim = shallowRef<ZimArchive | null>(null)
const zimQuery = ref('')
const importingArticle = ref('')

const slugPreview = computed(() => slugifyHeading(title.value) || 'imported-page')
const sourceIsZim = computed(() => (result.value?.sourceName ?? '').startsWith('ZIM'))

const zimArticles = computed<ZimArticle[]>(() =>
  zim.value ? zim.value.listArticles(zimQuery.value, 24) : [],
)
const zimArticleCount = computed(() => zim.value?.articleCount ?? 0)
const zimEntryCount = computed(() => zim.value?.entryCount ?? 0)

async function load() {
  await loadWikiByHandle(lichen, {
    handle: handle.value,
    wikiSlug: wikiSlug.value,
    viewerDid: auth.did,
    authAgent: auth.agent,
  })
}

onMounted(load)
watch(() => route.fullPath, load)

function applyResult(converted: WikipediaImportResult) {
  result.value = converted
  title.value = converted.title
  convertError.value = ''
  publishError.value = ''
}

function baseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'Imported page'
}

async function runConvert() {
  convertError.value = ''
  result.value = null
  fileError.value = ''
  if (!input.value.trim()) {
    convertError.value = 'Paste a wiki URL, page text, wikitext or saved HTML first.'
    return
  }
  converting.value = true
  try {
    applyResult(await convertWikipediaInput(input.value))
  } catch (err) {
    convertError.value = err instanceof Error ? err.message : 'Could not convert that input.'
  } finally {
    converting.value = false
  }
}

async function openZimFile(file: File) {
  readingFile.value = true
  fileError.value = ''
  try {
    zim.value = await openZim(file, file.name)
    zimQuery.value = ''
    result.value = null
    title.value = ''
    convertError.value = ''
  } catch (err) {
    zim.value = null
    fileError.value =
      err instanceof Error ? err.message : 'Could not open that ZIM archive.'
  } finally {
    readingFile.value = false
  }
}

async function importFile(file: File) {
  const name = file.name.toLowerCase()
  fileError.value = ''

  if (name.endsWith('.zim')) {
    await openZimFile(file)
    return
  }

  readingFile.value = true
  try {
    if (name.endsWith('.html') || name.endsWith('.htm')) {
      applyResult(convertHtmlText(await file.text(), baseName(file.name)))
      return
    }
    if (name.endsWith('.txt') || name.endsWith('.md')) {
      applyResult(await convertWikipediaInput(await file.text(), { fallbackTitle: baseName(file.name) }))
      return
    }
    fileError.value = 'Drop a .zim archive, a saved .html page, or a .txt/.md export.'
  } catch (err) {
    fileError.value = err instanceof Error ? err.message : 'Could not read that file.'
  } finally {
    readingFile.value = false
  }
}

function onDragOver(event: DragEvent) {
  event.preventDefault()
  dragging.value = true
}

function onDragLeave() {
  dragging.value = false
}

async function onDrop(event: DragEvent) {
  event.preventDefault()
  dragging.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file) await importFile(file)
}

function pickFile() {
  fileInput.value?.click()
}

async function onFileChange(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (file) await importFile(file)
  target.value = ''
}

async function importZimArticle(article: ZimArticle) {
  if (!zim.value) return
  importingArticle.value = article.path
  convertError.value = ''
  try {
    applyResult(await convertZimArticle(zim.value, article))
  } catch (err) {
    convertError.value =
      err instanceof Error ? err.message : 'Could not read that article from the archive.'
  } finally {
    importingArticle.value = ''
  }
}

function closeZim() {
  zim.value = null
  zimQuery.value = ''
  importingArticle.value = ''
}

async function copyMarkdown() {
  if (!result.value) return
  try {
    await navigator.clipboard.writeText(result.value.markdown)
    copied.value = true
    setTimeout(() => (copied.value = false), 2000)
  } catch {
    publishError.value = 'Clipboard blocked — select the text below and copy manually.'
  }
}

/** Publish straight into the wiki when signed in; otherwise copy is the path. */
async function createPage() {
  if (!result.value || !auth.agent) return
  publishing.value = true
  publishError.value = ''
  try {
    const note = await lichen.createNote(auth.agent, title.value, result.value.markdown)
    await router.push(`/@${handle.value}/${wikiSlug.value}/${note.slug}`)
  } catch (err) {
    publishError.value = err instanceof Error ? err.message : 'Could not create the page.'
  } finally {
    publishing.value = false
  }
}
</script>

<template>
  <div class="import-page">
    <div class="inner">
      <header>
        <RouterLink :to="`/@${handle}/${wikiSlug}`" class="muted">← Wiki home</RouterLink>
        <h1>Import a page</h1>
        <p class="muted">
          Bring in an article from Wikipedia, Fandom or wiki.gg — by URL, by dropping a ZIM
          archive or saved HTML file, or by pasting the page's text or wikitext. It converts to
          this wiki's format: fact box, sections, wikilinks, images and categories.
        </p>
      </header>

      <div
        class="dropzone"
        :class="{ dragging, busy: readingFile }"
        role="button"
        tabindex="0"
        :aria-busy="readingFile"
        @click="pickFile"
        @keydown.enter.prevent="pickFile"
        @keydown.space.prevent="pickFile"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
        @drop="onDrop"
      >
        <input
          ref="fileInput"
          class="file-input"
          type="file"
          accept=".zim,.html,.htm,.txt,.md"
          @change="onFileChange"
        />
        <strong>{{ readingFile ? 'Reading file…' : 'Drop a file here' }}</strong>
        <span class="muted">
          .zim archives (Kiwix Wikipedia, wiki.gg mirrors), saved .html pages, or .txt exports —
          or click to choose one.
        </span>
      </div>
      <p v-if="fileError" class="error-text">{{ fileError }}</p>

      <section v-if="zim" class="zim-panel">
        <div class="zim-head">
          <div>
            <strong>{{ zim.fileName }}</strong>
            <span class="muted">
              · {{ zimArticleCount.toLocaleString() }} articles of
              {{ zimEntryCount.toLocaleString() }} entries
            </span>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" @click="closeZim">Close archive</button>
        </div>
        <label class="field-label" for="zim-search">Find an article</label>
        <input
          id="zim-search"
          v-model="zimQuery"
          class="title-input"
          type="search"
          placeholder="Search titles in this archive"
        />
        <ul class="zim-list">
          <li v-for="article in zimArticles" :key="article.path">
            <button
              type="button"
              class="zim-article"
              :disabled="!!importingArticle"
              @click="importZimArticle(article)"
            >
              <span>{{ article.title }}</span>
              <span class="muted">
                {{ importingArticle === article.path ? 'Reading…' : article.path }}
              </span>
            </button>
          </li>
        </ul>
        <p v-if="!zimArticles.length" class="muted zim-empty">No articles match that search.</p>
      </section>

      <label class="field-label" for="import-input">Or paste a URL, text, wikitext or HTML</label>
      <textarea
        id="import-input"
        v-model="input"
        class="import-input"
        rows="8"
        placeholder="https://en.wikipedia.org/wiki/Ocean — or a Fandom/wiki.gg article URL, page text, or wikitext"
      ></textarea>
      <div class="actions">
        <button type="button" class="btn btn-primary" :disabled="converting" @click="runConvert">
          {{ converting ? 'Converting…' : 'Convert' }}
        </button>
      </div>
      <p v-if="convertError" class="error-text">{{ convertError }}</p>

      <template v-if="result">
        <section class="result">
          <label class="field-label" for="import-title">Page title</label>
          <input id="import-title" v-model="title" class="title-input" type="text" />

          <p v-if="result.sourceName" class="muted image-note">
            Imported from {{ result.sourceName }}
            <template v-if="result.sourceUrl && result.sourceUrl.startsWith('http')">
              · <a :href="result.sourceUrl" target="_blank" rel="noreferrer noopener">source</a>
            </template>
          </p>
          <p v-if="result.imageUrls.length" class="muted image-note">
            {{ result.imageUrls.length }} image{{ result.imageUrls.length === 1 ? '' : 's' }} found —
            <template v-if="sourceIsZim">
              small images were embedded in the note from the archive; ones that were too large
              were skipped.
            </template>
            <template v-else>
              they stay hotlinked to the source wiki. Re-upload any you want to keep on your PDS.
            </template>
          </p>
          <ul v-if="result.warnings.length" class="warnings">
            <li v-for="warning in result.warnings" :key="warning" class="muted">{{ warning }}</li>
          </ul>

          <div class="result-actions">
            <button type="button" class="btn btn-secondary" @click="copyMarkdown">
              {{ copied ? 'Copied ✓' : 'Copy markdown' }}
            </button>
            <button
              v-if="auth.agent"
              type="button"
              class="btn btn-primary"
              :disabled="publishing"
              @click="createPage"
            >
              {{ publishing ? 'Creating…' : 'Create page' }}
            </button>
            <RouterLink v-else :to="`/@${handle}/${wikiSlug}/edit/${slugPreview}`" class="btn btn-primary">
              Paste it into a new page
            </RouterLink>
          </div>
          <p v-if="publishError" class="error-text">{{ publishError }}</p>

          <details class="raw" open>
            <summary>Markdown source</summary>
            <pre data-testid="import-markdown">{{ result.markdown }}</pre>
          </details>

          <h2>Preview</h2>
          <div class="preview">
            <MarkdownRenderer
              :source="result.markdown"
              :wiki-slug="wikiSlug"
              :owner-handle="handle"
            />
          </div>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.import-page {
  padding: 2rem 1.25rem 4rem;
}

.inner {
  max-width: 760px;
  margin: 0 auto;
}

header h1 {
  margin: 0.5rem 0 0.25rem;
  font-family: var(--pckt-font-content);
}

.field-label {
  display: block;
  margin: 1.25rem 0 0.35rem;
  font-size: 0.8125rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--pckt-text-muted);
}

.dropzone {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  align-items: center;
  text-align: center;
  margin-top: 1.25rem;
  padding: 1.5rem 1rem;
  border: 2px dashed var(--pckt-border);
  border-radius: var(--pckt-radius-sm);
  background: var(--pckt-bg-elevated);
  cursor: pointer;
}

.dropzone:hover,
.dropzone:focus-visible,
.dropzone.dragging {
  border-color: var(--pckt-accent);
}

.dropzone.busy {
  opacity: 0.7;
  cursor: progress;
}

.dropzone .muted {
  font-size: 0.8125rem;
}

.file-input {
  display: none;
}

.zim-panel {
  margin-top: 1rem;
  padding: 0.9rem 1rem;
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-sm);
  background: var(--pckt-bg-elevated);
}

.zim-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  font-size: 0.875rem;
}

.zim-list {
  list-style: none;
  margin: 0.5rem 0 0;
  padding: 0;
  max-height: 22rem;
  overflow: auto;
}

.zim-article {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.1rem;
  width: 100%;
  padding: 0.4rem 0.5rem;
  border: none;
  border-bottom: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-sm);
  background: transparent;
  color: var(--pckt-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.zim-article:hover:not(:disabled),
.zim-article:focus-visible {
  background: var(--pckt-bg-muted);
}

.zim-article:disabled {
  cursor: progress;
}

.zim-article .muted {
  font-size: 0.75rem;
}

.zim-empty {
  margin: 0.5rem 0 0;
  font-size: 0.8125rem;
}

.import-input,
.title-input {
  width: 100%;
  box-sizing: border-box;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-btn);
  background: var(--pckt-bg-elevated);
  color: var(--pckt-text);
  font: inherit;
}

.import-input {
  resize: vertical;
  font-family: var(--pckt-font-mono);
  font-size: 0.85rem;
}

.actions {
  margin-top: 0.75rem;
  display: flex;
  gap: 0.5rem;
}

.result {
  margin-top: 1.5rem;
  border-top: 1px solid var(--pckt-border);
  padding-top: 0.5rem;
}

.result-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0.9rem 0;
}

.image-note,
.warnings {
  margin: 0.5rem 0 0;
  font-size: 0.8125rem;
}

.warnings {
  padding-left: 1.25rem;
}

.raw {
  margin: 0.9rem 0;
}

.raw summary {
  cursor: pointer;
  color: var(--pckt-text-muted);
  font-size: 0.875rem;
}

.raw pre {
  max-height: 20rem;
  overflow: auto;
  padding: 0.75rem;
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-sm);
  background: var(--pckt-bg-elevated);
  font-size: 0.8rem;
  white-space: pre-wrap;
  word-break: break-word;
}

.result h2 {
  margin: 1.25rem 0 0.5rem;
  font-family: var(--pckt-font-content);
}

.preview {
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-sm);
  padding: 0.25rem 1rem;
  background: var(--pckt-bg-elevated);
}

.error-text {
  color: var(--pckt-red);
  margin: 0.5rem 0 0;
}
</style>
