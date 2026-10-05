# dsh-tool-firecrawl

[English](README.md) | [中文](README.zh.md)

[Firecrawl](https://www.firecrawl.dev/) web scraping integration for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) as a Cordis plugin. The agent can scrape pages, map sites, search the web, and manage crawl jobs while the API key and oversized content stay out of tool output.

## Install

```sh
npm install @libai168/dsh-tool-firecrawl
```

Requires `@deepseek-ai/cordis` (^4.0.1) and `@deepseek-ai/dsh-tools` (^0.1.0-rc.6) as peer dependencies.

## Configuration

```yaml
- name: 'github:LJH-snow/dsh-tool-firecrawl'
  config:
    # baseUrl: 'https://api.firecrawl.dev'
    apiKeyEnv: 'FIRECRAWL_API_KEY'
    # timeoutMs: 120000
```

The plugin reads the Firecrawl API key from the environment variable named by `apiKeyEnv` (default: `FIRECRAWL_API_KEY`). Do not put a usable key in source, examples, tests, or committed configuration. Create the key in the Firecrawl dashboard and grant only the access your deployment needs.

The `baseUrl` override must be an absolute `http://` or `https://` root URL. Only publicly reachable hosts are allowed: localhost, loopback, private, link-local, CGNAT, multicast, reserved/documentation/benchmark ranges, and every IANA special-purpose block are rejected, and a hostname whose DNS results contain any such address fails closed before the request is sent. Credentials, query strings, fragments, and non-root paths are not allowed.

## Tools

| Tool | Description | Write |
|---|---|---|
| `firecrawl_auth_test` | Verify the API key and report remaining credits without returning the key | No |
| `firecrawl_scrape` | Scrape one URL to markdown plus page metadata | No |
| `firecrawl_map` | Map the URLs of one site, optionally ranked by a search query | No |
| `firecrawl_search` | Search the web and return titles, URLs, and descriptions | No |
| `firecrawl_crawl_start` | Start a crawl job and return its ID (billable) | Yes |
| `firecrawl_crawl_status` | Read one crawl job's status and page metadata | No |
| `firecrawl_crawl_cancel` | Cancel one crawl job | Yes |

## Security contract

- The API key is read from an environment variable at plugin startup and is never included in tool output or rendered text.
- Scrape markdown is capped at 20,000 characters, descriptions at 500, titles at 300, map links at 200 entries, search results at 100 entries, and crawl status pages at 50 entries.
- Crawl status returns page metadata only; page content from crawl results is never forwarded.
- Crawl pagination (`next`) URLs are accepted only when they stay on the configured Firecrawl API host, so the bearer key is never sent to a foreign host.
- `firecrawl_crawl_start` defaults to 20 pages and clamps the page limit at 200 to bound credit usage; it and `firecrawl_crawl_cancel` are marked `kind: 'edit'`.
- The client passes caller cancellation signals through to `fetch` and uses a 120-second timeout by default.
- API failures are normalized into `{ ok: false, reason }` or `{ found: false, reason }` tool results.

## API scope

This version uses the Firecrawl v2 public API: `GET /v2/team/credit-usage`, `POST /v2/scrape`, `POST /v2/map`, `POST /v2/search`, and the `POST /v2/crawl`, `GET /v2/crawl/{id}`, `DELETE /v2/crawl/{id}` job lifecycle. Structured extraction, batch scrape, parse, monitors, and browser interactions are intentionally not included yet.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## License

[MIT](LICENSE)
