<script setup lang="ts">
import { appUrl } from '@/lib/base-url'
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useLichenStore } from '@/stores/lichen'
import { loadWikiByHandle } from '@/lib/atproto/wiki-loader'
import { normalizeHandle } from '@/lib/config'
import { resolveHandleToDid } from '@/lib/atproto/auth'
import ThemeEditor from '@/components/ThemeEditor.vue'
import WikiHeaderImageEditor from '@/components/WikiHeaderImageEditor.vue'
import WikiMediaLibrary from '@/components/WikiMediaLibrary.vue'
import HandleTypeahead from '@/components/HandleTypeahead.vue'
import CollaborationSettings from '@/components/settings/CollaborationSettings.vue'
import DockButtonsSettings from '@/components/settings/DockButtonsSettings.vue'
import { downloadWikiExport } from '@/lib/export/wiki-bundle'
import WikiImportButton from '@/components/WikiImportButton.vue'
import { applyWikiTheme, loadLocalTheme, saveLocalTheme, themeFromWiki } from '@/lib/theme'
import { useThemeMode } from '@/composables/useThemeMode'
import type { LichenMemberRequestRecord, MemberRole, PcktTheme } from '@/types/lichen'
import { canManage } from '@/lib/lichen/collections'
import { isValidSlug } from '@/lib/atproto/lichen'
import {
  approveMemberRequest,
  denyMemberRequest,
  listIncomingMemberRequests,
} from '@/lib/lichen/member-requests'

const auth = useAuthStore()
const lichen = useLichenStore()
const route = useRoute()
const router = useRouter()
const { syncFromStorage } = useThemeMode()

const handle = computed(() => normalizeHandle(route.params.handle as string))
const wikiSlug = computed(() => route.params.wikiSlug as string)
const visibility = ref<'public' | 'private'>('public')
const memberHandle = ref('')
const memberRole = ref<MemberRole>('viewer')
const theme = ref<PcktTheme>(loadLocalTheme())
const saved = ref(false)
const memberError = ref('')
const inviteCopied = ref(false)
const pendingRequests = ref<LichenMemberRequestRecord[]>([])
const requestsLoading = ref(false)
const requestRole = ref<MemberRole>('contributor')

const canManageWiki = computed(() => canManage(lichen.access))
const isOwner = computed(
  () => !!auth.did && !!lichen.currentWiki && lichen.currentWiki.ownerDid === auth.did,
)
const wikiMembers = computed(() =>
  lichen.memberships.filter((m) => m.wikiRef === lichen.currentWiki?.uri),
)

const deleteExpanded = ref(false)
const deleteConfirmText = ref('')
const deleting = ref(false)
const deleteError = ref('')

const purgeExpanded = ref(false)
const purgeConfirmText = ref('')
const purging = ref(false)
const purgeError = ref('')

const deleteConfirmTarget = computed(() => lichen.currentWiki?.name ?? '')
const canConfirmDelete = computed(
  () =>
    !!deleteConfirmTarget.value &&
    deleteConfirmText.value.trim() === deleteConfirmTarget.value,
)
const canConfirmPurge = computed(
  () =>
    !!deleteConfirmTarget.value &&
    purgeConfirmText.value.trim() === deleteConfirmTarget.value,
)

const slugExpanded = ref(false)
const newSlug = ref('')
const slugConfirmText = ref('')
const renamingSlug = ref(false)
const slugError = ref('')

const slugConfirmTarget = computed(() => lichen.currentWiki?.slug ?? '')
const normalizedNewSlug = computed(() => newSlug.value.trim().toLowerCase())
const canConfirmSlugChange = computed(() => {
  const next = normalizedNewSlug.value
  const current = slugConfirmTarget.value
  return (
    !!current &&
    !!next &&
    next !== current &&
    isValidSlug(next) &&
    slugConfirmText.value.trim() === current
  )
})
const previewPath = computed(() =>
  auth.handle && normalizedNewSlug.value
    ? `/@${auth.handle}/${normalizedNewSlug.value}`
    : '',
)

const inviteUrl = computed(() => {
  if (!lichen.currentWiki || typeof window === 'undefined') return ''
  const url = new URL(appUrl(`/@${handle.value}/${wikiSlug.value}`))
  url.searchParams.set('invite', lichen.currentWiki.uri)
  return url.toString()
})

async function refreshRequests() {
  if (!auth.agent || !lichen.currentWiki || !canManageWiki.value) return
  requestsLoading.value = true
  try {
    pendingRequests.value = await listIncomingMemberRequests(auth.agent, lichen.currentWiki.uri)
  } catch {
    pendingRequests.value = []
  } finally {
    requestsLoading.value = false
  }
}

onMounted(async () => {
  if (!auth.agent) {
    router.replace('/')
    return
  }

  const did = await loadWikiByHandle(lichen, {
    handle: handle.value,
    wikiSlug: wikiSlug.value,
    viewerDid: auth.did,
    authAgent: auth.agent,
  })
  if (!did) return

  if (lichen.currentWiki) {
    visibility.value = lichen.currentWiki.visibility
    // Wiki-level presentation wins over the viewer's local defaults.
    const wiki = lichen.currentWiki
    theme.value = {
      ...loadLocalTheme(),
      ...themeFromWiki(wiki),
    }
  }
  applyWikiTheme(theme.value)
  await refreshRequests()
})

async function saveVisibility() {
  if (!auth.agent || !canManageWiki.value) return
  await lichen.setWikiVisibility(auth.agent, visibility.value)
  saved.value = true
  setTimeout(() => { saved.value = false }, 2000)
}

async function resolveMemberDid(input: string): Promise<string> {
  const trimmed = input.trim()
  if (trimmed.startsWith('did:')) return trimmed
  return resolveHandleToDid(trimmed)
}

async function addMember() {
  if (!auth.agent || !memberHandle.value.trim() || !canManageWiki.value) return
  memberError.value = ''
  try {
    const did = await resolveMemberDid(memberHandle.value)
    await lichen.addMember(auth.agent, did, memberRole.value)
    memberHandle.value = ''
  } catch (err) {
    memberError.value = err instanceof Error ? err.message : 'Could not add member'
  }
}

async function changeRole(uri: string, role: MemberRole) {
  if (!auth.agent || !canManageWiki.value) return
  await lichen.updateMemberRole(auth.agent, uri, role)
}

async function removeMember(uri: string) {
  if (!auth.agent || !canManageWiki.value) return
  if (!confirm('Remove this member?')) return
  await lichen.removeMember(auth.agent, uri)
}

async function approveRequest(request: LichenMemberRequestRecord) {
  if (!auth.agent || !lichen.currentWiki) return
  const membership = await approveMemberRequest(
    auth.agent,
    request,
    requestRole.value,
    lichen.currentWiki.ownerDid,
  )
  const exists = lichen.memberships.some((m) => m.uri === membership.uri)
  if (!exists) {
    lichen.memberships.push(membership)
  }
  pendingRequests.value = pendingRequests.value.filter((item) => item.uri !== request.uri)
}

async function denyRequest(request: LichenMemberRequestRecord) {
  await denyMemberRequest(request)
  pendingRequests.value = pendingRequests.value.filter((item) => item.uri !== request.uri)
}

async function copyInvite() {
  if (!inviteUrl.value) return
  await navigator.clipboard.writeText(inviteUrl.value)
  inviteCopied.value = true
  setTimeout(() => { inviteCopied.value = false }, 2000)
}

// --- Custom domain wizard --------------------------------------------------

const domainInput = ref('')
const dnsChecking = ref(false)
const dnsResults = ref<Array<{ label: string; ok: boolean; detail: string }> | null>(null)
const GITHUB_PAGES_IPS = ['185.199.108.153', '185.199.109.153', '185.199.110.153', '185.199.111.153']

async function dohQuery(name: string, type: string): Promise<{ Answer?: Array<{ type: number; data: string }> }> {
  const response = await fetch(
    `https://mozilla.cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
    { headers: { accept: 'application/dns-json' } },
  )
  if (!response.ok) throw new Error(`DNS lookup failed (${response.status})`)
  return response.json()
}

async function checkDomainDns() {
  const domain = domainInput.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!domain) return
  dnsChecking.value = true
  dnsResults.value = null
  try {
    const [apex, www] = await Promise.all([
      dohQuery(domain, 'A'),
      dohQuery(`www.${domain}`, 'CNAME').catch(() => ({}) as { Answer?: Array<{ type: number; data: string }> }),
    ])
    const aIps = (apex.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data)
    const aOk = GITHUB_PAGES_IPS.some((ip) => aIps.includes(ip))
    const cnames = (www.Answer ?? []).filter((a) => a.type === 5).map((a) => a.data)
    const cnameOk = cnames.some((d) => /\.github\.io\.?$/i.test(d))
    dnsResults.value = [
      {
        label: `${domain} points at GitHub Pages`,
        ok: aOk,
        detail: aIps.length ? aIps.join(', ') : 'no A records found',
      },
      {
        label: `www.${domain} points at your github.io page`,
        ok: cnameOk,
        detail: cnames.length ? cnames.join(', ') : 'no CNAME record found',
      },
    ]
  } catch (err) {
    dnsResults.value = [
      { label: 'DNS lookup', ok: false, detail: err instanceof Error ? err.message : 'failed' },
    ]
  } finally {
    dnsChecking.value = false
  }
}

async function exportWiki() {
  if (!lichen.currentWiki) return
  await downloadWikiExport(lichen.currentWiki, lichen.notes, lichen.revisions, {
    ownerHandle: handle.value,
  })
}

async function saveTheme() {
  saveLocalTheme(theme.value)
  applyWikiTheme(theme.value)
  syncFromStorage()
  if (auth.agent && canManageWiki.value && lichen.currentWiki) {
    const mode = theme.value.mode
    // 'auto' is the absence of a wiki-level preference: viewers keep their own.
    await lichen.setWikiTheme(auth.agent, {
      theme: mode === 'light' || mode === 'dark' ? mode : undefined,
      accentColor: theme.value.accentColor,
      bgColor: theme.value.bgColor,
      cardColor: theme.value.cardColor,
      sidebarColor: theme.value.sidebarColor,
      headerColor: theme.value.headerColor,
      fontFamily: theme.value.fontFamily,
      layoutWidth: theme.value.layoutWidth,
    })
  }
  saved.value = true
  setTimeout(() => { saved.value = false }, 2000)
}

function toggleDeleteSection() {
  deleteExpanded.value = !deleteExpanded.value
  deleteConfirmText.value = ''
  deleteError.value = ''
  if (deleteExpanded.value) {
    purgeExpanded.value = false
    purgeConfirmText.value = ''
    purgeError.value = ''
  }
}

function togglePurgeSection() {
  purgeExpanded.value = !purgeExpanded.value
  purgeConfirmText.value = ''
  purgeError.value = ''
  if (purgeExpanded.value) {
    deleteExpanded.value = false
    deleteConfirmText.value = ''
    deleteError.value = ''
  }
}

function toggleSlugSection() {
  slugExpanded.value = !slugExpanded.value
  newSlug.value = ''
  slugConfirmText.value = ''
  slugError.value = ''
}

async function changeWikiSlug() {
  if (!auth.agent || !isOwner.value || !canConfirmSlugChange.value || renamingSlug.value) return
  renamingSlug.value = true
  slugError.value = ''
  try {
    const wiki = await lichen.renameCurrentWikiSlug(auth.agent, normalizedNewSlug.value)
    slugExpanded.value = false
    await router.replace(`/@${handle.value}/${wiki.slug}/settings`)
  } catch (err) {
    slugError.value = err instanceof Error ? err.message : 'Could not change wiki URL'
  } finally {
    renamingSlug.value = false
  }
}

async function deleteWiki() {
  if (!auth.agent || !isOwner.value || !canConfirmDelete.value || deleting.value) return
  deleting.value = true
  deleteError.value = ''
  try {
    await lichen.deleteCurrentWiki(auth.agent)
    router.replace('/dashboard')
  } catch (err) {
    deleteError.value = err instanceof Error ? err.message : 'Could not delete wiki'
  } finally {
    deleting.value = false
  }
}

async function purgeWikiNow() {
  if (!auth.agent || !lichen.currentWiki || !isOwner.value || !canConfirmPurge.value || purging.value) {
    return
  }
  purging.value = true
  purgeError.value = ''
  try {
    await lichen.purgeWiki(auth.agent, lichen.currentWiki)
    router.replace('/dashboard')
  } catch (err) {
    purgeError.value = err instanceof Error ? err.message : 'Could not permanently delete wiki'
  } finally {
    purging.value = false
  }
}
</script>

<template>
  <div class="settings-page">
    <div class="settings-inner">
      <header>
        <h1>Wiki settings</h1>
        <p class="muted">{{ wikiSlug }} · Lichen access control &amp; display</p>
      </header>

      <section v-if="canManageWiki" class="card section">
        <h2>Visibility</h2>
        <div class="field">
          <label class="label" for="visibility">Who sees this wiki in the app?</label>
          <select id="visibility" v-model="visibility" class="select">
            <option value="public">Public — listed and readable by anyone</option>
            <option value="private">Unlisted — hidden inside pckt.wiki</option>
          </select>
        </div>
        <p class="muted visibility-note">
          Unlisted hides the wiki from listings and from readers who are not members. It is
          not encryption: pages and their edit history live as records in your PDS repo,
          which anyone can fetch directly. Treat every wiki as public, and keep secrets out.
        </p>
        <button type="button" class="btn btn-primary" @click="saveVisibility">
          Save visibility
        </button>
      </section>

      <section v-if="canManageWiki" class="card section">
        <h2>Members</h2>
        <p class="muted">Invite by handle or DID. Memberships are stored as <code>wiki.lichen.membership</code>.</p>

        <div class="invite-row">
          <button type="button" class="btn btn-secondary btn-sm" @click="copyInvite">
            {{ inviteCopied ? 'Invite link copied' : 'Copy invite link' }}
          </button>
        </div>

        <ul class="member-list">
          <li v-for="member in wikiMembers" :key="member.uri">
            <code class="member-id">{{ member.memberDid }}</code>
            <select
              class="select select-sm"
              :value="member.role"
              @change="changeRole(member.uri, ($event.target as HTMLSelectElement).value as MemberRole)"
            >
              <option value="admin">Admin</option>
              <option value="contributor">Contributor</option>
              <option value="viewer">Viewer</option>
            </select>
            <button type="button" class="btn btn-ghost btn-sm" @click="removeMember(member.uri)">
              Remove
            </button>
          </li>
        </ul>

        <div class="field">
          <label class="label" for="member-handle">Member handle or DID</label>
          <HandleTypeahead
            id="member-handle"
            v-model="memberHandle"
            placeholder="@friend.bsky.social"
            @select="addMember"
          />
        </div>
        <div class="field">
          <label class="label" for="member-role">Role</label>
          <select id="member-role" v-model="memberRole" class="select">
            <option value="admin">Admin</option>
            <option value="contributor">Contributor</option>
            <option value="viewer">Viewer</option>
          </select>
        </div>
        <button type="button" class="btn btn-secondary" @click="addMember">Add member</button>
        <p v-if="memberError" class="error-text">{{ memberError }}</p>
      </section>

      <section v-if="canManageWiki" class="card section">
        <h2>Join requests</h2>
        <p class="muted">
          Pending <code>wiki.lichen.memberRequest</code> records that reference this wiki.
        </p>
        <div class="field">
          <label class="label" for="request-role">Approve as</label>
          <select id="request-role" v-model="requestRole" class="select">
            <option value="admin">Admin</option>
            <option value="contributor">Contributor</option>
            <option value="viewer">Viewer</option>
          </select>
        </div>
        <p v-if="requestsLoading" class="muted">Loading requests…</p>
        <ul v-else-if="pendingRequests.length" class="member-list">
          <li v-for="request in pendingRequests" :key="request.uri">
            <code class="member-id">{{ request.requesterDid }}</code>
            <button type="button" class="btn btn-primary btn-sm" @click="approveRequest(request)">
              Approve
            </button>
            <button type="button" class="btn btn-ghost btn-sm" @click="denyRequest(request)">
              Deny
            </button>
          </li>
        </ul>
        <p v-else class="muted">No pending requests.</p>
        <button type="button" class="btn btn-ghost btn-sm" @click="refreshRequests">Refresh</button>
      </section>

      <CollaborationSettings v-if="canManageWiki && lichen.currentWiki" />

      <DockButtonsSettings v-if="canManageWiki && lichen.currentWiki" />

      <WikiHeaderImageEditor v-if="canManageWiki && lichen.currentWiki" />

      <ThemeEditor v-model="theme" />

      <section v-if="canManageWiki" class="card section">
        <h2>Custom domain</h2>
        <p class="muted">
          Serve this wiki from a domain you own. Point the DNS at GitHub Pages (where this app
          is deployed), add the domain in your repository's Pages settings, and everything —
          OAuth sign-in included — moves to the new address.
        </p>
        <ol class="domain-steps">
          <li>
            At your registrar, add four <code>A</code> records on <code>@</code>:
            <code>185.199.108.153</code>, <code>185.199.109.153</code>,
            <code>185.199.110.153</code>, <code>185.199.111.153</code> — and a <code>CNAME</code>
            on <code>www</code> to <code>&lt;your-github-username&gt;.github.io</code>.
          </li>
          <li>In your GitHub repository: Settings → Pages → Custom domain → enter the domain.</li>
          <li>Check the records here, then deploy — the site rebuilds for the new address.</li>
        </ol>
        <div class="domain-check">
          <input
            v-model="domainInput"
            class="input"
            type="text"
            placeholder="your-domain.wiki"
            spellcheck="false"
            autocomplete="off"
            @keydown.enter="checkDomainDns"
          />
          <button type="button" class="btn btn-secondary" :disabled="dnsChecking || !domainInput.trim()" @click="checkDomainDns">
            {{ dnsChecking ? 'Checking…' : 'Check DNS' }}
          </button>
        </div>
        <ul v-if="dnsResults" class="domain-results">
          <li v-for="result in dnsResults" :key="result.label">
            <span :class="result.ok ? 'domain-ok' : 'domain-bad'">{{ result.ok ? '✓' : '✗' }}</span>
            {{ result.label }}
            <span class="muted">— {{ result.detail }}</span>
          </li>
        </ul>
      </section>

      <section v-if="canManageWiki" class="card section">
        <h2>Backup</h2>
        <p class="muted">
          Full export includes pages, images, header links and icons, top navbar links,
          subheader links and icons, header image, theme, plus a browsable
          <code>site/</code> folder. Import into this wiki or restore on another account.
        </p>
        <div class="backup-actions">
          <button type="button" class="btn btn-secondary" @click="exportWiki">
            Export full backup
          </button>
          <WikiImportButton />
        </div>
      </section>

      <WikiMediaLibrary :notes="lichen.notes" :can-edit="canManageWiki" />

      <section v-if="isOwner" class="card section danger-zone">
        <h2>Danger zone</h2>

        <div class="danger-block">
          <h3>Change URL</h3>
          <p class="muted">
            Updates the path from <code>/{{ wikiSlug }}</code> to a new slug.
            Notes and members move with it. The old URL redirects here.
            External bookmarks that use the old AT-URI will not update.
          </p>

          <button
            v-if="!slugExpanded"
            type="button"
            class="btn btn-danger-outline"
            @click="toggleSlugSection"
          >
            Change wiki URL…
          </button>

          <div v-else class="delete-confirm">
            <div class="field">
              <label class="label" for="new-slug">New URL slug</label>
              <input
                id="new-slug"
                v-model="newSlug"
                class="input"
                type="text"
                autocomplete="off"
                spellcheck="false"
                :disabled="renamingSlug"
                placeholder="oseanworld"
              />
              <p v-if="previewPath" class="muted slug-preview">
                New path: <code>{{ previewPath }}</code>
              </p>
              <p
                v-if="normalizedNewSlug && !isValidSlug(normalizedNewSlug)"
                class="error-text"
              >
                Use lowercase letters, numbers, and hyphens only.
              </p>
            </div>
            <div class="field">
              <label class="label" for="slug-confirm">
                Type the current slug <strong>{{ slugConfirmTarget }}</strong> to confirm
              </label>
              <input
                id="slug-confirm"
                v-model="slugConfirmText"
                class="input"
                type="text"
                autocomplete="off"
                spellcheck="false"
                :disabled="renamingSlug"
                :placeholder="slugConfirmTarget"
              />
            </div>
            <div class="delete-actions">
              <button
                type="button"
                class="btn btn-secondary"
                :disabled="renamingSlug"
                @click="toggleSlugSection"
              >
                Cancel
              </button>
              <button
                type="button"
                class="btn btn-danger"
                :disabled="renamingSlug || !canConfirmSlugChange"
                @click="changeWikiSlug"
              >
                {{ renamingSlug ? 'Changing…' : 'Change URL' }}
              </button>
            </div>
            <p v-if="slugError" class="error-text">{{ slugError }}</p>
          </div>
        </div>

        <div class="danger-block">
          <h3>Move to trash</h3>
          <p class="muted">
            Move this wiki to the trash. You can restore it from My wikis for 30 days;
            after that it is permanently deleted from your PDS along with its notes and history.
            Export a backup first if you might want a copy outside the restore window.
          </p>

          <button
            v-if="!deleteExpanded"
            type="button"
            class="btn btn-danger-outline"
            @click="toggleDeleteSection"
          >
            Move to trash…
          </button>

          <div v-else class="delete-confirm">
            <div class="field">
              <label class="label" for="delete-confirm">
                Type <strong>{{ deleteConfirmTarget }}</strong> to confirm
              </label>
              <input
                id="delete-confirm"
                v-model="deleteConfirmText"
                class="input"
                type="text"
                autocomplete="off"
                spellcheck="false"
                :disabled="deleting"
                :placeholder="deleteConfirmTarget"
              />
            </div>
            <div class="delete-actions">
              <button
                type="button"
                class="btn btn-secondary"
                :disabled="deleting"
                @click="toggleDeleteSection"
              >
                Cancel
              </button>
              <button
                type="button"
                class="btn btn-danger"
                :disabled="deleting || !canConfirmDelete"
                @click="deleteWiki"
              >
                {{ deleting ? 'Moving…' : 'Move wiki to trash' }}
              </button>
            </div>
            <p v-if="deleteError" class="error-text">{{ deleteError }}</p>
          </div>
        </div>

        <div class="danger-block">
          <h3>Delete permanently</h3>
          <p class="muted">
            Instantly remove this wiki, its notes, revisions, and memberships from your PDS.
            This cannot be undone — there is no trash or restore window.
          </p>

          <button
            v-if="!purgeExpanded"
            type="button"
            class="btn btn-danger-outline"
            @click="togglePurgeSection"
          >
            Delete permanently…
          </button>

          <div v-else class="delete-confirm">
            <div class="field">
              <label class="label" for="purge-confirm">
                Type <strong>{{ deleteConfirmTarget }}</strong> to confirm
              </label>
              <input
                id="purge-confirm"
                v-model="purgeConfirmText"
                class="input"
                type="text"
                autocomplete="off"
                spellcheck="false"
                :disabled="purging"
                :placeholder="deleteConfirmTarget"
              />
            </div>
            <div class="delete-actions">
              <button
                type="button"
                class="btn btn-secondary"
                :disabled="purging"
                @click="togglePurgeSection"
              >
                Cancel
              </button>
              <button
                type="button"
                class="btn btn-danger"
                :disabled="purging || !canConfirmPurge"
                @click="purgeWikiNow"
              >
                {{ purging ? 'Deleting…' : 'Delete permanently' }}
              </button>
            </div>
            <p v-if="purgeError" class="error-text">{{ purgeError }}</p>
          </div>
        </div>
      </section>

      <div class="actions">
        <button type="button" class="btn btn-secondary" @click="router.push('/library')">
          Back
        </button>
        <button type="button" class="btn btn-primary" @click="saveTheme">
          {{ saved ? 'Saved!' : 'Save display theme' }}
        </button>
      </div>

      <p v-if="lichen.error" class="error-text">{{ lichen.error }}</p>
    </div>
  </div>
</template>

<style scoped>
.visibility-note {
  margin: 0.5rem 0 1rem;
  font-size: 0.8125rem;
  line-height: 1.5;
}

.settings-page {
  padding: 2rem 1.25rem 4rem;
}

.settings-inner {
  max-width: 640px;
  margin: 0 auto;
  display: grid;
  gap: 1rem;
}

header h1 {
  margin: 0 0 0.25rem;
  font-family: var(--pckt-font-content);
}

.section {
  padding: 1.25rem;
}

.section h2 {
  margin: 0 0 1rem;
  font-size: 1rem;
}

.invite-row {
  margin-bottom: 0.75rem;
}

.backup-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
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
  flex: 1 1 12rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.select-sm {
  width: auto;
  min-width: 8rem;
}

.actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

.danger-zone {
  border-color: color-mix(in srgb, var(--pckt-danger) 35%, var(--pckt-border));
}

.danger-zone h2 {
  color: var(--pckt-danger);
}

.danger-block + .danger-block {
  margin-top: 1.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid color-mix(in srgb, var(--pckt-danger) 18%, var(--pckt-border));
}

.danger-block h3 {
  margin: 0 0 0.5rem;
  font-size: 0.9375rem;
}

.slug-preview {
  margin: 0.375rem 0 0;
  font-size: 0.8125rem;
}

.delete-confirm {
  display: grid;
  gap: 0.75rem;
}

.delete-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  justify-content: flex-end;
}

.btn-danger-outline {
  border-color: color-mix(in srgb, var(--pckt-danger) 45%, transparent);
  background: color-mix(in srgb, var(--pckt-danger) 6%, var(--pckt-bg-elevated));
  color: color-mix(in srgb, var(--pckt-danger) 90%, var(--pckt-text));
  box-shadow: var(--pckt-shadow-xs);
}

.btn-danger-outline:hover:not(:disabled) {
  background: color-mix(in srgb, var(--pckt-danger) 12%, var(--pckt-bg-elevated));
  border-color: color-mix(in srgb, var(--pckt-danger) 60%, transparent);
  color: var(--pckt-danger);
}

.btn-danger {
  border-color: color-mix(in srgb, var(--pckt-danger) 55%, transparent);
  background: var(--pckt-danger);
  color: #fff;
  box-shadow: var(--pckt-shadow-xs);
}

.btn-danger:hover:not(:disabled) {
  filter: brightness(0.95);
}

.btn-danger:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

code {
  font-family: var(--pckt-font-mono);
  font-size: 0.8125em;
}

.domain-steps {
  margin: 0 0 0.75rem;
  padding-left: 1.25rem;
  font-size: 0.875rem;
  display: grid;
  gap: 0.375rem;
}

.domain-check {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.domain-check .input {
  flex: 1 1 14rem;
  min-width: 0;
}

.domain-results {
  list-style: none;
  margin: 0.75rem 0 0;
  padding: 0;
  display: grid;
  gap: 0.25rem;
  font-size: 0.875rem;
}

.domain-ok {
  color: #1faf38;
  font-weight: 700;
}

.domain-bad {
  color: var(--pckt-danger);
  font-weight: 700;
}
</style>
