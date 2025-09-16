const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3030;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || 'mcp-zoning-token';
const ALLOW_NO_AUTH = process.env.ALLOW_NO_AUTH === '1' || process.env.ALLOW_NO_AUTH === 'true';
const DEBUG_MCP = process.env.DEBUG_MCP === '1' || process.env.DEBUG_MCP === 'true';
const VECTOR_STORE_NAME = process.env.VECTOR_STORE_NAME || 'zoning-codes-store';
const HOST = process.env.HOST || '0.0.0.0';
const JSONRPC_VERSION = '2.0';
const PROTOCOL_VERSION = { major: 0, minor: 1 };
const SERVER_METADATA = {
  name: 'Zoning MCP Server',
  version: '1.0.0',
  description: 'Semantic search interface for zoning code PDFs'
};

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

if (DEBUG_MCP) {
  app.use((req, res, next) => {
    const start = Date.now();
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    res.on('finish', () => {
      console.log(` ↳ Responded ${res.statusCode} in ${Date.now() - start}ms`);
    });
    next();
  });
}

// Authentication middleware
const authenticate = (req, res, next) => {
  if (ALLOW_NO_AUTH) {
    return next();
  }
  
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }
  
  const token = authHeader.substring(7);
  if (token !== MCP_AUTH_TOKEN) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  next();
};

// Multer setup for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Vector store management
const VECTOR_STORE_FILE = '.vector-store.json';

function loadVectorStore() {
  try {
    if (fs.existsSync(VECTOR_STORE_FILE)) {
      const data = fs.readFileSync(VECTOR_STORE_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading vector store:', error);
  }
  return null;
}

function saveVectorStore(storeData) {
  try {
    fs.writeFileSync(VECTOR_STORE_FILE, JSON.stringify(storeData, null, 2));
  } catch (error) {
    console.error('Error saving vector store:', error);
  }
}

async function createVectorStore() {
  try {
    const response = await fetch('https://api.openai.com/v1/vector_stores', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      },
      body: JSON.stringify({
        name: VECTOR_STORE_NAME,
        expires_after: {
          anchor: 'last_active_at',
          days: 30
        }
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const vectorStore = await response.json();
    saveVectorStore(vectorStore);
    return vectorStore;
  } catch (error) {
    console.error('Error creating vector store:', error);
    throw error;
  }
}

async function getOrCreateVectorStore() {
  let vectorStore = loadVectorStore();
  
  if (!vectorStore) {
    console.log('Creating new vector store...');
    vectorStore = await createVectorStore();
    console.log('Vector store created:', vectorStore.id);
  } else {
    console.log('Using existing vector store:', vectorStore.id);
  }
  
  return vectorStore;
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

function jsonRpcError(res, id, code, message, data) {
  const errorPayload = {
    jsonrpc: JSONRPC_VERSION,
    id: id ?? null,
    error: { code, message }
  };

  if (data !== undefined) {
    errorPayload.error.data = data;
  }

  res.json(errorPayload);
}

function jsonRpcResult(res, id, result) {
  res.json({
    jsonrpc: JSONRPC_VERSION,
    id: id ?? null,
    result
  });
}

function extractOutputText(responseBody) {
  if (!responseBody) {
    return '';
  }

  if (typeof responseBody.output_text === 'string' && responseBody.output_text.trim()) {
    return responseBody.output_text;
  }

  if (Array.isArray(responseBody.output)) {
    const textChunks = [];
    for (const item of responseBody.output) {
      if (item && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part && typeof part.text === 'string') {
            textChunks.push(part.text);
          }
        }
      }
    }
    return textChunks.join('\n').trim();
  }

  return '';
}

// File ingestion endpoint
app.post('/ingest', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });
    }

    const file = req.file;
    console.log(`Ingesting file: ${file.originalname} (${file.size} bytes)`);

    // Upload file to OpenAI
    const formData = new FormData();
    const blob = new Blob([file.buffer], { type: file.mimetype });
    formData.append('file', blob, file.originalname);
    formData.append('purpose', 'assistants');

    const uploadResponse = await fetch('https://api.openai.com/v1/files', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: formData
    });

    if (!uploadResponse.ok) {
      throw new Error(`File upload failed: ${uploadResponse.status}`);
    }

    const uploadedFile = await uploadResponse.json();
    console.log('File uploaded to OpenAI:', uploadedFile.id);

    // Get or create vector store
    const vectorStore = await getOrCreateVectorStore();

    // Attach file to vector store
    const attachResponse = await fetch(`https://api.openai.com/v1/vector_stores/${vectorStore.id}/files`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      },
      body: JSON.stringify({
        file_id: uploadedFile.id
      })
    });

    if (!attachResponse.ok) {
      throw new Error(`File attachment failed: ${attachResponse.status}`);
    }

    const attachment = await attachResponse.json();
    console.log('File attached to vector store:', attachment.id);

    res.json({
      success: true,
      fileId: uploadedFile.id,
      vectorStoreId: vectorStore.id,
      attachmentId: attachment.id,
      filename: file.originalname
    });

  } catch (error) {
    console.error('Ingestion error:', error);
    res.status(500).json({ error: error.message });
  }
});

// MCP endpoint for JSON-RPC requests
app.post('/mcp', authenticate, async (req, res) => {
  const body = req.body || {};
  const { jsonrpc, method, params = {}, id = null } = body;

  if (DEBUG_MCP) {
    try {
      console.log('MCP request body:', JSON.stringify(body));
    } catch (e) {
      console.log('MCP request body (unserializable)');
    }
  }

  if (jsonrpc && jsonrpc !== JSONRPC_VERSION) {
    return jsonRpcError(res, id, -32600, 'Invalid JSON-RPC version');
  }

  if (!method) {
    return jsonRpcError(res, id, -32600, 'Invalid request: missing method');
  }

  try {
    if (method === 'initialize') {
      return jsonRpcResult(res, id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {
            listChanged: false
          }
        },
        serverInfo: SERVER_METADATA
      });
    }

    if (method === 'server/info') {
      return jsonRpcResult(res, id, {
        ...SERVER_METADATA,
        capabilities: {
          tools: {
            listChanged: false
          }
        }
      });
    }

    if (method === 'ping') {
      return jsonRpcResult(res, id, { ok: true });
    }

    if (method === 'tools/list') {
      return jsonRpcResult(res, id, {
        tools: [
          {
            name: 'search_zoning',
            description: 'Search through zoning code documents for specific information. Returns structured citations with filename, section, and relevant text snippets.',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'The search query for zoning information (e.g., "setback requirements for residential buildings")'
                }
              },
              required: ['query']
            }
          }
        ],
        next_cursor: null
      });
    }

    if (method === 'tools/call') {
      if (!OPENAI_API_KEY) {
        return jsonRpcError(res, id, -32001, 'OPENAI_API_KEY is not configured');
      }

      const { name, arguments: args = {} } = params;

      if (name !== 'search_zoning') {
        return jsonRpcError(res, id, -32601, `Unknown tool: ${name}`);
      }

      const query = args.query;

      if (!query || typeof query !== 'string') {
        return jsonRpcError(res, id, -32602, 'Missing required argument: query');
      }

      const vectorStore = await getOrCreateVectorStore();

      if (DEBUG_MCP) {
        console.log('=== MCP Search Request ===');
        console.log('Query:', query);
        console.log('Vector Store ID:', vectorStore.id);
      }

      const payload = {
        model: 'gpt-4o-mini',
        input: `Search the zoning documents for: ${query}. Provide specific citations with document names, section references, and relevant text snippets.`,
        tools: [{ type: 'file_search' }],
        tool_resources: {
          file_search: {
            vector_store_ids: [vectorStore.id]
          }
        }
      };

      if (DEBUG_MCP) {
        console.log('=== OpenAI Responses API Payload ===');
        console.log(JSON.stringify(payload, null, 2));
      }

      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v2'
        },
        body: JSON.stringify(payload)
      });

      const requestId = response.headers.get('x-request-id');
      if (DEBUG_MCP && requestId) {
        console.log('OpenAI Request ID:', requestId);
      }

      if (!response.ok) {
        const errorText = await response.text();

        if (DEBUG_MCP) {
          console.log('=== OpenAI API Error ===');
          console.log('Status:', response.status);
          console.log('Error:', errorText);
        }

        if (errorText.includes("Unknown parameter: 'attachments'")) {
          if (DEBUG_MCP) {
            console.log('Retrying with fallback payload shape...');
          }

          const fallbackPayload = {
            model: 'gpt-4o-mini',
            input: `Search the zoning documents for: ${query}. Provide specific citations with document names, section references, and relevant text snippets.`,
            tools: [{
              type: 'file_search',
              vector_store_ids: [vectorStore.id]
            }]
          };

          const fallbackResponse = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${OPENAI_API_KEY}`,
              'Content-Type': 'application/json',
              'OpenAI-Beta': 'assistants=v2'
            },
            body: JSON.stringify(fallbackPayload)
          });

          if (!fallbackResponse.ok) {
            throw new Error(`Fallback request failed: ${fallbackResponse.status}`);
          }

          const fallbackResult = await fallbackResponse.json();
          const fallbackText = extractOutputText(fallbackResult);
          const parsedFallback = parseSearchResults(fallbackText || '');

          return jsonRpcResult(res, id, {
            content: [
              {
                type: 'text',
                text: parsedFallback
              }
            ]
          });
        }

        throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
      }

      const result = await response.json();

      if (DEBUG_MCP) {
        console.log('=== OpenAI Response ===');
        console.log(JSON.stringify(result, null, 2));
      }

      const outputText = extractOutputText(result);
      const structuredResults = parseSearchResults(outputText || '');

      return jsonRpcResult(res, id, {
        content: [
          {
            type: 'text',
            text: structuredResults
          }
        ]
      });
    }

    return jsonRpcError(res, id, -32601, `Unknown method: ${method}`);
  } catch (error) {
    console.error('MCP error:', error);
    return jsonRpcError(res, id, -32000, error.message || 'Server error');
  }
});

// SSE endpoint for ChatGPT connector compatibility
app.get('/sse', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  // Send periodic pings to keep connection alive
  const pingInterval = setInterval(() => {
    res.write('data: {"type":"ping","timestamp":"' + new Date().toISOString() + '"}\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(pingInterval);
  });
});

// POST /sse endpoint that delegates to /mcp
app.post('/sse', authenticate, async (req, res) => {
  // Delegate to the existing /mcp handler
  req.url = '/mcp';
  app._router.handle(req, res);
});

// Helper function to parse and structure search results
function parseSearchResults(rawOutput) {
  try {
    // Try to extract structured information from the response
    const lines = rawOutput.split('\n').filter(line => line.trim());
    const citations = [];
    
    let currentCitation = {};
    
    for (const line of lines) {
      // Look for document/filename references
      if (line.includes('.pdf') || line.includes('Document:') || line.includes('Source:')) {
        if (currentCitation.filename) {
          citations.push(currentCitation);
        }
        currentCitation = {
          filename: extractFilename(line),
          section: '',
          snippet: ''
        };
      }
      // Look for section references
      else if (line.includes('Section') || line.includes('Article') || line.includes('Chapter')) {
        currentCitation.section = line.trim();
      }
      // Collect content as snippet
      else if (line.trim() && !line.includes('【') && !line.includes('】')) {
        currentCitation.snippet += (currentCitation.snippet ? ' ' : '') + line.trim();
      }
    }
    
    // Add the last citation
    if (currentCitation.filename) {
      citations.push(currentCitation);
    }
    
    // If we have structured citations, format them nicely
    if (citations.length > 0) {
      return JSON.stringify({
        results: citations,
        total_found: citations.length,
        query_processed: true
      }, null, 2);
    }
    
    // Fallback: return raw output if parsing fails
    return rawOutput;
    
  } catch (error) {
    console.error('Error parsing search results:', error);
    return rawOutput;
  }
}

function extractFilename(text) {
  // Extract filename from various formats
  const pdfMatch = text.match(/([^\/\\]+\.pdf)/i);
  if (pdfMatch) return pdfMatch[1];
  
  const sourceMatch = text.match(/(?:Source|Document):\s*(.+)/i);
  if (sourceMatch) return sourceMatch[1].trim();
  
  return 'Unknown Document';
}

// Start server
app.listen(PORT, HOST, () => {
  console.log(`MCP Server running on http://${HOST}:${PORT}`);
  console.log(`Authentication: ${ALLOW_NO_AUTH ? 'DISABLED' : 'ENABLED'}`);
  console.log(`Debug mode: ${DEBUG_MCP ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
