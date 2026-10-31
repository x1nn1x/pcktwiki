<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useLichenStore } from '@/stores/lichen'
import { defaultHomeContent } from '@/lib/lichen/default-home'

const auth = useAuthStore()
const lichen = useLichenStore()
const router = useRouter()

const name = ref('')
const description = ref('')
const language = ref('en')
const visibility = ref<'public' | 'private'>('public')
const starter = ref<'blank' | 'fiction' | 'community' | 'fan'>('blank')
const saving = ref(false)
const importError = ref('')
const importInput = ref<HTMLInputElement | null>(null)

/** Starter packs: a few seeded pages so a new wiki is never an empty room. */
const STARTERS: Record<
  Exclude<typeof starter.value, 'blank'>,
  Array<{ slug: string; title: string; body: string }>
> = {
  fiction: [
    {
      slug: 'characters',
      title: 'Characters',
      body: '# Characters\n\nA cast list for your world.\n\n## Major characters\n\n- [[character-name]] — one line about them\n\n## Minor characters\n\n- \n\n[[Category:Meta]]',
    },
    {
      slug: 'locations',
      title: 'Locations',
      body: '# Locations\n\nEvery place worth a page.\n\n- [[place-name]] — one line about it\n\n[[Category:Meta]]',
    },
    {
      slug: 'timeline',
      title: 'Timeline',
      body: '# Timeline\n\nWhat happened, in order.\n\n- **Day 1** — the first event\n\n[[Category:Meta]]',
    },
  ],
  community: [
    {
      slug: 'about',
      title: 'About',
      body: '# About\n\nWhat this community is about, in a paragraph.\n\n[[Category:Meta]]',
    },
    {
      slug: 'rules',
      title: 'Rules',
      body: '# Rules\n\n1. Be kind.\n2. Cite sources where you can.\n3. Disagree with ideas, not people.\n\n[[Category:Meta]]',
    },
    {
      slug: 'news',
      title: 'News',
      body: '# News\n\nWhat changed lately — new pages, decisions, events.\n\n[[Category:Meta]]',
    },
  ],
  fan: [
    {
      slug: 'episodes',
      title: 'Episodes',
      body: '# Episodes\n\nOne page per episode or chapter.\n\n- [[episode-1]] — first airing, key moments\n\n[[Category:Meta]]',
    },
    {
      slug: 'cast',
      title: 'Cast',
      body: '# Cast\n\nEveryone on screen, minor or major.\n\n- [[character-name]] — played by, first appearance\n\n[[Category:Meta]]',
    },
    {
      slug: 'lore',
      title: 'Lore',
      body: '# Lore\n\nThe world behind the story.\n\n- [[lore-entry]] — what fans agree on, what they debate\n\n[[Category:Meta]]',
    },
  ],
}

async function createWiki() {
  if (!name.value.trim()) return
  saving.value = true
  importError.value = ''
  try {
    if (!auth.agent) {
      const { createDraftWiki } = await import('@/lib/offline/draft-wiki')
      const draft = await createDraftWiki(name.value.trim(), language.value)
      router.push(`/draft/${draft.id}/home`)
      return
    }

    const wiki = await lichen.createWiki(
      auth.agent,
      name.value.trim(),
      language.value,
      visibility.value,
      description.value.trim(),
      defaultHomeContent(name.value.trim()),
    )

    // Seed the starter pages (best-effort — the wiki exists either way).
    const starterPages = starter.value === 'blank' ? [] : STARTERS[starter.value]
    for (const page of starterPages) {
      await lichen
        .createNoteWithSlug(
          auth.agent,
          page.slug,
          page.title,
          page.body,
          'Starter page',
        )
        .catch(() => {})
    }

    router.push(`/@${auth.handle}/${wiki.slug}`)
  } finally {
    saving.value = false
  }
}

/**
 * Track the imported wiki as a fork of the one the bundle came from. Off by
 * default so restoring your own backup does not gain an upstream.
 */
const trackAsFork = ref(false)

function pickImportFile() {
  importError.value = ''
  importInput.value?.click()
}

async function importWiki(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !auth.agent) return
  saving.value = true
  importError.value = ''
  try {
    await lichen.loadOwnerWikis(auth.agent)
    const { parseWikiZip } = await import('@/lib/export/wiki-bundle')
    const { importWikiBundle } = await import('@/lib/export/wiki-import')
    const bundle = await parseWikiZip(file)
    const result = await importWikiBundle(
      auth.agent,
      bundle,
      lichen.wikis.map((w) => w.slug),
      { trackAsFork: trackAsFork.value },
    )
    router.push(`/@${auth.handle}/${result.slug}`)
  } catch (err) {
    importError.value = err instanceof Error ? err.message : 'Could not import wiki'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="create-page">
    <div class="create-inner">
      <header class="create-header">
        <h1>Create wiki</h1>
        <p class="muted">
          <template v-if="auth.isAuthenticated">
            Creates <code>wiki.lichen.wiki</code> + home article + admin membership on your PDS.
          </template>
          <template v-else>
            Start locally without signing in, or sign in to publish directly to your PDS.
          </template>
        </p>
      </header>

      <form class="create-workspace card" @submit.prevent="createWiki">
        <div class="create-meta">
          <div class="field create-meta-name">
            <label class="label" for="name">Wiki name</label>
            <input id="name" v-model="name" class="input" type="text" required />
          </div>

          <div class="field create-meta-description">
            <label class="label" for="description">Description</label>
            <textarea id="description" v-model="description" class="textarea" rows="2" />
          </div>

          <div class="field">
            <label class="label" for="language">Language</label>
            <select id="language" v-model="language" class="select">
              <option value="en">English</option>
              <option value="fr">Français</option>
              <option value="ja">日本語</option>
            </select>
          </div>

          <div class="field">
            <label class="label" for="starter">Start from</label>
            <select id="starter" v-model="starter" class="select">
              <option value="blank">Blank — just a home page</option>
              <option value="fiction">Fiction world — characters, locations, timeline</option>
              <option value="community">Community — about, rules, news</option>
              <option value="fan">Fan wiki — episodes, cast, lore</option>
            </select>
            <p class="muted field-note">
              Starter pages are seeded with outlines you can rewrite — they're yours.
            </p>
          </div>

          <div class="field">
            <label class="label" for="visibility">Visibility</label>
            <select id="visibility" v-model="visibility" class="select">
              <option value="public">Public</option>
              <option value="private">Unlisted</option>
            </select>
            <p class="muted field-note">
              Unlisted hides a wiki in the app but does not encrypt it — its records stay
              readable in your PDS repo. Don't put anything secret in a wiki.
            </p>
          </div>
        </div>

        <footer class="create-workspace-footer">
          <div class="create-formatting-help" />
          <button type="submit" class="btn btn-primary" :disabled="saving || !name.trim()">
            {{
              saving
                ? 'Creating…'
                : auth.isAuthenticated
                  ? 'Create wiki'
                  : 'Start locally'
            }}
          </button>
        </footer>
      </form>

      <section v-if="auth.isAuthenticated" class="import-card card">
        <div class="import-copy">
          <h2>Restore from export</h2>
          <p class="muted">
            Import a full <code>.pcktwiki.zip</code> backup (pages, images, and navigation)
            from this or another account.
          </p>
          <label class="import-fork">
            <input v-model="trackAsFork" type="checkbox" :disabled="saving" />
            <span>
              Track as a fork of the original
              <small class="muted">
                Keeps a link to the wiki this backup came from so you can pull in its
                later changes. Leave off when restoring your own backup.
              </small>
            </span>
          </label>
          <p v-if="importError" class="error-text">{{ importError }}</p>
        </div>
        <div class="import-actions">
          <input
            ref="importInput"
            type="file"
            accept=".zip,.pcktwiki.zip,application/zip"
            hidden
            @change="importWiki"
          />
          <button
            type="button"
            class="btn btn-secondary"
            :disabled="saving"
            @click="pickImportFile"
          >
            {{ saving ? 'Importing…' : 'Import full backup' }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.field-note {
  margin: 0.375rem 0 0;
  font-size: 0.75rem;
  line-height: 1.5;
}

.create-page {
  padding: 2rem 1.25rem 4rem;
}

.create-inner {
  max-width: 1100px;
  margin: 0 auto;
  display: grid;
  gap: 1rem;
}

.create-header {
  margin-bottom: 0.25rem;
}

.create-header h1 {
  margin: 0 0 0.25rem;
  font-family: var(--pckt-font-content);
}

.create-header p {
  margin: 0;
}

.create-workspace {
  display: grid;
  gap: 0;
  padding: 0;
  overflow: hidden;
}

.create-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem 1rem;
  padding: 1.125rem 1.25rem;
  background: var(--pckt-bg-muted);
  border-bottom: 1px solid var(--pckt-border);
}

.create-meta-name,
.create-meta-description {
  grid-column: 1 / -1;
}

@media (max-width: 560px) {
  .create-meta {
    grid-template-columns: 1fr;
  }
}

.create-workspace-footer {
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  gap: 1rem;
  padding: 1rem 1.25rem 1.25rem;
}

.import-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1.125rem 1.25rem;
  flex-wrap: wrap;
}

.import-copy h2 {
  margin: 0 0 0.25rem;
  font-size: 1rem;
}

.import-copy p {
  margin: 0;
}

.import-fork {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
  margin-top: 0.625rem;
  font-size: 0.875rem;
  line-height: 1.4;
}

.import-fork small {
  display: block;
}

.import-copy .error-text {
  margin-top: 0.5rem;
}

.import-actions {
  flex-shrink: 0;
}
</style>
