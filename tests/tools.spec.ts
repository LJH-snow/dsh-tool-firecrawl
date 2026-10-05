import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FirecrawlClient } from '../src/client.ts'
import { createTools } from '../src/index.ts'

/** Deterministic DNS so tests never depend on real resolution. */
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 as const }]


const clientForTest = () => new FirecrawlClient({ lookupImpl: publicLookup, apiKey: process.env.FIRECRAWL_TEST_API_KEY ?? randomUUID() })

describe('dsh-tool-firecrawl tools', () => {
  it('registers the Firecrawl tool set', () => {
    expect(createTools(clientForTest()).map(tool => tool.name)).toEqual([
      'firecrawl_auth_test',
      'firecrawl_scrape',
      'firecrawl_map',
      'firecrawl_search',
      'firecrawl_crawl_start',
      'firecrawl_crawl_status',
      'firecrawl_crawl_cancel',
    ])
  })

  it('renders scrape, map, and search results', () => {
    const tools = createTools(clientForTest())
    const scrape = tools.find(item => item.name === 'firecrawl_scrape')!
    const scrapeView = scrape.output.render({}, {
      found: true,
      title: 'Example',
      finalUrl: 'https://example.com',
      statusCode: 200,
      description: 'An example page',
      markdown: 'a'.repeat(6000),
      truncated: true,
    }) as Array<{ text: string }>
    expect(scrapeView[0].text).toContain('Example (https://example.com) status=200')
    expect(scrapeView[0].text).toContain('[truncated preview of 6000 characters]')

    const map = tools.find(item => item.name === 'firecrawl_map')!
    const mapView = map.output.render({}, {
      found: true,
      items: [{ url: 'https://example.com/docs', title: 'Docs', description: '' }],
      total: 1,
      truncated: false,
    }) as Array<{ text: string }>
    expect(mapView[0].text).toContain('https://example.com/docs — Docs')

    const search = tools.find(item => item.name === 'firecrawl_search')!
    const searchView = search.output.render({}, {
      found: true,
      items: [{ url: 'https://example.com/docs', title: 'Docs', description: 'Documentation' }],
      creditsUsed: 1,
    }) as Array<{ text: string }>
    expect(searchView[0].text).toContain('1. Docs')
    expect(searchView[0].text).toContain('https://example.com/docs')
  })

  it('renders crawl status and marks crawl start/cancel as edits', () => {
    const tools = createTools(clientForTest())
    const status = tools.find(item => item.name === 'firecrawl_crawl_status')!
    const statusView = status.output.render({}, {
      found: true,
      id: 'crawl-1',
      status: 'scraping',
      total: 10,
      completed: 2,
      creditsUsed: 3,
      hasMore: false,
      pages: [{ url: 'https://example.com/a', title: 'A', statusCode: 200 }],
    }) as Array<{ text: string }>
    expect(statusView[0].text).toContain('crawl=crawl-1 status=scraping completed=2/10 creditsUsed=3 hasMore=no')
    expect(statusView[0].text).toContain('https://example.com/a title=A status=200')

    const start = tools.find(item => item.name === 'firecrawl_crawl_start')!
    const cancel = tools.find(item => item.name === 'firecrawl_crawl_cancel')!
    expect(start.presentCall({ url: 'https://example.com' })).toMatchObject({ kind: 'edit' })
    expect(cancel.presentCall({ crawlId: 'crawl-1' })).toMatchObject({ kind: 'edit' })
    const scrape = tools.find(item => item.name === 'firecrawl_scrape')!
    expect(scrape.presentCall({ url: 'https://example.com' })).toMatchObject({ kind: 'read' })

    const cancelView = cancel.output.render({}, { ok: true, id: 'crawl-1', status: 'cancelled' }) as Array<{ text: string }>
    expect(cancelView[0].text).toContain('Crawl crawl-1 status=cancelled')
  })
})
