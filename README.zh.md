# dsh-tool-firecrawl

[English](README.md) | [中文](README.zh.md)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的 [Firecrawl](https://www.firecrawl.dev/) 网页抓取 Cordis 插件。Agent 可以抓取页面、映射站点、搜索网页并管理爬取任务，同时 API Key 和超长内容不会进入工具输出。

## 安装

```sh
npm install @libai168/dsh-tool-firecrawl
```

需要 peer dependency：`@deepseek-ai/cordis`（^4.0.1）和 `@deepseek-ai/dsh-tools`（^0.1.0-rc.6）。

## 配置

```yaml
- name: 'github:LJH-snow/dsh-tool-firecrawl'
  config:
    # baseUrl: 'https://api.firecrawl.dev'
    apiKeyEnv: 'FIRECRAWL_API_KEY'
    # timeoutMs: 120000
```

插件从 `apiKeyEnv` 指定的环境变量读取 Firecrawl API Key（默认是 `FIRECRAWL_API_KEY`）。不要把可用密钥写入源码、示例、测试或提交的配置文件。密钥在 Firecrawl 控制台创建，并只授予部署所需的访问权限。

`baseUrl` 覆盖 必须是绝对的 `http://` 或 `https://` 根地址。只允许公网可达主机：localhost、环回、私有、链路本地、CGNAT、组播、保留/文档/基准测试网段以及全部 IANA 特殊用途地址段都会被拒绝；DNS 结果包含任一此类地址时会在发出请求前 fail closed。不允许 credentials、query、fragment 或非根路径。

## 工具

| 工具 | 说明 | 写操作 |
|---|---|---|
| `firecrawl_auth_test` | 验证 API Key 并报告剩余额度，不回显密钥 | 否 |
| `firecrawl_scrape` | 抓取单个 URL，返回 markdown 和页面元数据 | 否 |
| `firecrawl_map` | 映射站点 URL 列表，可按搜索词排序 | 否 |
| `firecrawl_search` | 网页搜索，返回标题、URL 和描述 | 否 |
| `firecrawl_crawl_start` | 启动爬取任务并返回任务 ID（消耗额度） | 是 |
| `firecrawl_crawl_status` | 查看爬取任务状态和页面元数据 | 否 |
| `firecrawl_crawl_cancel` | 取消单个爬取任务 | 是 |

## 安全契约

- API Key 在插件启动时从环境变量读取，不进入工具返回值或渲染文本。
- 抓取 markdown 上限 20000 字符、描述 500、标题 300、map 链接 200 条、搜索结果 100 条、爬取状态页面 50 条。
- 爬取状态只返回页面元数据，不会转发爬取结果中的页面内容。
- 爬取分页（`next`）URL 只接受与所配置 Firecrawl API 主机同源的地址，Bearer 密钥不会发送到外部主机。
- `firecrawl_crawl_start` 默认 20 页且上限 200 页，控制额度消耗；它与 `firecrawl_crawl_cancel` 标记为 `kind: 'edit'`。
- 调用方取消信号会传递给 `fetch`，默认请求超时为 120 秒。
- API 错误会规范化为 `{ ok: false, reason }` 或 `{ found: false, reason }`。

## API 范围

当前版本使用 Firecrawl v2 公开 API：`GET /v2/team/credit-usage`、`POST /v2/scrape`、`POST /v2/map`、`POST /v2/search`，以及 `POST /v2/crawl`、`GET /v2/crawl/{id}`、`DELETE /v2/crawl/{id}` 任务生命周期。结构化抽取、批量抓取、文件解析、监控和浏览器交互暂未包含。

## 开发

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## 许可证

[MIT](LICENSE)
