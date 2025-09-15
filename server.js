import express from 'express'
import bodyParser from 'body-parser'
import cors from 'cors'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import multer from 'multer'
import { OpenAI } from 'openai'
import fetch from 'node-fetch'

// Resolve paths
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Load env from repo root .env so we can share with other tools
dotenv.config({ path: path.resolve(__dirname, '..', '.env') })

const PORT = process.env.PORT || 3030
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || 'mcp-zoning-token'
const ALLOW_NO_AUTH = (process.env.ALLOW_NO_AUTH || '').toLowerCase() === '1' || (process.env.ALLOW_NO_AUTH || '').toLowerCase() === 'true'
const VECTOR_STORE_NAME = process.env.VECTOR_STORE_NAME || 'zoning-codes-store'
const DEBUG = (process.env.DEBUG_MCP || '').toLowerCase() === '1' || (process.env.DEBUG_MCP || '').toLowerCase() === 'true'
const JURISDICTIONS = [
  'Ascension Parish, LA',
  'East Baton Rouge Parish, LA',
  'City of Zachary, LA'
]

if (!process.env.OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in environment. Set it in .env at repo root.')
  process.exit(1)
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const app = express()
app.use(cors())
app.use(bodyParser.json({ limit: '5mb' }))

function debug(...args) {
  if (DEBUG) console.log(...args)
}

// Simple bearer auth for this demo server (can be bypassed via ALLOW_NO_AUTH)
app.use((req, res, next) => {
  if (ALLOW_NO_AUTH) return next()
  const auth = req.get('authorization') || ''
  if (!AUTH_TOKEN || auth === `Bearer ${AUTH_TOKEN}`) return next()
  return res.status(401).json({ error: 'unauthorized' })
})

// Persist vector store id locally
const statePath = path.join(__dirname, '.vector-store.json')
function loadState() {
  try {
    const raw = fs.readFileSync(statePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return { vectorStoreId: null }
  }
}
function saveState(s) {
  fs.writeFileSync(statePath, JSON.stringify(s, null, 2))
}

async function ensureVectorStore() {
  const state = loadState()
  if (state.vectorStoreId) return state.vectorStoreId
  // Use HTTP API for vector store creation to ensure compatibility with SDK versions
  const resp = await fetch('https://api.openai.com/v1/vector_stores', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ name: VECTOR_STORE_NAME })
  })
  if (!resp.ok) {
    const txt = await resp.text()
    throw new Error(`Failed to create vector store via HTTP: ${resp.status} ${txt}`)
  }
  const json = await resp.json()
  const id = json.id
  saveState({ vectorStoreId: id })
  return id
}

// Health
app.get('/health', (req, res) => res.json({ ok: true }))

// Ingest a single file via multipart form-data
// fields: file (binary), jurisdiction (text)
const upload = multer({ dest: path.join(os.tmpdir(), 'zoning-mcp-uploads') })
app.post('/ingest', upload.single('file'), async (req, res) => {
  try {
    debug('Ingest request content-type:', req.headers['content-type'])
    debug('Ingest req.file:', !!req.file, req.file?.originalname)
    debug('Ingest req.body keys:', Object.keys(req.body || {}))
    if (!req.file) return res.status(400).json({ error: 'no_multipart_file' })
    const jurisdiction = req.body?.jurisdiction || null
    const filename = req.file.originalname || req.file.filename

    const storeId = await ensureVectorStore()
    const file = await openai.files.create({
      file: fs.createReadStream(req.file.path),
      purpose: 'assistants',
    })

    const resp2 = await fetch(`https://api.openai.com/v1/vector_stores/${storeId}/files`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ file_id: file.id })
    })
    if (!resp2.ok) {
      const txt = await resp2.text()
      throw new Error(`Failed to attach file to vector store via HTTP: ${resp2.status} ${txt}`)
    }

    // Cleanup temp file
    fs.unlink(req.file.path, () => {})

    return res.json({ ok: true, file_id: file.id, vector_store_id: storeId, filename })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: err.message || 'ingest failed' })
  }
})

// Compatibility: some clients probe /sse. Provide minimal handlers.
// 1) POST /sse: treat exactly like /mcp for JSON-based clients that post here.
app.post('/sse', (req, res, next) => {
  // Delegate to /mcp handler
  req.url = '/mcp'
  next()
})

// 2) GET /sse: open a simple SSE stream with periodic ping; this is NOT a full MCP SSE impl,
// but helps certain connectors pass initial reachability checks.
app.get('/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()
  const ping = () => {
    res.write(`event: ping\n`)
    res.write(`data: {"ok":true}\n\n`)
  }
  const timer = setInterval(ping, 15000)
  ping()
  req.on('close', () => clearInterval(timer))
})

// Minimal MCP over HTTP sketch
// Core MCP endpoint (JSON over HTTP)
app.post('/mcp', async (req, res) => {
  const { method, params } = req.body || {}
  try {
    switch (method) {
      case 'initialize': {
        await ensureVectorStore()
        return res.json({
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: 'zoning-mcp-server', version: '0.1.0' }
          }
        })
      }
      case 'tools/list': {
        return res.json({
          result: {
            tools: [
              {
                name: 'search_zoning',
                description: 'Semantic search across Ascension, East Baton Rouge, and Zachary zoning codes. Returns citations.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    query: { type: 'string', description: 'User question or keywords' },
                    top_k: { type: 'integer', minimum: 1, maximum: 25, default: 6 },
                    jurisdiction: { type: 'string', enum: JURISDICTIONS, description: 'Optional filter' }
                  },
                  required: ['query']
                }
              }
            ]
          }
        })
      }
      case 'tools/call': {
        const { name, arguments: args } = params || {}
        if (name !== 'search_zoning') return res.status(400).json({ error: 'unknown tool' })

        const storeId = await ensureVectorStore()
        const query = args?.query || ''
        const topK = Math.min(Math.max(args?.top_k || 6, 1), 25)
        const jurisdiction = args?.jurisdiction

        let prompt = `Find highly relevant zoning code passages for: ${query}.`
        if (jurisdiction) prompt += ` Restrict to jurisdiction: ${jurisdiction}.`
        prompt += ` Return a concise JSON with citations (filename, page or section, snippet).`

        // Two payload shapes known-good in 2025
        const makePayloadA = () => ({
          model: 'gpt-4o-mini',
          input: prompt,
          tools: [{ type: 'file_search' }],
          tool_resources: { file_search: { vector_store_ids: [storeId] } },
        })

        const makePayloadB = () => ({
          model: 'gpt-4o-mini',
          input: prompt,
          tools: [{ type: 'file_search', vector_store_ids: [storeId] }],
        })

        async function callResponses(payload, label) {
          const body = JSON.stringify(payload)
          debug(`DEBUG responses.create ${label} payload:`, body)
          const rr = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
              'content-type': 'application/json',
            },
            body,
          })
          const reqId = rr.headers.get('x-request-id') || null
          const textBody = await rr.text()
          if (!rr.ok) {
            console.error(`OpenAI error (${label}) [${rr.status}] reqId=${reqId}:`, textBody)
            const err = new Error(textBody)
            err.status = rr.status
            err.requestId = reqId
            throw err
          }
          debug(`OpenAI OK (${label}) reqId=${reqId}`)
          return JSON.parse(textBody)
        }

        function extractCitationsFromText(text) {
          if (!text || typeof text !== 'string') return []
          // Try fenced code block ```json ... ```
          const fence = /```json\s*([\s\S]*?)```/i.exec(text)
          let jsonStr = fence ? fence[1] : null
          if (!jsonStr) {
            // Try to find first JSON array in text
            const start = text.indexOf('[')
            const end = text.lastIndexOf(']')
            if (start !== -1 && end !== -1 && end > start) jsonStr = text.slice(start, end + 1)
          }
          try {
            const parsed = jsonStr ? JSON.parse(jsonStr) : JSON.parse(text)
            const arr = Array.isArray(parsed) ? parsed : (parsed?.citations || [])
            if (!Array.isArray(arr)) return []
            return arr
              .map((c) => ({
                filename: c.filename || c.file || c.name || null,
                section: c.section || c.page || c.location || null,
                snippet: c.snippet || c.text || c.excerpt || null,
              }))
              .filter((c) => c.filename && (c.section || c.snippet))
          } catch {
            return []
          }
        }

        try {
          // First try: tool_resources (most stable)
          let r
          try {
            r = await callResponses(makePayloadA(), 'A:tool_resources')
          } catch (e) {
            const lower = String(e.message || '').toLowerCase()
            if (lower.includes("unknown parameter: 'attachments'") || (e.status >= 400 && e.status < 500)) {
              console.warn('Retrying with alternate payload shape (B)')
              r = await callResponses(makePayloadB(), 'B:inline-vector_store_ids')
            } else {
              throw e
            }
          }

          // output_text helper, with fallback to walk structured output
          let text = r.output_text || ''
          if (!text && Array.isArray(r.output)) {
            const parts = []
            for (const item of r.output) {
              if (item?.content) {
                for (const c of item.content) {
                  if (c.type === 'output_text' && c?.text) parts.push(c.text)
                }
              }
            }
            text = parts.join('\n').trim()
          }

          const citations = extractCitationsFromText(text)

          const result = {
            citations,
            vector_store_id: storeId,
            top_k: topK,
            jurisdiction: jurisdiction || null,
          }
          if (DEBUG) result.raw_text = text

          return res.json({ result })
        } catch (err) {
          console.error(err)
          return res.status(400).json({ error: err.message || 'responses failed' })
        }
      }
      case 'resources/list': {
        const storeId = await ensureVectorStore()
        const resp = await fetch(`https://api.openai.com/v1/vector_stores/${storeId}/files`, {
          headers: { 'authorization': `Bearer ${process.env.OPENAI_API_KEY}` }
        })
        if (!resp.ok) {
          const t = await resp.text()
          throw new Error(`Failed to list files via HTTP: ${resp.status} ${t}`)
        }
        const filesList = await resp.json()
        const resources = filesList.data.map((f) => ({
          uri: `openai-file://${f.id}`,
          name: f.filename || f.id,
          description: 'Zoning PDF in vector store',
          annotations: { jurisdiction: f?.metadata?.jurisdiction || null }
        }))
        return res.json({ result: { resources } })
      }
      case 'resources/read': {
        const { uri } = params || {}
        if (!uri || !uri.startsWith('openai-file://')) return res.status(400).json({ error: 'invalid uri' })
        const fileId = uri.replace('openai-file://', '')
        // We will not attempt to parse binary PDF to text here; instead, return a note + filename
        const meta = await openai.files.retrieve(fileId)
        return res.json({
          result: {
            contents: [
              { type: 'text', text: `Binary PDF: ${meta.filename}. Use the search_zoning tool to request specific sections or summaries.` }
            ],
            annotations: { filename: meta.filename }
          }
        })
      }
      default:
        return res.status(400).json({ error: 'unknown method' })
    }
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: err.message || 'server error' })
  }
})

app.listen(PORT, () => {
  console.log(`Zoning MCP server listening on http://localhost:${PORT}`)
})
