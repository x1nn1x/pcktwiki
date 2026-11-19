<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { getActorAvatar } from '@/lib/atproto/actor-avatars'
import { sizedAvatarUrl } from '@/lib/media/avatar-cdn'

const props = withDefaults(
  defineProps<{
    handle: string
    name: string
    seed: string
    accentColor: string
    size?: number
    /** Pre-resolved avatar URL — skips a network fetch when provided */
    avatar?: string
    /** Prefer eager only for above-the-fold / LCP avatars. */
    loading?: 'lazy' | 'eager'
  }>(),
  { size: 64, loading: 'lazy' },
)

const avatarUrl = ref<string | null>(null)
const imageFailed = ref(false)

const displayUrl = computed(() => sizedAvatarUrl(avatarUrl.value, props.size))

const initials = props.name
  .split(/\s+/)
  .slice(0, 2)
  .map((part) => part[0]?.toUpperCase() ?? '')
  .join('')

async function resolveAvatar(): Promise<void> {
  imageFailed.value = false

  if (props.avatar) {
    avatarUrl.value = props.avatar
    return
  }

  avatarUrl.value = await getActorAvatar(props.handle)
}

watch(
  () => [props.handle, props.avatar] as const,
  () => {
    void resolveAvatar()
  },
  { immediate: true },
)
</script>

<template>
  <div
    class="wiki-avatar"
    :style="{
      width: `${size}px`,
      height: `${size}px`,
      backgroundColor: accentColor,
      fontSize: `${Math.round(size * 0.34)}px`,
    }"
  >
    <img
      v-if="displayUrl && !imageFailed"
      :src="displayUrl"
      :alt="name"
      class="wiki-avatar-image"
      :width="size"
      :height="size"
      :loading="loading"
      :fetchpriority="loading === 'eager' ? 'high' : 'auto'"
      decoding="async"
      @error="imageFailed = true"
    />
    <span v-else class="wiki-avatar-initials">{{ initials || seed.slice(0, 1).toUpperCase() }}</span>
  </div>
</template>

<style scoped>
.wiki-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}

.wiki-avatar-image {
  display: block;
  width: 100%;
  height: 100%;
  max-width: none;
  object-fit: cover;
}

.wiki-avatar-initials {
  color: #fff;
  font-family: var(--pckt-font-ui);
  font-weight: 700;
  letter-spacing: -0.02em;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
}
</style>
