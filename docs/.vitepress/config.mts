import { defineConfig } from 'vitepress'

// hodor 文档服务配置（独立于主应用，所有依赖装在 docs/ 下）
export default defineConfig({
  lang: 'zh-CN',
  title: 'Hodor',
  // GitHub Pages 项目页路径（https://<user>.github.io/hodor/），资产与站内链接都会带上此前缀
  base: '/hodor/',
  description: 'Telegram 双向私聊机器人 —— 客服消息双向转发，一个用户一个群组独立话题，消息不串线',

  // VitePress 不会给 head 里的绝对路径自动加 base 前缀，图标需显式写 /hodor/ 前缀
  // 图标文件均在 docs/public/（icon.png 为 logo，另生成 apple-touch-icon.png 180 / favicon.png 64）
  head: [
    ['link', { rel: 'icon', type: 'image/png', sizes: '64x64', href: '/hodor/favicon.png' }],
    ['link', { rel: 'apple-touch-icon', sizes: '180x180', href: '/hodor/apple-touch-icon.png' }],
  ],

  themeConfig: {
    // 导航栏 logo 会经 withBase 自动补上 /hodor/ 前缀
    logo: '/icon.png',

    // 顶部导航只保留用户最常读的三页；架构 / 开发 / 规划等经侧边栏与页面互链到达
    nav: [
      { text: '功能介绍', link: '/guide/features' },
      { text: '部署流程', link: '/guide/deploy' },
      { text: '运维手册', link: '/guide/ops' },
    ],

    // 全站共用一份侧边栏，按受众分四组：使用（普通用户）→ 参考（维护者）
    // → 开发（贡献者）→ 规划（未实现）。三份关键文档展开二级小节便于直达；
    // 一级分组固定展开；三份关键文档的二级小节默认收起（collapsed: true，
    // 可点击展开，当前所在页面的小节列表也会自动展开）；
    // 锚点 id 以 VitePress 构建产物为准，页面改标题时需同步
    sidebar: [
      {
        text: '使用',
        items: [
          {
            text: '功能介绍',
            link: '/guide/features',
            collapsed: true,
            items: [
              { text: '核心概念', link: '/guide/features#核心概念' },
              { text: '对话流程', link: '/guide/features#对话流程' },
              { text: '消息能力', link: '/guide/features#消息能力' },
              { text: '人机验证', link: '/guide/features#人机验证' },
              { text: '频率限制', link: '/guide/features#频率限制' },
              { text: '管理命令', link: '/guide/features#管理命令' },
              { text: '拦截行为汇总', link: '/guide/features#拦截行为汇总' },
            ],
          },
          {
            text: '部署流程',
            link: '/guide/deploy',
            collapsed: true,
            items: [
              { text: '前置条件', link: '/guide/deploy#前置条件' },
              { text: '环境变量', link: '/guide/deploy#环境变量-基础-9-项-权威清单' },
              { text: '部署方式（三选一）', link: '/guide/deploy#部署方式-三选一' },
              { text: '部署多个实例', link: '/guide/deploy#部署多个实例' },
              { text: 'Turnstile 申请与配置（可选）', link: '/guide/deploy#turnstile' },
              { text: '部署后收尾', link: '/guide/deploy#部署后收尾' },
              { text: '常见问题', link: '/guide/deploy#常见问题' },
            ],
          },
          {
            text: '运维手册',
            link: '/guide/ops',
            collapsed: true,
            items: [
              { text: 'Webhook 绑定与解绑', link: '/guide/ops#webhook-绑定与解绑' },
              { text: '更换 Bot 或客服群', link: '/guide/ops#switch-bot-or-group' },
              { text: '验证模式与密钥变更', link: '/guide/ops#验证模式与密钥变更' },
              { text: '健康自检与版本', link: '/guide/ops#健康自检与版本' },
              { text: '常用 SQL', link: '/guide/ops#常用-sql' },
              { text: '故障排查', link: '/guide/ops#故障排查' },
            ],
          },
        ],
      },
      {
        text: '参考（维护者）',
        items: [
          { text: '原理与架构', link: '/guide/architecture' },
          { text: '数据表', link: '/guide/database' },
        ],
      },
      {
        text: '开发',
        items: [
          { text: '本地开发', link: '/guide/development' },
          { text: '发布与更新', link: '/guide/release' },
        ],
      },
      {
        text: '规划（未实现）',
        items: [
          { text: '规划总览', link: '/todo/' },
          { text: 'P3 自托管', link: '/todo/p3' },
        ],
      },
    ],

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
