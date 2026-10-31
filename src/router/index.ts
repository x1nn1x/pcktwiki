import { createRouter, createWebHistory } from 'vue-router'
import { pinia } from '@/pinia'
import { useAuthStore } from '@/stores/auth'
// The landing page is the first paint, so it stays static rather than waiting
// on a chunk.
import LandingPage from '@/pages/LandingPage.vue'

/**
 * Every other page is loaded on navigation. Beyond code-splitting, this breaks
 * an import cycle: pages pull in wiki-loader, which imports this module back, so
 * a static `import EditPage` meant the routes array could be built while that
 * binding was still uninitialized — the `Cannot access 'X' before
 * initialization` errors seen whenever HMR re-entered the router.
 */
const LearnPage = () => import('@/pages/LearnPage.vue')
const BrowseWikisPage = () => import('@/pages/BrowseWikisPage.vue')
const FaqPage = () => import('@/pages/FaqPage.vue')
const DonatePage = () => import('@/pages/DonatePage.vue')
const GlobalSearchPage = () => import('@/pages/GlobalSearchPage.vue')
const DashboardPage = () => import('@/pages/DashboardPage.vue')
const CreateWikiPage = () => import('@/pages/CreateWikiPage.vue')
const EditPage = () => import('@/pages/EditPage.vue')
const HistoryPage = () => import('@/pages/HistoryPage.vue')
const SettingsPage = () => import('@/pages/SettingsPage.vue')
const WikiVersionsPage = () => import('@/pages/WikiVersionsPage.vue')
const RecentChangesPage = () => import('@/pages/RecentChangesPage.vue')
const SearchPage = () => import('@/pages/SearchPage.vue')
const CategoryPage = () => import('@/pages/CategoryPage.vue')
const WikiPage = () => import('@/pages/WikiPage.vue')
const LibraryPage = () => import('@/pages/LibraryPage.vue')
const DraftWikiPage = () => import('@/pages/DraftWikiPage.vue')
const FollowFeedPage = () => import('@/pages/FollowFeedPage.vue')
const MaintenancePage = () => import('@/pages/MaintenancePage.vue')
const TimelinePage = () => import('@/pages/TimelinePage.vue')
const GraphPage = () => import('@/pages/GraphPage.vue')
const MapPage = () => import('@/pages/MapPage.vue')
const RenamePage = () => import('@/pages/RenamePage.vue')
const SuggestionsPage = () => import('@/pages/SuggestionsPage.vue')
const ForumPage = () => import('@/pages/ForumPage.vue')
const DockButtonPage = () => import('@/pages/DockButtonPage.vue')
import { getCachedHandle } from '@/lib/atproto/handle-cache'
import { parseAtUriParam } from '@/lib/atproto/permalinks'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      component: LandingPage,
    },
    {
      path: '/learn',
      name: 'learn',
      component: LearnPage,
    },
    {
      path: '/wikis',
      name: 'browse-wikis',
      component: BrowseWikisPage,
    },
    {
      path: '/faq',
      name: 'faq',
      component: FaqPage,
    },
    {
      path: '/donate',
      name: 'donate',
      component: DonatePage,
    },
    {
      path: '/search',
      name: 'global-search',
      component: GlobalSearchPage,
    },
    {
      path: '/library',
      name: 'library',
      component: LibraryPage,
    },
    {
      path: '/feed',
      name: 'follow-feed',
      component: FollowFeedPage,
    },
    {
      path: '/draft/:draftId/:noteSlug?',
      name: 'draft-wiki',
      component: DraftWikiPage,
    },
    {
      path: '/dashboard',
      name: 'dashboard',
      component: DashboardPage,
      meta: { requiresAuth: true },
    },
    {
      path: '/wiki/new',
      name: 'create-wiki',
      component: CreateWikiPage,
    },
    {
      path: '/@:handle/:wikiSlug/edit/:noteSlug',
      name: 'edit-note',
      component: EditPage,
      meta: { requiresAuth: true },
    },
    {
      path: '/@:handle/:wikiSlug/:noteSlug/history',
      name: 'note-history',
      component: HistoryPage,
    },
    {
      path: '/@:handle/:wikiSlug/settings',
      name: 'wiki-settings',
      component: SettingsPage,
      meta: { requiresAuth: true },
    },
    {
      path: '/@:handle/:wikiSlug/versions',
      name: 'wiki-versions',
      component: WikiVersionsPage,
      meta: { requiresAuth: true },
    },
    {
      path: '/@:handle/:wikiSlug/recent',
      name: 'wiki-recent',
      component: RecentChangesPage,
    },
    {
      path: '/@:handle/:wikiSlug/search',
      name: 'wiki-search',
      component: SearchPage,
    },
    {
      path: '/@:handle/:wikiSlug/category/:categorySlug',
      name: 'wiki-category',
      component: CategoryPage,
    },
    {
      path: '/@:handle/:wikiSlug/special/maintenance',
      name: 'wiki-maintenance',
      component: MaintenancePage,
    },
    {
      path: '/@:handle/:wikiSlug/special/timeline',
      name: 'wiki-timeline',
      component: TimelinePage,
    },
    {
      path: '/@:handle/:wikiSlug/special/graph',
      name: 'wiki-graph',
      component: GraphPage,
    },
    {
      path: '/@:handle/:wikiSlug/special/map',
      name: 'wiki-map',
      component: MapPage,
    },
    {
      path: '/@:handle/:wikiSlug/special/rename',
      name: 'wiki-rename',
      component: RenamePage,
      meta: { requiresAuth: true },
    },
    {
      path: '/@:handle/:wikiSlug/forum',
      name: 'wiki-forum',
      component: ForumPage,
    },
    {
      path: '/dock-button',
      name: 'dock-button',
      component: DockButtonPage,
    },
    {
      path: '/@:handle/:wikiSlug/suggestions',
      name: 'wiki-suggestions',
      component: SuggestionsPage,
    },
    {
      path: '/@:handle/:wikiSlug',
      name: 'wiki-home',
      component: WikiPage,
    },
    {
      path: '/@:handle/:wikiSlug/:noteSlug',
      name: 'wiki-note',
      component: WikiPage,
    },
  ],
  scrollBehavior(to, _from, savedPosition) {
    if (savedPosition) return savedPosition
    if (to.hash) {
      return { el: to.hash, top: 80, behavior: 'smooth' }
    }
    return { top: 0 }
  },
})

router.beforeEach(async (to) => {
  const auth = useAuthStore(pinia)

  const atParam = typeof to.query.at === 'string' ? to.query.at : null
  if (atParam) {
    const parsed = parseAtUriParam(atParam)
    if (parsed) {
      const handle = getCachedHandle(parsed.did)
      if (handle && parsed.collection === 'wiki.lichen.wiki') {
        return { path: `/@${handle}/${parsed.rkey}`, replace: true }
      }
      if (handle && parsed.collection === 'wiki.lichen.note') {
        const { getRepoReadAgent } = await import('@/lib/atproto/pds')
        const { listNotes, listWikis } = await import('@/lib/atproto/lichen')
        try {
          const agent = await getRepoReadAgent(parsed.did)
          const [notes, wikis] = await Promise.all([
            listNotes(agent, parsed.did),
            listWikis(agent, parsed.did),
          ])
          const note = notes.find((n) => n.uri.endsWith(`/${parsed.rkey}`))
          if (note) {
            const wiki = wikis.find((w) => w.uri === note.wikiRef)
            if (wiki) {
              return {
                path: `/@${handle}/${wiki.slug}/${note.slug}`,
                replace: true,
              }
            }
          }
        } catch {
          // fall through
        }
      }
    }
  }

  if (to.meta.requiresAuth) {
    if (auth.loading) {
      await auth.initialize()
    }
    if (!auth.isAuthenticated) {
      return { name: 'home', query: { redirect: to.fullPath } }
    }
  }

  return true
})

export default router
