import { computed, onMounted, ref, shallowRef } from 'vue'
import {
  buildPortalWikiSelection,
  featuredSnapshotAgeMs,
  getWikiPortalStats,
  loadFeaturedWikis,
  sortWikisByNoteCount,
  type FeaturedWiki,
  type PortalWikiSelection,
} from '@/lib/lichen/featured-wiki-loader'

/** Snapshots older than this get a quiet network refresh after first paint. */
const SNAPSHOT_REFRESH_AFTER_MS = 30 * 60 * 1000

const wikis = shallowRef<FeaturedWiki[]>([])
const loading = ref(false)
const loaded = ref(false)
let sharedLoad: Promise<FeaturedWiki[]> | null = null

function ensureFeaturedWikis(force = false): Promise<FeaturedWiki[]> {
  if (!force && loaded.value) return Promise.resolve(wikis.value)
  if (!force && sharedLoad) return sharedLoad

  loading.value = true
  sharedLoad = loadFeaturedWikis({ force })
    .then((result) => {
      wikis.value = result
      loaded.value = true
      return result
    })
    .finally(() => {
      loading.value = false
      sharedLoad = null
    })

  return sharedLoad
}

function portalSelectionFromCache(): PortalWikiSelection | null {
  return loaded.value ? buildPortalWikiSelection(wikis.value) : null
}

/**
 * Instant snapshot, current data shortly after: when the committed snapshot is
 * getting old, fetch the live wikis without blocking the first paint.
 */
function refreshWhenSnapshotStale(onFresh: (wikis: FeaturedWiki[]) => void): void {
  if (featuredSnapshotAgeMs() <= SNAPSHOT_REFRESH_AFTER_MS) return
  void ensureFeaturedWikis(true)
    .then(onFresh)
    .catch(() => {
      /* keep showing the snapshot */
    })
}

export function useFeaturedWikis() {
  const portalSelection = ref<PortalWikiSelection | null>(portalSelectionFromCache())

  onMounted(() => {
    void ensureFeaturedWikis().then((list) => {
      portalSelection.value = buildPortalWikiSelection(list)
      refreshWhenSnapshotStale((fresh) => {
        portalSelection.value = buildPortalWikiSelection(fresh)
      })
    })
  })

  const stats = computed(() => getWikiPortalStats(wikis.value))
  const sortedWikis = computed(() => sortWikisByNoteCount(wikis.value))

  return {
    wikis,
    loading,
    loaded,
    portalSelection,
    stats,
    sortedWikis,
    refresh: () => ensureFeaturedWikis(true),
  }
}

export function useFeaturedWikisList() {
  onMounted(() => {
    void ensureFeaturedWikis().then(() => {
      refreshWhenSnapshotStale(() => {
        /* `wikis` is the shared ref; the refresh already replaced it */
      })
    })
  })

  return {
    wikis,
    loading,
    loaded,
    refresh: () => ensureFeaturedWikis(true),
  }
}
