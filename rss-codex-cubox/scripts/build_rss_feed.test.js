const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const { XMLParser, XMLValidator } = require("fast-xml-parser")

const {
  RSS_FILENAME,
  buildAndWriteRssFeed,
  buildCurrentItems,
  buildDirectItems,
  fetchExistingRss,
  mergeItems,
  normalizeRssFilename,
  normalizePublicUrl,
  parseExistingRss,
  renderRssXml,
} = require("./build_rss_feed")

const TEST_RSS_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  parseTagValue: false,
})

test("normalizePublicUrl accepts only a root site URL and appends the feed filename", () => {
  assert.deepEqual(normalizePublicUrl("ak.example.com"), {
    origin: "https://ak.example.com",
    feedUrl: `https://ak.example.com/${RSS_FILENAME}`,
  })

  assert.deepEqual(normalizePublicUrl("https://ak.example.com/"), {
    origin: "https://ak.example.com",
    feedUrl: `https://ak.example.com/${RSS_FILENAME}`,
  })

  assert.deepEqual(normalizePublicUrl("ak.example.com", { rssFilename: "readwise-weekly.xml" }), {
    origin: "https://ak.example.com",
    feedUrl: "https://ak.example.com/readwise-weekly.xml",
  })

  assert.throws(() => normalizePublicUrl("https://ak.example.com/rss.xml"), /root domain/)
  assert.throws(() => normalizePublicUrl("https://ak.example.com/?v=1"), /root domain/)
})

test("normalizeRssFilename rejects path traversal and accepts simple XML names", () => {
  assert.equal(normalizeRssFilename("readwise-weekly.xml"), "readwise-weekly.xml")
  assert.throws(() => normalizeRssFilename("../readwise-weekly.xml"), /safe filename/)
  assert.throws(() => normalizeRssFilename("feeds/readwise-weekly.xml"), /safe filename/)
  assert.throws(() => normalizeRssFilename(""), /Missing RSS_FILENAME/)
})

test("buildCurrentItems validates Codex output and enriches it with input metadata", () => {
  const items = buildCurrentItems(
    {
      items: [
        {
          title: "New <AI>",
          link: "https://example.com/new",
          score: 8.4,
          summary: "摘要 & 重点",
        },
      ],
    },
    [
      {
        title: "New <AI>",
        link: "https://example.com/new",
        published_local: "2026-04-24T01:02:03.000Z",
        feed_name: "Source & Name",
        feed_url: "https://feed.example.com/rss.xml",
      },
    ]
  )

  assert.equal(items.length, 1)
  assert.equal(items[0].description, "(8.4/10) 摘要 & 重点")
  assert.equal(items[0].pubDateMs, Date.parse("2026-04-24T01:02:03.000Z"))
  assert.equal(items[0].sourceTitle, "Source & Name")
  assert.equal(items[0].sourceUrl, "https://feed.example.com/rss.xml")
})

test("buildDirectItems converts plain RSS item input with build-time defaults", () => {
  const defaultPubDateMs = Date.parse("2026-04-25T00:00:00.000Z")
  const items = buildDirectItems(
    [
      {
        title: "Wise Reads Vol. 10",
        link: "https://wise.readwise.io/issues/wisereads-vol-10/",
      },
    ],
    { defaultPubDateMs }
  )

  assert.deepEqual(items, [
    {
      title: "Wise Reads Vol. 10",
      link: "https://wise.readwise.io/issues/wisereads-vol-10/",
      guid: "https://wise.readwise.io/issues/wisereads-vol-10/",
      description: "Wise Reads Vol. 10",
      pubDateMs: defaultPubDateMs,
      sourceTitle: "",
      sourceUrl: "",
    },
  ])
})

test("parseExistingRss reads prior RSS items for history merging", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><item>
<title>Old Item</title>
<link>https://example.com/old</link>
<guid isPermaLink="true">https://example.com/old</guid>
<description>old description</description>
<pubDate>Thu, 23 Apr 2026 01:00:00 GMT</pubDate>
</item></channel></rss>`

  const items = parseExistingRss(xml)

  assert.equal(items.length, 1)
  assert.equal(items[0].title, "Old Item")
  assert.equal(items[0].link, "https://example.com/old")
  assert.equal(items[0].guid, "https://example.com/old")
  assert.equal(items[0].description, "old description")
})

test("mergeItems keeps history, replaces duplicates with current items, and limits size", () => {
  const oldItems = [
    {
      title: "Old Duplicate",
      link: "https://example.com/a",
      guid: "https://example.com/a",
      description: "old",
      pubDateMs: Date.parse("2026-04-20T00:00:00.000Z"),
    },
    {
      title: "History",
      link: "https://example.com/b",
      guid: "https://example.com/b",
      description: "history",
      pubDateMs: Date.parse("2026-04-19T00:00:00.000Z"),
    },
  ]
  const currentItems = [
    {
      title: "Current Duplicate",
      link: "https://example.com/a",
      guid: "https://example.com/a",
      description: "new",
      pubDateMs: Date.parse("2026-04-24T00:00:00.000Z"),
    },
    {
      title: "Current Fresh",
      link: "https://example.com/c",
      guid: "https://example.com/c",
      description: "fresh",
      pubDateMs: Date.parse("2026-04-23T00:00:00.000Z"),
    },
  ]

  const merged = mergeItems(currentItems, oldItems, { maxItems: 3 })

  assert.deepEqual(
    merged.map((item) => item.title),
    ["Current Duplicate", "Current Fresh", "History"]
  )
})

test("renderRssXml escapes XML and points atom self link at the fixed filename", () => {
  const xml = renderRssXml({
    title: "AK RSS Preferred",
    description: "精选 RSS",
    siteUrl: "https://ak.example.com",
    feedUrl: `https://ak.example.com/${RSS_FILENAME}`,
    generatedAt: new Date("2026-04-25T00:00:00.000Z"),
    items: [
      {
        title: "A & B <C>",
        link: "https://example.com/a?x=1&y=2",
        guid: "https://example.com/a?x=1&y=2",
        description: "(8.8/10) 摘要 <重点>",
        pubDateMs: Date.parse("2026-04-24T00:00:00.000Z"),
        sourceTitle: "Feed & Source",
        sourceUrl: "https://feed.example.com/rss.xml?x=1&y=2",
      },
    ],
  })

  assert.match(xml, /<atom:link href="https:\/\/ak\.example\.com\/rss-akrss-preferred\.xml"/)
  assert.match(xml, /<title>A &amp; B &lt;C&gt;<\/title>/)
  assert.match(xml, /<link>https:\/\/example\.com\/a\?x=1&amp;y=2<\/link>/)
  assert.match(xml, /<description>\(8\.8\/10\) 摘要 &lt;重点&gt;<\/description>/)
  assert.match(xml, /<source url="https:\/\/feed\.example\.com\/rss\.xml\?x=1&amp;y=2">Feed &amp; Source<\/source>/)
  assert.equal(XMLValidator.validate(xml), true)

  const parsed = TEST_RSS_PARSER.parse(xml)
  assert.equal(parsed.rss.version, "2.0")
  assert.equal(parsed.rss["xmlns:atom"], "http://www.w3.org/2005/Atom")
  assert.equal(parsed.rss.channel.item.guid.isPermaLink, "true")
})

test("renderRssXml omits source when source URL is missing", () => {
  const xml = renderRssXml({
    title: "AK RSS Preferred",
    description: "精选 RSS",
    siteUrl: "https://ak.example.com",
    feedUrl: `https://ak.example.com/${RSS_FILENAME}`,
    generatedAt: new Date("2026-04-25T00:00:00.000Z"),
    items: [
      {
        title: "A",
        link: "https://example.com/a",
        guid: "https://example.com/a",
        description: "summary",
        pubDateMs: Date.parse("2026-04-24T00:00:00.000Z"),
        sourceTitle: "Feed Without URL",
        sourceUrl: "",
      },
    ],
  })

  assert.doesNotMatch(xml, /<source/)
  assert.equal(XMLValidator.validate(xml), true)
})

test("fetchExistingRss treats 404 as first run and fails on other bad statuses", async () => {
  const missing = await fetchExistingRss("https://ak.example.com/rss-akrss-preferred.xml", {
    fetchImpl: async () => ({
      status: 404,
      ok: false,
      text: async () => "not found",
    }),
  })

  assert.equal(missing, "")

  await assert.rejects(
    () =>
      fetchExistingRss("https://ak.example.com/rss-akrss-preferred.xml", {
        fetchImpl: async () => ({
          status: 500,
          ok: false,
          text: async () => "server failed",
        }),
      }),
    /Fetch existing RSS failed: 500/
  )
})

test("buildAndWriteRssFeed writes a named feed and merges local history", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rss-feed-test-"))
  const outputDir = path.join(workspace, "public-rss")
  const itemsPath = path.join(workspace, "items.json")

  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(
    path.join(outputDir, "readwise-weekly.xml"),
    renderRssXml({
      title: "Readwise Weekly",
      description: "Weekly Wise Reads",
      siteUrl: "https://rss.example.com",
      feedUrl: "https://rss.example.com/readwise-weekly.xml",
      generatedAt: new Date("2026-04-18T00:00:00.000Z"),
      items: [
        {
          title: "Wise Reads Vol. 9",
          link: "https://wise.readwise.io/issues/wisereads-vol-9/",
          guid: "https://wise.readwise.io/issues/wisereads-vol-9/",
          description: "Wise Reads Vol. 9",
          pubDateMs: Date.parse("2026-04-18T00:00:00.000Z"),
        },
      ],
    })
  )
  fs.writeFileSync(
    itemsPath,
    `${JSON.stringify(
      [
        {
          title: "Wise Reads Vol. 10",
          link: "https://wise.readwise.io/issues/wisereads-vol-10/",
        },
      ],
      null,
      2
    )}\n`
  )

  const result = await buildAndWriteRssFeed({
    workspace,
    itemsPath: "items.json",
    publicUrl: "https://rss.example.com",
    outputDir: "public-rss",
    rssFilename: "readwise-weekly.xml",
    title: "Readwise Weekly",
    description: "Weekly Wise Reads",
    maxItems: 10,
    generatedAt: new Date("2026-04-25T00:00:00.000Z"),
    fetchImpl: async () => {
      throw new Error("local history should avoid network fetch")
    },
  })

  const xml = fs.readFileSync(result.outputPath, "utf8")

  assert.equal(result.feedUrl, "https://rss.example.com/readwise-weekly.xml")
  assert.equal(result.itemCount, 2)
  assert.equal(result.previousItemCount, 1)
  assert.match(xml, /<atom:link href="https:\/\/rss\.example\.com\/readwise-weekly\.xml"/)
  assert.match(xml, /<title>Wise Reads Vol\. 10<\/title>/)
  assert.match(xml, /<title>Wise Reads Vol\. 9<\/title>/)
  assert.equal(
    fs.readFileSync(path.join(outputDir, "_headers"), "utf8"),
    "/*.xml\n  Content-Type: application/rss+xml; charset=utf-8\n  Cache-Control: public, max-age=300\n"
  )
})

test("buildAndWriteRssFeed treats missing local and unreachable remote history as first run", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rss-feed-test-"))

  fs.writeFileSync(
    path.join(workspace, "items.json"),
    `${JSON.stringify(
      [
        {
          title: "Wise Reads Vol. 10",
          link: "https://wise.readwise.io/issues/wisereads-vol-10/",
        },
      ],
      null,
      2
    )}\n`
  )

  const result = await buildAndWriteRssFeed({
    workspace,
    itemsPath: "items.json",
    publicUrl: "https://deleted-pages.example.com",
    outputDir: "public-rss",
    rssFilename: "readwise-weekly.xml",
    title: "Readwise Weekly",
    description: "Weekly Wise Reads",
    generatedAt: new Date("2026-04-25T00:00:00.000Z"),
    fetchImpl: async () => {
      throw new Error("fetch failed")
    },
  })

  const xml = fs.readFileSync(result.outputPath, "utf8")

  assert.equal(result.itemCount, 1)
  assert.equal(result.previousItemCount, 0)
  assert.match(xml, /<title>Wise Reads Vol\. 10<\/title>/)
})
