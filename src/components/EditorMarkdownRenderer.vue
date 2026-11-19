<script setup lang="ts">
import { computed } from 'vue'
import { useInternalLinkNavigation } from '@/composables/useInternalLinkNavigation'
import { renderEditorMarkdown } from '@/lib/editor-markdown-render'

const { onMarkdownClick } = useInternalLinkNavigation()

const props = defineProps<{
  source: string
  wikiSlug?: string
  ownerHandle?: string
}>()

const html = computed(() =>
  renderEditorMarkdown(props.source, {
    wikiSlug: props.wikiSlug,
    ownerHandle: props.ownerHandle,
  }),
)
</script>

<template>
  <div class="prose markdown-body" v-html="html" @click="onMarkdownClick" />
</template>

<style scoped>
:deep(.wikilink) {
  color: var(--pckt-blue);
  font-weight: 600;
  text-decoration: none;
}

:deep(.wikilink:hover) {
  text-decoration: underline;
}

:deep(.wikilink-missing) {
  color: var(--pckt-red);
  border-bottom: 1px dashed var(--pckt-red);
}

:deep(.wiki-editor-eol) {
  display: block;
  height: 0;
  overflow: hidden;
  font-size: 0;
  line-height: 0;
  pointer-events: auto;
}
</style>
