#!/usr/bin/env node

const fs = require("fs")
const path = require("path")
const OpenAI = require("openai")

const DEFAULT_MODEL = "gpt-5.4"
const DEFAULT_REASONING_EFFORT = "medium"
const REQUEST_HEADERS = {
  Accept: "application/json",
  "User-Agent": "codex-cli",
}

function resolveWorkspace() {
  return process.env.GITHUB_WORKSPACE || process.cwd()
}

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

function log(message) {
  console.log(`[run_codex] ${message}`)
}

function writeGithubOutput(key, value) {
  const githubOutput = process.env.GITHUB_OUTPUT

  if (!githubOutput) {
    return
  }

  fs.appendFileSync(githubOutput, `${key}=${value}\n`)
}

function extractJsonText(text) {
  const trimmed = toSafeString(text)

  if (!trimmed) {
    return ""
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fencedMatch) {
    return toSafeString(fencedMatch[1])
  }

  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1)
  }

  return trimmed
}

function collectOutputTextFromResponse(response) {
  if (!response || !Array.isArray(response.output)) {
    return ""
  }

  const texts = []

  for (const item of response.output) {
    if (!item || item.type !== "message" || !Array.isArray(item.content)) {
      continue
    }

    for (const content of item.content) {
      if (content && content.type === "output_text" && typeof content.text === "string") {
        texts.push(content.text)
      }
    }
  }

  return texts.join("").trim()
}

async function main() {
  const workspace = resolveWorkspace()
  const promptPath = path.resolve(workspace, requireEnv("PROMPT_FILE"))
  const outputPath = path.resolve(workspace, requireEnv("OUTPUT_FILE"))
  const apiKey = requireEnv("OPENAI_API_KEY")
  const baseURL = toSafeString(process.env.OPENAI_API_BASE_URL) || undefined
  const model = toSafeString(process.env.OPENAI_MODEL) || DEFAULT_MODEL
  const reasoningEffort =
    toSafeString(process.env.OPENAI_REASONING_EFFORT) || DEFAULT_REASONING_EFFORT

  const prompt = fs.readFileSync(promptPath, "utf8").trim()
  if (!prompt) {
    throw new Error(`Prompt file is empty: ${promptPath}`)
  }

  log(
    `start request model=${model} effort=${reasoningEffort} baseURL=${baseURL ? "set" : "default"} promptChars=${prompt.length}`
  )
  log(`files prompt=${path.relative(workspace, promptPath)}`)
  log(`headers=${JSON.stringify(REQUEST_HEADERS)}`)

  const client = new OpenAI({
    apiKey,
    baseURL,
    timeout: 10 * 60 * 1000,
    maxRetries: 2,
  })

  log("sending responses.stream request")
  const stream = client.responses.stream(
    {
      model,
      reasoning: {
        effort: reasoningEffort,
      },
      input: prompt,
    },
    {
      headers: REQUEST_HEADERS,
    }
  )

  let eventCount = 0
  let streamedOutputText = ""

  stream.on("event", (event) => {
    eventCount += 1

    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      streamedOutputText += event.delta
    }

    if (
      event.type === "response.created" ||
      event.type === "response.completed" ||
      event.type === "response.failed" ||
      event.type === "response.incomplete"
    ) {
      log(`stream event type=${event.type}`)
    }
  })

  const response = await stream.finalResponse()
  log(`response received id=${response.id} status=${response.status || "unknown"}`)
  log(`stream finished events=${eventCount}`)

  if (response.error) {
    throw new Error(
      `OpenAI response failed: ${response.error.code || "unknown"} ${response.error.message || ""}`.trim()
    )
  }

  if (response.status && response.status !== "completed") {
    const details = response.incomplete_details
      ? JSON.stringify(response.incomplete_details)
      : response.status
    throw new Error(`OpenAI response not completed: ${details}`)
  }

  const outputText =
    toSafeString(response.output_text) ||
    collectOutputTextFromResponse(response) ||
    toSafeString(streamedOutputText)

  log(
    `output_text chars sdk=${toSafeString(response.output_text).length} response=${collectOutputTextFromResponse(response).length} streamed=${toSafeString(streamedOutputText).length}`
  )

  if (!outputText) {
    throw new Error("OpenAI returned empty output_text")
  }

  let payload

  try {
    payload = JSON.parse(extractJsonText(outputText))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const preview = outputText.slice(0, 400)
    throw new Error(`OpenAI returned invalid JSON: ${message}; preview=${JSON.stringify(preview)}`)
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("OpenAI output must be a JSON object")
  }

  if (!Array.isArray(payload.items)) {
    throw new Error("OpenAI output.items must be an array")
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`)
  log(`wrote ${payload.items.length} items to ${path.relative(workspace, outputPath)}`)

  writeGithubOutput("response_id", response.id)
  writeGithubOutput("output_file", path.relative(workspace, outputPath))
  writeGithubOutput("item_count", String(payload.items.length))

  log(`completed model=${model} items=${payload.items.length}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
