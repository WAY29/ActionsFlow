#!/usr/bin/env node

const fs = require("fs")
const path = require("path")
const { XMLParser } = require("fast-xml-parser")

const DEFAULT_TIMEOUT = 15000
const DEFAULT_DAYS = 7
const DEFAULT_TIMEZONE = "Asia/Shanghai"
const DEFAULT_WORKERS = 10
const USER_AGENT = "Mozilla/5.0 (compatible; rss-codex-cubox/1.0; +https://openai.com)"
const ACCEPT = "application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.8"
const OPML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  attributesGroupName: "@",
  parseTagValue: false,
  trimValues: true,
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

function collectFeeds(node, feeds) {
  if (!node || typeof node !== "object") {
    return
  }

  const attributes = node["@"] && typeof node["@"] === "object" ? node["@"] : {}
  const xmlUrl = toSafeString(attributes.xmlUrl)

  if (toSafeString(attributes.type) === "rss" && xmlUrl) {
    feeds.push({
      name: toSafeString(attributes.text || attributes.title),
      xmlUrl,
      htmlUrl: toSafeString(attributes.htmlUrl),
    })
  }

  for (const child of asArray(node.outline)) {
    collectFeeds(child, feeds)
  }
}

function loadFeeds(opmlPath) {
  const source = fs.readFileSync(opmlPath, "utf8")
  const parsed = OPML_PARSER.parse(source)
  const feeds = []

  for (const outline of asArray(parsed && parsed.opml && parsed.opml.body && parsed.opml.body.outline)) {
    collectFeeds(outline, feeds)
  }

  return feeds
}

function normalizeDate(value) {
  const text = toSafeString(value)

  if (!text) {
    return null
  }

  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function toDateKey(value, timeZone) {
  const date = value instanceof Date ? value : normalizeDate(value)

  if (!date) {
    return ""
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)

  const entries = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${entries.year}-${entries.month}-${entries.day}`
}

function shiftDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map((value) => Number(value))
  const date = new Date(Date.UTC(year, month - 1, day))
  date.setUTCDate(date.getUTCDate() + days)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = toSafeString(value)
    if (text) {
      return text
    }
  }
  return ""
}

function stripHtml(value) {
  return toSafeString(value)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function hostnameForLink(link) {
  try {
    return new URL(link).hostname
  } catch {
    return ""
  }
}

function normalizeFeedTitle(feed, item) {
  return firstNonEmpty(
    feed.title,
    feed.name,
    item.creator,
    item.author,
    hostnameForLink(item.link)
  )
}

async function parseFeed(feedMeta, helpers, parserOptions) {
  const parser = new helpers.rssParser(parserOptions)
  const feed = await parser.parseURL(feedMeta.xmlUrl)

  return (feed.items || []).map((item) => ({
    title: firstNonEmpty(item.title, "(untitled)"),
    link: firstNonEmpty(item.link, item.guid, item.id),
    summary: firstNonEmpty(item.contentSnippet, item.summary, item.content),
    publishedAt: firstNonEmpty(item.isoDate, item.pubDate, item.date),
    feedName: normalizeFeedTitle({ ...feedMeta, title: feed.title }, item),
    feedUrl: feedMeta.xmlUrl,
    siteUrl: firstNonEmpty(feed.link, feedMeta.htmlUrl),
  }))
}

async function mapWithConcurrency(items, workerCount, iteratee) {
  const results = new Array(items.length)
  let cursor = 0

  async function worker() {
    while (cursor < items.length) {
      const currentIndex = cursor
      cursor += 1
      results[currentIndex] = await iteratee(items[currentIndex], currentIndex)
    }
  }

  const count = Math.max(1, Math.min(workerCount, items.length))
  await Promise.all(Array.from({ length: count }, () => worker()))
  return results
}

module.exports = async function ({ helpers }) {
  const workspace = resolveWorkspace()
  const feedsFile = path.join(workspace, "rss-codex-cubox", "references", "feeds.opml")
  const feeds = loadFeeds(feedsFile)

  if (feeds.length === 0) {
    throw new Error(`No feeds configured in ${feedsFile}`)
  }

  const endDateKey = toDateKey(new Date(), DEFAULT_TIMEZONE)
  const startDateKey = shiftDateKey(endDateKey, -(DEFAULT_DAYS - 1))
  const parserOptions = {
    timeout: DEFAULT_TIMEOUT,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: ACCEPT,
    },
  }
  const errors = []

  const itemsByKey = new Map()

  const results = await mapWithConcurrency(feeds, DEFAULT_WORKERS, async (feed) => {
    try {
      return await parseFeed(feed, helpers, parserOptions)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push({ feed, message })
      helpers.log.warn(`skip feed ${feed.xmlUrl}: ${message}`)
      return []
    }
  })

  for (const items of results) {
    for (const item of items) {
      const link = toSafeString(item.link)
      const title = toSafeString(item.title)
      const publishedDate = normalizeDate(item.publishedAt)
      const publishedDateKey = toDateKey(publishedDate, DEFAULT_TIMEZONE)

      if (!link || !title || !publishedDateKey) {
        continue
      }
      if (publishedDateKey < startDateKey || publishedDateKey > endDateKey) {
        continue
      }

      itemsByKey.set(link, {
        id: link,
        title,
        link,
        summary: stripHtml(item.summary),
        published_local: publishedDate.toISOString(),
        feed_name: toSafeString(item.feedName),
        feed_url: toSafeString(item.feedUrl),
        site_url: toSafeString(item.siteUrl),
      })
    }
  }

  if (errors.length === feeds.length) {
    throw new Error(`All ${feeds.length} feeds failed`)
  }

  if (errors.length > 0) {
    helpers.log.info(`rss-codex-cubox skipped ${errors.length} feeds and kept ${itemsByKey.size} items`)
  }

  return Array.from(itemsByKey.values()).sort((left, right) => {
    const publishedDiff = Date.parse(right.published_local || "") - Date.parse(left.published_local || "")

    if (publishedDiff !== 0) {
      return publishedDiff
    }

    return left.title.localeCompare(right.title)
  })
}
