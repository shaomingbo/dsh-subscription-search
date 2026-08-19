/**
 * One internal-chain web search provider: ChatGPT → Grok → Exa → DeepSeek.
 *
 * rc.7's dsh-web only supports a scalar searchProvider, so the chain lives
 * inside this provider. An unavailable provider is skipped; provider/network/
 * HTTP failure or a per-attempt timeout continues to the next; caller
 * cancellation stops immediately; an empty result succeeds; exhaustion throws
 * a bounded, secret-free error.
 */

const USER_AGENT = 'dsh-subscription-search/0.1.0'

const CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const CHATGPT_MODEL = 'gpt-5.6-sol'
const CHATGPT_MAX_OUTPUT_TOKENS = 4096

const GROK_BASE_URL = 'https://api.x.ai/v1'
const GROK_MODEL = 'grok-4.5'
const GROK_MAX_OUTPUT_TOKENS = 4096

const EXA_BASE_URL = 'https://api.exa.ai'
const EXA_NUM_RESULTS = 5
const EXA_HIGHLIGHTS_PER_RESULT = 1

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic/v1'
const DEEPSEEK_MODEL = 'deepseek-v4-flash'
const DEEPSEEK_API_VERSION = '2023-06-01'
const DEEPSEEK_MAX_TOKENS = 4096
const DEEPSEEK_MAX_USES = 5

/** Per-attempt deadline, matching the shipped chain default. */
const ATTEMPT_TIMEOUT_MS = 60000

class ChainWebError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ChainWebError'
    this.code = code
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCallerAborted(signal) {
  return signal?.aborted === true
}

function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function operationUrl(baseURL, operation) {
  return `${baseURL.replace(/\/+$/u, '')}/${operation}`
}

/** Race one attempt against the per-attempt timeout and caller cancellation. */
function withAttemptTimeout(operation, signal) {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS)
  timer.unref?.()
  return Promise.race([
    operation(controller.signal),
    new Promise((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        if (signal?.aborted === true) reject(new ChainWebError('WEB_ABORTED', 'Search aborted'))
        else reject(new ChainWebError('WEB_PROVIDER_TIMEOUT', 'Search attempt timed out'))
      }, { once: true })
    }),
  ]).finally(() => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  })
}

export class SubscriptionChainSearchProvider {
  constructor({ auth, credentials }) {
    this.auth = auth
    this.credentials = credentials
    this.id = 'subscription-search'
    this.attempts = []
  }

  available() {
    return true
  }

  async search(request, signal) {
    if (isCallerAborted(signal)) throw new ChainWebError('WEB_ABORTED', 'Search aborted')
    this.attempts = []
    const legs = [
      () => this.chatGptLeg(request, signal),
      () => this.grokLeg(request, signal),
      () => this.exaLeg(request, signal),
      () => this.deepSeekLeg(request, signal),
    ]
    for (const leg of legs) {
      if (isCallerAborted(signal)) throw new ChainWebError('WEB_ABORTED', 'Search aborted')
      try {
        const result = await withAttemptTimeout(leg, signal)
        this.attempts.push({ provider: this.id, status: 'ok' })
        return result
      } catch (error) {
        if (error instanceof ChainWebError && error.code === 'WEB_ABORTED') throw error
        if (error instanceof ChainWebError && error.code === 'WEB_PROVIDER_TIMEOUT') {
          this.attempts.push({ provider: this.id, status: 'timeout' })
          continue
        }
        this.attempts.push({ provider: this.id, status: 'error', code: safeErrorCode(error) })
      }
    }
    throw new ChainWebError(
      'WEB_SEARCH_CHAIN_EXHAUSTED',
      `web search chain exhausted (${this.attempts.map(renderAttemptFailure).join(', ')})`,
    )
  }

  /** ChatGPT: subscription OAuth → Codex Responses with native web_search. */
  async chatGptLeg(request, signal) {
    const oauth = await this.auth.resolveOAuth('openai-codex', signal)
    if (oauth === undefined) throw new ChainWebError('WEB_PROVIDER_CREDENTIAL_MISSING', 'ChatGPT subscription is not connected')
    return responsesSearch({
      oauth,
      baseURL: CHATGPT_BASE_URL,
      displayName: 'ChatGPT',
      signal,
      body: {
        model: CHATGPT_MODEL,
        store: false,
        stream: false,
        instructions: 'Search the web for the user query. Answer concisely and preserve URL citations.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: request.query }] }],
        tools: [{ type: 'web_search' }],
        tool_choice: 'auto',
        max_output_tokens: CHATGPT_MAX_OUTPUT_TOKENS,
      },
    })
  }

  /** Grok: subscription OAuth → xAI Responses with native web_search. */
  async grokLeg(request, signal) {
    const oauth = await this.auth.resolveOAuth('xai', signal)
    if (oauth === undefined) throw new ChainWebError('WEB_PROVIDER_CREDENTIAL_MISSING', 'Grok subscription is not connected')
    return responsesSearch({
      oauth,
      baseURL: GROK_BASE_URL,
      displayName: 'Grok',
      signal,
      body: {
        model: GROK_MODEL,
        input: request.query,
        tools: [{ type: 'web_search' }],
        tool_choice: 'auto',
        max_output_tokens: GROK_MAX_OUTPUT_TOKENS,
      },
    })
  }

  /** Exa: credentials EXA_API_KEY → POST /search with highlights. */
  async exaLeg(request, signal) {
    const apiKey = await this.resolveCredential('EXA_API_KEY', signal)
    if (apiKey === undefined) throw new ChainWebError('WEB_PROVIDER_CREDENTIAL_MISSING', 'Exa search requires EXA_API_KEY')
    const response = await safeFetch(`${EXA_BASE_URL}/search`, {
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
        contents: { highlights: { highlightsPerUrl: EXA_HIGHLIGHTS_PER_RESULT } },
        numResults: EXA_NUM_RESULTS,
      }),
      signal,
    }, 'Exa')
    if (!response.ok) throw new ChainWebError('WEB_PROVIDER_ERROR', `Exa search failed (HTTP ${response.status})`)
    const payload = await response.json()
    if (!isRecord(payload) || !Array.isArray(payload.results)) {
      throw new ChainWebError('WEB_PROVIDER_ERROR', 'Exa returned an unprocessable response body')
    }
    const sources = []
    for (const entry of payload.results) {
      if (!isRecord(entry)) continue
      const snippet = Array.isArray(entry.highlights)
        ? entry.highlights.find(h => typeof h === 'string' && h.trim().length > 0)
        : undefined
      if (snippet === undefined) continue
      sources.push({
        url: String(entry.url),
        ...typeof entry.title === 'string' && entry.title.length > 0 ? { title: entry.title } : {},
        snippet,
        ...typeof entry.publishedDate === 'string' && entry.publishedDate.length > 0 ? { publishedAt: entry.publishedDate } : {},
      })
    }
    return { sources, truncated: false }
  }

  /** DeepSeek: credentials DEEPSEEK_API_KEY → Anthropic Messages + web_search tool. */
  async deepSeekLeg(request, signal) {
    const apiKey = await this.resolveCredential('DEEPSEEK_API_KEY', signal)
    if (apiKey === undefined) throw new ChainWebError('WEB_PROVIDER_CREDENTIAL_MISSING', 'DeepSeek search requires DEEPSEEK_API_KEY')
    const endpoint = `${DEEPSEEK_BASE_URL}/messages`
    const body = {
      model: DEEPSEEK_MODEL,
      max_tokens: DEEPSEEK_MAX_TOKENS,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: `Perform a web search for the query: ${request.query}` }],
      }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: DEEPSEEK_MAX_USES }],
    }
    const response = await safeFetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'x-api-key': apiKey,
        authorization: `Bearer ${apiKey}`,
        'anthropic-version': DEEPSEEK_API_VERSION,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(body),
      signal,
    }, 'DeepSeek')
    if (!response.ok) throw new ChainWebError('WEB_PROVIDER_ERROR', `DeepSeek search failed (HTTP ${response.status})`)
    const payload = await response.json()
    if (!isRecord(payload) || !Array.isArray(payload.content)) {
      throw new ChainWebError('WEB_PROVIDER_ERROR', 'DeepSeek returned an unprocessable response body')
    }
    const resultBlocks = payload.content.filter(block => isRecord(block) && block.type === 'web_search_tool_result')
    if (resultBlocks.length === 0) {
      throw new ChainWebError('WEB_PROVIDER_ERROR', 'DeepSeek returned no web_search_tool_result blocks')
    }
    const snippets = new Map()
    for (const block of payload.content) {
      if (!isRecord(block) || block.type !== 'text') continue
      for (const cite of isRecord(block) && Array.isArray(block.citations) ? block.citations : []) {
        if (isRecord(cite) && typeof cite.url === 'string' && typeof cite.cited_text === 'string' && !snippets.has(cite.url)) {
          snippets.set(cite.url, cite.cited_text)
        }
      }
    }
    const seen = new Set()
    const sources = []
    for (const block of resultBlocks) {
      for (const item of isRecord(block) && Array.isArray(block.content) ? block.content : []) {
        if (!isRecord(item) || item.type !== 'web_search_result' || typeof item.url !== 'string' || item.url.length === 0) continue
        if (seen.has(item.url)) continue
        seen.add(item.url)
        const snippet = snippets.get(item.url)
        sources.push({
          url: item.url,
          ...typeof item.title === 'string' && item.title.length > 0 ? { title: item.title } : {},
          ...snippet !== undefined && snippet.length > 0 ? { snippet } : {},
          ...typeof item.page_age === 'string' && item.page_age.length > 0 ? { publishedAt: item.page_age } : {},
        })
      }
    }
    return { sources, truncated: false }
  }

  /** Resolve one credential reference, or undefined when unconfigured. */
  async resolveCredential(ref, signal) {
    if (isCallerAborted(signal)) throw new ChainWebError('WEB_ABORTED', 'Search aborted')
    try {
      const resolved = await this.credentials?.resolve(ref)
      if (resolved?.value !== undefined && resolved.value.length > 0) return resolved.value
    } catch {
      return undefined
    }
    return undefined
  }
}

/** One OAuth Responses search operation with safe diagnostics. */
async function responsesSearch({ oauth, baseURL, displayName, signal, body }) {
  const headers = {
    authorization: `Bearer ${oauth.apiKey}`,
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': USER_AGENT,
    ...oauth.headers ?? {},
  }
  const response = await safeFetch(operationUrl(baseURL, 'responses'), {
    method: 'POST',
    redirect: 'error',
    headers,
    body: JSON.stringify(body),
    signal,
  }, displayName)
  if (!response.ok) throw new ChainWebError('WEB_PROVIDER_ERROR', `${displayName} search failed (HTTP ${response.status})`)
  const payload = await response.json()
  if (!isRecord(payload)) throw new ChainWebError('WEB_PROVIDER_ERROR', `${displayName} returned an invalid response body`)
  const text = []
  const sources = new Map()
  if (Array.isArray(payload.output)) {
    for (const item of payload.output) {
      if (!isRecord(item)) continue
      collectSearchActionSources(item.action, sources)
      if (!Array.isArray(item.content)) continue
      for (const part of item.content) {
        if (!isRecord(part)) continue
        if (part.type === 'output_text' && typeof part.text === 'string' && part.text.length > 0) text.push(part.text)
        collectCitations(part.annotations, sources, true)
      }
    }
  }
  collectCitations(payload.citations, sources, false)
  const content = text.join('\n').trim()
  return {
    ...content.length === 0 ? {} : { content },
    sources: [...sources.values()],
    truncated: false,
  }
}

/** Fetch with redirect rejection and secret-free failure text. */
async function safeFetch(url, init, displayName) {
  let response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (isAbortError(error) || init.signal?.aborted === true) throw new ChainWebError('WEB_ABORTED', 'Search aborted')
    throw new ChainWebError('WEB_PROVIDER_ERROR', `${displayName} search request failed`)
  }
  return response
}

function collectCitations(value, sources, requireType) {
  if (!Array.isArray(value)) return
  for (const citation of value) {
    if (typeof citation === 'string' && !requireType) addSource({ url: citation }, sources)
    else if (isRecord(citation) && citation.type !== 'url_citation' && (requireType || citation.type !== undefined)) continue
    else if (isRecord(citation)) addSource(citation, sources)
  }
}

function collectSearchActionSources(value, sources) {
  if (!isRecord(value) || !Array.isArray(value.sources)) return
  for (const source of value.sources) if (isRecord(source)) addSource(source, sources)
}

function addSource(value, sources) {
  const url = value.url
  if (typeof url !== 'string' || !URL.canParse(url) || sources.has(url)) return
  const title = typeof value.title === 'string' && value.title.length > 0 ? value.title : undefined
  sources.set(url, { url, ...title === undefined ? {} : { title } })
}

/** Bound an unknown error to a stable safe code. */
function safeErrorCode(error) {
  const code = error instanceof ChainWebError ? error.code : undefined
  if (typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/u.test(code)) return code
  return 'WEB_PROVIDER_ERROR'
}

/** Render one attempt without provider error text. */
function renderAttemptFailure(attempt) {
  return attempt.code === undefined ? `${attempt.provider}:${attempt.status}` : `${attempt.provider}:${attempt.status}(${attempt.code})`
}
