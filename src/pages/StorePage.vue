<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useShareMeta } from '@/composables/useShareMeta'
import { useAuthStore } from '@/stores/auth'
import { formatMoney } from '@/lib/donations'
import {
  KIND_LABEL,
  fetchStoreConfig,
  isStoreConfigured,
  startStoreCheckout,
  type StoreProduct,
} from '@/lib/store'

/**
 * Storefront for merch and digital goods.
 *
 * Prices come from the worker catalogue, not from this page, and checkout is
 * a hosted Stripe session: the browser only sends product ids and quantities,
 * then follows the returned URL. Nothing about payment happens in the wiki.
 */

const configured = isStoreConfigured()
const auth = useAuthStore()

const currency = ref('usd')
const products = ref<StoreProduct[]>([])
const quantities = ref<Record<string, number>>({})
const loading = ref(configured)
const loadError = ref<string | null>(null)
const checkoutError = ref<string | null>(null)
const redirecting = ref(false)

const title = 'pckt.wiki store'
const description = 'Stickers, prints, tees and digital packs from pckt.wiki.'

useShareMeta({
  title: computed(() => title),
  description: computed(() => description),
})

const cart = computed(() =>
  products.value
    .map((product) => ({ product, quantity: quantities.value[product.id] ?? 0 }))
    .filter((line) => line.quantity > 0),
)

const cartCount = computed(() => cart.value.reduce((sum, line) => sum + line.quantity, 0))
const cartTotal = computed(() =>
  cart.value.reduce((sum, line) => sum + line.product.amount * line.quantity, 0),
)
const needsShipping = computed(() => cart.value.some((line) => line.product.kind !== 'digital'))

function price(amount: number): string {
  return formatMoney(amount, currency.value)
}

function setQuantity(product: StoreProduct, next: number): void {
  quantities.value = { ...quantities.value, [product.id]: Math.min(10, Math.max(0, next)) }
}

async function load() {
  if (!configured) return
  loading.value = true
  loadError.value = null
  try {
    const config = await fetchStoreConfig()
    currency.value = config.currency
    products.value = config.products
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : 'Could not load the store.'
  } finally {
    loading.value = false
  }
}

async function checkout() {
  if (!cart.value.length || redirecting.value) return
  redirecting.value = true
  checkoutError.value = null
  try {
    const url = await startStoreCheckout(
      cart.value.map((line) => ({ id: line.product.id, quantity: line.quantity })),
      auth.handle ?? undefined,
    )
    window.location.assign(url)
  } catch (err) {
    checkoutError.value = err instanceof Error ? err.message : 'Could not start checkout.'
    redirecting.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="store-page">
    <div class="store-inner">
      <header class="store-header">
        <RouterLink to="/" class="store-back muted">← Home</RouterLink>
        <h1 class="store-title">Store</h1>
        <p class="store-lead muted">
          Things you can hold, wear, or download. Payments run through Stripe; physical orders are
          packed by hand or printed on demand, and digital goods arrive as a download link the
          moment the payment clears.
        </p>
      </header>

      <div v-if="!configured" class="store-note card" role="note">
        <strong>Not connected yet.</strong>
        The storefront appears once the donations worker is deployed and
        <code>VITE_DONATIONS_API_URL</code> is set. See <code>worker/README.md</code>.
      </div>

      <div v-else-if="loadError" class="store-note card" role="alert">
        Could not load the store: {{ loadError }}
      </div>

      <p v-else-if="loading" class="muted" aria-busy="true">Loading products…</p>

      <p v-else-if="!products.length" class="muted">
        Nothing is on sale right now. Check back soon.
      </p>

      <div v-else class="store-layout">
        <ul class="store-grid">
          <li v-for="product in products" :key="product.id" class="store-card card">
            <img
              v-if="product.image"
              class="store-card-image"
              :src="product.image"
              :alt="product.name"
              loading="lazy"
            />
            <div class="store-card-body">
              <h2 class="store-card-name">{{ product.name }}</h2>
              <p class="store-card-kind muted">{{ KIND_LABEL[product.kind] }}</p>
              <p class="store-card-description">{{ product.description }}</p>
              <p class="store-card-price">{{ price(product.amount) }}</p>

              <div v-if="quantities[product.id]" class="store-stepper">
                <button type="button" :aria-label="`Remove one ${product.name}`" @click="setQuantity(product, (quantities[product.id] ?? 0) - 1)">
                  −
                </button>
                <span aria-live="polite">{{ quantities[product.id] }}</span>
                <button type="button" :aria-label="`Add one ${product.name}`" @click="setQuantity(product, (quantities[product.id] ?? 0) + 1)">
                  +
                </button>
              </div>
              <button v-else type="button" class="store-add" @click="setQuantity(product, 1)">
                Add to cart
              </button>
            </div>
          </li>
        </ul>

        <aside class="store-cart card" aria-label="Cart">
          <h2 class="store-cart-title">Cart</h2>
          <p v-if="!cart.length" class="muted">Nothing here yet.</p>
          <template v-else>
            <ul class="store-cart-lines">
              <li v-for="line in cart" :key="line.product.id">
                <span>{{ line.quantity }} × {{ line.product.name }}</span>
                <span>{{ price(line.product.amount * line.quantity) }}</span>
              </li>
            </ul>
            <p class="store-cart-total">
              <span>Total</span>
              <strong>{{ price(cartTotal) }}</strong>
            </p>
            <p v-if="needsShipping" class="store-cart-hint muted">
              Shipping address is collected at checkout.
            </p>
            <p v-if="checkoutError" class="store-cart-error" role="alert">{{ checkoutError }}</p>
            <button
              type="button"
              class="store-checkout"
              :disabled="redirecting"
              @click="checkout"
            >
              {{ redirecting ? 'Opening checkout…' : `Checkout (${cartCount})` }}
            </button>
          </template>
          <p class="store-cart-footnote muted">
            Card details never touch pckt.wiki.
          </p>
        </aside>
      </div>
    </div>
  </div>
</template>

<style scoped>
.store-page {
  background: var(--pckt-bg);
  padding: 2rem clamp(1rem, 3vw, 2.5rem) 5rem;
  min-height: calc(100dvh - 3rem);
}

.store-inner {
  max-width: 64rem;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.store-back {
  display: inline-block;
  margin-bottom: 1rem;
  font-size: 0.875rem;
  text-decoration: none;
  align-self: flex-start;
}

.store-back:hover {
  text-decoration: underline;
}

.store-header {
  display: flex;
  flex-direction: column;
}

.store-title {
  margin: 0 0 0.5rem;
  font-family: var(--pckt-font-ui);
  font-size: clamp(2rem, 4.5vw, 2.75rem);
  font-weight: 900;
  letter-spacing: -0.02em;
}

.store-lead {
  margin: 0;
  max-width: 46rem;
  font-size: 1rem;
  line-height: 1.5;
}

.store-note {
  padding: 0.875rem 1.125rem;
  font-size: 0.875rem;
  line-height: 1.5;
}

.store-note code {
  font-family: var(--pckt-font-mono);
  font-size: 0.8125em;
}

.store-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 1rem;
  align-items: start;
}

@media (min-width: 56rem) {
  .store-layout {
    grid-template-columns: minmax(0, 1fr) 20rem;
  }
}

.store-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
  gap: 1rem;
}

.store-card {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.store-card-image {
  width: 100%;
  aspect-ratio: 4 / 3;
  object-fit: cover;
  display: block;
}

.store-card-body {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 1rem;
}

.store-card-name {
  margin: 0;
  font-family: var(--pckt-font-ui);
  font-size: 1.0625rem;
  font-weight: 900;
}

.store-card-kind {
  margin: 0;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.store-card-description {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.45;
}

.store-card-price {
  margin: 0.25rem 0 0;
  font-family: var(--pckt-font-mono);
  font-size: 1rem;
  font-weight: 700;
}

.store-add,
.store-checkout {
  margin-top: 0.5rem;
  padding: 0.55rem 0.9rem;
  border: 1px solid var(--pckt-border, #a2a9b1);
  border-radius: var(--pckt-radius, 3px);
  background: var(--pckt-bg, #fff);
  color: var(--pckt-fg, #202122);
  font-family: var(--pckt-font-ui);
  font-size: 0.875rem;
  font-weight: 700;
  cursor: pointer;
}

.store-add:hover,
.store-checkout:hover:not(:disabled) {
  background: var(--pckt-bg-subtle, #f8f9fa);
}

.store-checkout {
  width: 100%;
  background: var(--pckt-link, #3366cc);
  color: #fff;
  border-color: var(--pckt-link, #3366cc);
}

.store-checkout:hover:not(:disabled) {
  filter: brightness(1.05);
  background: var(--pckt-link, #3366cc);
}

.store-checkout:disabled {
  opacity: 0.6;
  cursor: progress;
}

.store-stepper {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.5rem;
  font-family: var(--pckt-font-mono);
}

.store-stepper button {
  width: 1.75rem;
  height: 1.75rem;
  border: 1px solid var(--pckt-border, #a2a9b1);
  border-radius: var(--pckt-radius, 3px);
  background: var(--pckt-bg, #fff);
  color: inherit;
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
}

.store-stepper span {
  min-width: 1.25rem;
  text-align: center;
}

.store-cart {
  padding: 1.125rem;
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  position: sticky;
  top: 4rem;
}

.store-cart-title {
  margin: 0;
  font-family: var(--pckt-font-ui);
  font-size: 1.0625rem;
  font-weight: 900;
}

.store-cart-lines {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  font-size: 0.875rem;
}

.store-cart-lines li {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
}

.store-cart-total {
  display: flex;
  justify-content: space-between;
  margin: 0;
  padding-top: 0.5rem;
  border-top: 1px solid var(--pckt-border, #a2a9b1);
  font-size: 0.9375rem;
}

.store-cart-hint,
.store-cart-footnote {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.45;
}

.store-cart-error {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--pckt-danger, #b32424);
}
</style>
