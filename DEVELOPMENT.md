# dsh-tool-firecrawl 开发文档

## 1. 项目概览

| 项 | 内容 |
|---|---|
| 项目名 | `dsh-tool-firecrawl` |
| 定位 | DeepSeek Harness 的 Firecrawl 网页抓取插件 |
| 版本 | v0.2.0 |
| 架构 | Cordis 插件 + `ctx.tools.register(defineTool(...))` |
| API | Firecrawl v2 Public REST API（`https://api.firecrawl.dev/v2`） |
| 认证 | `Authorization: Bearer` 请求头，密钥从环境变量读取 |

### 1.1 目录

```text
src/client.ts        FirecrawlClient：fetch 注入、超时、AbortSignal、错误映射、响应限长
src/index.ts         7 个 defineTool 定义与插件 apply
 tests/client.spec.ts 客户端认证、参数、限长、next 校验、错误映射测试
 tests/tools.spec.ts  工具注册、render、写操作 kind 测试
examples/cordis.yml  dsh 组合配置示例
```

## 2. 技术决策

### 2.1 认证

- 从 `apiKeyEnv` 指定的环境变量读取 API Key，默认变量名为 `FIRECRAWL_API_KEY`。
- 客户端仅发送 `Authorization: Bearer`，不把密钥放进 URL、工具返回值、渲染文本或日志。
- 测试使用运行时随机值或外部环境变量，不在源码中写入凭据字面量。

### 2.2 工具范围

- 读：认证验证（credit-usage）、scrape、map、search、crawl 状态。
- 写：crawl 启动（计费操作）与 crawl 取消，均标记 `kind: 'edit'`。
- 不做：extract、batch scrape、parse、monitor、browser interact 等高级端点。

### 2.3 限长与成本防护

- scrape markdown 截断至 20000 字符并返回 `truncated` 标记；标题 300、描述 500。
- map 链接保留前 200 条并返回 `total`/`truncated`；search 结果上限 100 条；crawl 状态页面保留前 50 条且只输出元数据。
- crawl 启动默认 `limit: 20`，客户端强制 1-200，避免意外触发最多 10000 页的计费爬取。
- crawl 分页 `next` URL 必须与所配置 API 主机同源且路径以 `/v2/` 开头，否则拒绝请求，防止 Bearer 密钥外发。
- v2 契约要点（2026-10 官方 OpenAPI 核对）：`formats` 使用对象形式 `[{ type: 'markdown' }]`；search 响应为 `data.web[]`；metadata 字段可能是字符串或字符串数组，客户端统一展平。

### 2.4 超时与取消

- 默认 HTTP 超时 120 秒（scrape/crawl 属于慢请求），0 表示禁用。
- 调用方 `AbortSignal` 与内部超时通过 `AbortSignal.any` 合并。

## 3. 测试

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

测试覆盖 Bearer 请求头、scrape 参数与截断、map/search 映射与上限、crawl 启动限幅、crawl 状态脱敏、next URL 同源校验、DELETE 取消、HTTP 错误映射、工具注册、render 与写操作展示类型。

## 4. 后续方向

- 增加结构化抽取（extract）与批量抓取（batch scrape）工具。
- 增加 crawl 错误明细查询（Get Crawl Errors）。
- 按 Firecrawl API 版本变化补充兼容性测试。

## endpoint 安全校验

`baseUrl` 规范化为 origin + 路径前缀，禁止 credentials、query 和 fragment。每次请求前用 `src/url-security.ts` 做 fail-closed 目标校验：拒绝 localhost/.local 名称、环回、私有、链路本地、CGNAT、组播、保留及全部 IANA 特殊用途地址段，域名 DNS 结果含任一此类地址即拒绝。阻断清单（18 个 IPv4 + 16 个 IPv6）与 IANA 注册表对齐，`src/url-security.ts` 由 `.verify/url-security.template.ts` 生成，不得单独修改。`lookupImpl` 仅作测试注入点，不进入插件配置接口。
