#!/usr/bin/env node

const fs = require("fs")
const path = require("path")

const TARGET_TIMEZONE = "Asia/Shanghai"
const WINDOW_DAYS = 7

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function resolveWorkspace() {
  return process.env.GITHUB_WORKSPACE || process.cwd()
}

function toSafeString(value) {
  return typeof value === "string" ? value.trim() : ""
}

function decodeEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
}

function stripHtml(value) {
  return decodeEntities(toSafeString(value).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
}

function truncateText(value, maxLength) {
  if (value.length <= maxLength) {
    return value
  }

  if (maxLength <= 3) {
    return value.slice(0, maxLength)
  }

  return `${value.slice(0, maxLength - 3)}...`
}

function toDateKey(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
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

  const nextYear = String(date.getUTCFullYear())
  const nextMonth = String(date.getUTCMonth() + 1).padStart(2, "0")
  const nextDay = String(date.getUTCDate()).padStart(2, "0")
  return `${nextYear}-${nextMonth}-${nextDay}`
}

function normalizePublishedAt(item) {
  const rawValue = toSafeString(item.published_local || item.isoDate || item.pubDate || item.date)

  if (!rawValue) {
    return ""
  }

  const date = new Date(rawValue)
  return Number.isNaN(date.getTime()) ? "" : date.toISOString()
}

function normalizeSummary(item) {
  const candidates = [
    item.summary,
    item.contentSnippet,
    item.description,
    item.content,
  ]

  for (const candidate of candidates) {
    const summary = truncateText(stripHtml(candidate), 500)
    if (summary) {
      return summary
    }
  }

  return ""
}

function normalizeFeedName(item) {
  const explicitName = toSafeString(item.feed_name || item.feedName || item.creator || item.author)

  if (explicitName) {
    return explicitName
  }

  const link = toSafeString(item.link)
  if (!link) {
    return ""
  }

  try {
    return new URL(link).hostname
  } catch {
    return ""
  }
}

const workspace = resolveWorkspace()
const outputsPath = process.env.OUTPUTS_PATH

if (!outputsPath) {
  throw new Error("Missing OUTPUTS_PATH")
}

const outputsFile = path.resolve(workspace, outputsPath)
const outputs = readJson(outputsFile)

if (!Array.isArray(outputs)) {
  throw new Error(`Expected outputs array in ${outputsFile}`)
}

const endDateKey = toDateKey(new Date(), TARGET_TIMEZONE)
const startDateKey = shiftDateKey(endDateKey, -(WINDOW_DAYS - 1))
const itemsByLink = new Map()

for (const item of outputs) {
  const title = toSafeString(item.title)
  const link = toSafeString(item.link)
  const publishedLocal = normalizePublishedAt(item)
  const publishedDateKey = toDateKey(publishedLocal, TARGET_TIMEZONE)

  if (!title || !link || !publishedDateKey) {
    continue
  }

  if (publishedDateKey < startDateKey || publishedDateKey > endDateKey) {
    continue
  }

  itemsByLink.set(link, {
    title,
    link,
    summary: normalizeSummary(item),
    published_local: publishedLocal,
    feed_name: normalizeFeedName(item),
  })
}

const items = Array.from(itemsByLink.values()).sort((left, right) => {
  const publishedDiff = Date.parse(right.published_local || "") - Date.parse(left.published_local || "")

  if (publishedDiff !== 0) {
    return publishedDiff
  }

  return left.title.localeCompare(right.title)
})

if (items.length === 0) {
  throw new Error("No recent RSS items available for Codex input")
}

const tempDir = path.join(workspace, ".tmp", "rss-codex-cubox")
fs.mkdirSync(tempDir, { recursive: true })

const inputPath = path.join(tempDir, "input.json")
fs.writeFileSync(inputPath, `${JSON.stringify(items, null, 2)}\n`)

const templatePath = path.join(
  workspace,
  "rss-codex-cubox",
  "prompts",
  "cubox_digest_prompt.txt"
)
const template = fs.readFileSync(templatePath, "utf8")
const prompt = template.replace("{{FEED_ITEMS_JSON}}", JSON.stringify(items, null, 2))
const promptPath = path.join(tempDir, "prompt.txt")
fs.writeFileSync(promptPath, prompt)

const githubOutput = process.env.GITHUB_OUTPUT
if (!githubOutput) {
  throw new Error("Missing GITHUB_OUTPUT")
}

fs.appendFileSync(githubOutput, `input_path=${path.relative(workspace, inputPath)}\n`)
fs.appendFileSync(githubOutput, `prompt_path=${path.relative(workspace, promptPath)}\n`)
fs.appendFileSync(githubOutput, `item_count=${items.length}\n`)

console.log(`Prepared ${items.length} RSS items for Codex`)
