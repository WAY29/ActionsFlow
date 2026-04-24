#!/usr/bin/env node

const fs = require("fs")
const path = require("path")

const MAX_ITEMS = 10

function resolveWorkspace() {
  return process.env.GITHUB_WORKSPACE || process.cwd()
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function toSafeString(value) {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeScore(value) {
  const score = Number(value)
  if (!Number.isFinite(score)) {
    throw new Error(`Invalid score: ${value}`)
  }
  return Math.max(0, Math.min(10, score))
}

function normalizePublishedAt(value) {
  const time = Date.parse(value || "")
  return Number.isFinite(time) ? time : 0
}

function formatScore(score) {
  return Number.isInteger(score) ? `${score}.0` : score.toFixed(1)
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Codex output must be an object")
  }
  if (!Array.isArray(payload.items)) {
    throw new Error("Codex output.items must be an array")
  }
}

async function postToCubox(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Cubox request failed: ${response.status} ${text}`)
  }
  return text
}

async function main() {
  const workspace = resolveWorkspace()
  const codexOutputFile = process.env.CODEX_OUTPUT_FILE
  const inputItemsFile = process.env.INPUT_ITEMS_FILE
  const cuboxUrl = process.env.CUBOX_URL
  const folder = toSafeString(process.env.CUBOX_FOLDER) || "AI"
  const tags = toSafeString(process.env.CUBOX_TAGS)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)

  if (!codexOutputFile) {
    throw new Error("Missing CODEX_OUTPUT_FILE")
  }
  if (!inputItemsFile) {
    throw new Error("Missing INPUT_ITEMS_FILE")
  }
  if (!cuboxUrl) {
    throw new Error("Missing CUBOX_URL")
  }

  const codexOutputPath = path.resolve(workspace, codexOutputFile)
  const inputItemsPath = path.resolve(workspace, inputItemsFile)

  const payload = readJson(codexOutputPath)
  validatePayload(payload)

  const inputItems = readJson(inputItemsPath)
  const publishedByLink = new Map(
    inputItems.map((item) => [toSafeString(item.link), normalizePublishedAt(item.published_local)])
  )

  const items = payload.items.map((item, index) => {
    const title = toSafeString(item.title)
    const link = toSafeString(item.link)
    const summary = toSafeString(item.summary)
    const score = normalizeScore(item.score)

    if (!title || !link || !summary) {
      throw new Error(`Invalid item at index ${index}`)
    }

    return {
      index,
      title,
      link,
      summary,
      score,
      publishedAt: publishedByLink.get(link) || 0,
    }
  })

  const filtered = items
    .filter((item) => item.score > 7)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score
      }
      if (b.publishedAt !== a.publishedAt) {
        return b.publishedAt - a.publishedAt
      }
      return a.index - b.index
    })
    .slice(0, MAX_ITEMS)

  if (filtered.length === 0) {
    console.log("No qualifying items to push to Cubox")
    return
  }

  for (const item of filtered) {
    const body = {
      type: "url",
      content: item.link,
      title: item.title,
      description: `(${formatScore(item.score)}) ${item.summary}`,
      folder,
      tags,
    }

    await postToCubox(cuboxUrl, body)
    console.log(`Pushed to Cubox: ${item.title} (${formatScore(item.score)}/10)`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
