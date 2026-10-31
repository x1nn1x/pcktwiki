import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Agent } from '@atproto/api'
import {
  deleteMembershipRecord,
  deleteNoteRecord,
  deleteNoteWithRevisions,
  deleteRevisionRecord,
  deleteWikiRecord,
  getWikiBySlug,
  listMemberships,
  listNotes,
  listRevisions,
  listRecentRevisions,
  listWikis,
  parseAtUri,
  putWikiAtSlug,
  updateMembershipRole,
  updateNoteTitle,
  updateNoteNavTitle,
  updateNoteSlug,
  updateNoteSubheaderLinks,
  updateNoteWikiRef,
  updateWikiHeaderLinks,
  updateWikiNavbarLinks,
  updateWikiSidebarOrder,
  updateWikiHeaderImage,
  updateWikiName,
  updateWikiRecord,
  updateWikiTheme,
  type WikiThemeFields,
  updateWikiVisibility,
  writeMembershipRecord,
  writeNoteRecord,
  writeRevisionRecord,
  writeWikiRecord,
  uniqueSlug,
  isValidSlug,
  normalizeArticleSlug,
} from '@/lib/atproto/lichen'
import { mapWithConcurrency } from '@/lib/concurrency'
import {
  canEdit,
  canManage,
  getAccessLevel,
  normalizeRole,
  type AccessLevel,
  type MemberRole,
} from '@/lib/lichen/collections'
import { computeBacklinks, getBacklinksForNote, type Backlink } from '@/lib/lichen/backlinks'
import { branchNameFromSlug, migratedBranchSlug } from '@/lib/lichen/branches'
import {
  attachContentToNotes,
  buildNoteContents,
  clearNoteDamage,
  listRevisionHistory,
  reconstructAtRevision,
  replayRevisions,
  shouldSnapshot,
} from '@/lib/lichen/revisions'
import { subscribeFirehose, applyFirehoseRevision } from '@/lib/lichen/firehose'
import { toUserFacingNetworkError } from '@/lib/http-retry'
import { getPublicWikiCache, loadPublicWikiCache, setPublicWikiCache, clearPublicWikiCache } from '@/lib/lichen/wiki-cache'
import {
  isWikiTrashExpired,
  isWikiTrashed,
} from '@/lib/lichen/wiki-trash'
import {
  getPendingEdits,
  isOnline,
  queueEdit,
  removePendingEdit,
} from '@/lib/offline-queue'
import { getPublicAgent } from '@/lib/atproto/auth'
import { resolvePdsUrl } from '@/lib/atproto/pds'
import {
  documentToPcktBlogUrl,
  getActorProfile,
  listStandardDocuments,
  listStandardPublications,
} from '@/lib/standardsite/blog'
import {
  defaultBlogStubContent,
  findBlogStubSuggestions,
  type BlogStubSuggestion,
} from '@/lib/blog-sync'
import { resolveRedirectTarget } from '@/lib/lichen/content-meta'
import { defaultHomeContent } from '@/lib/lichen/default-home'
import {
  buildForkRecord,
  forkWiki as forkWikiRecords,
  type ForkProgress,
} from '@/lib/lichen/fork-wiki'
import {
  buildWikiTimeline,
  planWikiRewind,
  reconstructNoteAtTime,
  type WikiRewindPlan,
  type WikiVersionEntry,
} from '@/lib/lichen/wiki-versions'
import { computeForkChanges, type ForkChange } from '@/lib/lichen/fork-sync'
import {
  getForkByWikiUri,
  remapForkWikiRefs,
  removeFork,
  removeForkBaseline,
  saveFork,
  setForkAutoSync,
  setForkBaseline,
  updateFork,
  type ForkRecord,
  type ForkNoteBaseline,
} from '@/lib/lichen/fork'
import { remapWikiWatchRefs } from '@/lib/watchlist'
import {
  deleteBookmark,
  findBookmarkForWiki,
  writeBookmark,
} from '@/lib/lichen/bookmarks'
import {
  deleteApprovedMediaRecord,
  deletePageGrantRecord,
  deletePolicyRecord,
  listApprovedMedia,
  listPageGrants,
  listPolicies,
  transferBlob,
  updatePolicyRecord,
  writeApprovedMediaRecord,
  writePageGrantRecord,
  writePolicyRecord,
  writeSuggestionRecord,
  type PolicyFields,
  type SuggestionInput,
} from '@/lib/atproto/collab'
import { blobRefToJson } from '@/lib/atproto/blobs'
import { doesFollow } from '@/lib/atproto/graph'
import {
  findDisallowedImages,
  findPageGrant,
  resolveViewerCapabilities,
  resolveWikiPolicy,
  withPageGrant,
  type WikiCapabilities,
} from '@/lib/lichen/collab'
import {
  listIncomingSuggestions,
  rejectSuggestionLocally,
  rewriteBlobCid,
} from '@/lib/lichen/suggestions-remote'
import type { PublicWikiCacheEntry } from '@/lib/lichen/load-public-wiki'
import type {
  ActorProfile,
  LichenApprovedMediaRecord,
  LichenMembershipRecord,
  LichenNoteRecord,
  LichenNoteWithContent,
  LichenPageGrantRecord,
  LichenPolicyRecord,
  LichenRevisionRecord,
  LichenSuggestionRecord,
  LichenWikiRecord,
  PageGrantRole,
  StandardSiteDocument,
  StandardSitePublication,
} from '@/types/lichen'

export const useLichenStore = defineStore('lichen', () => {
  const wikis = ref<LichenWikiRecord[]>([])
  const currentWiki = ref<LichenWikiRecord | null>(null)
  const notes = ref<LichenNoteWithContent[]>([])
  const revisions = ref<LichenRevisionRecord[]>([])
  const memberships = ref<LichenMembershipRecord[]>([])
  const profile = ref<ActorProfile | null>(null)
  const ownerHandle = ref<string | null>(null)
  const blogPosts = ref<StandardSiteDocument[]>([])
  const publications = ref<StandardSitePublication[]>([])
  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)
  const access = ref<AccessLevel>('none')
  const policyRecord = ref<LichenPolicyRecord | null>(null)
  const pageGrants = ref<LichenPageGrantRecord[]>([])
  const approvedMedia = ref<LichenApprovedMediaRecord[]>([])
  const capabilities = ref<WikiCapabilities>({
    canRead: false,
    canPublish: false,
    canSuggest: false,
    imageMode: 'none',
    canSubmitImages: false,
    canManageWiki: false,
    canReviewPage: false,
  })
  const incomingSuggestions = ref<LichenSuggestionRecord[]>([])
  const suggestionsLoading = ref(false)
  const currentViewerDid = ref<string | null>(null)
  const firehoseUnsub = ref<(() => void) | null>(null)
  const activeWikiScope = ref<string | null>(null)
  const forkInfo = ref<ForkRecord | null>(null)
  const forkChanges = ref<ForkChange[]>([])
  const forkChecking = ref(false)
  const forking = ref(false)
  const forkProgress = ref<ForkProgress | null>(null)
  const cachedFrom = ref<number | null>(null)
  let loadSeq = 0
  /**
   * Whether `revisions` currently holds the wiki's ENTIRE history. Page views
   * load newest-first with snapshot anchoring; history/merge/rewind pages call
   * ensureFullHistory() before reading deep history.
   */
  const fullHistoryLoaded = ref(false)
  const fullHistoryLoading = ref(false)

  const activeWikis = computed(() =>
    wikis.value.filter((wiki) => !isWikiTrashed(wiki) && !wiki.redirectSlug),
  )
  const trashedWikis = computed(() =>
    wikis.value
      .filter((wiki) => isWikiTrashed(wiki) && !isWikiTrashExpired(wiki) && !wiki.redirectSlug)
      .slice()
      .sort((a, b) => Date.parse(b.deletedAt ?? '') - Date.parse(a.deletedAt ?? '')),
  )
  const wikiRedirectSlug = ref<string | null>(null)

  function refreshForkInfo(): void {
    forkInfo.value = currentWiki.value
      ? getForkByWikiUri(currentWiki.value.uri) ?? null
      : null
  }

  /**
   * When a fork is opened on a device without a local registry entry, rebuild
   * sync state from wiki.forkedFrom. Baselines are seeded from current fork
   * content so the first upstream check only surfaces genuine divergence.
   */
  async function rehydrateForkInfo(): Promise<void> {
    if (forkInfo.value) return
    const wiki = currentWiki.value
    if (!wiki?.forkedFrom || !canManage(access.value)) return

    const parsed = parseAtUri(wiki.forkedFrom)
    if (!parsed || parsed.collection !== 'wiki.lichen.wiki') return

    try {
      const profile = await getActorProfile(getPublicAgent(), parsed.did)
      const sourceHandle = profile.handle
      if (!sourceHandle) return

      const baselines: Record<string, ForkNoteBaseline> = {}
      for (const note of notes.value) {
        baselines[note.slug] = {
          sourceContent: note.content,
          sourceRevisionUri: note.latestRevisionUri,
        }
      }

      saveFork({
        forkWikiUri: wiki.uri,
        forkSlug: wiki.slug,
        forkHandle: ownerHandle.value ?? '',
        sourceDid: parsed.did,
        sourceHandle,
        sourceSlug: parsed.rkey,
        sourceWikiUri: wiki.forkedFrom,
        createdAt: wiki.forkedAt ?? wiki.createdAt,
        autoSync: false,
        lastCheckedAt: null,
        baselines,
      })
      refreshForkInfo()
    } catch {
      // Source actor may be unavailable; attribution badge still works via forkedFrom.
    }
  }

  function currentWikiAsPublicEntry(): PublicWikiCacheEntry {
    if (!currentWiki.value) throw new Error('No wiki selected')
    return {
      handle: ownerHandle.value ?? '',
      slug: currentWiki.value.slug,
      did: currentWiki.value.ownerDid,
      wiki: currentWiki.value,
      noteRecords: notes.value,
      revisionRecords: revisions.value,
      notesWithContent: notes.value,
      fetchedAt: Date.now(),
    }
  }

  /** Keep the browse/session cache aligned after local writes so refresh does not revive stale warnings. */
  function persistCurrentWikiContentCache(): void {
    const handle = ownerHandle.value
    const wiki = currentWiki.value
    if (!handle || !wiki) return
    const cached = getPublicWikiCache(handle, wiki.slug, Number.POSITIVE_INFINITY)
    if (!cached) {
      setPublicWikiCache(currentWikiAsPublicEntry())
      return
    }
    setPublicWikiCache({
      ...cached,
      wiki,
      noteRecords: notes.value,
      revisionRecords: revisions.value,
      notesWithContent: notes.value,
      fetchedAt: Date.now(),
    })
  }

  function wikiRepoDid(): string {
    if (!currentWiki.value) throw new Error('No wiki selected')
    return currentWiki.value.ownerDid
  }

  function assertCanEdit(): void {
    if (!canEdit(access.value)) {
      throw new Error('You do not have permission to edit this wiki')
    }
  }

  const backlinks = computed(() => {
    if (!currentWiki.value) return []
    const known = new Set(wikis.value.map((wiki) => wiki.slug))
    known.add(currentWiki.value.slug)
    return computeBacklinks(notes.value, currentWiki.value.slug, known)
  })

  function stopFirehose() {
    firehoseUnsub.value?.()
    firehoseUnsub.value = null
  }

  function startFirehose(ownerDid: string) {
    stopFirehose()
    firehoseUnsub.value = subscribeFirehose((commit) => {
      if (commit.did !== ownerDid) return

      if (commit.collection === 'wiki.lichen.noteRevision' && commit.record) {
        const noteRef = String(commit.record.noteRef ?? '')
        const note = notes.value.find((item) => item.uri === noteRef)
        if (!note) return

        const applied = applyFirehoseRevision(
          revisions.value,
          commit,
          note.content,
          note.latestRevisionUri,
        )
        if (!applied) return

        revisions.value = applied.revisions
        note.content = applied.content
        note.latestRevisionUri = applied.latestRevisionUri
        if (applied.damagedRevisions > 0) {
          note.damagedRevisions = applied.damagedRevisions
          note.damagedRevisionUris = applied.damagedRevisionUris
        } else {
          clearNoteDamage(note)
        }
        persistCurrentWikiContentCache()
      }
    })
  }

  async function resolveAccess(_agent: Agent, wiki: LichenWikiRecord, userDid: string | null) {
    const wikiMemberships = memberships.value.filter((item) => item.wikiRef === wiki.uri)
    const member = userDid
      ? wikiMemberships.find((item) => item.memberDid === userDid)
      : null
    access.value = getAccessLevel(
      wiki.ownerDid,
      wiki.visibility,
      userDid,
      member ? normalizeRole(member.role) : null,
    )

    const policy = resolveWikiPolicy(
      policyRecord.value?.wikiRef === wiki.uri ? policyRecord.value : null,
    )
    const ownerFollowsViewer =
      policy.editAccess === 'followers' &&
      !!userDid &&
      userDid !== wiki.ownerDid &&
      !member
        ? await doesFollow(wiki.ownerDid, userDid)
        : false
    capabilities.value = resolveViewerCapabilities({
      ownerDid: wiki.ownerDid,
      visibility: wiki.visibility,
      viewerDid: userDid,
      memberRole: member ? normalizeRole(member.role) : null,
      policy,
      ownerFollowsViewer,
    })
  }

  /** Wiki-wide capabilities with the viewer's grant for one article applied. */
  function capabilitiesForNote(noteSlug: string): WikiCapabilities {
    const wiki = currentWiki.value
    if (!wiki) return capabilities.value
    const grant = findPageGrant(
      pageGrants.value,
      wiki.uri,
      noteSlug,
      currentViewerDid.value,
    )
    return withPageGrant(
      capabilities.value,
      grant,
      resolveWikiPolicy(policyRecord.value?.wikiRef === wiki.uri ? policyRecord.value : null),
    )
  }

  async function loadOwnerWikis(agent: Agent): Promise<void> {
    error.value = null
    try {
      const [wikiList, membershipList, profileData] = await Promise.all([
        listWikis(agent, agent.accountDid),
        listMemberships(agent, agent.accountDid),
        getActorProfile(agent, agent.accountDid),
      ])
      wikis.value = wikiList
      memberships.value = membershipList
      profile.value = profileData
      ownerHandle.value = profileData.handle ?? null
    } catch (err) {
      error.value = toUserFacingNetworkError(err)
    }
  }

  function failLoad(message: string): void {
    stopFirehose()
    loading.value = false
    error.value = message
    wikiRedirectSlug.value = null
  }

  function consumeWikiRedirectSlug(): string | null {
    const slug = wikiRedirectSlug.value
    wikiRedirectSlug.value = null
    return slug
  }

  function applyCacheHit(
    cacheHit: PublicWikiCacheEntry,
    handle: string | undefined,
  ): void {
    currentWiki.value = cacheHit.wiki
    revisions.value = cacheHit.revisionRecords
    notes.value = attachContentToNotes(
      cacheHit.noteRecords,
      buildNoteContents(cacheHit.revisionRecords),
    )
    cachedFrom.value = cacheHit.fetchedAt
    if (handle) {
      ownerHandle.value = handle
    }
  }

  async function tryOfflineCache(
    handle: string,
    wikiSlug: string,
    ownerDid: string,
  ): Promise<PublicWikiCacheEntry | null> {
    const stored = await loadPublicWikiCache(handle, wikiSlug, { allowStale: true })
    if (!stored?.wiki || stored.did !== ownerDid) return null
    return stored
  }

  async function loadWiki(
    agent: Agent,
    ownerDid: string,
    wikiSlug: string,
    viewerDid: string | null,
    handle?: string,
  ): Promise<void> {
    const scope = handle ? `${handle}/${wikiSlug}` : wikiSlug
    const sameWiki =
      activeWikiScope.value === scope &&
      currentWiki.value?.slug === wikiSlug &&
      currentWiki.value?.ownerDid === ownerDid

    const seq = ++loadSeq
    error.value = null

    if (!sameWiki) {
      loading.value = true
      stopFirehose()
      currentWiki.value = null
      notes.value = []
      revisions.value = []
      memberships.value = []
      policyRecord.value = null
      pageGrants.value = []
      approvedMedia.value = []
      incomingSuggestions.value = []
      blogPosts.value = []
      publications.value = []
      cachedFrom.value = null
    }
    currentViewerDid.value = viewerDid

    /**
     * The full fetch-and-apply pass. Also runs in the background after a
     * cache paint (stale-while-revalidate), so a repeat visit paints instantly
     * and then quietly catches up with the PDS.
     */
    const fetchAndApply = async (): Promise<void> => {
      const profileAgent = getPublicAgent()
      const cached =
        handle && wikiSlug ? getPublicWikiCache(handle, wikiSlug) : null
      const cacheHit =
        cached && cached.did === ownerDid && cached.wiki?.slug === wikiSlug ? cached : null

      const [
        wiki,
        noteRecords,
        revisionResult,
        membershipRecords,
        policyRecords,
        grantRecords,
        approvedMediaRecords,
        profileData,
        publicationData,
        documentData,
      ] = await Promise.all([
        // Always refresh wiki metadata when online so settings writes (header links,
        // navbar links, header image, theme, visibility) are not stuck behind the browse cache.
        isOnline()
          ? getWikiBySlug(agent, ownerDid, wikiSlug)
          : cacheHit
            ? Promise.resolve(cacheHit.wiki)
            : getWikiBySlug(agent, ownerDid, wikiSlug),
        // Always refresh notes/revisions when online so local writes (and Keep this
        // version) are not stuck behind the browse cache after a refresh.
        cacheHit && !isOnline()
          ? Promise.resolve(cacheHit.noteRecords)
          : listNotes(agent, ownerDid),
        // Newest-first with snapshot anchoring: pages needing full history
        // (page history, merges, rewind) call ensureFullHistory() instead.
        cacheHit && !isOnline()
          ? Promise.resolve({ records: cacheHit.revisionRecords, complete: true })
          : listRecentRevisions(agent, ownerDid),
        listMemberships(agent, ownerDid).catch(() => [] as LichenMembershipRecord[]),
        listPolicies(agent, ownerDid).catch(() => []),
        listPageGrants(agent, ownerDid).catch(() => []),
        listApprovedMedia(agent, ownerDid).catch(() => []),
        getActorProfile(profileAgent, ownerDid),
        listStandardPublications(agent, ownerDid).catch(() => [] as StandardSitePublication[]),
        listStandardDocuments(agent, ownerDid).catch(() => [] as StandardSiteDocument[]),
      ])

      if (seq !== loadSeq) return

      if (!wiki) {
        error.value = 'Wiki not found'
        return
      }

      if (wiki.redirectSlug) {
        wikiRedirectSlug.value = wiki.redirectSlug
        currentWiki.value = null
        notes.value = []
        revisions.value = []
        return
      }

      wikiRedirectSlug.value = null

      if (isWikiTrashed(wiki)) {
        if (viewerDid === ownerDid) {
          error.value = 'This wiki is in the trash. Restore it from My wikis within 30 days.'
        } else {
          error.value = 'Wiki not found'
        }
        return
      }

      currentWiki.value = wiki

      if (cacheHit && !isOnline()) {
        revisions.value = cacheHit.revisionRecords
        // Rebuild so damage flags match current replay rules, not a stale snapshot.
        notes.value = attachContentToNotes(
          cacheHit.noteRecords,
          buildNoteContents(cacheHit.revisionRecords),
        )
        cachedFrom.value = cacheHit.fetchedAt
      } else {
        const filteredNotes = noteRecords.filter((note: LichenNoteRecord) => note.wikiRef === wiki.uri)
        revisions.value = revisionResult.records.filter((revision: LichenRevisionRecord) => {
          const note = noteRecords.find((item: LichenNoteRecord) => item.uri === revision.noteRef)
          return note?.wikiRef === wiki.uri
        })
        // The window covered the whole chain → this load has full history and
        // ensureFullHistory() is a no-op until the next wiki change.
        fullHistoryLoaded.value = revisionResult.complete

        const contents = buildNoteContents(revisions.value)
        notes.value = attachContentToNotes(filteredNotes, contents)
        cachedFrom.value = null

        if (handle) {
          const pdsUrl = await resolvePdsUrl(ownerDid).catch(() => null)
          setPublicWikiCache(
            {
              handle,
              slug: wikiSlug,
              did: ownerDid,
              wiki,
              noteRecords: filteredNotes,
              revisionRecords: revisions.value,
              notesWithContent: notes.value,
              fetchedAt: Date.now(),
            },
            {
              access: wiki.visibility === 'private' ? 'private' : 'public',
              pdsUrl,
            },
          )
        }
      }

      memberships.value = membershipRecords
      policyRecord.value =
        policyRecords.find((item: LichenPolicyRecord) => item.wikiRef === wiki.uri) ?? null
      pageGrants.value = grantRecords.filter(
        (item: LichenPageGrantRecord) => item.wikiRef === wiki.uri,
      )
      approvedMedia.value = approvedMediaRecords.filter(
        (item: LichenApprovedMediaRecord) => item.wikiRef === wiki.uri,
      )
      profile.value = { ...profileData, handle: handle ?? profileData.handle }
      ownerHandle.value = handle ?? profileData.handle ?? null
      publications.value = publicationData
      blogPosts.value = documentData

      await resolveAccess(agent, wiki, viewerDid)
      if (seq !== loadSeq) return

      if (wiki.visibility === 'private' && access.value === 'none') {
        error.value = 'This wiki is private'
        notes.value = []
        return
      }

      activeWikiScope.value = scope
      forkChanges.value = []
      refreshForkInfo()
      void rehydrateForkInfo()
      startFirehose(ownerDid)
    }

    try {
      const cached =
        handle && wikiSlug ? getPublicWikiCache(handle, wikiSlug) : null
      const cacheHit =
        cached && cached.did === ownerDid && cached.wiki?.slug === wikiSlug ? cached : null

      if (!cacheHit && !isOnline() && handle) {
        const offline = await tryOfflineCache(handle, wikiSlug, ownerDid)
        if (offline) {
          applyCacheHit(offline, handle)
          if (offline.wiki) {
            await resolveAccess(agent, offline.wiki, viewerDid)
            if (seq !== loadSeq) return
            if (offline.wiki.visibility === 'private' && access.value === 'none') {
              error.value = 'This wiki is private'
              notes.value = []
              return
            }
            activeWikiScope.value = scope
            forkChanges.value = []
            refreshForkInfo()
            return
          }
        }
      }

      // Stale-while-revalidate: a cached wiki paints instantly (online or not),
      // then the live fetch runs in the background and quietly updates.
      if (cacheHit && cacheHit.wiki) {
        applyCacheHit(cacheHit, handle)
        await resolveAccess(agent, cacheHit.wiki, viewerDid)
        if (seq !== loadSeq) return
        if (cacheHit.wiki.visibility === 'private' && access.value === 'none') {
          error.value = 'This wiki is private'
          notes.value = []
          return
        }
        activeWikiScope.value = scope
        forkChanges.value = []
        refreshForkInfo()
        loading.value = false
        if (isOnline()) {
          void fetchAndApply().catch(() => {
            // The cached view stays on screen; a network failure is not worth
            // blanking it for.
          })
        }
        return
      }

      await fetchAndApply()
    } catch (err) {
      if (seq !== loadSeq) return
      if (handle) {
        const stale = await tryOfflineCache(handle, wikiSlug, ownerDid)
        if (stale?.wiki) {
          applyCacheHit(stale, handle)
          await resolveAccess(agent, stale.wiki, viewerDid)
          if (stale.wiki.visibility === 'private' && access.value === 'none') {
            error.value = 'This wiki is private'
            notes.value = []
          } else {
            error.value = null
            activeWikiScope.value = scope
            forkChanges.value = []
            refreshForkInfo()
          }
          return
        }
      }
      if (!sameWiki) {
        currentWiki.value = null
        notes.value = []
        revisions.value = []
        activeWikiScope.value = null
        cachedFrom.value = null
      }
      error.value = toUserFacingNetworkError(err)
    } finally {
      if (seq === loadSeq) loading.value = false
    }
  }

  async function createWiki(
    agent: Agent,
    name: string,
    language = 'en',
    visibility: LichenWikiRecord['visibility'] = 'public',
    description = '',
    homeContent?: string,
    preferredSlug?: string,
  ): Promise<LichenWikiRecord> {
    const slug = uniqueSlug(
      preferredSlug?.trim() || name,
      wikis.value.map((wiki) => wiki.slug),
    )
    if (!isValidSlug(slug)) throw new Error('Invalid wiki slug')

    let wiki: LichenWikiRecord | null = null
    let membershipUri: string | null = null

    try {
      wiki = await writeWikiRecord(agent, slug, name, visibility, language, description || undefined)
      const membership = await writeMembershipRecord(agent, agent.accountDid, wiki.uri, 'admin')
      membershipUri = membership.uri
      wikis.value.push(wiki)

      const home = await writeNoteRecord(agent, 'home', 'Home', wiki.uri)
      const content = homeContent?.trim() || defaultHomeContent(name)
      await writeRevisionRecord(agent, home.uri, '', content, null, 'Initial revision')
      return wiki
    } catch (err) {
      if (wiki) {
        if (membershipUri) {
          await deleteMembershipRecord(agent, membershipUri).catch(() => {})
        }
        await deleteWikiRecord(agent, wiki).catch(() => {})
        wikis.value = wikis.value.filter((item) => item.uri !== wiki!.uri)
      }
      throw err
    }
  }

  async function createNote(agent: Agent, title: string, content = ''): Promise<LichenNoteWithContent> {
    if (!currentWiki.value) throw new Error('No wiki selected')
    const slug = uniqueSlug(
      title,
      notes.value.map((note) => note.slug),
    )
    return createNoteWithSlug(agent, slug, title, content)
  }

  async function createNoteWithSlug(
    agent: Agent,
    slug: string,
    title: string,
    content = '',
    message = 'Initial revision',
    blobs?: Array<Record<string, unknown>>,
  ): Promise<LichenNoteWithContent> {
    if (!currentWiki.value) throw new Error('No wiki selected')
    assertCanEdit()
    const normalized = normalizeArticleSlug(slug)
    if (!normalized || (!isValidSlug(normalized) && !normalized.includes(':'))) {
      throw new Error('Invalid article slug')
    }

    const existing = notes.value.find((note) => note.slug === normalized)
    if (existing) {
      await saveNoteEdit(
        agent,
        existing,
        title.trim() || existing.title,
        content,
        message,
        existing.latestRevisionUri,
        existing.content,
        false,
        blobs,
      )
      return existing
    }

    // The in-memory check above is not enough on its own: two calls in the same
    // tick both pass it (nothing awaits between check and write), and a list
    // rehydrated from cache can omit a note that already exists in the repo.
    // Either way the result is a second record on the same slug, which strands
    // the first. Serialise per slug, then confirm against the repo.
    const pending = creatingBySlug.get(normalized)
    if (pending) return pending

    const create = (async () => {
      const remote = await listNotes(agent, wikiRepoDid())
      const alreadyThere = remote.find(
        (note) => note.slug === normalized && note.wikiRef === currentWiki.value?.uri,
      )
      if (alreadyThere) {
        const known = notes.value.find((note) => note.uri === alreadyThere.uri)
        const target: LichenNoteWithContent =
          known ?? { ...alreadyThere, content: '', latestRevisionUri: null }
        if (!known) notes.value = [...notes.value, target]
        await saveNoteEdit(
          agent,
          target,
          title.trim() || target.title,
          content,
          message,
          target.latestRevisionUri,
          target.content,
          false,
          blobs,
        )
        return target
      }
      return writeNewNote(agent, normalized, title, content, message, blobs)
    })()

    creatingBySlug.set(normalized, create)
    try {
      return await create
    } finally {
      creatingBySlug.delete(normalized)
    }
  }

  /** In-flight creates keyed by slug, so concurrent calls share one write. */
  const creatingBySlug = new Map<string, Promise<LichenNoteWithContent>>()

  async function writeNewNote(
    agent: Agent,
    slug: string,
    title: string,
    content: string,
    message: string,
    blobs?: Array<Record<string, unknown>>,
  ): Promise<LichenNoteWithContent> {
    if (!currentWiki.value) throw new Error('No wiki selected')
    const repoDid = wikiRepoDid()
    const note = await writeNoteRecord(
      agent,
      slug,
      title.trim() || slug,
      currentWiki.value.uri,
      undefined,
      repoDid,
    )
    const revision = await writeRevisionRecord(
      agent,
      note.uri,
      '',
      content,
      null,
      message,
      undefined,
      repoDid,
      // First revision is a full snapshot so the page always has authoritative text
      // even if later diffs fail to replay.
      true,
      blobs,
    )

    const withContent: LichenNoteWithContent = {
      ...note,
      content,
      latestRevisionUri: revision.uri,
    }
    // Replace the array so every computed/watcher depending on `notes` refreshes.
    notes.value = [...notes.value, withContent]
    revisions.value = [...revisions.value, revision]

    const handle = ownerHandle.value
    if (handle && currentWiki.value) {
      const cached = getPublicWikiCache(handle, currentWiki.value.slug, Number.POSITIVE_INFINITY)
      if (cached) {
        setPublicWikiCache({
          ...cached,
          noteRecords: notes.value,
          revisionRecords: revisions.value,
          notesWithContent: notes.value,
          fetchedAt: Date.now(),
        })
      }
    }

    return withContent
  }

  async function saveNoteEdit(
    agent: Agent,
    note: LichenNoteWithContent,
    title: string,
    content: string,
    message?: string,
    parentRevision: string | null = note.latestRevisionUri,
    oldContent: string = note.content,
    forceSnapshot = false,
    blobs?: Array<Record<string, unknown>>,
    /**
     * Blank-page guard override. Writing empty text over real content is how
     * pages end up "Nothing written yet" with all history apparently gone —
     * the empty snapshots re-anchor replay to nothing. Merges and rewinds may
     * pass true when an empty state is the point.
     */
    allowBlank = false,
  ): Promise<void> {
    assertCanEdit()
    if (!allowBlank && !content.trim() && oldContent.trim()) {
      throw new Error(
        'This edit would blank the page. If you meant to delete it, use the page menu; old text can always be restored from history.',
      )
    }
    saving.value = true
    error.value = null
    try {
      const existingRevisions = revisions.value.filter(
        (item) => item.noteRef === note.uri,
      ).length
      const revision = await writeRevisionRecord(
        agent,
        note.uri,
        oldContent,
        content,
        parentRevision,
        message,
        undefined,
        wikiRepoDid(),
        forceSnapshot || shouldSnapshot(existingRevisions),
        blobs,
      )

      if (title !== note.title) {
        await updateNoteTitle(agent, note, title)
        note.title = title
      }

      note.content = content
      note.latestRevisionUri = revision.uri
      revisions.value.push(revision)
      // Current text is authoritative after a successful write — drop a stale
      // incomplete-rebuild warning until the next full replay.
      clearNoteDamage(note)
      persistCurrentWikiContentCache()
    } catch (err) {
      error.value = toUserFacingNetworkError(err)
      throw err
    } finally {
      saving.value = false
    }
  }

  /**
   * Treat the text on screen as complete: write a snapshot revision so future
   * replays re-anchor here, and clear the incomplete-rebuild banner.
   */
  async function acceptCurrentNoteContent(
    agent: Agent,
    note: LichenNoteWithContent,
    handle?: string,
    wikiSlug?: string,
  ): Promise<'saved' | 'queued'> {
    assertCanEdit()
    const message = 'Kept current page text'
    if (!isOnline()) {
      queueEdit({
        handle: handle ?? ownerHandle.value ?? '',
        wikiSlug: wikiSlug ?? currentWiki.value?.slug ?? '',
        noteSlug: note.slug,
        noteUri: note.uri,
        title: note.title,
        content: note.content,
        message,
        latestRevisionUri: note.latestRevisionUri,
      })
      clearNoteDamage(note)
      persistCurrentWikiContentCache()
      return 'queued'
    }

    await saveNoteEdit(
      agent,
      note,
      note.title,
      note.content,
      message,
      note.latestRevisionUri,
      note.content,
      true,
    )
    return 'saved'
  }

  /**
   * Delete a note and the revisions holding its text. Record listing pages
   * through to the end, so `revisions` holds every revision in the repo and
   * filtering locally catches all of them.
   */
  /**
   * Move a branch record onto the current slug format, in place.
   *
   * Branches are addressed by slug but reviewed from their parent, and nothing
   * links to them by wikilink, so unlike an article rename there is nothing to
   * rewrite and no redirect worth leaving behind — the record keeps its URI and
   * its whole revision history.
   */
  async function migrateBranchSlug(
    agent: Agent,
    note: LichenNoteWithContent,
  ): Promise<string> {
    assertCanEdit()
    const target = migratedBranchSlug(note.slug)
    if (!target) throw new Error('This branch slug is already in the current format')
    if (notes.value.some((item) => item.slug === target)) {
      throw new Error(`Another record already uses "${target}"`)
    }

    await updateNoteSlug(agent, note, target)
    note.slug = target
    return target
  }

  /** Revisions a merge would carry over: every branch revision after the fork copy. */
  function countMergeableRevisions(branchNote: LichenNoteWithContent): number {
    return Math.max(0, replayRevisions(branchNote.uri, revisions.value).length - 1)
  }

  const MERGE_MESSAGE_MAX = 1024

  function mergeRevisionMessage(
    revision: LichenRevisionRecord,
    branchSlug: string,
  ): string {
    const branchName = branchNameFromSlug(branchSlug) ?? branchSlug
    const suffix = ` (branch ${branchName}, ${revision.createdAt.slice(0, 10)})`
    const base = revision.message?.trim() || 'Edit on branch'
    const room = MERGE_MESSAGE_MAX - suffix.length
    return `${base.length > room ? `${base.slice(0, room - 1)}…` : base}${suffix}`
  }

  /**
   * Merge a branch into its parent, replaying the branch's edits as individual
   * revisions on the parent, then deleting the branch.
   *
   * The branch's revision records cannot be copied across verbatim. Their diffs
   * chain off the branch's own history, and orderRevisions sorts a note's
   * revisions by createdAt while buildNoteContents skips any whose
   * parentRevision is not the running head — so records carrying the branch's
   * original timestamps would sort in among the parent's own and break the
   * chain, silently reconstructing the wrong content. Each branch content state
   * is therefore re-diffed against its predecessor and written fresh: a rebase,
   * not a graft. The original date survives in the revision message.
   *
   * The first replayed step is diffed against the parent's current content, so
   * it absorbs any drift since the branch was taken — the same overwrite the
   * old squash merge performed, just no longer hidden in a single revision.
   */
  async function mergeBranchIntoParent(
    agent: Agent,
    branchNote: LichenNoteWithContent,
    parentNote: LichenNoteWithContent,
  ): Promise<number> {
    assertCanEdit()

    // The first state is the fork copy of the parent, not an edit made on the
    // branch; replaying it would write a revision reverting the parent to the
    // content it had when the branch was taken.
    const states = replayRevisions(branchNote.uri, revisions.value).slice(1)

    // A merge that failed part-way leaves the parent sitting on one of these
    // states with the branch still in place. Resuming after the last state the
    // parent already matches makes a retry pick up where it stopped, instead of
    // walking it back through steps it has taken.
    const done = states.map((state) => state.content).lastIndexOf(parentNote.content)

    let imported = 0
    for (const state of states.slice(done + 1)) {
      if (state.content === parentNote.content) continue
      await saveNoteEdit(
        agent,
        parentNote,
        parentNote.title,
        state.content,
        mergeRevisionMessage(state.revision, branchNote.slug),
        undefined,
        undefined,
        false,
        undefined,
        // A branch state can legitimately be empty (content was removed on
        // the branch); the blank-page guard is for accidental wipes.
        true,
      )
      imported += 1
    }

    // Replay is best-effort: an unreadable branch revision is dropped rather
    // than guessed at, so square up against the branch's final content to
    // guarantee the merge lands exactly what the branch holds.
    if (parentNote.content !== branchNote.content) {
      await saveNoteEdit(
        agent,
        parentNote,
        parentNote.title,
        branchNote.content,
        `Merged from branch ${branchNote.slug}`,
        undefined,
        undefined,
        false,
        undefined,
        true,
      )
      imported += 1
    }

    await removeNote(agent, branchNote)
    return imported
  }

  async function removeNote(agent: Agent, note: LichenNoteWithContent): Promise<void> {
    assertCanEdit()
    const revisionUris = revisions.value
      .filter((item) => item.noteRef === note.uri)
      .map((item) => item.uri)
    await deleteNoteWithRevisions(agent, note.uri, revisionUris, wikiRepoDid())
    notes.value = notes.value.filter((item) => item.uri !== note.uri)
    revisions.value = revisions.value.filter((item) => item.noteRef !== note.uri)
  }

  function patchWikiInList(wiki: LichenWikiRecord): void {
    const index = wikis.value.findIndex((item) => item.uri === wiki.uri)
    if (index >= 0) {
      wikis.value[index] = wiki
    } else {
      wikis.value.push(wiki)
    }
    if (currentWiki.value?.uri === wiki.uri) {
      currentWiki.value = wiki
    }
  }

  function clearLoadedWikiState(wikiUri: string, slug: string): void {
    const handle = ownerHandle.value
    if (handle) clearPublicWikiCache(handle, slug)
    if (forkInfo.value?.forkWikiUri === wikiUri) {
      removeFork(wikiUri)
    }
    if (currentWiki.value?.uri === wikiUri) {
      stopFirehose()
      currentWiki.value = null
      notes.value = []
      revisions.value = []
      access.value = 'none'
      activeWikiScope.value = null
      forkInfo.value = null
      forkChanges.value = []
      cachedFrom.value = null
    }
    memberships.value = memberships.value.filter((item) => item.wikiRef !== wikiUri)
    pageGrants.value = pageGrants.value.filter((item) => item.wikiRef !== wikiUri)
    approvedMedia.value = approvedMedia.value.filter((item) => item.wikiRef !== wikiUri)
    if (policyRecord.value?.wikiRef === wikiUri) policyRecord.value = null
  }

  /** Soft-delete: hide the wiki for 30 days so it can be restored. */
  async function deleteCurrentWiki(agent: Agent): Promise<void> {
    const wiki = currentWiki.value
    if (!wiki) throw new Error('No wiki selected')
    if (wiki.ownerDid !== agent.accountDid) {
      throw new Error('Only the wiki owner can delete it')
    }
    if (isWikiTrashed(wiki)) {
      throw new Error('This wiki is already in the trash')
    }
    if (wiki.redirectSlug) {
      throw new Error('This wiki slug is a redirect and cannot be trashed')
    }

    const trashed: LichenWikiRecord = {
      ...wiki,
      deletedAt: new Date().toISOString(),
      deletedFromVisibility: wiki.visibility,
      visibility: 'private',
    }
    await updateWikiRecord(agent, trashed)
    patchWikiInList(trashed)
    clearLoadedWikiState(wiki.uri, wiki.slug)
  }

  /**
   * Change the wiki URL slug. Creates a new wiki record, rewrites notes/memberships,
   * and leaves the old slug as a redirect stub.
   */
  async function renameCurrentWikiSlug(
    agent: Agent,
    nextSlugRaw: string,
  ): Promise<LichenWikiRecord> {
    const wiki = currentWiki.value
    if (!wiki) throw new Error('No wiki selected')
    if (wiki.ownerDid !== agent.accountDid) {
      throw new Error('Only the wiki owner can change the wiki URL')
    }
    if (isWikiTrashed(wiki) || wiki.redirectSlug) {
      throw new Error('Cannot change the URL of a trashed or redirect wiki')
    }

    const nextSlug = nextSlugRaw.trim().toLowerCase()
    if (!isValidSlug(nextSlug)) {
      throw new Error('URL must use lowercase letters, numbers, and hyphens')
    }
    if (nextSlug === wiki.slug) {
      throw new Error('That is already this wiki’s URL')
    }

    if (wikis.value.some((item) => item.slug === nextSlug)) {
      throw new Error('That URL is already in use')
    }
    const remote = await getWikiBySlug(agent, wiki.ownerDid, nextSlug)
    if (remote) {
      throw new Error('That URL is already in use')
    }

    const oldUri = wiki.uri
    const oldSlug = wiki.slug
    const created = await putWikiAtSlug(agent, nextSlug, wiki)

    await mapWithConcurrency(notes.value, 6, async (note) => {
      await updateNoteWikiRef(agent, note, created.uri)
      note.wikiRef = created.uri
    })

    const wikiMemberships = memberships.value.filter((item) => item.wikiRef === oldUri)
    await mapWithConcurrency(wikiMemberships, 6, async (membership) => {
      const parsed = parseAtUri(membership.uri)
      if (!parsed) return
      const updated = await writeMembershipRecord(
        agent,
        membership.memberDid,
        created.uri,
        membership.role,
        parsed.rkey,
        wiki.ownerDid,
      )
      memberships.value = memberships.value.map((item) =>
        item.uri === membership.uri ? updated : item,
      )
    })

    // Policy, page grants and approved media follow the wiki like memberships do;
    // otherwise the renamed wiki falls back to the default (looser) policy and
    // loses its per-article grants and approved photos.
    const wikiPolicies = (await listPolicies(agent, wiki.ownerDid)).filter(
      (item) => item.wikiRef === oldUri,
    )
    await mapWithConcurrency(wikiPolicies, 6, async (policy) => {
      const parsed = parseAtUri(policy.uri)
      if (!parsed) return
      const updated = await writePolicyRecord(
        agent,
        created.uri,
        {
          editAccess: policy.editAccess,
          suggestionsEnabled: policy.suggestionsEnabled,
          imageMode: policy.imageMode,
          imageSubmissions: policy.imageSubmissions,
        },
        parsed.rkey,
        wiki.ownerDid,
      )
      if (policyRecord.value?.uri === policy.uri) policyRecord.value = updated
    })

    const wikiGrants = (await listPageGrants(agent, wiki.ownerDid)).filter(
      (item) => item.wikiRef === oldUri,
    )
    await mapWithConcurrency(wikiGrants, 6, async (grant) => {
      const parsed = parseAtUri(grant.uri)
      if (!parsed) return
      const updated = await writePageGrantRecord(
        agent,
        created.uri,
        grant.noteSlug,
        grant.memberDid,
        grant.role,
        parsed.rkey,
        wiki.ownerDid,
      )
      pageGrants.value = pageGrants.value.map((item) => (item.uri === grant.uri ? updated : item))
    })

    const wikiMedia = (await listApprovedMedia(agent, wiki.ownerDid)).filter(
      (item) => item.wikiRef === oldUri,
    )
    await mapWithConcurrency(wikiMedia, 6, async (media) => {
      const parsed = parseAtUri(media.uri)
      if (!parsed) return
      const updated = await writeApprovedMediaRecord(
        agent,
        created.uri,
        media.imageCid,
        {
          blob: media.blob,
          mimeType: media.mimeType,
          alt: media.alt,
          addedBy: media.addedBy,
          source: media.source,
        },
        parsed.rkey,
        wiki.ownerDid,
      )
      approvedMedia.value = approvedMedia.value.map((item) =>
        item.uri === media.uri ? updated : item,
      )
    })

    const stub: LichenWikiRecord = {
      uri: oldUri,
      cid: wiki.cid,
      slug: oldSlug,
      ownerDid: wiki.ownerDid,
      name: wiki.name,
      visibility: 'private',
      language: wiki.language,
      createdAt: wiki.createdAt,
      description: `Moved to /${nextSlug}`,
      redirectSlug: nextSlug,
    }
    await updateWikiRecord(agent, stub)

    const handle = ownerHandle.value
    if (handle) {
      clearPublicWikiCache(handle, oldSlug)
    }

    remapWikiWatchRefs(oldUri, {
      wikiUri: created.uri,
      wikiSlug: nextSlug,
      wikiName: created.name,
    })
    remapForkWikiRefs(oldUri, { wikiUri: created.uri, slug: nextSlug })

    try {
      const existing = await findBookmarkForWiki(agent, agent.accountDid, oldUri)
      if (existing) {
        await deleteBookmark(agent, existing.uri)
        await writeBookmark(agent, created.uri)
      }
    } catch {
      // Bookmark rewrite is best-effort
    }

    wikis.value = wikis.value.map((item) => {
      if (item.uri === oldUri) return stub
      return item
    })
    if (!wikis.value.some((item) => item.uri === created.uri)) {
      wikis.value.push(created)
    } else {
      patchWikiInList(created)
    }

    currentWiki.value = created
    if (handle) {
      activeWikiScope.value = `${handle}/${nextSlug}`
    }
    refreshForkInfo()

    return created
  }

  async function restoreWiki(agent: Agent, wiki: LichenWikiRecord): Promise<void> {
    if (wiki.ownerDid !== agent.accountDid) {
      throw new Error('Only the wiki owner can restore it')
    }
    if (!isWikiTrashed(wiki)) return
    if (isWikiTrashExpired(wiki)) {
      throw new Error('This wiki can no longer be restored')
    }

    const restored: LichenWikiRecord = {
      ...wiki,
      visibility: wiki.deletedFromVisibility ?? wiki.visibility,
      deletedAt: undefined,
      deletedFromVisibility: undefined,
    }
    await updateWikiRecord(agent, restored)
    patchWikiInList(restored)
  }

  async function hardDeleteWikiRecords(agent: Agent, wiki: LichenWikiRecord): Promise<void> {
    // Only `.uri` is read here, so the bare record type is enough — and it is
    // what the listNotes refresh below assigns.
    let wikiNotes: LichenNoteRecord[] = notes.value.filter((note) => note.wikiRef === wiki.uri)
    let wikiRevisions = revisions.value.filter((item) =>
      wikiNotes.some((note) => note.uri === item.noteRef),
    )
    let wikiMemberships = memberships.value.filter((item) => item.wikiRef === wiki.uri)

    if (currentWiki.value?.uri !== wiki.uri) {
      const [allNotes, allRevisions, allMemberships] = await Promise.all([
        listNotes(agent, wiki.ownerDid),
        listRevisions(agent, wiki.ownerDid),
        listMemberships(agent, wiki.ownerDid),
      ])
      wikiNotes = allNotes.filter((note) => note.wikiRef === wiki.uri)
      const noteUris = new Set(wikiNotes.map((note) => note.uri))
      wikiRevisions = allRevisions.filter((item) => noteUris.has(item.noteRef))
      wikiMemberships = allMemberships.filter((item) => item.wikiRef === wiki.uri)
    }

    await mapWithConcurrency(wikiRevisions, 6, async (revision) => {
      await deleteRevisionRecord(agent, revision.uri)
    })
    await mapWithConcurrency(wikiNotes, 6, async (note) => {
      await deleteNoteRecord(agent, note.uri)
    })
    await mapWithConcurrency(wikiMemberships, 6, async (membership) => {
      await deleteMembershipRecord(agent, membership.uri)
    })

    // Policy, page grants and approved media point at the wiki by at-uri, and
    // the at-uri is slug-derived — left behind, they would silently apply again
    // to a new wiki created later under the same slug. Always read them from
    // the repo: in-memory state only covers the currently loaded wiki.
    const [allPolicies, allGrants, allMedia] = await Promise.all([
      listPolicies(agent, wiki.ownerDid),
      listPageGrants(agent, wiki.ownerDid),
      listApprovedMedia(agent, wiki.ownerDid),
    ])
    await mapWithConcurrency(
      allPolicies.filter((item) => item.wikiRef === wiki.uri),
      6,
      async (policy) => deletePolicyRecord(agent, policy.uri),
    )
    await mapWithConcurrency(
      allGrants.filter((item) => item.wikiRef === wiki.uri),
      6,
      async (grant) => deletePageGrantRecord(agent, grant.uri),
    )
    await mapWithConcurrency(
      allMedia.filter((item) => item.wikiRef === wiki.uri),
      6,
      async (media) => deleteApprovedMediaRecord(agent, media.uri),
    )
    await deleteWikiRecord(agent, wiki)
  }

  /** Permanently delete a wiki (notes, revisions, memberships, record). */
  async function purgeWiki(agent: Agent, wiki: LichenWikiRecord): Promise<void> {
    if (wiki.ownerDid !== agent.accountDid) {
      throw new Error('Only the wiki owner can permanently delete it')
    }
    await hardDeleteWikiRecords(agent, wiki)
    wikis.value = wikis.value.filter((item) => item.uri !== wiki.uri)
    clearLoadedWikiState(wiki.uri, wiki.slug)
  }

  /** Hard-delete trashed wikis past the restore window. Safe to call on dashboard load. */
  async function purgeExpiredTrashedWikis(agent: Agent): Promise<void> {
    const expired = wikis.value.filter((wiki) => isWikiTrashExpired(wiki))
    for (const wiki of expired) {
      try {
        await purgeWiki(agent, wiki)
      } catch {
        // Keep trying others; owner can retry later
      }
    }
  }

  async function setWikiTheme(
    agent: Agent,
    theme: LichenWikiRecord['theme'] | WikiThemeFields,
  ): Promise<void> {
    if (!currentWiki.value) return
    const fields: WikiThemeFields =
      theme === undefined || typeof theme === 'string' ? { theme } : theme
    await updateWikiTheme(agent, currentWiki.value, fields)
    const wiki = currentWiki.value
    if ('theme' in fields) wiki.theme = fields.theme
    if ('accentColor' in fields) wiki.accentColor = fields.accentColor
    if ('bgColor' in fields) wiki.bgColor = fields.bgColor
    if ('cardColor' in fields) wiki.cardColor = fields.cardColor
    if ('sidebarColor' in fields) wiki.sidebarColor = fields.sidebarColor
    if ('headerColor' in fields) wiki.headerColor = fields.headerColor
    if ('fontFamily' in fields) wiki.fontFamily = fields.fontFamily
    if ('layoutWidth' in fields) wiki.layoutWidth = fields.layoutWidth
  }

  async function setWikiHeaderLinks(
    agent: Agent,
    headerLinks: LichenWikiRecord['headerLinks'],
  ): Promise<void> {
    if (!currentWiki.value) throw new Error('No wiki selected')
    const links = headerLinks ?? []
    await updateWikiHeaderLinks(agent, currentWiki.value, links)
    currentWiki.value.headerLinks = links.length ? links : undefined

    const handle = ownerHandle.value
    if (handle) {
      const cached = getPublicWikiCache(handle, currentWiki.value.slug, Number.POSITIVE_INFINITY)
      if (cached?.wiki) {
        setPublicWikiCache({
          ...cached,
          wiki: { ...cached.wiki, headerLinks: currentWiki.value.headerLinks },
          fetchedAt: Date.now(),
        })
      } else {
        clearPublicWikiCache(handle, currentWiki.value.slug)
      }
    }
  }

  async function setWikiNavbarLinks(
    agent: Agent,
    navbarLinks: LichenWikiRecord['navbarLinks'],
  ): Promise<void> {
    if (!currentWiki.value) throw new Error('No wiki selected')
    const links = navbarLinks ?? []
    await updateWikiNavbarLinks(agent, currentWiki.value, links)
    currentWiki.value.navbarLinks = links.length ? links : undefined

    const handle = ownerHandle.value
    if (handle) {
      const cached = getPublicWikiCache(handle, currentWiki.value.slug, Number.POSITIVE_INFINITY)
      if (cached?.wiki) {
        setPublicWikiCache({
          ...cached,
          wiki: { ...cached.wiki, navbarLinks: currentWiki.value.navbarLinks },
          fetchedAt: Date.now(),
        })
      } else {
        clearPublicWikiCache(handle, currentWiki.value.slug)
      }
    }
  }

  async function setWikiSidebarOrder(agent: Agent, sidebarOrder: string[]): Promise<void> {
    if (!currentWiki.value) throw new Error('No wiki selected')
    const order = sidebarOrder.filter((slug) => slug.trim()).map((slug) => slug.trim())
    await updateWikiSidebarOrder(agent, currentWiki.value, order)
    // Keep empty arrays — they mean "customized, show nothing".
    currentWiki.value.sidebarOrder = order

    const handle = ownerHandle.value
    if (handle) {
      const cached = getPublicWikiCache(handle, currentWiki.value.slug, Number.POSITIVE_INFINITY)
      if (cached?.wiki) {
        setPublicWikiCache({
          ...cached,
          wiki: { ...cached.wiki, sidebarOrder: currentWiki.value.sidebarOrder },
          fetchedAt: Date.now(),
        })
      } else {
        clearPublicWikiCache(handle, currentWiki.value.slug)
      }
    }
  }

  async function setNoteSubheaderLinks(
    agent: Agent,
    note: LichenNoteWithContent,
    subheaderLinks: LichenNoteRecord['subheaderLinks'],
  ): Promise<void> {
    assertCanEdit()
    if (!currentWiki.value) throw new Error('No wiki selected')
    const links = subheaderLinks ?? []
    await updateNoteSubheaderLinks(agent, note, links)
    note.subheaderLinks = links.length ? links : undefined

    const handle = ownerHandle.value
    if (handle) {
      const cached = getPublicWikiCache(handle, currentWiki.value.slug, Number.POSITIVE_INFINITY)
      if (cached) {
        const nextNotes = notes.value
        setPublicWikiCache({
          ...cached,
          noteRecords: nextNotes,
          notesWithContent: nextNotes,
          fetchedAt: Date.now(),
        })
      } else {
        clearPublicWikiCache(handle, currentWiki.value.slug)
      }
    }
  }

  /** Set or clear a note's sidebar label. Empty string clears back to `title`. */
  async function setNoteNavTitle(
    agent: Agent,
    note: LichenNoteWithContent,
    navTitle: string,
  ): Promise<void> {
    assertCanEdit()
    if (!currentWiki.value) throw new Error('No wiki selected')
    const trimmed = navTitle.trim() || undefined
    await updateNoteNavTitle(agent, note, trimmed)
    note.navTitle = trimmed

    const handle = ownerHandle.value
    if (handle) {
      const cached = getPublicWikiCache(handle, currentWiki.value.slug, Number.POSITIVE_INFINITY)
      if (cached) {
        const nextNotes = notes.value
        setPublicWikiCache({
          ...cached,
          noteRecords: nextNotes,
          notesWithContent: nextNotes,
          fetchedAt: Date.now(),
        })
      } else {
        clearPublicWikiCache(handle, currentWiki.value.slug)
      }
    }
  }

  async function setWikiHeaderImage(
    agent: Agent,
    headerImage: LichenWikiRecord['headerImage'] | undefined,
  ): Promise<void> {
    if (!currentWiki.value) throw new Error('No wiki selected')
    await updateWikiHeaderImage(agent, currentWiki.value, headerImage)
    currentWiki.value.headerImage = headerImage

    const handle = ownerHandle.value
    if (handle) {
      const cached = getPublicWikiCache(handle, currentWiki.value.slug, Number.POSITIVE_INFINITY)
      if (cached?.wiki) {
        setPublicWikiCache({
          ...cached,
          wiki: { ...cached.wiki, headerImage: currentWiki.value.headerImage },
          fetchedAt: Date.now(),
        })
      } else {
        clearPublicWikiCache(handle, currentWiki.value.slug)
      }
    }
  }

  async function setWikiVisibility(
    agent: Agent,
    visibility: LichenWikiRecord['visibility'],
  ): Promise<void> {
    if (!currentWiki.value) return
    await updateWikiVisibility(agent, currentWiki.value, visibility)
    currentWiki.value.visibility = visibility
    await resolveAccess(agent, currentWiki.value, agent.accountDid)
  }

  async function setWikiName(
    agent: Agent,
    wiki: LichenWikiRecord,
    name: string,
  ): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Wiki name is required')
    if (trimmed.length > 256) throw new Error('Wiki name is too long')
    if (trimmed === wiki.name) return

    await updateWikiName(agent, wiki, trimmed)

    const index = wikis.value.findIndex((item) => item.uri === wiki.uri)
    if (index >= 0) {
      wikis.value[index] = { ...wikis.value[index]!, name: trimmed }
    }
    if (currentWiki.value?.uri === wiki.uri) {
      currentWiki.value = { ...currentWiki.value, name: trimmed }
    }

    const handle = ownerHandle.value
    if (handle) {
      const cached = getPublicWikiCache(handle, wiki.slug, Number.POSITIVE_INFINITY)
      if (cached?.wiki) {
        setPublicWikiCache({
          ...cached,
          wiki: { ...cached.wiki, name: trimmed },
          fetchedAt: Date.now(),
        })
      }
    }
  }

  async function addMember(
    agent: Agent,
    memberDid: string,
    role: MemberRole,
  ): Promise<void> {
    if (!currentWiki.value) return
    const trimmed = memberDid.trim()
    const exists = memberships.value.some(
      (item) => item.wikiRef === currentWiki.value!.uri && item.memberDid === trimmed,
    )
    if (exists) {
      throw new Error('This member already has access to the wiki')
    }
    const membership = await writeMembershipRecord(
      agent,
      trimmed,
      currentWiki.value.uri,
      role,
      undefined,
      currentWiki.value.ownerDid,
    )
    memberships.value.push(membership)
  }

  async function updateMemberRole(
    agent: Agent,
    membershipUri: string,
    role: MemberRole,
  ): Promise<void> {
    const existing = memberships.value.find((item) => item.uri === membershipUri)
    if (!existing || !currentWiki.value) return
    const updated = await updateMembershipRole(agent, existing, role)
    memberships.value = memberships.value.map((item) =>
      item.uri === membershipUri ? updated : item,
    )
  }

  async function removeMember(agent: Agent, membershipUri: string): Promise<void> {
    await deleteMembershipRecord(agent, membershipUri)
    memberships.value = memberships.value.filter((item) => item.uri !== membershipUri)
  }

  // ---------------------------------------------------------------------
  // Collaboration policy, page grants, approved media, suggestions
  // ---------------------------------------------------------------------

  /** Create or update the wiki's collaboration policy record. */
  async function setWikiPolicy(agent: Agent, fields: PolicyFields): Promise<void> {
    if (!currentWiki.value) throw new Error('No wiki selected')
    const existing = policyRecord.value?.wikiRef === currentWiki.value.uri
      ? policyRecord.value
      : null
    const saved = existing
      ? await updatePolicyRecord(agent, existing, fields)
      : await writePolicyRecord(agent, currentWiki.value.uri, fields)
    policyRecord.value = saved
    await resolveAccess(agent, currentWiki.value, currentViewerDid.value)
  }

  async function addPageGrant(
    agent: Agent,
    noteSlug: string,
    memberDid: string,
    role: PageGrantRole,
  ): Promise<void> {
    if (!currentWiki.value) throw new Error('No wiki selected')
    const trimmed = memberDid.trim()
    const duplicate = pageGrants.value.some(
      (item) =>
        item.wikiRef === currentWiki.value!.uri &&
        item.noteSlug === noteSlug &&
        item.memberDid === trimmed,
    )
    if (duplicate) {
      throw new Error('This member already has a grant on that article')
    }
    const grant = await writePageGrantRecord(
      agent,
      currentWiki.value.uri,
      noteSlug,
      trimmed,
      role,
      undefined,
      currentWiki.value.ownerDid,
    )
    pageGrants.value = [...pageGrants.value, grant]
  }

  async function removePageGrant(agent: Agent, grantUri: string): Promise<void> {
    await deletePageGrantRecord(agent, grantUri)
    pageGrants.value = pageGrants.value.filter((item) => item.uri !== grantUri)
  }

  async function addApprovedMedia(
    agent: Agent,
    imageCid: string,
    options: {
      blob?: unknown
      mimeType?: string
      alt?: string
      addedBy?: string
      source?: 'owner' | 'submission'
    } = {},
  ): Promise<LichenApprovedMediaRecord> {
    if (!currentWiki.value) throw new Error('No wiki selected')
    if (approvedMedia.value.some((item) => item.imageCid === imageCid)) {
      return approvedMedia.value.find((item) => item.imageCid === imageCid)!
    }
    const record = await writeApprovedMediaRecord(
      agent,
      currentWiki.value.uri,
      imageCid,
      options,
      undefined,
      currentWiki.value.ownerDid,
    )
    approvedMedia.value = [...approvedMedia.value, record]
    return record
  }

  async function removeApprovedMedia(agent: Agent, mediaUri: string): Promise<void> {
    await deleteApprovedMediaRecord(agent, mediaUri)
    approvedMedia.value = approvedMedia.value.filter((item) => item.uri !== mediaUri)
  }

  /**
   * File a suggestion against the current wiki. The record is written to the
   * signed-in user's own repo — the only repo they can write to — and picked
   * up by the wiki's review queue via Constellation. Authorisation is checked
   * against the target article so per-article grants count.
   */
  async function submitSuggestion(
    agent: Agent,
    input: Omit<SuggestionInput, 'wikiRef'>,
  ): Promise<LichenSuggestionRecord> {
    if (!currentWiki.value) throw new Error('No wiki selected')
    if (!capabilitiesForNote(input.noteSlug).canSuggest) {
      throw new Error('This wiki does not accept suggestions from your account')
    }
    return writeSuggestionRecord(agent, { ...input, wikiRef: currentWiki.value.uri })
  }

  async function refreshIncomingSuggestions(agent: Agent): Promise<void> {
    if (!currentWiki.value) return
    suggestionsLoading.value = true
    try {
      incomingSuggestions.value = await listIncomingSuggestions(
        agent,
        currentWiki.value.uri,
      )
    } catch {
      incomingSuggestions.value = []
    } finally {
      suggestionsLoading.value = false
    }
  }

  /**
   * Publish an approved suggestion into the wiki. Only the wiki owner's
   * session can do this — publishing means writing to their repo.
   *
   * Photo blobs in a suggestion live in the author's repo, so they are copied
   * here first: fetch from the author's PDS, re-upload to the wiki repo, and
   * rewrite the `blob:CID` embeds in the content before the revision lands.
   * Copied photos are registered as approved media so approved-only wikis
   * keep accepting them.
   */
  async function approveSuggestion(
    agent: Agent,
    suggestion: LichenSuggestionRecord,
  ): Promise<void> {
    const wiki = currentWiki.value
    if (!wiki) throw new Error('No wiki selected')
    if (wiki.ownerDid !== agent.accountDid) {
      throw new Error('Only the wiki owner can publish approved suggestions')
    }

    if (suggestion.kind === 'image') {
      for (const blobRef of suggestion.blobs ?? []) {
        const { imageCid, blob } = await transferBlob(agent, suggestion.authorDid, blobRef)
        await addApprovedMedia(agent, imageCid, {
          blob,
          mimeType: (blob as { mimeType?: string }).mimeType,
          alt: suggestion.alt,
          addedBy: suggestion.authorDid,
          source: 'submission',
        })
      }
      return
    }

    let content = suggestion.content ?? ''
    if (!content.trim()) throw new Error('The suggestion has no content to publish')

    // Transfer the blobs the author embedded (uploaded to their own PDS). Only
    // CIDs the approved content actually embeds are copied: the review screen
    // shows the text diff, so an unreferenced entry in `blobs` is an image the
    // owner never saw and must not land in the wiki repo or approved media.
    for (const blobRef of suggestion.blobs ?? []) {
      const json = blobRefToJson(blobRef)
      const oldCid =
        (json?.ref as { $link?: string } | undefined)?.$link ?? undefined
      if (!oldCid || !content.includes(`blob:${oldCid}`)) continue
      const { imageCid, blob } = await transferBlob(agent, suggestion.authorDid, blobRef, oldCid)
      content = rewriteBlobCid(content, oldCid, imageCid)
      await addApprovedMedia(agent, imageCid, {
        blob,
        mimeType: (blob as { mimeType?: string }).mimeType,
        alt: suggestion.alt,
        addedBy: suggestion.authorDid,
        source: 'submission',
      })
    }

    const existingNote = notes.value.find(
      (note) => note.slug === suggestion.noteSlug && note.wikiRef === wiki.uri,
    )
    const attribution = `Accepted suggestion from ${suggestion.authorDid}`
    if (existingNote) {
      await saveNoteEdit(
        agent,
        existingNote,
        suggestion.title?.trim() || existingNote.title,
        content,
        suggestion.message ? `${attribution}: ${suggestion.message}` : attribution,
        existingNote.latestRevisionUri,
        existingNote.content,
        false,
      )
    } else {
      await createNoteWithSlug(
        agent,
        suggestion.noteSlug,
        suggestion.title?.trim() || suggestion.noteSlug,
        content,
        attribution,
      )
    }
  }

  function rejectIncomingSuggestion(suggestion: LichenSuggestionRecord): void {
    rejectSuggestionLocally(suggestion.uri)
    incomingSuggestions.value = incomingSuggestions.value.filter(
      (item) => item.uri !== suggestion.uri,
    )
  }

  function getNoteBySlug(slug: string): LichenNoteWithContent | undefined {
    if (!slug) return undefined
    const exact = notes.value.find((note) => note.slug === slug)
    if (exact) return exact

    // URLs are matched case-insensitively (and after normalize), so /Foo and /foo
    // resolve to the same page.
    const normalized = normalizeArticleSlug(slug)
    if (normalized && normalized !== slug) {
      const byNormalized = notes.value.find((note) => note.slug === normalized)
      if (byNormalized) return byNormalized
    }

    const lower = slug.toLowerCase()
    return notes.value.find((note) => note.slug.toLowerCase() === lower)
  }

  function getResolvedNote(slug: string): LichenNoteWithContent | null {
    const note = getNoteBySlug(slug)
    if (!note) return null
    const resolved = resolveRedirectTarget(note, notes.value)
    return resolved ?? note
  }

  function getBlogStubSuggestions(): BlogStubSuggestion[] {
    return findBlogStubSuggestions(blogPosts.value, notes.value)
  }

  async function createBlogStub(
    agent: Agent,
    suggestion: BlogStubSuggestion,
  ): Promise<LichenNoteWithContent> {
    if (!currentWiki.value) throw new Error('No wiki selected')
    assertCanEdit()
    const blogUrl = documentToPcktBlogUrl(suggestion.post, publications.value[0]?.url)
    const content = defaultBlogStubContent(suggestion.post, blogUrl)
    const repoDid = wikiRepoDid()
    const note = await writeNoteRecord(
      agent,
      suggestion.suggestedSlug,
      suggestion.post.title ?? 'Blog post',
      currentWiki.value.uri,
      undefined,
      repoDid,
    )
    const revision = await writeRevisionRecord(
      agent,
      note.uri,
      '',
      content,
      null,
      'Blog stub from pckt.blog',
      undefined,
      repoDid,
    )
    const withContent: LichenNoteWithContent = {
      ...note,
      content,
      latestRevisionUri: revision.uri,
    }
    notes.value.push(withContent)
    revisions.value.push(revision)
    return withContent
  }

  async function createAllBlogStubs(agent: Agent): Promise<number> {
    const suggestions = getBlogStubSuggestions()
    let created = 0
    for (const suggestion of suggestions) {
      await createBlogStub(agent, suggestion)
      created += 1
    }
    return created
  }

  async function forkCurrentWiki(
    agent: Agent,
    options: {
      name?: string
      autoSync: boolean
      forkHandle: string
      visibility?: LichenWikiRecord['visibility']
    },
  ): Promise<LichenWikiRecord> {
    if (!currentWiki.value) throw new Error('No wiki to fork')
    if (forkInfo.value) throw new Error('This wiki is already a fork')

    forking.value = true
    forkProgress.value = null
    try {
      const source = currentWikiAsPublicEntry()
      const slug = uniqueSlug(
        options.name?.trim() || currentWiki.value.name,
        wikis.value.map((wiki) => wiki.slug),
      )
      const { wiki, baselines } = await forkWikiRecords(agent, source, {
        slug,
        name: options.name,
        visibility: options.visibility,
        onProgress: (progress) => {
          forkProgress.value = progress
        },
      })
      wikis.value.push(wiki)
      const record = buildForkRecord({
        wiki,
        forkHandle: options.forkHandle,
        source,
        baselines,
        autoSync: options.autoSync,
      })
      saveFork(record)
      return wiki
    } finally {
      forking.value = false
      forkProgress.value = null
    }
  }

  async function applyAcceptChange(agent: Agent, change: ForkChange, contentOverride?: string): Promise<void> {
    const info = forkInfo.value
    if (!info) throw new Error('This wiki is not a fork')
    const note = notes.value.find((item) => item.slug === change.slug)
    const content = contentOverride ?? change.theirs

    if (change.type === 'removed') {
      if (note) await removeNote(agent, note)
      removeForkBaseline(info.forkWikiUri, change.slug)
      refreshForkInfo()
      return
    }

    if (note) {
      await saveNoteEdit(agent, note, note.title, content, 'Synced from upstream')
    } else {
      await createNoteWithSlug(agent, change.slug, change.title, content, 'Synced from upstream')
    }
    setForkBaseline(info.forkWikiUri, change.slug, {
      sourceContent: change.theirs,
      sourceRevisionUri: change.sourceRevisionUri,
    })
    refreshForkInfo()
  }

  async function acceptForkChange(
    agent: Agent,
    change: ForkChange,
    contentOverride?: string,
  ): Promise<void> {
    await applyAcceptChange(agent, change, contentOverride)
    forkChanges.value = forkChanges.value.filter((item) => item.slug !== change.slug)
  }

  async function acceptAllNonConflicting(agent: Agent): Promise<number> {
    const toAccept = forkChanges.value.filter((c) => !c.conflicted)
    for (const change of toAccept) {
      await applyAcceptChange(agent, change)
    }
    forkChanges.value = forkChanges.value.filter((c) => c.conflicted)
    return toAccept.length
  }

  function denyForkChange(change: ForkChange): void {
    const info = forkInfo.value
    if (!info) return
    if (change.type === 'removed') {
      // Keep your copy and stop tracking the note from upstream.
      removeForkBaseline(info.forkWikiUri, change.slug)
    } else {
      // Keep your version but advance the merge base so it won't re-prompt.
      setForkBaseline(info.forkWikiUri, change.slug, {
        sourceContent: change.theirs,
        sourceRevisionUri: change.sourceRevisionUri,
      })
    }
    forkChanges.value = forkChanges.value.filter((item) => item.slug !== change.slug)
    refreshForkInfo()
  }

  async function checkForkUpdates(agent: Agent | null): Promise<void> {
    const info = forkInfo.value
    if (!info) return
    forkChecking.value = true
    try {
      const { loadPublicWikiData } = await import('@/lib/lichen/load-public-wiki')
      const source = await loadPublicWikiData(info.sourceHandle, info.sourceSlug, {
        force: true,
      })
      let changes = computeForkChanges(info, source.notesWithContent, notes.value)

      if (info.autoSync && agent) {
        for (const change of changes.filter((item) => !item.conflicted)) {
          await applyAcceptChange(agent, change)
        }
        refreshForkInfo()
        if (forkInfo.value) {
          changes = computeForkChanges(forkInfo.value, source.notesWithContent, notes.value)
        }
      }

      forkChanges.value = changes
      updateFork(info.forkWikiUri, { lastCheckedAt: new Date().toISOString() })
      refreshForkInfo()
    } finally {
      forkChecking.value = false
    }
  }

  function setForkAutoSyncPref(autoSync: boolean): void {
    if (!forkInfo.value) return
    setForkAutoSync(forkInfo.value.forkWikiUri, autoSync)
    refreshForkInfo()
  }

  function detachFork(): void {
    if (!forkInfo.value) return
    removeFork(forkInfo.value.forkWikiUri)
    forkChanges.value = []
    refreshForkInfo()
  }

  function getWikiTimeline(): WikiVersionEntry[] {
    return buildWikiTimeline(notes.value, revisions.value)
  }

  function getRewindPlan(targetTime: string): WikiRewindPlan {
    return planWikiRewind(notes.value, revisions.value, targetTime)
  }

  function getWikiContentAtTime(noteRef: string, targetTime: string): string | null {
    return reconstructNoteAtTime(noteRef, revisions.value, targetTime)
  }

  async function rewindWikiToTime(agent: Agent, targetTime: string): Promise<void> {
    if (!currentWiki.value) throw new Error('No wiki selected')
    assertCanEdit()
    const plan = planWikiRewind(notes.value, revisions.value, targetTime)
    const label = new Date(targetTime).toLocaleString()
    for (const state of plan.restore) {
      await saveNoteEdit(
        agent,
        state.note,
        state.note.title,
        state.contentAtTime,
        `Rewound to ${label}`,
        undefined,
        undefined,
        false,
        undefined,
        // Rewinding to a moment when the page was empty is intentional.
        true,
      )
    }
    for (const state of plan.remove) {
      await removeNote(agent, state.note)
    }
  }

  async function processOfflineQueue(agent: Agent): Promise<number> {
    if (!isOnline()) return 0
    const pending = getPendingEdits()
    let synced = 0

    for (const edit of pending) {
      try {
        const note = notes.value.find((item) => item.uri === edit.noteUri)
        if (!note) {
          removePendingEdit(edit.id)
          continue
        }
        const oldContent = note.content
        await saveNoteEdit(
          agent,
          note,
          edit.title,
          edit.content,
          edit.message,
          note.latestRevisionUri,
          oldContent,
        )
        removePendingEdit(edit.id)
        synced += 1
      } catch {
        // Keep in queue for next attempt
      }
    }

    return synced
  }

  async function queueOrSaveNoteEdit(
    agent: Agent,
    note: LichenNoteWithContent,
    title: string,
    content: string,
    message?: string,
    handle?: string,
    wikiSlug?: string,
    blobs?: Array<Record<string, unknown>>,
  ): Promise<'saved' | 'queued'> {
    // Only the owner's session can write to the wiki's repo. Every other
    // contributor — members included — files a suggestion on their own repo
    // for the review queue instead. The image policy is enforced here too, so
    // the inline editors cannot smuggle fresh images past the photo ladder.
    if (currentWiki.value && agent.accountDid !== currentWiki.value.ownerDid) {
      const caps = capabilitiesForNote(note.slug)
      const disallowed = findDisallowedImages(
        note.content,
        content,
        approvedMedia.value,
        caps.imageMode,
      )
      if (disallowed.length) {
        throw new Error(
          caps.imageMode === 'none'
            ? 'This wiki only accepts text-only edits'
            : 'This wiki only allows approved photos — remove the new images you added',
        )
      }
      await submitSuggestion(agent, {
        noteSlug: note.slug,
        kind: 'edit',
        content,
        title: title !== note.title ? title : undefined,
        baseRevision: note.latestRevisionUri ?? undefined,
        message: message?.trim() || undefined,
        blobs,
      })
      return 'saved'
    }
    assertCanEdit()
    if (!isOnline()) {
      queueEdit({
        handle: handle ?? ownerHandle.value ?? '',
        wikiSlug: wikiSlug ?? currentWiki.value?.slug ?? '',
        noteSlug: note.slug,
        noteUri: note.uri,
        title,
        content,
        message,
        latestRevisionUri: note.latestRevisionUri,
      })
      note.content = content
      note.title = title
      clearNoteDamage(note)
      persistCurrentWikiContentCache()
      return 'queued'
    }

    await saveNoteEdit(
      agent,
      note,
      title,
      content,
      message,
      note.latestRevisionUri,
      note.content,
      false,
      blobs,
    )
    return 'saved'
  }

  function getBacklinksFor(slug: string): Backlink[] {
    return getBacklinksForNote(backlinks.value, slug)
  }

  /**
   * Load any revisions the newest-first page-view fetch skipped. Pages that
   * read deep history (page history, wiki versions, rewind, merges,
   * suggestions) call this first; it's a no-op when the last load already
   * covered the whole chain.
   */
  async function ensureFullHistory(agent: Agent | null): Promise<void> {
    const wiki = currentWiki.value
    if (!wiki || fullHistoryLoaded.value || fullHistoryLoading.value) return
    const readAgent = agent ?? getPublicAgent()
    fullHistoryLoading.value = true
    try {
      const all = await listRevisions(readAgent, wiki.ownerDid)
      fullHistoryLoaded.value = true
      revisions.value = all.filter((revision) => {
        const note = notes.value.find((item) => item.uri === revision.noteRef)
        return note?.wikiRef === wiki.uri
      })
      const contents = buildNoteContents(revisions.value)
      notes.value = attachContentToNotes(
        notes.value.map(({ content: _content, latestRevisionUri: _lru, ...record }) => record),
        contents,
      )
    } finally {
      fullHistoryLoading.value = false
    }
  }

  function getHistory(noteRef: string): LichenRevisionRecord[] {
    return listRevisionHistory(noteRef, revisions.value)
  }

  function getContentAtRevision(noteRef: string, revisionUri: string): string {
    return reconstructAtRevision(noteRef, revisionUri, revisions.value)
  }

  function reset() {
    stopFirehose()
    wikis.value = []
    currentWiki.value = null
    notes.value = []
    revisions.value = []
    fullHistoryLoaded.value = false
    fullHistoryLoading.value = false
    memberships.value = []
    policyRecord.value = null
    pageGrants.value = []
    approvedMedia.value = []
    capabilities.value = {
      canRead: false,
      canPublish: false,
      canSuggest: false,
      imageMode: 'none',
      canSubmitImages: false,
      canManageWiki: false,
      canReviewPage: false,
    }
    incomingSuggestions.value = []
    currentViewerDid.value = null
    profile.value = null
    ownerHandle.value = null
    blogPosts.value = []
    publications.value = []
    access.value = 'none'
    error.value = null
    activeWikiScope.value = null
    forkInfo.value = null
    forkChanges.value = []
    forkChecking.value = false
    forking.value = false
    forkProgress.value = null
    cachedFrom.value = null
  }

  return {
    wikis,
    activeWikis,
    trashedWikis,
    currentWiki,
    activeWikiScope,
    notes,
    revisions,
    memberships,
    policyRecord,
    pageGrants,
    approvedMedia,
    capabilities,
    incomingSuggestions,
    suggestionsLoading,
    profile,
    ownerHandle,
    blogPosts,
    publications,
    loading,
    saving,
    error,
    access,
    backlinks,
    forkInfo,
    forkChanges,
    forkChecking,
    forking,
    forkProgress,
    cachedFrom,
    loadOwnerWikis,
    loadWiki,
    failLoad,
    consumeWikiRedirectSlug,
    createWiki,
    createNote,
    createNoteWithSlug,
    saveNoteEdit,
    acceptCurrentNoteContent,
    removeNote,
    mergeBranchIntoParent,
    countMergeableRevisions,
    migrateBranchSlug,
    deleteCurrentWiki,
    renameCurrentWikiSlug,
    restoreWiki,
    purgeWiki,
    purgeExpiredTrashedWikis,
    setWikiVisibility,
    setWikiName,
    setWikiTheme,
    setWikiHeaderLinks,
    setWikiNavbarLinks,
    setWikiSidebarOrder,
    setNoteSubheaderLinks,
    setNoteNavTitle,
    setWikiHeaderImage,
    addMember,
    updateMemberRole,
    removeMember,
    setWikiPolicy,
    addPageGrant,
    removePageGrant,
    addApprovedMedia,
    removeApprovedMedia,
    submitSuggestion,
    refreshIncomingSuggestions,
    approveSuggestion,
    rejectIncomingSuggestion,
    capabilitiesForNote,
    getNoteBySlug,
    getResolvedNote,
    getBlogStubSuggestions,
    createBlogStub,
    createAllBlogStubs,
    processOfflineQueue,
    queueOrSaveNoteEdit,
    getBacklinksFor,
    getHistory,
    ensureFullHistory,
    getContentAtRevision,
    forkCurrentWiki,
    checkForkUpdates,
    acceptForkChange,
    acceptAllNonConflicting,
    denyForkChange,
    setForkAutoSyncPref,
    detachFork,
    refreshForkInfo,
    rehydrateForkInfo,
    getWikiTimeline,
    getRewindPlan,
    getWikiContentAtTime,
    rewindWikiToTime,
    reset,
  }
})
