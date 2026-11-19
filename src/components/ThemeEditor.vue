<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PcktTheme, ThemeRegion } from '@/types/lichen'
import {
  ACCENT_PRESETS,
  DEFAULT_PCKT_THEME,
  FONT_OPTIONS,
  SURFACE_PRESETS,
  THEME_REGION_FIELDS,
  THEME_REGION_LABELS,
} from '@/types/lichen'
import { applyWikiTheme, DEFAULT_ACCENT_LIGHT } from '@/lib/theme'
import { THEME_PRESETS } from '@/data/theme-presets'
import ThemeColorField from '@/components/ThemeColorField.vue'
import {
  loadCustomPalettes,
  nextCustomPaletteName,
  removeCustomPalette,
  saveCustomPalette,
  type CustomPalette,
} from '@/lib/custom-palettes'
import {
  copyThemeMarkdown,
  downloadThemePack,
  importThemePack,
  packToTheme,
  themeToPack,
  type ThemePack,
} from '@/types/theme-pack'

const props = defineProps<{
  modelValue: PcktTheme
}>()

const emit = defineEmits<{
  'update:modelValue': [value: PcktTheme]
}>()

const theme = computed({
  get: () => props.modelValue,
  set: (value: PcktTheme) => emit('update:modelValue', value),
})

const surfaceRegions: ThemeRegion[] = ['bg', 'card', 'sidebar', 'header']
const themeName = ref('Custom theme')
const shareStatus = ref('')
const pasteOpen = ref(false)
const pasteText = ref('')
const importError = ref('')
const customPalettes = ref<CustomPalette[]>(loadCustomPalettes())
const newPaletteName = ref('')

const allPalettes = computed(() => [...THEME_PRESETS, ...customPalettes.value])

function isCustomPack(pack: ThemePack): pack is CustomPalette {
  return 'id' in pack && typeof (pack as CustomPalette).id === 'string'
}

const accentModel = computed({
  get: () => theme.value.accentColor ?? DEFAULT_ACCENT_LIGHT,
  set: (value: string) => updateField('accentColor', value),
})

function updateField<K extends keyof PcktTheme>(key: K, value: PcktTheme[K]) {
  theme.value = { ...theme.value, [key]: value }
}

function surfaceColor(region: ThemeRegion): string {
  const field = THEME_REGION_FIELDS[region]
  return (theme.value[field] as string | undefined) ?? '#f9fafb'
}

function setSurface(region: ThemeRegion, color: string | undefined) {
  updateField(THEME_REGION_FIELDS[region], color)
}

function onSurfaceUpdate(region: ThemeRegion, color: string) {
  setSurface(region, color)
}

function sameHex(a?: string, b?: string): boolean {
  return (a ?? '').toLowerCase() === (b ?? '').toLowerCase()
}

function isPaletteActive(pack: ThemePack): boolean {
  return (
    sameHex(theme.value.accentColor, pack.accent) &&
    sameHex(theme.value.bgColor, pack.bg) &&
    sameHex(theme.value.cardColor, pack.card) &&
    sameHex(theme.value.sidebarColor, pack.sidebar) &&
    sameHex(theme.value.headerColor, pack.header)
  )
}

function applyPack(pack: ThemePack, opts: { colorsOnly?: boolean } = {}) {
  if (!opts.colorsOnly) themeName.value = pack.name
  theme.value = packToTheme(pack, theme.value, opts)
  importError.value = ''
  shareStatus.value = `Applied “${pack.name}”`
  window.setTimeout(() => {
    if (shareStatus.value.startsWith('Applied')) shareStatus.value = ''
  }, 2000)
}

function applyPreset(preset: ThemePack) {
  applyPack(preset, { colorsOnly: true })
}

function isDefaultTheme(): boolean {
  const t = theme.value
  return (
    sameHex(t.accentColor, DEFAULT_PCKT_THEME.accentColor) &&
    !t.bgColor &&
    !t.cardColor &&
    !t.sidebarColor &&
    !t.headerColor &&
    (t.fontFamily ?? DEFAULT_PCKT_THEME.fontFamily) === DEFAULT_PCKT_THEME.fontFamily &&
    (t.mode ?? DEFAULT_PCKT_THEME.mode) === DEFAULT_PCKT_THEME.mode &&
    (t.layoutWidth ?? DEFAULT_PCKT_THEME.layoutWidth) === DEFAULT_PCKT_THEME.layoutWidth
  )
}

function resetToDefault() {
  const next = { ...DEFAULT_PCKT_THEME }
  themeName.value = 'Default'
  theme.value = next
  applyWikiTheme(next)
  importError.value = ''
  shareStatus.value = 'Reset to default theme'
  window.setTimeout(() => {
    if (shareStatus.value.startsWith('Reset')) shareStatus.value = ''
  }, 2000)
}

function saveCurrentAsPalette() {
  const name =
    newPaletteName.value.trim() ||
    themeName.value.trim() ||
    nextCustomPaletteName(customPalettes.value)
  const pack = themeToPack(
    {
      ...theme.value,
      accentColor: theme.value.accentColor ?? '#ff5d5b',
      bgColor: theme.value.bgColor ?? '#f9fafb',
      cardColor: theme.value.cardColor ?? '#ffffff',
      sidebarColor: theme.value.sidebarColor ?? '#f3f4f6',
      headerColor: theme.value.headerColor ?? '#f9fafb',
    },
    name,
  )
  saveCustomPalette(pack)
  customPalettes.value = loadCustomPalettes()
  newPaletteName.value = ''
  shareStatus.value = `Saved palette “${name}”`
  window.setTimeout(() => {
    if (shareStatus.value.startsWith('Saved palette')) shareStatus.value = ''
  }, 2000)
}

function deleteCustom(pack: CustomPalette) {
  customPalettes.value = removeCustomPalette(pack.id)
}

function currentPack(): ThemePack {
  return themeToPack(theme.value, themeName.value.trim() || 'Custom theme')
}

function exportCurrent() {
  downloadThemePack(currentPack())
  shareStatus.value = 'Downloaded markdown theme'
  window.setTimeout(() => {
    if (shareStatus.value.startsWith('Downloaded')) shareStatus.value = ''
  }, 2000)
}

async function copyCurrent() {
  try {
    await copyThemeMarkdown(currentPack())
    shareStatus.value = 'Copied markdown — paste it anywhere'
    window.setTimeout(() => {
      if (shareStatus.value.startsWith('Copied')) shareStatus.value = ''
    }, 2500)
  } catch {
    importError.value = 'Could not copy to clipboard'
  }
}

function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      applyPack(importThemePack(String(reader.result)))
    } catch (err) {
      importError.value = err instanceof Error ? err.message : 'Invalid theme file'
    }
  }
  reader.readAsText(file)
}

function applyPaste() {
  try {
    applyPack(importThemePack(pasteText.value))
    pasteOpen.value = false
    pasteText.value = ''
  } catch (err) {
    importError.value = err instanceof Error ? err.message : 'Invalid theme markdown'
  }
}
</script>

<template>
  <div class="theme-editor card">
    <h3>Display theme</h3>
    <p class="muted">
      App-level styling. Managers can also recolor layout regions live with Theme mode on a wiki page.
      Themes export as a short markdown file you can share and paste.
    </p>

    <div class="field">
      <label class="label" for="theme-name">Theme name</label>
      <input
        id="theme-name"
        class="input"
        type="text"
        v-model="themeName"
        placeholder="Custom theme"
      />
    </div>

    <div class="field">
      <span class="label">Palettes</span>
      <div class="preset-row">
        <button
          v-for="preset in allPalettes"
          :key="isCustomPack(preset) ? preset.id : preset.name"
          type="button"
          class="palette-chip"
          :class="{ active: isPaletteActive(preset) }"
          :aria-pressed="isPaletteActive(preset)"
          :title="`Apply ${preset.name}`"
          @click="applyPreset(preset)"
        >
          <span class="palette-dots" aria-hidden="true">
            <span class="palette-dot" :style="{ background: preset.bg ?? '#f9fafb' }" />
            <span class="palette-dot" :style="{ background: preset.card ?? '#fff' }" />
            <span class="palette-dot" :style="{ background: preset.accent }" />
          </span>
          <span>{{ preset.name }}</span>
          <span
            v-if="isCustomPack(preset)"
            class="palette-remove"
            role="button"
            tabindex="0"
            :title="`Remove ${preset.name}`"
            :aria-label="`Remove ${preset.name}`"
            @click.stop.prevent="deleteCustom(preset)"
            @keydown.enter.stop.prevent="deleteCustom(preset)"
          >
            ×
          </span>
        </button>
        <button
          type="button"
          class="palette-add"
          title="Save current colors as a new palette"
          aria-label="Add custom palette"
          @click="saveCurrentAsPalette"
        >
          +
        </button>
      </div>
      <input
        class="input palette-name-input"
        type="text"
        v-model="newPaletteName"
        maxlength="40"
        placeholder="Name for + (optional)"
        aria-label="Optional name for new palette"
      />
      <div class="preset-actions reset-row">
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          :disabled="isDefaultTheme()"
          @click="resetToDefault"
        >
          Reset to default
        </button>
      </div>
    </div>

    <div class="field">
      <span class="label">Accent color</span>
      <ThemeColorField
        v-model="accentModel"
        :swatches="ACCENT_PRESETS"
        label="Accent"
        id="theme-accent"
      />
    </div>

    <div
      v-for="region in surfaceRegions"
      :key="region"
      class="field"
    >
      <span class="label">{{ THEME_REGION_LABELS[region] }}</span>
      <ThemeColorField
        :model-value="surfaceColor(region)"
        :swatches="SURFACE_PRESETS"
        :label="THEME_REGION_LABELS[region]"
        :id="`theme-surface-${region}`"
        @update:model-value="onSurfaceUpdate(region, $event)"
      />
      <button type="button" class="btn btn-ghost btn-sm surface-reset" @click="setSurface(region, undefined)">
        Reset
      </button>
    </div>

    <div class="field">
      <label class="label" for="font">Content font</label>
      <select
        id="font"
        class="select"
        :value="theme.fontFamily ?? 'Literata'"
        @change="updateField('fontFamily', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="font in FONT_OPTIONS" :key="font" :value="font">
          {{ font }}
        </option>
      </select>
    </div>

    <div class="field">
      <label class="label" for="mode">Color mode</label>
      <select
        id="mode"
        class="select"
        :value="theme.mode ?? 'auto'"
        @change="updateField('mode', ($event.target as HTMLSelectElement).value as PcktTheme['mode'])"
      >
        <option value="light">Light</option>
        <option value="dark">Dark</option>
        <option value="auto">Auto</option>
      </select>
    </div>

    <div class="field">
      <label class="label" for="width">Layout width</label>
      <select
        id="width"
        class="select"
        :value="theme.layoutWidth ?? 'medium'"
        @change="updateField('layoutWidth', ($event.target as HTMLSelectElement).value as PcktTheme['layoutWidth'])"
      >
        <option value="narrow">Narrow</option>
        <option value="medium">Medium</option>
        <option value="wide">Wide</option>
      </select>
    </div>

    <div class="field">
      <label class="label">Share theme</label>
      <div class="preset-actions">
        <button type="button" class="btn btn-secondary btn-sm" @click="copyCurrent">
          Copy markdown
        </button>
        <button type="button" class="btn btn-secondary btn-sm" @click="exportCurrent">
          Download .md
        </button>
        <label class="btn btn-secondary btn-sm import-label">
          Import file
          <input
            type="file"
            accept="text/markdown,.md,application/json,.json,.pckt-theme.md,.pckt-theme.json"
            hidden
            @change="onImportFile"
          />
        </label>
        <button type="button" class="btn btn-ghost btn-sm" @click="pasteOpen = !pasteOpen">
          Paste markdown
        </button>
      </div>
      <p v-if="shareStatus" class="share-status">{{ shareStatus }}</p>
      <p v-if="importError" class="import-error">{{ importError }}</p>
      <div v-if="pasteOpen" class="paste-box">
        <label class="label" for="theme-paste">Paste a theme markdown card</label>
        <textarea
          id="theme-paste"
          v-model="pasteText"
          class="input paste-input"
          rows="8"
          placeholder="# My theme&#10;&#10;```pckt-theme&#10;name: My theme&#10;accent: #ff5d5b&#10;…&#10;```"
        />
        <div class="preset-actions">
          <button type="button" class="btn btn-primary btn-sm" @click="applyPaste">
            Apply pasted theme
          </button>
          <button type="button" class="btn btn-ghost btn-sm" @click="pasteOpen = false">
            Close
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.theme-editor {
  padding: 1.25rem;
}

.preset-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-bottom: 0.5rem;
}

.palette-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0;
  padding: 0.3rem 0.55rem 0.3rem 0.35rem;
  border: 1px solid var(--pckt-border);
  border-radius: 999px;
  background: var(--pckt-bg);
  color: var(--pckt-text);
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
}

.palette-chip:hover,
.palette-chip:focus-visible {
  border-color: var(--pckt-accent);
}

.palette-chip.active {
  border-color: var(--pckt-accent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--pckt-accent) 35%, transparent);
}

.palette-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 0;
  width: 2rem;
  height: 2rem;
  border: 1px dashed var(--pckt-border);
  border-radius: 999px;
  background: transparent;
  color: var(--pckt-text-muted);
  font-size: 1.1rem;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
}

.palette-add:hover,
.palette-add:focus-visible {
  border-color: var(--pckt-accent);
  color: var(--pckt-accent);
}

.palette-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1rem;
  height: 1rem;
  margin-left: 0.1rem;
  border-radius: 999px;
  color: var(--pckt-text-muted);
  font-size: 0.85rem;
  line-height: 1;
}

.palette-remove:hover,
.palette-remove:focus-visible {
  color: var(--pckt-text);
}

.palette-name-input {
  margin-top: 0.5rem;
}

.reset-row {
  margin-top: 0.65rem;
}

.palette-dots {
  display: inline-flex;
  align-items: center;
}

.palette-dot {
  width: 0.85rem;
  height: 0.85rem;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--pckt-border) 70%, transparent);
  margin-inline-end: -0.3rem;
}

.palette-dot:last-child {
  margin-inline-end: 0;
}

.preset-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.import-label {
  cursor: pointer;
}

.surface-reset {
  margin-top: 0.35rem;
}

h3 {
  margin: 0 0 0.25rem;
  font-size: 1rem;
}

.share-status {
  margin: 0.5rem 0 0;
  font-size: 0.8125rem;
  color: var(--pckt-text-muted);
}

.import-error {
  margin: 0.5rem 0 0;
  font-size: 0.8125rem;
  color: var(--pckt-red);
}

.paste-box {
  margin-top: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.paste-input {
  font-family: var(--pckt-font-mono);
  font-size: 0.75rem;
  line-height: 1.4;
  resize: vertical;
}
</style>
