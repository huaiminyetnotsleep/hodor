import { defineConfig } from 'vitepress'

// hodor 文档服务配置（独立于主应用，所有依赖装在 docs/ 下）
export default defineConfig({
  lang: 'zh-CN',
  title: 'hodor',
  // GitHub Pages 项目页路径（https://<user>.github.io/hodor/），资产与站内链接都会带上此前缀
  base: '/hodor/',
  description: 'Telegram Forum Topics 客服消息中继 Bot —— 一个用户，一个话题，消息不串线',

  // VitePress 不会给 head 里的绝对路径自动加 base 前缀，favicon 需显式写 /hodor/ 前缀
  head: [['link', { rel: 'icon', href: '/hodor/favicon.ico' }]],

  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '功能介绍', link: '/guide/features' },
      { text: '部署流程', link: '/guide/deploy' },
      { text: '原理与架构', link: '/guide/architecture' },
      { text: '运维手册', link: '/guide/ops' },
      {
        text: '开发',
        items: [
          { text: '本地开发', link: '/guide/development' },
          { text: '发布与更新', link: '/guide/release' },
          { text: '数据表', link: '/guide/database' },
        ],
      },
      {
        text: 'TODO',
        items: [
          { text: '全量列表', link: '/todo/' },
          { text: 'P1', link: '/todo/p1' },
          { text: 'P2', link: '/todo/p2' },
          { text: 'P3', link: '/todo/p3' },
        ],
      },
    ],

    sidebar: {
      '/todo/': [
        {
          text: 'TODO',
          items: [
            { text: '全量列表', link: '/todo/' },
            { text: 'P1', link: '/todo/p1' },
            { text: 'P2', link: '/todo/p2' },
            { text: 'P3', link: '/todo/p3' },
          ],
        },
      ],
      '/guide/': [
        {
          text: '指南',
          items: [
            { text: '功能介绍', link: '/guide/features' },
            { text: '部署流程', link: '/guide/deploy' },
            { text: '原理与架构', link: '/guide/architecture' },
            { text: '运维手册', link: '/guide/ops' },
          ],
        },
        {
          text: '开发',
          items: [
            { text: '本地开发', link: '/guide/development' },
            { text: '发布与更新', link: '/guide/release' },
            { text: '数据表', link: '/guide/database' },
          ],
        },
        {
          text: '更多',
          items: [
            { text: 'TODO', link: '/todo/' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/huaiminyetnotsleep/hodor' },
    ],

    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            noResultsText: '未找到相关结果',
            resetButtonTitle: '清除查询条件',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
          },
        },
      },
    },

    outline: { level: [2, 3], label: '本页目录' },

    docFooter: { prev: '上一页', next: '下一页' },

    lastUpdated: { text: '最后更新' },

    returnToTopLabel: '回到顶部',

    externalLinkIcon: true,
  },
})
