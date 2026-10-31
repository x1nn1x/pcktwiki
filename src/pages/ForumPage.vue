<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { loadWikiByHandle } from '@/lib/atproto/wiki-loader'
import { useAuthStore } from '@/stores/auth'
import { useLichenStore } from '@/stores/lichen'
import { normalizeHandle } from '@/lib/config'
import { getPublicAgent } from '@/lib/atproto/auth'
import {
  createForumTopic,
  listForumTopics,
  type ForumTopicRecord,
} from '@/lib/pckt-records'
import { fetchThread, threadChunks, type ThreadTree } from '@/lib/forum'
import ForumComposer from '@/components/ForumComposer.vue'

const HIDDEN_KEY = 'pckt.wiki.forum.hidden'

function readHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed : [])
  } catch {
    return new Set()
  }
}
function saveHidden(ids: Set<string>) {
  localStorage.setItem(HIDDEN_KEY, JSON.stringify([...ids]))
}

const route = useRoute()
const auth = useAuthStore()
const lichen = useLichenStore()

const handle = computed(() => normalizeHandle(route.params.handle as string))
const wikiSlug = computed(() => route.params.wikiSlug as string)
const noteFilter = computed(() => {
  const raw = route.query.note
  return typeof raw === 'string' ? raw : null
})

const topics = ref<ForumTopicRecord[]>([])
const threads = ref<Record<string, ThreadTree | null>>({})
const excerpts = ref<Record<string, { text: string; author: string; avatar?: string; replies: number; atTime: string }>>({})
const loading = ref(true)
const composerOpen = ref(false)
const expanded = ref<string | null>(null)
const error = ref('')
const canManageWiki = computed(() => {
  const wiki = lichen.currentWiki
  return !!auth.did && !!wiki && wiki.ownerDid === auth.did
})

const hidden = ref(readHidden())
const visibleTopics = computed(() => topics.value.filter((t) => !hidden.value.has(t.rootPost)))

function bskyUrl(uri: string): string {
  const m = /at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/.exec(uri)
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : 'https://bsky.app'
}

function hideTopic(rootPost: string) {
  hidden.value.add(rootPost)
  saveHidden(hidden.value)
}

async function load() {
  loading.value = true
  error.value = ''
  await loadWikiByHandle(lichen, {
    handle: handle.value,
    wikiSlug: wikiSlug.value,
    viewerDid: auth.did,
    authAgent: auth.agent,
  })
  const wiki = lichen.currentWiki
  if (!wiki) {
    loading.value = false
    return
  }
  try {
    topics.value = await listForumTopics(auth.agent ?? getPublicAgent(), wiki.uri)
    for (const topic of topics.value) {
      if (excerpts.value[topic.rootPost]) continue
      const tree = await fetchThread(topic.rootPost, 0)
      if (tree) {
        excerpts.value = {
          ...excerpts.value,
          [topic.rootPost]: {
            text: tree.post.text,
            author: tree.post.author.handle,
            avatar: tree.post.author.avatar,
            replies: tree.post.replyCount,
            atTime: tree.post.createdAt,
          },
        }
      }
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load the forum'
  } finally {
    loading.value = false
  }
}

async function expand(topic: ForumTopicRecord) {
  if (expanded.value === topic.rootPost) {
    expanded.value = null
    return
  }
  expanded.value = topic.rootPost
  if (!threads.value[topic.rootPost]) {
    threads.value = { ...threads.value, [topic.rootPost]: null }
    const tree = await fetchThread(topic.rootPost, 10)
    threads.value = { ...threads.value, [topic.rootPost]: tree }
  }
}

const filtered = computed(() =>
  noteFilter.value
    ? visibleTopics.value.filter((t) => t.noteSlug === noteFilter.value)
    : visibleTopics.value,
)

const pageLinkUrl = computed(() => {
  if (typeof window === 'undefined') return undefined
  return `https://allour.wiki/@${handle.value}/${wikiSlug.value}${noteFilter.value ? `/${noteFilter.value}` : ''}`
})

async function onPublished() {
  const wiki = lichen.currentWiki
  if (!auth.agent || !wiki) return
  // The composer just posted a thread; anchor it as a topic for this wiki.
  const composer = composerRef.value
  const result = composer?.lastResult
  if (result) {
    const topic = await createForumTopic(auth.agent, {
      wikiRef: wiki.uri,
      rootPost: result.root.uri,
      noteSlug: noteFilter.value ?? undefined,
    })
    topics.value = [topic, ...topics.value]
    composerOpen.value = false
    void expand(topic)
  }
}

const composerRef = ref<InstanceType<typeof ForumComposer> | null>(null)

onMounted(load)
watch(() => route.fullPath, load)
</script>

<template>
  <div class="forum-page">
    <div class="forum-inner">
      <header>
        <RouterLink :to="`/@${handle}/${wikiSlug}`" class="muted">← Wiki home</RouterLink>
        <h1>Forum</h1>
        <p class="muted">
          Discussions for this wiki, powered by Bluesky posts — threads you start here are
          real Bluesky threads, and Bluesky replies show up here.
          <template v-if="noteFilter"> Showing discussions about <strong>{{ noteFilter }}</strong>.</template>
        </p>
        <p v-if="noteFilter" class="muted">
          <RouterLink :to="`/@${handle}/${wikiSlug}/forum`">Show every discussion</RouterLink>
        </p>
      </header>

      <section class="card forum-composer-card">
        <button
          v-if="!composerOpen"
          type="button"
          class="btn btn-primary"
          @click="composerOpen = true"
        >
          {{ noteFilter ? `Discuss “${noteFilter}”` : 'Start a discussion' }}
        </button>
        <ForumComposer
          v-else
          ref="composerRef"
          :key="noteFilter ?? 'all'"
          :link-url="pageLinkUrl"
          :placeholder="noteFilter ? `What should change on “${noteFilter}”?` : undefined"
          @published="onPublished"
        />
        <p v-if="!auth.isAuthenticated && !composerOpen" class="muted forum-signin-hint">
          <RouterLink :to="{ name: 'home', query: { redirect: route.fullPath } }">Sign in</RouterLink>
          to start a discussion — replies happen right on Bluesky.
        </p>
      </section>

      <p v-if="loading" class="muted">Loading discussions…</p>
      <p v-else-if="error" class="error-text">{{ error }}</p>
      <p v-else-if="!filtered.length" class="muted">
        No discussions yet{{ noteFilter ? ` about “${noteFilter}”` : '' }} — start the first one.
      </p>

      <section
        v-for="topic in filtered"
        :key="topic.uri"
        class="card forum-topic"
      >
        <button type="button" class="forum-topic-head" @click="expand(topic)">
          <img
            v-if="excerpts[topic.rootPost]?.avatar"
            :src="excerpts[topic.rootPost]!.avatar"
            alt=""
            class="forum-avatar"
            loading="lazy"
          />
          <span class="forum-topic-meta">
            <strong>{{ excerpts[topic.rootPost]?.text.slice(0, 110) || 'Loading…' }}</strong>
            <span class="muted forum-topic-sub">
              @{{ excerpts[topic.rootPost]?.author ?? '…' }}
              · {{ excerpts[topic.rootPost]?.replies ?? 0 }} replies
              · {{ new Date(excerpts[topic.rootPost]?.atTime ?? topic.createdAt).toLocaleDateString() }}
              <template v-if="topic.noteSlug"> · about <em>{{ topic.noteSlug }}</em></template>
            </span>
          </span>
          <span class="forum-topic-open">{{ expanded === topic.rootPost ? '▲' : '▼' }}</span>
        </button>

        <div v-if="expanded === topic.rootPost" class="forum-thread">
          <p v-if="threads[topic.rootPost] === null" class="muted">Loading thread…</p>
          <template v-else-if="threads[topic.rootPost]">
            <div
              v-for="(chunk, index) in threadChunks(threads[topic.rootPost]!)"
              :key="chunk.uri"
              class="forum-post"
              :class="{ 'forum-post--root': index === 0 }"
            >
              <img
                v-if="chunk.author.avatar"
                :src="chunk.author.avatar"
                alt=""
                class="forum-avatar forum-avatar--sm"
                loading="lazy"
              />
              <div class="forum-post-body">
                <p class="forum-post-author">
                  {{ chunk.author.displayName || '@' + chunk.author.handle }}
                  <span class="muted">@{{ chunk.author.handle }}</span>
                  <template v-if="index > 0"> <span class="muted">· continued</span></template>
                </p>
                <p class="forum-post-text">{{ chunk.text }}</p>
              </div>
            </div>
            <div
              v-for="reply in threads[topic.rootPost]!.replies"
              :key="reply.post.uri"
              class="forum-post forum-post--reply"
            >
              <img
                v-if="reply.post.author.avatar"
                :src="reply.post.author.avatar"
                alt=""
                class="forum-avatar forum-avatar--sm"
                loading="lazy"
              />
              <div class="forum-post-body">
                <p class="forum-post-author">
                  {{ reply.post.author.displayName || '@' + reply.post.author.handle }}
                  <span class="muted">@{{ reply.post.author.handle }}</span>
                </p>
                <p class="forum-post-text">{{ reply.post.text }}</p>
              </div>
            </div>
          </template>
          <ForumComposer
            v-if="auth.isAuthenticated"
            compact
            :reply-to="threads[topic.rootPost]?.post
              ? (() => {
                  const chunks = threadChunks(threads[topic.rootPost]!)
                  return { uri: chunks[chunks.length - 1].uri, cid: chunks[chunks.length - 1].cid }
                })()
              : undefined"
            :reply-root="{ uri: topic.rootPost, cid: threads[topic.rootPost]?.post.cid ?? '' }"
            placeholder="Reply to this discussion…"
            @published="load"
          />
          <div class="forum-topic-actions">
            <a :href="bskyUrl(topic.rootPost)" target="_blank" rel="noopener noreferrer" class="btn btn-ghost btn-sm">
              View on Bluesky
            </a>
            <button
              v-if="canManageWiki"
              type="button"
              class="btn btn-ghost btn-sm"
              @click="hideTopic(topic.rootPost)"
            >
              Hide from this wiki
            </button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.forum-page {
  padding: 2rem 1.25rem 6rem;
}

.forum-inner {
  max-width: 760px;
  margin: 0 auto;
  display: grid;
  gap: 1rem;
}

header h1 {
  margin: 0.5rem 0 0.25rem;
  font-family: var(--pckt-font-content);
}

header p {
  margin: 0 0 0.5rem;
}

.forum-composer-card {
  padding: 1rem 1.25rem;
}

.forum-signin-hint {
  margin: 0.5rem 0 0;
  font-size: 0.875rem;
}

.forum-topic {
  padding: 0.75rem 1rem;
}

.forum-topic-head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.forum-topic-meta {
  display: grid;
  gap: 0.15rem;
  min-width: 0;
}

.forum-topic-sub {
  font-size: 0.8125rem;
}

.forum-topic-open {
  margin-left: auto;
  color: var(--pckt-text-muted);
}

.forum-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  flex: none;
}

.forum-avatar--sm {
  width: 28px;
  height: 28px;
}

.forum-thread {
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--pckt-border);
  display: grid;
  gap: 0.625rem;
}

.forum-post {
  display: flex;
  gap: 0.625rem;
  padding: 0.5rem 0;
}

.forum-post--root {
  border-left: 3px solid var(--pckt-accent, var(--pckt-red));
  padding-left: 0.625rem;
}

.forum-post--reply {
  margin-left: 2.25rem;
}

.forum-post-author {
  margin: 0 0 0.15rem;
  font-size: 0.8125rem;
  font-weight: 700;
}

.forum-post-text {
  margin: 0;
  font-size: 0.9375rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.forum-topic-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.25rem;
}
</style>
