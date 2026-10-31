<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import {
  BSKY_POST_LIMIT,
  publishThread,
  splitIntoPosts,
} from '@/lib/forum'

/**
 * The forum composer hides Bluesky entirely: the author writes normally, and
 * the live preview shows where each Bluesky post will break — paragraphs are
 * kept whole, so the thread also reads well on Bluesky itself.
 */
const props = defineProps<{
  /** Absolute URL appended to the first chunk so Bluesky readers can find the wiki. */
  linkUrl?: string
  replyTo?: { uri: string; cid: string }
  replyRoot?: { uri: string; cid: string }
  placeholder?: string
  compact?: boolean
}>()

const emit = defineEmits<{
  published: []
}>()

const auth = useAuthStore()
const text = ref('')
const posting = ref(false)
const progress = ref('')
const error = ref('')
let lastResult: { root: { uri: string; cid: string }; leaf: { uri: string; cid: string } } | null = null

const chunks = computed(() => {
  let body = text.value.trim()
  if (!body) return []
  if (props.linkUrl && !body.includes(props.linkUrl)) body = `${body}\n\n${props.linkUrl}`
  return splitIntoPosts(body)
})

/** Paragraphs the author can still add before the current post fills up. */
const currentRoom = computed(() => {
  const last = chunks.value[chunks.value.length - 1]
  if (!last) return BSKY_POST_LIMIT
  return BSKY_POST_LIMIT - last.length
})

/** True when a paragraph break right now would open a fresh Bluesky post. */
const atParagraphBoundary = computed(() => /\n{2,}\s*$/.test(text.value))

async function publish() {
  if (!auth.agent || posting.value) return
  error.value = ''
  posting.value = true
  progress.value = ''
  try {
    const result = await publishThread(auth.agent, text.value, {
      linkUrl: props.linkUrl,
      replyTo: props.replyTo,
      replyRoot: props.replyRoot,
      onProgress: (done, total) => {
        progress.value = total > 1 ? `Posting ${done} of ${total}…` : ''
      },
    })
    lastResult = result
    text.value = ''
    emit('published')
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not post'
  } finally {
    posting.value = false
    progress.value = ''
  }
}

defineExpose({
  /** The thread the composer last published, for parents that anchor topics. */
  get lastResult() {
    return lastResult
  },
})
</script>

<template>
  <div class="forum-composer" :class="{ compact }">
    <textarea
      v-model="text"
      class="forum-composer-input"
      :placeholder="placeholder ?? 'Start a discussion… blank lines split long posts so they read well everywhere.'"
      rows="4"
    ></textarea>

    <div v-if="chunks.length" class="forum-composer-preview" aria-live="polite">
      <p class="forum-composer-hint">
        {{ chunks.length === 1
          ? 'Fits in one post.'
          : `Will appear as ${chunks.length} connected posts — on Bluesky too.` }}
        <template v-if="chunks.length > 1">
          Blank lines start the next post
          <template v-if="atParagraphBoundary"> — you're at one now.</template>
          <template v-else>. Add a blank line to start the next post early.</template>
        </template>
      </p>
      <div
        v-for="(chunk, index) in chunks"
        :key="index"
        class="forum-composer-chunk"
        :class="{ 'is-over': chunk.length > BSKY_POST_LIMIT }"
      >
        <span class="forum-composer-chunk-tag">
          {{ chunks.length > 1 ? `post ${index + 1}` : 'post' }} · {{ chunk.length }}/{{ BSKY_POST_LIMIT }}
        </span>
        <span class="forum-composer-chunk-text">{{ chunk.text }}</span>
      </div>
      <p class="forum-composer-room">
        {{ currentRoom >= 0
          ? `${currentRoom} characters left in this post — a blank line starts the next one.`
          : 'This post is over the limit; add a paragraph break.' }}
      </p>
    </div>

    <div class="forum-composer-actions">
      <button
        type="button"
        class="btn btn-primary btn-sm"
        :disabled="posting || !chunks.length"
        @click="publish"
      >
        {{ posting ? progress || 'Posting…' : chunks.length > 1 ? `Post as ${chunks.length} connected posts` : 'Post to the forum' }}
      </button>
      <span v-if="!auth.isAuthenticated" class="muted forum-composer-signin">Sign in to post.</span>
    </div>
    <p v-if="error" class="error-text">{{ error }}</p>
  </div>
</template>

<style scoped>
.forum-composer {
  display: grid;
  gap: 0.625rem;
}

.forum-composer-input {
  width: 100%;
  min-height: 6rem;
  padding: 0.75rem;
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-sm);
  background: var(--pckt-bg-elevated);
  color: var(--pckt-text);
  font: inherit;
  resize: vertical;
  box-sizing: border-box;
}

.forum-composer-hint {
  margin: 0 0 0.5rem;
  font-size: 0.8125rem;
  color: var(--pckt-text-muted);
}

.forum-composer-chunk {
  position: relative;
  padding: 0.5rem 0.625rem 0.5rem 0.75rem;
  border: 1px dashed var(--pckt-border);
  border-radius: var(--pckt-radius-sm);
  margin-bottom: 0.5rem;
  font-size: 0.875rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.forum-composer-chunk + .forum-composer-chunk::before {
  content: '↩ continues as a reply';
  display: block;
  margin: -1.35rem 0 0.35rem -0.75rem;
  font-size: 0.6875rem;
  color: var(--pckt-text-muted);
}

.forum-composer-chunk.is-over {
  border-color: var(--pckt-danger);
}

.forum-composer-chunk-tag {
  display: block;
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--pckt-text-muted);
  margin-bottom: 0.25rem;
}

.forum-composer-room {
  margin: 0;
  font-size: 0.75rem;
  color: var(--pckt-text-muted);
}

.forum-composer-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.forum-composer-signin {
  font-size: 0.8125rem;
}
</style>
