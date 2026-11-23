<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useShareMeta } from '@/composables/useShareMeta'
import { formatMoney } from '@/lib/donations'
import { fetchStoreOrder, isStoreConfigured, type StoreOrder } from '@/lib/store'

/**
 * Landing page for a completed Checkout Session.
 *
 * Stripe redirects here immediately, but the order row is written by the
 * webhook, which can land a moment later. Retry a handful of times rather
 * than showing "not found" for a payment that succeeded.
 */

const route = useRoute()
const sessionId = computed(() => String(route.query.session_id ?? ''))

const order = ref<StoreOrder | null>(null)
const error = ref<string | null>(null)

const title = 'Thanks for your order — pckt.wiki'
const description = 'Your pckt.wiki order.'

useShareMeta({
  title: computed(() => title),
  description: computed(() => description),
})

const RETRY_DELAYS = [0, 1200, 2500, 5000, 8000]

async function load() {
  if (!isStoreConfigured()) {
    error.value = 'The store is not connected on this site yet.'
    return
  }
  if (!sessionId.value) {
    error.value = 'This page needs the checkout session id from Stripe.'
    return
  }

  for (const delay of RETRY_DELAYS) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    try {
      order.value = await fetchStoreOrder(sessionId.value)
      return
    } catch (err) {
      // Keep the last message; a 404 here usually just means "webhook pending".
      error.value = err instanceof Error ? err.message : 'Could not load the order.'
    }
  }
}

function money(amount: number): string {
  return formatMoney(amount, order.value?.currency ?? 'usd')
}

onMounted(load)
</script>

<template>
  <div class="thanks-page">
    <div class="thanks-inner">
      <RouterLink to="/store" class="thanks-back muted">← Store</RouterLink>

      <template v-if="order">
        <h1 class="thanks-title">Thank you</h1>
        <p class="thanks-lead muted">
          Payment received. A receipt is on its way from Stripe.
        </p>

        <section class="card thanks-card" aria-labelledby="order-summary">
          <h2 id="order-summary">Your order</h2>
          <ul class="thanks-items">
            <li v-for="item in order.items" :key="item.productId">
              <span>{{ item.quantity }} × {{ item.name }}</span>
              <span>{{ money(item.amount * item.quantity) }}</span>
            </li>
          </ul>
          <p class="thanks-total">
            <span>Total</span>
            <strong>{{ money(order.amount) }}</strong>
          </p>
        </section>

        <section v-if="order.downloads.length" class="card thanks-card" aria-labelledby="downloads">
          <h2 id="downloads">Downloads</h2>
          <ul class="thanks-downloads">
            <li v-for="download in order.downloads" :key="download.url">
              <a :href="download.url" rel="noopener">{{ download.name }}</a>
            </li>
          </ul>
          <p class="muted thanks-hint">
            Keep this page bookmarked — each link is personal and works a limited number of times.
          </p>
        </section>

        <p class="thanks-lead muted">
          Physical items are packed and posted within a few days. Print-on-demand items ship
          straight from the printer, so tracking arrives separately.
        </p>
      </template>

      <template v-else>
        <h1 class="thanks-title">Finishing your order…</h1>
        <p v-if="error" class="thanks-error card" role="alert">
          {{ error }}
          <span class="thanks-error-hint">
            If you were charged, the order will appear here shortly — refresh in a minute.
          </span>
        </p>
        <p v-else class="muted" aria-busy="true">Waiting for the payment confirmation…</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.thanks-page {
  background: var(--pckt-bg);
  padding: 2rem clamp(1rem, 3vw, 2.5rem) 5rem;
  min-height: calc(100dvh - 3rem);
}

.thanks-inner {
  max-width: 42rem;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.thanks-back {
  display: inline-block;
  font-size: 0.875rem;
  text-decoration: none;
  align-self: flex-start;
}

.thanks-back:hover {
  text-decoration: underline;
}

.thanks-title {
  margin: 0;
  font-family: var(--pckt-font-ui);
  font-size: clamp(1.75rem, 4vw, 2.5rem);
  font-weight: 900;
  letter-spacing: -0.02em;
}

.thanks-lead {
  margin: 0;
  font-size: 0.9375rem;
  line-height: 1.5;
}

.thanks-card {
  padding: 1.125rem;
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
}

.thanks-card h2 {
  margin: 0;
  font-family: var(--pckt-font-ui);
  font-size: 1.0625rem;
  font-weight: 900;
}

.thanks-items,
.thanks-downloads {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  font-size: 0.9375rem;
}

.thanks-items li,
.thanks-total {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
}

.thanks-total {
  margin: 0;
  padding-top: 0.5rem;
  border-top: 1px solid var(--pckt-border, #a2a9b1);
}

.thanks-downloads a {
  color: var(--pckt-link, #3366cc);
  font-weight: 700;
}

.thanks-hint {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.45;
}

.thanks-error {
  padding: 0.875rem 1.125rem;
  font-size: 0.875rem;
  line-height: 1.5;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.thanks-error-hint {
  font-size: 0.8125rem;
  opacity: 0.8;
}
</style>
