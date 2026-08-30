import { SearchChainError } from './search-chain.js'

const USER_AGENT = 'dsh-subscription-search/1.0.0'
const EXA_BASE_URL = 'https://api.exa.ai'
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic/v1'

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function credential(credentials, ref, signal) {
  if (signal?.aborted) throw signal.reason
  try {
    const resolved = await credentials.resolve(ref)
    if (typeof resolved?.value === 'string' && resolved.value.length > 0) return resolved.value
  } catch {}
  throw new SearchChainError('SEARCH_CREDENTIAL_MISSING', `${ref} is not configured`)
}

async function safeFetch(fetchImpl, url, init, name) {
  try {
    return await fetchImpl(url, init)
  } catch (error) {
    if (init.signal?.aborted) throw init.signal.reason
    throw new SearchChainError('SEARCH_BACKEND_REQUEST_FAILED', `${name} search request failed`)
  }
}

/** Built-in Exa adapter; credentials remain behind the ordinary DSH credential ref. */
export function createExaBackend({ credentials, fetchImpl = fetch }) {
  return {
    id: 'exa',
    label: 'Exa',
    async search(request, signal) {
      const apiKey = await credential(credentials, 'EXA_API_KEY', signal)
      const response = await safeFetch(fetchImpl, `${EXA_BASE_URL}/search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          query: request.query,
          type: 'auto',
          contents: { highlights: { highlightsPerUrl: 1 } },
          numResults: 5,
        }),
        signal,
      }, 'Exa')
      if (!response.ok) throw new SearchChainError('SEARCH_BACKEND_HTTP_ERROR', `Exa search failed (HTTP ${response.status})`)
      const payload = await response.json()
      if (!isRecord(payload) || !Array.isArray(payload.results)) {
        throw new SearchChainError('SEARCH_BACKEND_INVALID_RESPONSE', 'Exa returned an invalid response')
      }
      const sources = []
      for (const entry of payload.results) {
        if (!isRecord(entry) || typeof entry.url !== 'string' || !URL.canParse(entry.url)) continue
        const snippet = Array.isArray(entry.highlights)
          ? entry.highlights.find(value => typeof value === 'string' && value.trim() !== '')
          : undefined
        sources.push({
          url: entry.url,
          ...typeof entry.title === 'string' && entry.title !== '' ? { title: entry.title } : {},
          ...snippet === undefined ? {} : { snippet },
          ...typeof entry.publishedDate === 'string' && entry.publishedDate !== '' ? { publishedAt: entry.publishedDate } : {},
        })
      }
      return { sources, truncated: false }
    },
  }
}

/** Built-in DeepSeek adapter; credentials remain behind the ordinary DSH credential ref. */
export function createDeepSeekBackend({ credentials, fetchImpl = fetch }) {
  return {
    id: 'deepseek',
    label: 'DeepSeek',
    async search(request, signal) {
      const apiKey = await credential(credentials, 'DEEPSEEK_API_KEY', signal)
      const response = await safeFetch(fetchImpl, `${DEEPSEEK_BASE_URL}/messages`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'x-api-key': apiKey,
          authorization: `Bearer ${apiKey}`,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          max_tokens: 4096,
          messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${request.query}` }] }],
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
        }),
        signal,
      }, 'DeepSeek')
      if (!response.ok) throw new SearchChainError('SEARCH_BACKEND_HTTP_ERROR', `DeepSeek search failed (HTTP ${response.status})`)
      const payload = await response.json()
      if (!isRecord(payload) || !Array.isArray(payload.content)) {
        throw new SearchChainError('SEARCH_BACKEND_INVALID_RESPONSE', 'DeepSeek returned an invalid response')
      }
      const snippets = new Map()
      for (const block of payload.content) {
        if (!isRecord(block) || block.type !== 'text' || !Array.isArray(block.citations)) continue
        for (const cite of block.citations) {
          if (isRecord(cite) && typeof cite.url === 'string' && typeof cite.cited_text === 'string') snippets.set(cite.url, cite.cited_text)
        }
      }
      const seen = new Set()
      const sources = []
      for (const block of payload.content) {
        if (!isRecord(block) || block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue
        for (const item of block.content) {
          if (!isRecord(item) || item.type !== 'web_search_result' || typeof item.url !== 'string' || !URL.canParse(item.url) || seen.has(item.url)) continue
          seen.add(item.url)
          sources.push({
            url: item.url,
            ...typeof item.title === 'string' && item.title !== '' ? { title: item.title } : {},
            ...snippets.has(item.url) ? { snippet: snippets.get(item.url) } : {},
            ...typeof item.page_age === 'string' && item.page_age !== '' ? { publishedAt: item.page_age } : {},
          })
        }
      }
      return { sources, truncated: false }
    },
  }
}

/** Scalar dsh-web compatibility adapter retaining provider id subscription-search. */
export class SubscriptionChainSearchProvider {
  constructor(searchChain) {
    this.id = 'subscription-search'
    this.searchChain = searchChain
  }

  available() {
    return true
  }

  search(request, signal) {
    return this.searchChain.search(request, undefined, signal)
  }
}
