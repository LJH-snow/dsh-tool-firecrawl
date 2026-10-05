/** Firecrawl v2 REST API client with injected fetch for testability. */

import { assertSafeUrl, EndpointSecurityError, normalizeBaseUrl, type LookupImpl } from './url-security.js'

export interface FirecrawlClientOptions {
  /** Firecrawl API host root, for example https://api.firecrawl.dev. */
  baseUrl?: string
  /** Firecrawl API key. Prefer supplying it from a secret-backed config. */
  apiKey?: string
  /** HTTP request timeout in milliseconds. 0 disables the timeout. */
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** Test-only DNS lookup override; production uses node:dns/promises. */
  lookupImpl?: LookupImpl
}

export class FirecrawlError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'FirecrawlError'
  }
}

export interface FirecrawlCreditUsageInfo {
  remainingCredits: number
  planCredits: number
}

export interface FirecrawlScrapeInfo {
  sourceUrl: string
  finalUrl: string
  title: string
  description: string
  statusCode: number
  markdown: string
  truncated: boolean
}

export interface FirecrawlLinkInfo {
  url: string
  title: string
  description: string
}

export interface FirecrawlSearchResultInfo {
  url: string
  title: string
  description: string
}

export interface FirecrawlPageInfo {
  url: string
  title: string
  statusCode: number
}

export interface FirecrawlCrawlStatusInfo {
  id: string
  status: string
  total: number
  completed: number
  creditsUsed: number
  createdAt: string
  completedAt: string
  expiresAt: string
  hasMore: boolean
  pages: FirecrawlPageInfo[]
}

export interface FirecrawlMapResult {
  items: FirecrawlLinkInfo[]
  total: number
  truncated: boolean
}

export interface FirecrawlSearchResult {
  items: FirecrawlSearchResultInfo[]
  creditsUsed: number
}

export interface FirecrawlCrawlStartResult {
  id: string
}

const MARKDOWN_LIMIT = 20000
const TITLE_LIMIT = 300
const DESCRIPTION_LIMIT = 500
const MAP_LINKS_LIMIT = 200
const SEARCH_RESULTS_LIMIT = 100
const CRAWL_PAGES_LIMIT = 50

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Metadata fields may arrive as a string or an array of strings; flatten to one string. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string').join(' ')
  return value == null ? '' : String(value)
}

function asField(record: Record<string, unknown>, key: string): string {
  return asText(record[key])
}

function asNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function clampText(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value
}

function clampInt(value: number | undefined, min: number, max: number): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function encode(value: string): string {
  return encodeURIComponent(value)
}

function mapPageMeta(item: unknown): FirecrawlPageInfo {
  const record = asRecord(item)
  const meta = asRecord(record.metadata)
  return {
    url: asField(meta, 'url') || asField(meta, 'sourceURL'),
    title: clampText(asField(meta, 'title'), TITLE_LIMIT),
    statusCode: asNumber(meta, 'statusCode'),
  }
}

export class FirecrawlClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly lookupImpl: LookupImpl | undefined

  constructor(options: FirecrawlClientOptions = {}) {
    try {
      this.baseUrl = normalizeBaseUrl(options.baseUrl, 'https://api.firecrawl.dev')
    } catch (error) {
      if (error instanceof EndpointSecurityError) throw new FirecrawlError(error.message, 400)
      throw error
    }
    this.apiKey = options.apiKey ?? ''
    this.timeoutMs = options.timeoutMs ?? 120000
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.lookupImpl = options.lookupImpl
  }

  hasCredentials(): boolean {
    return Boolean(this.apiKey)
  }

  getBaseUrl(): string {
    return this.baseUrl
  }

  private async request<T = unknown>(
    method: string,
    pathOrUrl: string,
    options: { body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (!this.hasCredentials()) throw new FirecrawlError('Firecrawl API key not configured.', 401)
    const url = /^https?:\/\//i.test(pathOrUrl) ? new URL(pathOrUrl) : new URL(`${this.baseUrl}${pathOrUrl}`)
    try {
      await assertSafeUrl(url, this.lookupImpl)
    } catch (error) {
      if (error instanceof EndpointSecurityError) throw new FirecrawlError(error.message, 400)
      throw error
    }
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.apiKey}`,
    }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    const controller = new AbortController()
    const combined = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    const timer = this.timeoutMs > 0 ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined
    try {
      const response = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: combined,
      })
      const raw = await response.text()
      let json: unknown = {}
      if (raw) {
        try { json = JSON.parse(raw) } catch { json = {} }
      }
      if (!response.ok) {
        const record = asRecord(json)
        const message = asField(record, 'error') || asField(record, 'message') || raw.slice(0, 300) || response.statusText
        throw new FirecrawlError(`Firecrawl API ${method} ${pathOrUrl} returned HTTP ${response.status}: ${message}`, response.status)
      }
      return json as T
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async authTest(signal?: AbortSignal): Promise<FirecrawlCreditUsageInfo> {
    const raw = await this.request('GET', '/v2/team/credit-usage', { signal })
    const data = asRecord(asRecord(raw).data)
    return {
      remainingCredits: asNumber(data, 'remainingCredits'),
      planCredits: asNumber(data, 'planCredits'),
    }
  }

  async scrape(
    url: string,
    options: { onlyMainContent?: boolean; maxAgeMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<FirecrawlScrapeInfo> {
    const body: Record<string, unknown> = { url, formats: [{ type: 'markdown' }] }
    if (options.onlyMainContent !== undefined) body.onlyMainContent = options.onlyMainContent
    if (options.maxAgeMs !== undefined) body.maxAge = clampInt(options.maxAgeMs, 0, Number.MAX_SAFE_INTEGER)
    if (options.timeoutMs !== undefined) body.timeout = clampInt(options.timeoutMs, 1000, 300000)
    const raw = await this.request('POST', '/v2/scrape', { body, signal: options.signal })
    const data = asRecord(asRecord(raw).data)
    const meta = asRecord(data.metadata)
    const markdown = asField(data, 'markdown')
    return {
      sourceUrl: asField(meta, 'sourceURL'),
      finalUrl: asField(meta, 'url') || asField(meta, 'sourceURL'),
      title: clampText(asField(meta, 'title'), TITLE_LIMIT),
      description: clampText(asField(meta, 'description'), DESCRIPTION_LIMIT),
      statusCode: asNumber(meta, 'statusCode'),
      markdown: clampText(markdown, MARKDOWN_LIMIT),
      truncated: markdown.length > MARKDOWN_LIMIT,
    }
  }

  async map(url: string, options: { search?: string; limit?: number; signal?: AbortSignal } = {}): Promise<FirecrawlMapResult> {
    const body: Record<string, unknown> = { url }
    if (options.search) body.search = options.search
    const limit = clampInt(options.limit, 1, 1000)
    if (limit !== undefined) body.limit = limit
    const raw = await this.request('POST', '/v2/map', { body, signal: options.signal })
    const links = asArray(asRecord(raw).links).map(item => {
      const link = asRecord(item)
      return {
        url: asField(link, 'url'),
        title: clampText(asField(link, 'title'), TITLE_LIMIT),
        description: clampText(asField(link, 'description'), DESCRIPTION_LIMIT),
      }
    }).filter(link => link.url)
    return { items: links.slice(0, MAP_LINKS_LIMIT), total: links.length, truncated: links.length > MAP_LINKS_LIMIT }
  }

  async search(query: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<FirecrawlSearchResult> {
    const body: Record<string, unknown> = { query }
    const limit = clampInt(options.limit, 1, SEARCH_RESULTS_LIMIT)
    if (limit !== undefined) body.limit = limit
    const raw = await this.request('POST', '/v2/search', { body, signal: options.signal })
    const record = asRecord(raw)
    const data = asRecord(record.data)
    const items = asArray(data.web).map(item => {
      const result = asRecord(item)
      return {
        url: asField(result, 'url'),
        title: clampText(asField(result, 'title'), TITLE_LIMIT),
        description: clampText(asField(result, 'description'), DESCRIPTION_LIMIT),
      }
    }).filter(result => result.url).slice(0, SEARCH_RESULTS_LIMIT)
    return { items, creditsUsed: asNumber(record, 'creditsUsed') }
  }

  async crawlStart(
    url: string,
    options: { limit?: number; includePaths?: string[]; excludePaths?: string[]; signal?: AbortSignal } = {},
  ): Promise<FirecrawlCrawlStartResult> {
    const body: Record<string, unknown> = { url }
    const limit = clampInt(options.limit, 1, 200)
    if (limit !== undefined) body.limit = limit
    if (options.includePaths?.length) body.includePaths = options.includePaths
    if (options.excludePaths?.length) body.excludePaths = options.excludePaths
    const raw = await this.request('POST', '/v2/crawl', { body, signal: options.signal })
    return { id: asField(asRecord(raw), 'id') }
  }

  async crawlStatus(crawlId: string, options: { next?: string; signal?: AbortSignal } = {}): Promise<FirecrawlCrawlStatusInfo> {
    let path = `/v2/crawl/${encode(crawlId)}`
    if (options.next) {
      const base = new URL(this.baseUrl)
      let target: URL
      try { target = new URL(options.next) } catch {
        throw new FirecrawlError('crawl next URL is invalid.', 400)
      }
      if (target.origin !== base.origin || !target.pathname.startsWith('/v2/')) {
        throw new FirecrawlError('crawl next URL must stay on the configured Firecrawl API host.', 400)
      }
      path = target.toString()
    }
    const raw = await this.request('GET', path, { signal: options.signal })
    const record = asRecord(raw)
    return {
      id: crawlId,
      status: asField(record, 'status'),
      total: asNumber(record, 'total'),
      completed: asNumber(record, 'completed'),
      creditsUsed: asNumber(record, 'creditsUsed'),
      createdAt: asField(record, 'createdAt'),
      completedAt: asField(record, 'completedAt'),
      expiresAt: asField(record, 'expiresAt'),
      hasMore: Boolean(record.next),
      pages: asArray(record.data).map(mapPageMeta).slice(0, CRAWL_PAGES_LIMIT),
    }
  }

  async crawlCancel(crawlId: string, signal?: AbortSignal): Promise<{ status: string }> {
    const raw = await this.request('DELETE', `/v2/crawl/${encode(crawlId)}`, { signal })
    return { status: asField(asRecord(raw), 'status') }
  }
}
