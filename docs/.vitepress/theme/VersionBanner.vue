<script setup lang="ts">
import { computed } from 'vue'
import { useData } from 'vitepress'
import type { ThemeConfig } from '../config'
import { versionHref } from './versioning'

const { theme, page, site } = useData<ThemeConfig>()
const versioning = computed(() => theme.value.versioning)
const latest = computed(() => versioning.value.versions.find((v) => v.latest))
const latestHref = computed(() =>
  latest.value ? versionHref(latest.value, page.value.relativePath, site.value.cleanUrls) : '/docs/',
)
</script>

<template>
  <div v-if="versioning.current !== versioning.latest" class="VersionBanner">
    <p>
      You are reading the documentation for Kloak <strong>{{ versioning.current }}</strong>.
      The latest release is {{ versioning.latest }}.
      <a :href="latestHref" target="_self">Read the latest docs</a>
    </p>
  </div>
</template>

<style scoped>
.VersionBanner {
  margin-bottom: 24px;
  border: 1px solid var(--vp-custom-block-warning-border);
  border-radius: 8px;
  padding: 12px 16px;
  background-color: var(--vp-custom-block-warning-bg);
  color: var(--vp-custom-block-warning-text);
  font-size: 14px;
  line-height: 24px;
}

.VersionBanner a {
  font-weight: 600;
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.VersionBanner a:hover {
  color: var(--vp-c-brand-1);
}

/* On the home page the banner sits above the hero, outside the doc layout. */
.VPHome .VersionBanner {
  margin: 24px auto 0;
  max-width: 1152px;
  width: calc(100% - 48px);
}

@media (min-width: 640px) {
  .VPHome .VersionBanner {
    width: calc(100% - 96px);
  }
}

@media (min-width: 960px) {
  .VPHome .VersionBanner {
    width: calc(100% - 128px);
  }
}
</style>
