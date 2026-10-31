<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { getPublicAgent } from '@/lib/atproto/auth'
import { listWikis } from '@/lib/atproto/lichen'
import {
  forkDockButton,
  getDockButton,
  linkDockItem,
  resolveDockButtonArt,
  type ResolvedDockButton,
} from '@/lib/pckt-records'

/**
 * The share page for one dock button: /dock-button?at=<at-uri of the record>.
 * Anyone who opens a shared button link sees the art and destination here and
 * can add it to one of their own wikis — linked (stays synced with the
 * creator) or forked (copied, then fully theirs to edit).
 */
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const button = ref<ResolvedDockButton | null>(null)
const loading = ref(true)
const error = ref('')
const busy = ref(false)
const done = ref('')

const myWikis = ref<Array<{ uri: string; name: string; slug: string }>>([])
const selectedWiki = ref('')

const buttonUri = computed(() => {
  const raw = route.query.at
  return typeof raw === 'string' && raw.startsWith('at://') ? raw : null
})

async function loadButton() {
  loading.value = true
  error.value = ''
  button.value = null
  if (!buttonUri.value) {
    error.value = 'No button URI in the link.'
    loading.value = false
    return
  }
  try {
    const fetched = await getDockButton(getPublicAgent(), buttonUri.value)
    if (!fetched) {
      error.value = 'That button does not exist (or was removed by its creator).'
    } else {
      button.value = await resolveDockButtonArt(fetched)
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load the button'
  } finally {
    loading.value = false
  }
}

async function loadMyWikis() {
  if (!auth.agent) return
  try {
    const wikis = await listWikis(auth.agent, auth.agent.accountDid)
    myWikis.value = wikis
      .filter((w) => !w.deletedAt && !w.redirectSlug)
      .map((w) => ({ uri: w.uri, name: w.name, slug: w.slug }))
    if (myWikis.value.length && !selectedWiki.value) {
      selectedWiki.value = myWikis.value[0]!.uri
    }
  } catch {
    // sign-in state will show the sign-in prompt instead
  }
}

async function add(mode: 'link' | 'fork') {
  if (!auth.agent || !button.value || !selectedWiki.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    if (mode === 'link') {
      await linkDockItem(auth.agent, selectedWiki.value, button.value.uri)
      done.value = `Linked to your wiki — it stays synced with @${handleLabel.value}'s updates.`
    } else {
      await forkDockButton(auth.agent, selectedWiki.value, button.value)
      done.value = 'Forked to your wiki — the art and destination are now yours to edit in Settings → Dock buttons.'
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not add the button'
  } finally {
    busy.value = false
  }
}

const handleLabel = computed(() => {
  const did = button.value?.creatorDid ?? ''
  return did.replace(/^did:plc:/, '').slice(0, 12) || 'the creator'
})

const shareUrl = computed(() => {
  if (!button.value || typeof window === 'undefined') return ''
  return `${window.location.origin}/dock-button?at=${button.value.uri}`
})

function goHome() {
  router.push('/')
}

onMounted(() => {
  void loadButton()
  void loadMyWikis()
})
watch(buttonUri, loadButton)
</script>

<template>
  <div class="dockbtn-page">
    <div class="dockbtn-inner">
      <p v-if="loading" class="muted">Loading button…</p>
      <template v-else-if="button">
        <div class="card dockbtn-card">
          <div class="dockbtn-preview">
            <img v-if="button.artUrl" :src="button.artUrl" alt="" width="96" height="96" />
            <span class="dockbtn-label">{{ button.label }}</span>
          </div>
          <div class="dockbtn-meta">
            <h1>Dock button</h1>
            <p class="muted">
              Shared by its creator for any wiki to use. Leads to
              <code>{{ button.href }}</code
              >.
            </p>
            <p class="dockbtn-share">
              Share link:
              <code>{{ shareUrl }}</code>
            </p>
          </div>
        </div>

        <div v-if="!auth.isAuthenticated" class="card dockbtn-add">
          <p class="muted">
            <RouterLink to="/">Sign in</RouterLink> to add this button to one of your wikis.
          </p>
        </div>
        <div v-else-if="!myWikis.length" class="card dockbtn-add">
          <p class="muted">You don't have a wiki yet — create one first, then add this button.</p>
          <button type="button" class="btn btn-primary" @click="goHome">Create a wiki</button>
        </div>
        <div v-else class="card dockbtn-add">
          <h2>Add to your wiki</h2>
          <div class="dockbtn-row">
            <select v-model="selectedWiki" class="select" aria-label="Choose wiki">
              <option v-for="w in myWikis" :key="w.uri" :value="w.uri">{{ w.name }} ({{ w.slug }})</option>
            </select>
            <button type="button" class="btn btn-secondary" :disabled="busy" @click="add('link')">
              Link it
            </button>
            <button type="button" class="btn btn-primary" :disabled="busy" @click="add('fork')">
              Fork it
            </button>
          </div>
          <p class="muted dockbtn-explain">
            <strong>Link</strong> keeps it synced with the creator — their art and label updates
            flow to your dock. <strong>Fork</strong> copies the art into your wiki so you can
            edit both the design and the destination.
          </p>
          <p v-if="done" class="dockbtn-done">{{ done }}</p>
        </div>
        <p v-if="error" class="error-text">{{ error }}</p>
      </template>
      <p v-else class="error-text">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.dockbtn-page {
  padding: 2rem 1.25rem 4rem;
}

.dockbtn-inner {
  max-width: 620px;
  margin: 0 auto;
  display: grid;
  gap: 1rem;
}

.dockbtn-card {
  padding: 1.25rem;
  display: flex;
  gap: 1.25rem;
  align-items: center;
}

.dockbtn-preview {
  display: grid;
  justify-items: center;
  gap: 0.375rem;
  flex: none;
}

.dockbtn-preview img {
  width: 96px;
  height: 96px;
  object-fit: contain;
}

.dockbtn-label {
  font-size: 0.6875rem;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.12em;
}

.dockbtn-meta h1 {
  margin: 0 0 0.25rem;
  font-size: 1.125rem;
}

.dockbtn-meta p {
  margin: 0 0 0.375rem;
  font-size: 0.875rem;
}

.dockbtn-share {
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}

.dockbtn-add {
  padding: 1.25rem;
  display: grid;
  gap: 0.75rem;
}

.dockbtn-add h2 {
  margin: 0;
  font-size: 1rem;
}

.dockbtn-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}

.dockbtn-explain {
  margin: 0;
  font-size: 0.8125rem;
}

.dockbtn-done {
  margin: 0;
  font-size: 0.875rem;
  color: var(--pckt-accent, var(--pckt-red));
}

code {
  font-family: var(--pckt-font-mono);
  font-size: 0.8125em;
  overflow-wrap: anywhere;
}
</style>
