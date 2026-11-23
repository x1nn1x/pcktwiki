<script setup lang="ts">
import { RouterLink } from 'vue-router'
import MakeWikiLink from '@/components/MakeWikiLink.vue'
import { isDonationsConfigured } from '@/lib/donations'
import { isStoreConfigured } from '@/lib/store'
</script>

<template>
  <footer class="landing-footer">
    <div class="landing-footer-inner">
      <div class="landing-footer-cta">
        <h2 class="landing-footer-title">Ready to build your wiki?</h2>
        <p class="landing-footer-lead">
          Your articles, your PDS, your rules. Sign in and create your first wiki in minutes.
        </p>
        <MakeWikiLink />
      </div>

      <nav class="landing-footer-links" aria-label="Related links">
        <RouterLink to="/wikis">Browse wikis</RouterLink>
        <RouterLink to="/faq">FAQ</RouterLink>
        <RouterLink v-if="isStoreConfigured()" to="/store">Store</RouterLink>
        <RouterLink v-if="isDonationsConfigured()" to="/donate">Donate</RouterLink>
        <a href="https://pckt.blog" target="_blank" rel="noopener noreferrer">pckt.blog</a>
        <a href="https://lichen.wiki" target="_blank" rel="noopener noreferrer">lichen.wiki</a>
        <a
          href="https://tangled.org/juprodh.me/lichen.wiki"
          target="_blank"
          rel="noopener noreferrer"
        >
          Lichen lexicons
        </a>
      </nav>

      <p class="landing-footer-copy muted">
        pckt.wiki — your personal wiki on the open social web
      </p>
    </div>
  </footer>
</template>

<style scoped>
.landing-footer {
  padding: 4rem 1.5rem 3rem;
  background: var(--pckt-bg-muted);
  border-top: 1px solid var(--pckt-border);
}

.landing-footer-inner {
  max-width: 40rem;
  margin: 0 auto;
  text-align: center;
}

.landing-footer-cta {
  margin-bottom: 2.5rem;
}

.landing-footer-title {
  margin: 0 0 0.75rem;
  font-family: var(--pckt-font-ui);
  font-size: clamp(1.5rem, 4vw, 2rem);
  font-weight: 900;
  letter-spacing: -0.02em;
}

.landing-footer-lead {
  margin: 0 0 1.25rem;
  font-family: var(--pckt-font-ui);
  font-size: 1.0625rem;
  line-height: 1.5;
  color: var(--pckt-text-muted);
}

.landing-footer-links {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.5rem 1.25rem;
  margin-bottom: 1.5rem;
  font-family: var(--pckt-font-ui);
  font-size: 0.875rem;
  font-weight: 600;
}

.landing-footer-links a {
  color: var(--pckt-text-muted);
  text-decoration: none;
}

.landing-footer-links a:hover {
  color: var(--pckt-text);
  text-decoration: underline;
}

.landing-footer-copy {
  margin: 0;
  font-size: 0.8125rem;
}
</style>
