import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { FirecrawlClient, FirecrawlError } from '../src/client.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const testApiKey = process.env.FIRECRAWL_TEST_API_KEY ?? randomUUID()

function client(fetchImpl: ReturnType<typeof vi.fn>) {
  return new FirecrawlClient({ baseUrl: 'https://firecrawl.test.invalid', apiKey: testApiKey, fetchImpl })
}

describe('FirecrawlClient', () => {
  it('authenticates with the bearer header and maps credit usage', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      success: true,
      data: { remainingCredits: 900, planCredits: 1000, billingPeriodStart: null, billingPeriodEnd: null },
    }))
    const result = await client(fetchImpl).authTest()

    expect(result).toEqual({ remainingCredits: 900, planCredits: 1000 })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://firecrawl.test.invalid/v2/team/credit-usage')
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${testApiKey}`)
    expect(JSON.stringify(result)).not.toContain(testApiKey)
  })

  it('scrapes one URL with markdown format and truncates oversized content', async () => {
    const longMarkdown = 'x'.repeat(25000)
    const fetchImpl = vi.fn(async () => jsonResponse({
      success: true,
      data: {
        markdown: longMarkdown,
        metadata: {
          title: ['Example', 'Page'],
          description: 'An example page',
          sourceURL: 'https://example.com',
          statusCode: 200,
        },
      },
    }))
    const result = await client(fetchImpl).scrape('https://example.com', { onlyMainContent: true })

    expect(result.title).toBe('Example Page')
    expect(result.description).toBe('An example page')
    expect(result.sourceUrl).toBe('https://example.com')
    expect(result.statusCode).toBe(200)
    expect(result.markdown).toHaveLength(20000)
    expect(result.truncated).toBe(true)
    expect(JSON.stringify(result)).not.toContain(testApiKey)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://firecrawl.test.invalid/v2/scrape')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ url: 'https://example.com', formats: [{ type: 'markdown' }], onlyMainContent: true })
  })

  it('omits unset scrape options and clamps the scrape timeout', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true, data: { markdown: 'hi', metadata: { sourceURL: 'https://example.com' } } }))
    const firecrawl = client(fetchImpl)
    await firecrawl.scrape('https://example.com')
    await firecrawl.scrape('https://example.com', { maxAgeMs: 3600000, timeoutMs: 999999 })

    const [firstBody, secondBody] = (fetchImpl.mock.calls as Array<[string, RequestInit]>).map(([, init]) => JSON.parse(init.body as string))
    expect(firstBody).toEqual({ url: 'https://example.com', formats: [{ type: 'markdown' }] })
    expect(secondBody).toEqual({ url: 'https://example.com', formats: [{ type: 'markdown' }], maxAge: 3600000, timeout: 300000 })
  })

  it('maps site links and caps the returned list', async () => {
    const manyLinks = Array.from({ length: 250 }, (_, index) => ({ url: `https://example.com/page-${index}`, title: `Page ${index}`, description: '' }))
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, links: [{ url: 'https://example.com/', title: 'Home', description: 'Welcome' }] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, links: manyLinks }))
    const firecrawl = client(fetchImpl)
    const mapped = await firecrawl.map('https://example.com', { search: 'docs', limit: 50 })
    const capped = await firecrawl.map('https://example.com')

    expect(mapped).toEqual({ items: [{ url: 'https://example.com/', title: 'Home', description: 'Welcome' }], total: 1, truncated: false })
    expect(capped.total).toBe(250)
    expect(capped.items).toHaveLength(200)
    expect(capped.truncated).toBe(true)
    const [firstBody] = (fetchImpl.mock.calls as Array<[string, RequestInit]>).map(([, init]) => JSON.parse(init.body as string))
    expect(firstBody).toEqual({ url: 'https://example.com', search: 'docs', limit: 50 })
  })

  it('searches the web and returns metadata-only results', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      success: true,
      data: { web: [{ url: 'https://example.com/docs', title: 'Docs', description: 'Documentation', markdown: 'DO-NOT-EXPOSE' }] },
      creditsUsed: 1,
    }))
    const result = await client(fetchImpl).search('example docs', { limit: 5 })

    expect(result).toEqual({
      items: [{ url: 'https://example.com/docs', title: 'Docs', description: 'Documentation' }],
      creditsUsed: 1,
    })
    expect(JSON.stringify(result)).not.toContain('DO-NOT-EXPOSE')
    expect(JSON.stringify(result)).not.toContain(testApiKey)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://firecrawl.test.invalid/v2/search')
    expect(JSON.parse(init.body as string)).toEqual({ query: 'example docs', limit: 5 })
  })

  it('starts crawls with an enforced page limit and reports the job id', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, id: 'crawl-1', url: 'https://firecrawl.test.invalid/v2/crawl/crawl-1' }))
      .mockResolvedValueOnce(jsonResponse({ success: true, id: 'crawl-2', url: 'https://firecrawl.test.invalid/v2/crawl/crawl-2' }))
    const firecrawl = client(fetchImpl)
    const started = await firecrawl.crawlStart('https://example.com', { limit: 20 })
    const clamped = await firecrawl.crawlStart('https://example.com', { limit: 10000, includePaths: ['blog/.*'], excludePaths: ['tag/.*'] })

    expect(started).toEqual({ id: 'crawl-1' })
    expect(clamped).toEqual({ id: 'crawl-2' })
    const bodies = (fetchImpl.mock.calls as Array<[string, RequestInit]>).map(([, init]) => JSON.parse(init.body as string))
    expect(bodies[0]).toEqual({ url: 'https://example.com', limit: 20 })
    expect(bodies[1]).toEqual({ url: 'https://example.com', limit: 200, includePaths: ['blog/.*'], excludePaths: ['tag/.*'] })
    expect((fetchImpl.mock.calls[0] as [string, RequestInit])[1].method).toBe('POST')
  })

  it('reports crawl status with page metadata only and guards pagination URLs', async () => {
    const statusBody = {
      success: true,
      status: 'scraping',
      total: 10,
      completed: 2,
      creditsUsed: 3,
      createdAt: '2026-10-05T00:00:00.000Z',
      expiresAt: '2026-10-06T00:00:00.000Z',
      next: 'https://firecrawl.test.invalid/v2/crawl/crawl-1?page=2',
      data: [{ markdown: 'DO-NOT-EXPOSE', metadata: { url: 'https://example.com/a', title: 'A', statusCode: 200 } }],
    }
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(statusBody))
      .mockResolvedValueOnce(jsonResponse(statusBody))
    const firecrawl = client(fetchImpl)
    const status = await firecrawl.crawlStatus('crawl-1')
    const paged = await firecrawl.crawlStatus('crawl-1', { next: 'https://firecrawl.test.invalid/v2/crawl/crawl-1?page=2' })

    expect(status).toMatchObject({ id: 'crawl-1', status: 'scraping', total: 10, completed: 2, creditsUsed: 3, hasMore: true })
    expect(status.pages).toEqual([{ url: 'https://example.com/a', title: 'A', statusCode: 200 }])
    expect(JSON.stringify(status)).not.toContain('DO-NOT-EXPOSE')
    expect((fetchImpl.mock.calls[1] as [string])[0]).toBe('https://firecrawl.test.invalid/v2/crawl/crawl-1?page=2')

    await expect(firecrawl.crawlStatus('crawl-1', { next: 'https://evil.example.invalid/v2/crawl/crawl-1' })).rejects.toThrow(FirecrawlError)
    await expect(firecrawl.crawlStatus('crawl-1', { next: 'https://firecrawl.test.invalid/other/path' })).rejects.toThrow('must stay on the configured Firecrawl API host')
  })

  it('cancels one crawl and maps HTTP errors without leaking the key', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, status: 'cancelled' }))
      .mockResolvedValueOnce(jsonResponse({ success: false, error: 'Payment required to access this resource.' }, 402))
    const firecrawl = client(fetchImpl)
    const cancelled = await firecrawl.crawlCancel('crawl-1')

    expect(cancelled).toEqual({ status: 'cancelled' })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://firecrawl.test.invalid/v2/crawl/crawl-1')
    expect(init.method).toBe('DELETE')
    await expect(firecrawl.authTest()).rejects.toThrow('Payment required')
    await expect(new FirecrawlClient({}).authTest()).rejects.toThrow(FirecrawlError)
  })
})
