#!/usr/bin/env node

const fs = require("fs")

const DEFAULT_MODEL = "gpt-5.4"
const DEFAULT_REASONING_EFFORT = "medium"
const DEFAULT_PROMPT = "Reply with exactly OK."
const DEFAULT_TIMEOUT_MS = 300000

function toSafeString(value) {
  return typeof value === "string" ? value.trim() : ""
}

function requireEnv(name) {
  const value = toSafeString(process.env[name])

  if (!value) {
    throw new Error(`Missing ${name}`)
  }

  return value
}

function readFileIfPresent(filePath) {
  const value = toSafeString(filePath)
  if (!value) {
    return ""
  }

  return fs.readFileSync(value, "utf8")
}

function parseBoolean(value) {
  return /^(1|true|yes|on)$/i.test(toSafeString(value))
}

function log(message) {
  console.log(`[run_codex_test] ${message}`)
}

function buildResponsesUrl(baseURL) {
  if (/\/responses\/?$/.test(baseURL)) {
    return baseURL
  }

  if (baseURL.endsWith("/")) {
    return `${baseURL}responses`
  }

  return `${baseURL}/responses`
}

function pickHeaders(headers, names) {
  const values = {}

  for (const name of names) {
    const value = headers.get(name)
    if (value) {
      values[name] = value
    }
  }

  return values
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength)}...`
}

async function main() {
  const apiKey = requireEnv("OPENAI_API_KEY")
  const baseURL = requireEnv("OPENAI_API_BASE_URL")
  const url = buildResponsesUrl(baseURL)
  const model = toSafeString(process.env.OPENAI_MODEL) || DEFAULT_MODEL
  const reasoningEffort =
    toSafeString(process.env.OPENAI_REASONING_EFFORT) || DEFAULT_REASONING_EFFORT
  const promptFile = toSafeString(process.env.OPENAI_TEST_PROMPT_FILE)
  const prompt =
    readFileIfPresent(promptFile).trim() ||
    toSafeString(process.env.OPENAI_TEST_PROMPT) ||
    DEFAULT_PROMPT
  const schemaFile = toSafeString(process.env.OPENAI_TEST_SCHEMA_FILE)
  const schemaText = readFileIfPresent(schemaFile).trim()
  const useStream = parseBoolean(process.env.OPENAI_TEST_STREAM)
  const accept = useStream ? "text/event-stream" : "application/json"
  const userAgent = toSafeString(process.env.OPENAI_TEST_USER_AGENT) || "run-codex-test"
  const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)

  const body = {
    model,
    input: prompt,
    reasoning: {
      effort: reasoningEffort,
    },
    max_output_tokens: 32,
  }

  if (schemaText) {
    body.text = {
      format: {
        type: "json_schema",
        name: "codex_test_output",
        schema: JSON.parse(schemaText),
        strict: true,
      },
    }
  }

  if (useStream) {
    body.stream = true
  }

  log(`url=${url}`)
  log(`model=${model} effort=${reasoningEffort} timeoutMs=${timeoutMs} stream=${useStream}`)
  log(`headers=${JSON.stringify({ Accept: accept, "User-Agent": userAgent })}`)
  log(
    `prompt=${JSON.stringify({
      source: promptFile || "env/default",
      chars: prompt.length,
      preview: truncate(prompt, 120),
    })}`
  )
  log(
    `schema=${JSON.stringify({
      source: schemaFile || "none",
      enabled: Boolean(schemaText),
      chars: schemaText.length,
    })}`
  )

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let response

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: accept,
        "User-Agent": userAgent,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  const contentType = toSafeString(response.headers.get("content-type"))
  log(`status=${response.status} ${response.statusText || ""}`.trim())
  log(
    `headers=${JSON.stringify(
      pickHeaders(response.headers, [
        "content-type",
        "server",
        "cf-ray",
        "cf-cache-status",
        "location",
      ])
    )}`
  )

  const text = await response.text()
  log(`body_preview=${JSON.stringify(truncate(text, 1200))}`)

  if (contentType.includes("application/json")) {
    try {
      const payload = JSON.parse(text)
      const outputText =
        payload && typeof payload.output_text === "string" ? payload.output_text : ""
      log(
        `json_summary=${JSON.stringify({
          id: payload && payload.id,
          status: payload && payload.status,
          output_text: truncate(outputText, 200),
        })}`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`json_parse_error=${message}`)
    }
  } else if (/cloudflare|just a moment|attention required/i.test(text)) {
    log("detected_cloudflare_challenge=true")
  } else {
    log("detected_cloudflare_challenge=false")
  }

  if (!response.ok) {
    process.exit(1)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
