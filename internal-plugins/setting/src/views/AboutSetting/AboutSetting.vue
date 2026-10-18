<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { GITHUB_REPOSITORY_URL } from '@shared/updateSource'

const version = ref('')

/**
 * 读取宿主版本用于标识当前 sTools 构建。
 * @returns 版本加载结束的 Promise。
 */
async function loadVersion(): Promise<void> {
  // 插件仍使用上游 API 命名，保证插件调用契约兼容。
  version.value = await window.ztools.internal.getAppVersion()
}

/**
 * 打开原始 ZTools 项目，明确框架和界面的来源。
 * @returns 无返回值。
 */
function openUpstream(): void {
  window.ztools.shellOpenExternal(GITHUB_REPOSITORY_URL)
}

onMounted(loadVersion)
</script>

<template>
  <div class="content-panel">
    <div class="about-container">
      <img class="about-logo" src="/logo.png" alt="sTools" draggable="false" />
      <h1>sTools</h1>
      <p class="about-version">v{{ version }} · 基于 ZTools 3.2.0</p>
      <div class="card about-card">
        <h2>快捷键优先的工具箱</h2>
        <p>沿用 ZTools 的 Electron 框架、Vue 前端与插件运行机制，在此基础上调整和优化。</p>
        <p>默认使用 Ctrl + Alt + Space 呼出；进入「快捷键管理」为插件的每个功能设置快捷键。</p>
      </div>
      <div class="card about-card">
        <h2>独立配置与版本</h2>
        <p>个人数据位于用户目录的 .stools 文件夹，与 ZTools 分开保存。</p>
        <p>
          此版本采用手动更新，请使用 sTools 的完整安装包。上游账户、插件市场等服务仍以 ZTools
          的名称显示。
        </p>
      </div>
      <div class="card about-card">
        <h2>开源来源</h2>
        <p>
          ZTools © 2025 lzx8589561，及其贡献者。依据 MIT 许可证修改，完整许可证随源码和程序保留。
        </p>
        <button class="btn" @click="openUpstream">查看 ZTools 原项目</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.about-container {
  max-width: 720px;
  margin: 24px auto;
}
.about-logo {
  width: 64px;
  height: 64px;
}
h1 {
  margin: 12px 0 4px;
  font-size: 30px;
}
.about-version {
  opacity: 0.6;
  margin-bottom: 24px;
}
.about-card {
  padding: 20px;
  margin: 14px 0;
}
h2 {
  font-size: 15px;
  margin: 0 0 10px;
}
p {
  line-height: 1.8;
  font-size: 13px;
}
</style>
