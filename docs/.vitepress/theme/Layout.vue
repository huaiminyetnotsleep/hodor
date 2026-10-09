<script setup lang="ts">
import { withBase } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
</script>

<template>
  <DefaultTheme.Layout>
    <template #home-hero-image>
      <div class="home-hero-images">
        <img
          :src="withBase('/icon.png')"
          class="home-hero-icon"
          alt="Hodor 图标"
          width="88"
          height="88"
        />
        <img
          :src="withBase('/social-preview.png')"
          class="home-hero-banner"
          alt="Hodor Telegram 话题式客服机器人：一人一话题，消息不串线"
          width="1280"
          height="640"
        />
      </div>
    </template>
  </DefaultTheme.Layout>
</template>
