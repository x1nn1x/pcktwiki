<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useLichenStore } from '@/stores/lichen'
import { resolveWikiPolicy } from '@/lib/lichen/collab'
import type { ForumThreadAccess } from '@/types/lichen'
import { getAuthenticatedAgent, resolveHandleToDid } from '@/lib/atproto/auth'
import HandleTypeahead from '@/components/HandleTypeahead.vue'
import type { PageGrantRole, WikiEditAccess, WikiImageMode } from '@/types/lichen'

/**
 * Wiki settings for collaboration: who can contribute, whether edits land in
 * an approval queue, the photo ladder, per-article grants, and the
 * approved-photo registry. Everything here writes `wiki.pckt.*` records to
 * the wiki owner's repo.
 */
const lichen = useLichenStore()

const wikiRef = computed(() => lichen.currentWiki?.uri ?? '')

// --- Policy ---------------------------------------------------------------

const editAccess = ref<WikiEditAccess>('members')
const suggestionsEnabled = ref(true)
const imageMode = ref<WikiImageMode>('any')
const imageSubmissions = ref(false)
const forumEnabled = ref(true)
const forumThreads = ref<ForumThreadAccess>('anyone')
const forumMods = ref<string[]>([])
const modHandle = ref('')
const modError = ref('')
const policySaved = ref(false)
const policySaving = ref(false)
const policyError = ref('')

watch(
  wikiRef,
  () => {
    const resolved = resolveWikiPolicy(lichen.policyRecord)
    editAccess.value = resolved.editAccess
    suggestionsEnabled.value = resolved.suggestionsEnabled
    imageMode.value = resolved.imageMode
    imageSubmissions.value = resolved.imageSubmissions
    forumEnabled.value = resolved.forumEnabled
    forumThreads.value = resolved.forumThreads
    forumMods.value = [...resolved.forumMods]
    policySaved.value = false
  },
  { immediate: true },
)

async function savePolicy() {
  const agent = await agentForWrite()
  if (!agent) return
  policySaving.value = true
  policyError.value = ''
  try {
    await lichen.setWikiPolicy(agent, {
      editAccess: editAccess.value,
      suggestionsEnabled: suggestionsEnabled.value,
      imageMode: imageMode.value,
      imageSubmissions: imageSubmissions.value,
      forumEnabled: forumEnabled.value,
      forumThreads: forumThreads.value,
      forumMods: [...forumMods.value],
    })
    policySaved.value = true
    setTimeout(() => {
      policySaved.value = false
    }, 2000)
  } catch (err) {
    policyError.value = err instanceof Error ? err.message : 'Could not save the policy'
  } finally {
    policySaving.value = false
  }
}

// --- Page grants ----------------------------------------------------------

const grantHandle = ref('')
const grantSlug = ref('')
const grantRole = ref<PageGrantRole>('suggester')
const grantError = ref('')
const grantSaving = ref(false)

const wikiGrants = computed(() =>
  lichen.pageGrants.filter((item) => item.wikiRef === wikiRef.value),
)

const articleSlugs = computed(() =>
  lichen.notes
    .filter((note) => !note.slug.startsWith('branch:'))
    .map((note) => note.slug)
    .sort((a, b) => a.localeCompare(b)),
)

async function agentForWrite() {
  // SettingsPage only mounts this for wikis the signed-in user manages; the
  // store actions write through the wiki owner's repo, which only the
  // owner's session can actually reach.
  return getAuthenticatedAgent()
}

async function addMod() {
  const agent = await agentForWrite()
  const raw = modHandle.value.trim()
  if (!agent || !raw) return
  modError.value = ''
  try {
    const did = raw.startsWith('did:') ? raw : await resolveHandleToDid(raw)
    if (forumMods.value.includes(did)) {
      modError.value = 'Already a mod'
      return
    }
    forumMods.value = [...forumMods.value, did]
    modHandle.value = ''
    await savePolicy()
  } catch (err) {
    modError.value = err instanceof Error ? err.message : 'Could not add the mod'
  }
}

async function removeMod(did: string) {
  forumMods.value = forumMods.value.filter((m) => m !== did)
  await savePolicy()
}

async function addGrant() {
  const agent = await agentForWrite()
  if (!agent || !grantHandle.value.trim() || !grantSlug.value.trim()) return
  grantSaving.value = true
  grantError.value = ''
  try {
    const did = grantHandle.value.trim().startsWith('did:')
      ? grantHandle.value.trim()
      : await resolveHandleToDid(grantHandle.value.trim())
    await lichen.addPageGrant(agent, grantSlug.value.trim(), did, grantRole.value)
    grantHandle.value = ''
    grantSlug.value = ''
  } catch (err) {
    grantError.value = err instanceof Error ? err.message : 'Could not add the grant'
  } finally {
    grantSaving.value = false
  }
}

async function removeGrant(uri: string) {
  const agent = await agentForWrite()
  if (!agent) return
  if (!confirm('Remove this article grant?')) return
  await lichen.removePageGrant(agent, uri)
}

// --- Approved media -------------------------------------------------------

const mediaError = ref('')

async function removeMedia(uri: string) {
  const agent = await agentForWrite()
  if (!agent) return
  if (!confirm('Remove this photo from the approved library?')) return
  mediaError.value = ''
  try {
    await lichen.removeApprovedMedia(agent, uri)
  } catch (err) {
    mediaError.value = err instanceof Error ? err.message : 'Could not remove the photo'
  }
}
</script>

<template>
  <section class="card section">
    <h2>Collaboration</h2>
    <p class="muted">
      Stored as <code>wiki.pckt.policy</code>. People outside the owner’s account always
      contribute by suggestion — their edits land in the review queue
      (<RouterLink :to="`/@${lichen.ownerHandle}/${lichen.currentWiki?.slug}/suggestions`">
        Suggested edits</RouterLink>) and nothing publishes until approved.
    </p>

    <div class="field">
      <label class="label" for="collab-edit-access">Who can propose edits?</label>
      <select id="collab-edit-access" v-model="editAccess" class="select">
        <option value="members">Members only</option>
        <option value="followers">Members, plus people I follow</option>
        <option value="anyone">Anyone signed in</option>
      </select>
    </div>

    <div class="field">
      <label class="check">
        <input v-model="suggestionsEnabled" type="checkbox" />
        <span>
          Allow edit-on-approval (suggested edits)
          <span class="muted">— off means only members you approved can propose anything</span>
        </span>
      </label>
    </div>

    <div class="field">
      <label class="label" for="collab-image-mode">Photos contributors can add</label>
      <select id="collab-image-mode" v-model="imageMode" class="select">
        <option value="any">Any photo — upload freely</option>
        <option value="approved">Approved photos only</option>
        <option value="none">Text only — no photos</option>
      </select>
    </div>

    <div class="field">
      <label class="check">
        <input v-model="imageSubmissions" type="checkbox" />
        <span>
          Accept photo submissions
          <span class="muted">— contributors can send photos for your approval</span>
        </span>
      </label>
    </div>

    <button type="button" class="btn btn-primary" :disabled="policySaving" @click="savePolicy">
      {{ policySaving ? 'Saving…' : policySaved ? 'Saved!' : 'Save collaboration policy' }}
    </button>
    <p v-if="policyError" class="error-text">{{ policyError }}</p>
  </section>

  <section class="card section">
    <h2>Forum</h2>
    <p class="muted">
      Discussions run on Bluesky threads anchored to this wiki. Mods can hide any topic or
      reply from this wiki's forum — the posts themselves stay on Bluesky.
    </p>

    <div class="field">
      <label class="check">
        <input v-model="forumEnabled" type="checkbox" />
        <span>Forum enabled <span class="muted">— off closes it to everyone</span></span>
      </label>
    </div>

    <div class="field">
      <label class="label" for="forum-threads">Who can start new discussions</label>
      <select id="forum-threads" v-model="forumThreads" class="select">
        <option value="anyone">Anyone signed in</option>
        <option value="permitted">Members and mods only — others can still reply</option>
      </select>
    </div>

    <div class="field">
      <label class="label" for="forum-mod">Forum mods (can hide posts)</label>
      <HandleTypeahead
        id="forum-mod"
        v-model="modHandle"
        placeholder="@friend.bsky.social"
        @select="addMod"
      />
      <ul v-if="forumMods.length" class="member-list">
        <li v-for="did in forumMods" :key="did">
          <code class="member-id">{{ did }}</code>
          <button type="button" class="btn btn-ghost btn-sm" @click="removeMod(did)">
            Remove
          </button>
        </li>
      </ul>
      <p v-if="modError" class="error-text">{{ modError }}</p>
    </div>

    <button type="button" class="btn btn-secondary" :disabled="policySaving" @click="savePolicy">
      {{ policySaving ? 'Saving…' : 'Save forum settings' }}
    </button>
  </section>

  <section class="card section">
    <h2>Article permissions</h2>
    <p class="muted">
      Per-article grants (<code>wiki.pckt.pageGrant</code>) override the wiki-wide policy for
      one person on one page. Article admins also review that page’s suggestions.
    </p>

    <ul v-if="wikiGrants.length" class="member-list">
      <li v-for="grant in wikiGrants" :key="grant.uri">
        <code class="member-id">{{ grant.memberDid }}</code>
        <span class="grant-slug">{{ grant.noteSlug }}</span>
        <span class="grant-role">{{ grant.role }}</span>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          @click="removeGrant(grant.uri)"
        >
          Remove
        </button>
      </li>
    </ul>
    <p v-else class="muted">No per-article grants yet.</p>

    <div class="grant-form">
      <div class="field">
        <label class="label" for="grant-handle">Member handle or DID</label>
        <HandleTypeahead
          id="grant-handle"
          v-model="grantHandle"
          placeholder="@friend.bsky.social"
          @select="addGrant"
        />
      </div>
      <div class="field">
        <label class="label" for="grant-slug">Article</label>
        <input
          id="grant-slug"
          v-model="grantSlug"
          class="input"
          type="text"
          list="grant-article-slugs"
          placeholder="castle"
          autocomplete="off"
          spellcheck="false"
        />
        <datalist id="grant-article-slugs">
          <option v-for="slug in articleSlugs" :key="slug" :value="slug" />
        </datalist>
      </div>
      <div class="field">
        <label class="label" for="grant-role">Role on that article</label>
        <select id="grant-role" v-model="grantRole" class="select">
          <option value="admin">Admin — review its suggestions</option>
          <option value="editor">Editor — propose with photo rights</option>
          <option value="suggester">Suggester — propose text-only edits</option>
          <option value="viewer">Viewer — read this article</option>
        </select>
      </div>
      <button
        type="button"
        class="btn btn-secondary"
        :disabled="grantSaving"
        @click="addGrant"
      >
        Add grant
      </button>
    </div>
    <p v-if="grantError" class="error-text">{{ grantError }}</p>
  </section>

  <section class="card section">
    <h2>Approved photos</h2>
    <p class="muted">
      Photos contributors may embed when the policy is “approved photos only”. Approving a
      photo submission adds it here automatically; removing one blocks new embeds.
    </p>

    <p v-if="!lichen.approvedMedia.length" class="muted">No approved photos yet.</p>
    <ul v-else class="media-list">
      <li v-for="media in lichen.approvedMedia" :key="media.uri">
        <code class="member-id">{{ media.alt || media.imageCid }}</code>
        <span class="muted">{{ media.source === 'submission' ? 'from a submission' : 'added by you' }}</span>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          @click="removeMedia(media.uri)"
        >
          Remove
        </button>
      </li>
    </ul>
    <p v-if="mediaError" class="error-text">{{ mediaError }}</p>
  </section>
</template>

<style scoped>
.section {
  padding: 1.25rem;
}

.section h2 {
  margin: 0 0 1rem;
  font-size: 1rem;
}

.section > p {
  margin: 0 0 1rem;
  font-size: 0.875rem;
}

.field {
  margin-bottom: 0.875rem;
}

.check {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  font-size: 0.875rem;
}

.check input {
  margin-top: 0.15rem;
}

.member-list {
  list-style: none;
  margin: 0 0 1rem;
  padding: 0;
}

.member-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--pckt-border);
  font-size: 0.875rem;
}

.member-id {
  flex: 1 1 10rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--pckt-font-mono);
  font-size: 0.8125em;
}

.grant-slug,
.grant-role {
  color: var(--pckt-text-muted);
  font-size: 0.8125rem;
}

.grant-role {
  text-transform: capitalize;
}

.grant-form {
  display: grid;
  gap: 0;
}

code {
  font-size: 0.8125em;
}
</style>
