import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallView } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FirecrawlClient, FirecrawlError } from './client.js'

export const name = 'dsh-tool-firecrawl'
export const inject = ['tools']

export interface FirecrawlPluginConfig {
  baseUrl?: string
  /** Environment variable containing the Firecrawl API key. */
  apiKeyEnv?: string
  timeoutMs?: number
}

export function apply(ctx: Context, config: FirecrawlPluginConfig = {}) {
  const apiKeyEnv = config.apiKeyEnv ?? 'FIRECRAWL_API_KEY'
  const client = new FirecrawlClient({
    baseUrl: config.baseUrl,
    apiKey: process.env[apiKeyEnv],
    timeoutMs: config.timeoutMs,
  })
  for (const tool of createTools(client)) ctx.tools.register(tool)
}

function text(value: string) {
  return [{ type: 'text' as const, text: value }]
}

function unavailable(reason: string) {
  return { found: false, items: [], reason }
}

function errorReason(error: unknown): string {
  return error instanceof FirecrawlError ? error.message : error instanceof Error ? error.message : String(error)
}

const MARKDOWN_PREVIEW = 4000
const MAP_RENDER_LIMIT = 100
const CRAWL_PAGE_RENDER_LIMIT = 50

function renderCredit(value: { ok?: boolean; reason?: string; remainingCredits?: number; planCredits?: number; baseUrl?: string }) {
  return value.ok
    ? text(`Firecrawl authentication succeeded at ${value.baseUrl ?? ''} remaining=${value.remainingCredits ?? 0} plan=${value.planCredits ?? 0}`)
    : text(`Firecrawl authentication failed: ${value.reason ?? ''}`)
}

function renderScrape(value: { found?: boolean; reason?: string; title?: string; description?: string; sourceUrl?: string; finalUrl?: string; statusCode?: number; markdown?: string; truncated?: boolean }) {
  if (!value.found) return text(value.reason ?? 'Firecrawl scrape failed.')
  const preview = (value.markdown ?? '').slice(0, MARKDOWN_PREVIEW)
  return text([
    `${value.title || '(untitled)'} (${value.finalUrl || value.sourceUrl || ''}) status=${value.statusCode ?? 0}`,
    value.description ? `description=${value.description}` : '',
    `--- markdown ---`,
    preview,
    value.truncated || (value.markdown ?? '').length > MARKDOWN_PREVIEW ? `[truncated preview of ${(value.markdown ?? '').length} characters]` : '',
  ].filter(Boolean).join('\n'))
}

function renderMap(items: Array<{ url?: string; title?: string; description?: string }>, total?: number) {
  if (!items.length) return text('No Firecrawl map links found.')
  const shown = items.slice(0, MAP_RENDER_LIMIT).map(link => `${link.url ?? ''}${link.title ? ` — ${link.title}` : ''}`)
  const omitted = Math.max(0, items.length - MAP_RENDER_LIMIT)
  if (total && total > items.length) shown.push(`... total=${total} links (${items.length} returned)`)
  if (omitted > 0) shown.push(`... ${omitted} more links omitted`)
  return text(shown.join('\n'))
}

function renderSearch(items: Array<{ url?: string; title?: string; description?: string }>) {
  if (!items.length) return text('No Firecrawl search results found.')
  return text(items.map((result, index) => [
    `${index + 1}. ${result.title || result.url || ''}`,
    `  ${result.url ?? ''}`,
    result.description ? `  ${result.description}` : '',
  ].filter(Boolean).join('\n')).join('\n'))
}

function renderCrawlStatus(value: { found?: boolean; reason?: string; id?: string; status?: string; total?: number; completed?: number; creditsUsed?: number; hasMore?: boolean; pages?: Array<{ url?: string; title?: string; statusCode?: number }> }) {
  if (!value.found) return text(value.reason ?? 'Firecrawl crawl status unavailable.')
  const shown = (value.pages ?? []).slice(0, CRAWL_PAGE_RENDER_LIMIT).map(page => `  ${page.url ?? ''} title=${page.title ?? ''} status=${page.statusCode ?? 0}`)
  if ((value.pages ?? []).length > CRAWL_PAGE_RENDER_LIMIT) shown.push(`  ... ${value.pages!.length - CRAWL_PAGE_RENDER_LIMIT} more pages omitted`)
  return text([
    `crawl=${value.id ?? ''} status=${value.status ?? ''} completed=${value.completed ?? 0}/${value.total ?? 0} creditsUsed=${value.creditsUsed ?? 0} hasMore=${value.hasMore ? 'yes' : 'no'}`,
    ...shown,
  ].join('\n'))
}

function renderWrite(value: { ok?: boolean; reason?: string; id?: string; status?: string }) {
  return value.ok
    ? text(`Crawl ${value.id ?? ''} status=${value.status ?? 'cancelled'}`)
    : text(`Firecrawl crawl operation failed: ${value.reason ?? ''}`)
}

function splitPaths(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const paths = value.split(',').map(item => item.trim()).filter(Boolean)
  return paths.length ? paths : undefined
}

export function createTools(client: FirecrawlClient) {
  return [
    defineTool({
      name: 'firecrawl_auth_test',
      description: 'Verify the configured Firecrawl API key without returning it, and report remaining plan credits.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, remainingCredits: { type: 'number' }, planCredits: { type: 'number' }, baseUrl: { type: 'string' } } },
        render: (_args, value) => renderCredit(value),
      },
      presentCall(): ToolCallView { return { card: 'generic', title: 'Verify Firecrawl credentials', kind: 'read' } },
      async execute(_args, exec) {
        if (!client.hasCredentials()) return { ok: false, reason: 'Firecrawl API key is not configured.' }
        try {
          const usage = await client.authTest(exec.signal)
          return { ok: true, baseUrl: client.getBaseUrl(), ...usage }
        } catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'firecrawl_scrape',
      description: 'Scrape one URL and return its markdown plus page metadata. Output is capped; the API key is never included.',
      parameters: {
        url: { type: 'string', required: true, description: 'Absolute URL to scrape' },
        onlyMainContent: { type: 'boolean', description: 'Exclude navs, headers, and footers (default true)' },
        maxAgeMs: { type: 'integer', description: 'Return cached content younger than this age in milliseconds' },
        timeoutMs: { type: 'integer', description: 'Firecrawl scrape timeout in milliseconds, 1000-300000' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { found: { type: 'boolean' }, reason: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, sourceUrl: { type: 'string' }, finalUrl: { type: 'string' }, statusCode: { type: 'number' }, markdown: { type: 'string' }, truncated: { type: 'boolean' } } },
        render: (_args, value) => renderScrape(value),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Scrape ${args.url ?? ''}`, kind: 'read' } },
      async execute(args, exec) {
        if (!client.hasCredentials()) return { found: false, reason: 'Firecrawl API key is not configured.' }
        if (!args.url) return { found: false, reason: 'url is required.' }
        try {
          return { found: true, ...await client.scrape(args.url as string, {
            onlyMainContent: args.onlyMainContent === undefined ? true : Boolean(args.onlyMainContent),
            maxAgeMs: args.maxAgeMs as number,
            timeoutMs: args.timeoutMs as number,
            signal: exec.signal,
          }) }
        } catch (error) { return { found: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'firecrawl_map',
      description: 'Map the URLs of one site, optionally ranked by a search query. Links are capped at 200 entries.',
      parameters: {
        url: { type: 'string', required: true, description: 'Base URL to map' },
        search: { type: 'string', description: 'Order results by relevance to this query' },
        limit: { type: 'integer', description: 'Maximum links to map, 1-1000 (default 100)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { found: { type: 'boolean' }, reason: { type: 'string' }, items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' } } } }, total: { type: 'number' }, truncated: { type: 'boolean' } } },
        render: (_args, value) => !value.found ? text(value.reason ?? 'Firecrawl map failed.') : renderMap(value.items ?? [], value.total),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Map ${args.url ?? ''}`, kind: 'search' } },
      async execute(args, exec) {
        if (!client.hasCredentials()) return unavailable('Firecrawl API key is not configured.')
        if (!args.url) return unavailable('url is required.')
        try {
          return { found: true, ...await client.map(args.url as string, { search: args.search as string, limit: (args.limit as number) ?? 100, signal: exec.signal }) }
        } catch (error) { return unavailable(errorReason(error)) }
      },
    }),

    defineTool({
      name: 'firecrawl_search',
      description: 'Search the web and return result titles, URLs, and descriptions without scraping full pages.',
      parameters: {
        query: { type: 'string', required: true, description: 'Search query, up to 500 characters' },
        limit: { type: 'integer', description: 'Maximum results, 1-100 (default 10)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { found: { type: 'boolean' }, reason: { type: 'string' }, items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' } } } }, creditsUsed: { type: 'number' } } },
        render: (_args, value) => !value.found ? text(value.reason ?? 'Firecrawl search failed.') : renderSearch(value.items ?? []),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Search: ${args.query ?? ''}`, kind: 'search' } },
      async execute(args, exec) {
        if (!client.hasCredentials()) return unavailable('Firecrawl API key is not configured.')
        if (!args.query) return unavailable('query is required.')
        try { return { found: true, ...await client.search(args.query as string, { limit: args.limit as number, signal: exec.signal }) } }
        catch (error) { return unavailable(errorReason(error)) }
      },
    }),

    defineTool({
      name: 'firecrawl_crawl_start',
      description: 'Start a Firecrawl crawl job and return its job ID. BILLABLE operation; the page limit defaults to 20 and is capped at 200.',
      parameters: {
        url: { type: 'string', required: true, description: 'Base URL to start crawling from' },
        limit: { type: 'integer', description: 'Maximum pages to crawl, 1-200 (default 20)' },
        includePaths: { type: 'string', description: 'Comma-separated include path regex patterns' },
        excludePaths: { type: 'string', description: 'Comma-separated exclude path regex patterns' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, id: { type: 'string' } } },
        render: (_args, value) => value.ok ? text(`Crawl started id=${value.id ?? ''}. Poll with firecrawl_crawl_status.`) : text(`Firecrawl crawl start failed: ${value.reason ?? ''}`),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Start crawl ${args.url ?? ''}`, kind: 'edit' } },
      async execute(args, exec) {
        if (!client.hasCredentials()) return { ok: false, reason: 'Firecrawl API key is not configured.' }
        if (!args.url) return { ok: false, reason: 'url is required.' }
        try {
          const result = await client.crawlStart(args.url as string, {
            limit: (args.limit as number) ?? 20,
            includePaths: splitPaths(args.includePaths),
            excludePaths: splitPaths(args.excludePaths),
            signal: exec.signal,
          })
          return { ok: true, id: result.id }
        } catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'firecrawl_crawl_status',
      description: 'Get one crawl job status with page metadata. Page content is never returned; pagination URLs must stay on the Firecrawl API host.',
      parameters: {
        crawlId: { type: 'string', required: true, description: 'Firecrawl crawl job ID' },
        next: { type: 'string', description: 'Opaque next URL returned by a previous status response' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { found: { type: 'boolean' }, reason: { type: 'string' }, id: { type: 'string' }, status: { type: 'string' }, total: { type: 'number' }, completed: { type: 'number' }, creditsUsed: { type: 'number' }, createdAt: { type: 'string' }, completedAt: { type: 'string' }, expiresAt: { type: 'string' }, hasMore: { type: 'boolean' }, pages: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' }, title: { type: 'string' }, statusCode: { type: 'number' } } } } } },
        render: (_args, value) => renderCrawlStatus(value),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Crawl status ${args.crawlId ?? ''}`, kind: 'read' } },
      async execute(args, exec) {
        if (!client.hasCredentials()) return { found: false, reason: 'Firecrawl API key is not configured.' }
        if (!args.crawlId) return { found: false, reason: 'crawlId is required.' }
        try { return { found: true, ...await client.crawlStatus(args.crawlId as string, { next: args.next as string, signal: exec.signal }) } }
        catch (error) { return { found: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'firecrawl_crawl_cancel',
      description: 'Cancel one Firecrawl crawl job. WRITE operation; single job only.',
      parameters: { crawlId: { type: 'string', required: true, description: 'Firecrawl crawl job ID' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, id: { type: 'string' }, status: { type: 'string' } } },
        render: (_args, value) => renderWrite(value),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Cancel crawl ${args.crawlId ?? ''}`, kind: 'edit' } },
      async execute(args, exec) {
        if (!client.hasCredentials()) return { ok: false, reason: 'Firecrawl API key is not configured.' }
        if (!args.crawlId) return { ok: false, reason: 'crawlId is required.' }
        try { return { ok: true, id: args.crawlId as string, ...await client.crawlCancel(args.crawlId as string, exec.signal) } }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),
  ]
}
