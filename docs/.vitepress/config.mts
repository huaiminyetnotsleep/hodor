import { defineConfig } from 'vitepress'

// hodor 文档服务配置（独立于主应用，所有依赖装在 docs/ 下）
export default defineConfig({
  lang: 'zh-CN',
  title: 'hodor',
  description: 'Telegram Forum Topics 客服消息中继 Bot —— 一个用户，一个话题，消息不串线',

  head: [['link', { rel: 'icon', href: '/favicon.ico' }]],

  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      {
        text: '指南',
        items: [
          { text: '功能介绍', link: '/guide/features' },
          { text: '部署流程', link: '/guide/deploy' },
          { text: '原理与架构', link: '/guide/architecture' },
          { text: '运维手册', link: '/guide/ops' },
          { text: '数据表', link: '/guide/database' },
        ],
      },
      { text: 'PRD', link: '/prd' },
      {
        text: 'TODO',
        items: [
          { text: '全量列表', link: '/todo/' },
          { text: 'P1', link: '/todo/p1' },
          { text: 'P2', link: '/todo/p2' },
          { text: 'P3', link: '/todo/p3' },
        ],
      },
      {
        text: 'GitHub',
        link: 'https://github.com/huaiminyetnotsleep/hodor',
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
            { text: '数据表', link: '/guide/database' },
          ],
        },
        {
          text: '更多',
          items: [
            { text: '产品需求文档（PRD）', link: '/prd' },
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
