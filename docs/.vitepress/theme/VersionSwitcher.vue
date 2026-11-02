<script setup lang="ts">
import { computed, ref } from 'vue'
import { useData } from 'vitepress'
import VPFlyout from 'vitepress/dist/client/theme-default/components/VPFlyout.vue'
import type { ThemeConfig } from '../config'
import { versionHref, versionLabel } from './versioning'

defineProps<{ screenMenu?: boolean }>()

const { theme, page, site } = useData<ThemeConfig>()
const versioning = computed(() => theme.value.versioning)
const links = computed(() =>
  versioning.value.versions.map((version) => ({
    id: version.id,
    text: versionLabel(version),
    href: versionHref(version, page.value.relativePath, site.value.cleanUrls),
    current: version.id === versioning.value.current,
  })),
)

const open = ref(false)
</script>

<template>
  <VPFlyout
    v-if="!screenMenu"
    class="VersionSwitcher"
    :button="versioning.current"
    label="Documentation version"
  >
    <a
      v-for="link in links"
      :key="link.id"
      class="link"
      :class="{ active: link.current }"
      :href="link.href"
      target="_self"
    >{{ link.text }}</a>
    <div class="divider" />
    <a class="link" :href="versioning.releasesUrl" target="_blank" rel="noreferrer">
      Release notes
    </a>
  </VPFlyout>

  <div v-else class="VersionSwitcherScreen" :class="{ open }">
    <button class="button" :aria-expanded="open" @click="open = !open">
      <span>Version: {{ versioning.current }}</span>
      <span class="vpi-plus button-icon" />
    </button>
    <div class="items">
      <a
        v-for="link in links"
        :key="link.id"
        class="item"
        :class="{ active: link.current }"
        :href="link.href"
        target="_self"
      >{{ link.text }}</a>
      <a class="item" :href="versioning.releasesUrl" target="_blank" rel="noreferrer">
        Release notes
      </a>
    </div>
  </div>
</template>

<style scoped>
.link {
  display: block;
  border-radius: 6px;
  padding: 0 12px;
  line-height: 32px;
  font-size: 14px;
  font-weight: 500;
  color: var(--vp-c-text-1);
  white-space: nowrap;
  transition:
    background-color 0.25s,
    color 0.25s;
}

.link:hover {
  color: var(--vp-c-brand-1);
  background-color: var(--vp-c-default-soft);
}

.link.active {
  color: var(--vp-c-brand-1);
}

.divider {
  margin: 8px -12px;
  border-top: 1px solid var(--vp-c-divider);
}

.VersionSwitcherScreen {
  border-bottom: 1px solid var(--vp-c-divider);
  height: 48px;
  overflow: hidden;
  transition: border-color 0.5s;
}

.VersionSwitcherScreen.open {
  height: auto;
  padding-bottom: 10px;
}

.VersionSwitcherScreen .button {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 4px 11px 0;
  width: 100%;
  line-height: 24px;
  font-size: 14px;
  font-weight: 500;
  color: var(--vp-c-text-1);
  transition: color 0.25s;
}

.VersionSwitcherScreen .button:hover {
  color: var(--vp-c-brand-1);
}

.VersionSwitcherScreen .button-icon {
  transition: transform 0.25s;
}

.VersionSwitcherScreen.open .button-icon {
  transform: rotate(45deg);
}

.VersionSwitcherScreen .item {
  display: block;
  margin-left: 12px;
  line-height: 32px;
  font-size: 14px;
  font-weight: 400;
  color: var(--vp-c-text-1);
  transition: color 0.25s;
}

.VersionSwitcherScreen .item:hover,
.VersionSwitcherScreen .item.active {
  color: var(--vp-c-brand-1);
}
</style>
