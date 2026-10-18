<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
const method = ref<'wechat' | 'phone'>('wechat')
const router = useRouter()
</script>
<template>
  <main class="content-panel login-page">
    <section class="card login-card">
      <img src="/logo.png" class="login-logo" alt="S" />
      <h1>登录 sTools</h1>
      <p class="subtitle">登录功能正在准备中，所有本地功能均可免登录使用。</p>
      <div class="login-tabs" role="tablist" aria-label="登录方式">
        <button
          role="tab"
          :aria-selected="method === 'wechat'"
          :class="{ active: method === 'wechat' }"
          @click="method = 'wechat'"
        >
          微信登录
        </button>
        <button
          role="tab"
          :aria-selected="method === 'phone'"
          :class="{ active: method === 'phone' }"
          @click="method = 'phone'"
        >
          手机号登录
        </button>
      </div>
      <div class="login-status" role="status">
        <h2>{{ method === 'wechat' ? '微信登录暂未接入' : '手机号登录暂未接入' }}</h2>
        <p>
          {{
            method === 'wechat'
              ? '接入后可通过微信扫码登录。'
              : '接入后可使用手机号和短信验证码登录。'
          }}
        </p>
        <p>当前无需提交任何个人信息。</p>
      </div>
      <button class="btn btn-solid" @click="router.replace({ name: 'Shortcuts' })">
        继续免登录使用
      </button>
    </section>
  </main>
</template>
<style scoped>
.login-page {
  padding: 32px;
}
.login-card {
  max-width: 560px;
  margin: 16px auto;
  padding: 32px;
  text-align: center;
}
.login-logo {
  width: 60px;
  height: 60px;
}
h1 {
  font-size: 24px;
  margin: 16px 0;
}
h2 {
  font-size: 17px;
}
p {
  line-height: 1.8;
  color: var(--text-secondary);
}
.login-tabs {
  display: flex;
  gap: 8px;
  margin-top: 28px;
}
.login-tabs button {
  flex: 1;
  padding: 12px;
  border: 1px solid var(--divider-color);
  border-radius: 8px;
  background: var(--card-bg);
  color: var(--text-color);
  cursor: pointer;
}
.login-tabs button.active {
  border-color: var(--primary-color);
  color: var(--primary-color);
  background: var(--primary-light-bg);
}
.login-status {
  padding: 24px 0;
}
</style>
