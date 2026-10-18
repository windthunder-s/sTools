<script setup lang="ts">
import { PluginDetail as SharedPluginDetail } from '@/components'
import type { PluginUninstallOptions, TabId, PluginDownloadState } from '@/components'
defineProps<{
  plugin: any
  isLoading?: boolean
  downloadState?: PluginDownloadState
  isRunning?: boolean
  initialTab?: TabId
  targetCommentId?: number | null
}>()
defineEmits<{
  (e: 'back'): void
  (e: 'open'): void
  (e: 'download'): void
  (e: 'upgrade'): void
  (e: 'uninstall', options: PluginUninstallOptions): void
  (e: 'kill'): void
  (e: 'open-folder'): void
  (e: 'package'): void
  (e: 'reload'): void
}>()
</script>
<template>
  <SharedPluginDetail
    :plugin="plugin"
    :is-loading="isLoading"
    :download-state="downloadState"
    :is-running="isRunning"
    :show-comments="false"
    :show-data="false"
    :show-download-count="true"
    @back="$emit('back')"
    @open="$emit('open')"
    @download="$emit('download')"
    @upgrade="$emit('upgrade')"
    @uninstall="$emit('uninstall', $event)"
    @kill="$emit('kill')"
    @open-folder="$emit('open-folder')"
  />
</template>
