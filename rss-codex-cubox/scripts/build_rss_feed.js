#!/usr/bin/env node

const fs = require("fs")
const path = require("path")
const { XMLBuilder, XMLParser, XMLValidator } = require("fast-xml-parser")

const RSS_FILENAME = "rss-akrss-preferred.xml"
const DEFAULT_OUTPUT_DIR = ".tmp/rss-codex-rss/public"
const DEFAULT_TITLE = "AK RSS Preferred"
const DEFAULT_DESCRIPTION = "Codex-curated RSS recommendations"
const DEFAULT_MAX_ITEMS = 50
const DEFAULT_FETCH_TIMEOUT_MS = 15000
const USER_AGENT = "Mozilla/5.0 (compatible; rss-codex-rss/1.0)"
const ACCEPT = "application/rss+xml, application/xml, text/xml, */*;q=0.8"
const RSS_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
})
const RSS_BUILDER = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  indentBy: "  ",
  suppressBooleanAttributes: false,
  suppressEmptyNode: true,
})

function resolveWorkspace() {
  return process.env.GITHUB_WORKSPACE || process.cwd()
}

function toSafeString(value) {
  return typeof value === "string" ? value.trim() : ""
}

function asArray(value) {
  if (Array.isArray(value)) {
    return value
  }

  return value ? [value] : []
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function requireEnv(name) {
  const value = toSafeString(process.env[name])

  if (!value) {
    throw new Error(`Missing ${name}`)
  }

  return value
}

function normalizePublicUrl(value) {
  const rawValue = requireValue(value, "RSS_PUBLIC_URL")
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(rawValue) ? rawValue : `https://${rawValue}`
  let parsed

  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error("RSS_PUBLIC_URL must be a valid root domain URL")
  }

  if (!parsed.hostname || !["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("RSS_PUBLIC_URL must be an http(s) root domain URL")
  }

  if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
    throw new Error("RSS_PUBLIC_URL must be a root domain URL without path, query, or hash")
  }

  const origin = parsed.origin
  return {
    origin,
    feedUrl: `${origin}/${RSS_FILENAME}`,
  }
}

function requireValue(value, name) {
  const text = toSafeString(value)

  if (!text) {
    throw new Error(`Missing ${name}`)
  }

  return text
}

function normalizeScore(value) {
  const score = Number(value)

  if (!Number.isFinite(score)) {
    throw new Error(`Invalid score: ${value}`)
  }

  return Math.max(0, Math.min(10, score))
}

function formatScore(score) {
  return Number.isInteger(score) ? `${score}.0` : score.toFixed(1)
}

function normalizePublishedAt(value) {
  const time = Date.parse(value || "")
  return Number.isFinite(time) ? time : 0
}

function toPositiveInteger(value, fallback) {
  const number = Number(value)

  if (!Number.isFinite(number) || number <= 0) {
    return fallback
  }

  return Math.floor(number)
}

function validateCodexPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Codex output must be an object")
  }

  if (!Array.isArray(payload.items)) {
    throw new Error("Codex output.items must be an array")
  }
}

function buildCurrentItems(payload, inputItems) {
  validateCodexPayload(payload)

  if (!Array.isArray(inputItems)) {
    throw new Error("Input items must be an array")
  }

  const metadataByLink = new Map(
    inputItems.map((item) => [toSafeString(item.link), item])
  )

  return payload.items.map((item, index) => {
    const title = toSafeString(item.title)
    const link = toSafeString(item.link)
    const summary = toSafeString(item.summary)
    const score = normalizeScore(item.score)
    const metadata = metadataByLink.get(link) || {}
    const pubDateMs = normalizePublishedAt(metadata.published_local)

    if (!title || !link || !summary) {
      throw new Error(`Invalid Codex item at index ${index}`)
    }

    return {
      title,
      link,
      guid: link,
      description: `(${formatScore(score)}/10) ${summary}`,
      pubDateMs,
      sourceTitle: toSafeString(metadata.feed_name),
      sourceUrl: toSafeString(metadata.feed_url),
    }
  })
}

function textValue(value) {
  if (typeof value === "string") {
    return value
  }

  if (value && typeof value === "object") {
    if (typeof value["#text"] === "string") {
      return value["#text"]
    }
    if (typeof value.text === "string") {
      return value.text
    }
  }

  return ""
}

function parseExistingRss(xml) {
  const source = toSafeString(xml)

  if (!source) {
    return []
  }

  const parsed = RSS_PARSER.parse(source)
  const channel = parsed && parsed.rss && parsed.rss.channel

  if (!channel) {
    return []
  }

  return asArray(channel.item)
    .map((item) => {
      const title = toSafeString(textValue(item.title))
      const link = toSafeString(textValue(item.link))
      const guid = toSafeString(textValue(item.guid))
      const description = toSafeString(textValue(item.description))
      const pubDateText = toSafeString(textValue(item.pubDate))
      const source = item.source && typeof item.source === "object" ? item.source : null

      return {
        title,
        link,
        guid: guid || link,
        description,
        pubDateMs: normalizePublishedAt(pubDateText),
        sourceTitle: source ? toSafeString(textValue(source)) : "",
        sourceUrl: source ? toSafeString(source.url) : "",
      }
    })
    .filter((item) => item.title && (item.link || item.guid))
}

function itemKeys(item) {
  return [toSafeString(item.link), toSafeString(item.guid)].filter(Boolean)
}

function replaceExisting(items, keyToIndex, item) {
  const keys = itemKeys(item)

  if (keys.length === 0) {
    return
  }

  const existingIndex = keys
    .map((key) => keyToIndex.get(key))
    .find((index) => Number.isInteger(index))

  if (Number.isInteger(existingIndex)) {
    items[existingIndex] = item
  } else {
    items.push(item)
  }

  const index = Number.isInteger(existingIndex) ? existingIndex : items.length - 1
  for (const key of keys) {
    keyToIndex.set(key, index)
  }
}

function mergeItems(currentItems, oldItems, options = {}) {
  const maxItems = toPositiveInteger(options.maxItems, DEFAULT_MAX_ITEMS)
  const maxAgeDays = Number(options.maxAgeDays || 0)
  const nowMs = Number(options.nowMs || Date.now())
  const minPubDateMs =
    Number.isFinite(maxAgeDays) && maxAgeDays > 0
      ? nowMs - maxAgeDays * 24 * 60 * 60 * 1000
      : 0
  const items = []
  const keyToIndex = new Map()

  for (const item of oldItems) {
    replaceExisting(items, keyToIndex, item)
  }

  for (const item of currentItems) {
    replaceExisting(items, keyToIndex, item)
  }

  return items
    .filter((item) => !minPubDateMs || !item.pubDateMs || item.pubDateMs >= minPubDateMs)
    .sort((left, right) => {
      if (right.pubDateMs !== left.pubDateMs) {
        return right.pubDateMs - left.pubDateMs
      }

      return toSafeString(left.title).localeCompare(toSafeString(right.title))
    })
    .slice(0, maxItems)
}

function formatRfc822(value) {
  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    return new Date(0).toUTCString()
  }

  return date.toUTCString()
}

function buildRssItem(item, buildDate) {
  const pubDate = item.pubDateMs ? formatRfc822(item.pubDateMs) : buildDate
  const sourceTitle = toSafeString(item.sourceTitle)
  const sourceUrl = toSafeString(item.sourceUrl)
  const rssItem = {
    title: item.title,
    guid: {
      "@_isPermaLink": "true",
      "#text": item.guid || item.link,
    },
    pubDate,
  }

  if (toSafeString(item.link)) {
    rssItem.link = item.link
  }

  if (sourceTitle && sourceUrl) {
    rssItem.source = {
      "@_url": sourceUrl,
      "#text": sourceTitle,
    }
  }

  if (toSafeString(item.description)) {
    rssItem.description = item.description
  }

  return rssItem
}

function renderRssXml({ title, description, siteUrl, feedUrl, generatedAt, items }) {
  const buildDate = formatRfc822(generatedAt)
  const doc = {
    "?xml": {
      "@_version": "1.0",
      "@_encoding": "UTF-8",
    },
    rss: {
      "@_version": "2.0",
      "@_xmlns:atom": "http://www.w3.org/2005/Atom",
      channel: {
        title,
        link: siteUrl,
        description,
        language: "zh-CN",
        lastBuildDate: buildDate,
        "atom:link": {
          "@_href": feedUrl,
          "@_rel": "self",
          "@_type": "application/rss+xml",
        },
        item: items.map((item) => buildRssItem(item, buildDate)),
      },
    },
  }
  const xml = `${RSS_BUILDER.build(doc)}\n`
  const validationResult = XMLValidator.validate(xml)

  if (validationResult !== true) {
    throw new Error(`Generated RSS XML is invalid: ${JSON.stringify(validationResult)}`)
  }

  return xml
}

async function fetchExistingRss(feedUrl, options = {}) {
  const fetchImpl = options.fetchImpl || fetch
  const timeoutMs = toPositiveInteger(options.timeoutMs, DEFAULT_FETCH_TIMEOUT_MS)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(feedUrl, {
      headers: {
        Accept: ACCEPT,
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    })

    if (response.status === 404) {
      return ""
    }

    const text = await response.text()
    if (!response.ok) {
      throw new Error(`Fetch existing RSS failed: ${response.status} ${text.slice(0, 200)}`)
    }

    return text
  } finally {
    clearTimeout(timer)
  }
}

function writeGithubOutput(key, value) {
  const githubOutput = process.env.GITHUB_OUTPUT

  if (!githubOutput) {
    return
  }

  fs.appendFileSync(githubOutput, `${key}=${value}\n`)
}

function writeHeadersFile(outputDir) {
  const headersPath = path.join(outputDir, "_headers")
  const headers = [
    `/${RSS_FILENAME}`,
    "  Content-Type: application/rss+xml; charset=utf-8",
    "  Cache-Control: public, max-age=300",
    "",
  ].join("\n")

  fs.writeFileSync(headersPath, headers)
}

async function main() {
  const workspace = resolveWorkspace()
  const codexOutputPath = path.resolve(workspace, requireEnv("CODEX_OUTPUT_FILE"))
  const inputItemsPath = path.resolve(workspace, requireEnv("INPUT_ITEMS_FILE"))
  const outputDir = path.resolve(
    workspace,
    toSafeString(process.env.RSS_OUTPUT_DIR) || DEFAULT_OUTPUT_DIR
  )
  const { origin, feedUrl } = normalizePublicUrl(requireEnv("RSS_PUBLIC_URL"))
  const title = toSafeString(process.env.RSS_TITLE) || DEFAULT_TITLE
  const description = toSafeString(process.env.RSS_DESCRIPTION) || DEFAULT_DESCRIPTION
  const maxItems = Number(process.env.RSS_MAX_ITEMS || DEFAULT_MAX_ITEMS)
  const maxAgeDays = Number(process.env.RSS_MAX_AGE_DAYS || 0)

  const payload = readJson(codexOutputPath)
  const inputItems = readJson(inputItemsPath)
  const currentItems = buildCurrentItems(payload, inputItems)
  const existingXml = await fetchExistingRss(feedUrl, {
    timeoutMs: Number(process.env.RSS_FETCH_TIMEOUT_MS || DEFAULT_FETCH_TIMEOUT_MS),
  })
  const oldItems = parseExistingRss(existingXml)
  const mergedItems = mergeItems(currentItems, oldItems, {
    maxItems,
    maxAgeDays,
  })
  const rssXml = renderRssXml({
    title,
    description,
    siteUrl: origin,
    feedUrl,
    generatedAt: new Date(),
    items: mergedItems,
  })

  fs.mkdirSync(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, RSS_FILENAME)
  fs.writeFileSync(outputPath, rssXml)
  writeHeadersFile(outputDir)

  writeGithubOutput("output_dir", path.relative(workspace, outputDir))
  writeGithubOutput("output_file", path.relative(workspace, outputPath))
  writeGithubOutput("feed_url", feedUrl)
  writeGithubOutput("item_count", String(mergedItems.length))
  writeGithubOutput("new_item_count", String(currentItems.length))
  writeGithubOutput("previous_item_count", String(oldItems.length))

  console.log(
    `Built RSS ${path.relative(workspace, outputPath)}: current=${currentItems.length} previous=${oldItems.length} merged=${mergedItems.length} url=${feedUrl}`
  )
}

module.exports = {
  RSS_FILENAME,
  buildCurrentItems,
  fetchExistingRss,
  mergeItems,
  normalizePublicUrl,
  parseExistingRss,
  renderRssXml,
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
