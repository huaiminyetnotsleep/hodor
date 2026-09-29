# 文档服务（VitePress）：所有依赖安装在 docs/ 下，根目录不产生 node_modules。
# 首次运行各命令会自动检查并安装依赖。

DOCS_DIR := docs

.PHONY: help docs-install docs-dev docs-build docs-preview

help: ## 显示可用命令
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  make %-14s %s\n", $$1, $$2}'

docs-install: ## 安装文档服务依赖（装到 docs/ 下）
	npm --prefix $(DOCS_DIR) install

docs-dev: ## 启动文档开发服务器 http://localhost:5173
	@[ -d $(DOCS_DIR)/node_modules/vitepress ] || npm --prefix $(DOCS_DIR) install
	npm --prefix $(DOCS_DIR) run dev

docs-build: ## 构建文档站点到 docs/.vitepress/dist
	@[ -d $(DOCS_DIR)/node_modules/vitepress ] || npm --prefix $(DOCS_DIR) install
	npm --prefix $(DOCS_DIR) run build

docs-preview: ## 预览构建产物
	@[ -d $(DOCS_DIR)/node_modules/vitepress ] || npm --prefix $(DOCS_DIR) install
	npm --prefix $(DOCS_DIR) run preview
