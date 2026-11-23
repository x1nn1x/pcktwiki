<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { resolveSubdomainHandle } from '@/lib/lichen/subdomain-handle'

/**
 * `/by/<label>/<wiki>/<page>` — a deep link on a username subdomain.
 *
 * The label may be a default Bluesky handle (`oseanstudio.bsky.social`) or a
 * custom-domain one (`mfzx.net`), and only the public directory knows which.
 * Resolve the label first, then continue to the canonical `/@handle/...` URL so
 * the article route needs no subdomain awareness.
 */

const route = useRoute()
const router = useRouter()
const failed = ref(false)

async function resolve() {
  const sub = String(route.params.sub ?? '').trim().toLowerCase()
  const rest = [route.params.pathMatch].flat().filter(Boolean).join('/')
  if (!sub || !rest) {
    failed.value = true
    return
  }

  const handle = await resolveSubdomainHandle(sub)
  await router.replace({
    path: `/@${handle}/${rest}`,
    query: route.query,
    hash: route.hash,
  })
}

onMounted(resolve)
watch(() => [route.params.sub, route.params.pathMatch], resolve)
</script>

<template>
  <div class="handle-redirect">
    <p v-if="failed" class="muted">
      That address does not point at a wiki page.
      <RouterLink to="/wikis">Browse wikis →</RouterLink>
    </p>
    <p v-else class="muted" aria-busy="true">Opening wiki…</p>
  </div>
</template>

<style scoped>
.handle-redirect {
  max-width: 40rem;
  margin: 0 auto;
  padding: 3rem 1.25rem;
}
</style>
