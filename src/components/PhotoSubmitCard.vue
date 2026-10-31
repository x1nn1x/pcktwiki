<script setup lang="ts">
import { ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useLichenStore } from '@/stores/lichen'
import { uploadBlob } from '@/lib/atproto/blobs'
import { prepareImageUpload } from '@/lib/media/prepare-image-upload'

/**
 * Photo-submission entry point for contributors the wiki's image policy
 * blocks from embedding directly. Photos are uploaded to the submitter's own
 * PDS and filed as a `wiki.pckt.suggestion` (kind 'image'); the wiki owner
 * reviews them and, on approval, copies them into the wiki's approved-media
 * registry.
 */
const props = defineProps<{
  /** Article the photos are submitted for (shown in the review queue). */
  noteSlug: string
}>()

const auth = useAuthStore()
const lichen = useLichenStore()

const busy = ref(false)
const error = ref('')
const done = ref(false)
const alt = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

async function submit() {
  const input = fileInput.value
  if (!auth.agent || !input?.files?.length) return
  busy.value = true
  error.value = ''
  done.value = false
  try {
    const blobs: Record<string, unknown>[] = []
    for (const raw of Array.from(input.files).slice(0, 5)) {
      const prepared = await prepareImageUpload(raw, 'article')
      const uploaded = await uploadBlob(auth.agent, prepared)
      blobs.push(uploaded.blob as Record<string, unknown>)
    }
    await lichen.submitSuggestion(auth.agent, {
      noteSlug: props.noteSlug,
      kind: 'image',
      blobs,
      alt: alt.value.trim() || undefined,
      message: 'Photo submission',
    })
    done.value = true
    alt.value = ''
    input.value = ''
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not submit the photo'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="photo-submit card" aria-label="Submit a photo">
    <div class="photo-submit-copy">
      <h2>Submit a photo</h2>
      <p class="muted">
        This wiki reviews photos before they can be used. Your upload goes to your own
        account and the wiki owner can approve it into the wiki’s photo library.
      </p>
    </div>
    <div class="photo-submit-form">
      <input
        v-model="alt"
        class="input"
        type="text"
        :disabled="busy"
        placeholder="What does the photo show? (alt text)"
        aria-label="Alt text"
      />
      <input
        ref="fileInput"
        class="photo-submit-file"
        type="file"
        accept="image/*"
        multiple
        :disabled="busy"
        aria-label="Choose photos"
      />
      <button
        type="button"
        class="btn btn-primary btn-sm"
        :disabled="busy || !fileInput?.files?.length"
        @click="submit"
      >
        {{ busy ? 'Submitting…' : 'Submit for review' }}
      </button>
    </div>
    <p v-if="done" class="muted photo-submit-status">
      Submitted — the wiki owner can approve it from the wiki settings.
    </p>
    <p v-if="error" class="error-text photo-submit-status">{{ error }}</p>
  </section>
</template>

<style scoped>
.photo-submit {
  padding: 1rem 1.25rem;
  margin-bottom: 1rem;
  display: grid;
  gap: 0.75rem;
}

.photo-submit h2 {
  margin: 0 0 0.25rem;
  font-size: 1rem;
}

.photo-submit-copy p {
  margin: 0;
  font-size: 0.875rem;
}

.photo-submit-form {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}

.photo-submit-form .input {
  flex: 1 1 14rem;
  min-width: 0;
}

.photo-submit-file {
  font-size: 0.8125rem;
  max-width: 100%;
}

.photo-submit-status {
  margin: 0;
  font-size: 0.8125rem;
}
</style>
