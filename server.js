const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3030;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || 'mcp-zoning-token';
const ALLOW_NO_AUTH = process.env.ALLOW_NO_AUTH === '1' || process.env.ALLOW_NO_AUTH === 'true';
const DEBUG_MCP = process.env.DEBUG_MCP === '1' || process.env.DEBUG_MCP === 'true';
const VECTOR_STORE_NAME = process.env.VECTOR_STORE_NAME || 'zoning-codes-store';

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

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

// File ingestion endpoint
app.post('/ingest', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
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

// MCP endpoint for tools/list
app.post('/mcp', authenticate, async (req, res) => {
  try {
    const { method, params } = req.body;

    if (method === 'tools/list') {
      res.json({
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
        ]
      });
    } else if (method === 'tools/call') {
      const { name, arguments: args } = params;
      
      if (name === 'search_zoning') {
        const vectorStore = await getOrCreateVectorStore();
        const query = args.query;

        if (DEBUG_MCP) {
          console.log('=== MCP Search Request ===');
          console.log('Query:', query);
          console.log('Vector Store ID:', vectorStore.id);
        }

        // Primary payload using tool_resources (stable shape)
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

        try {
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
            
              // Fallback: try inline vector_store_ids shape
            if (errorText.includes('Unknown parameter: \'attachments\'')) {
              console.log('Retrying with fallback payload shape...');
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
              return res.json({
                content: [
                  {
                    type: 'text',
                    text: parseSearchResults(fallbackResult.output)
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

          // Parse and structure the response
          const structuredResults = parseSearchResults(result.output);

          res.json({
            content: [
              {
                type: 'text',
                text: structuredResults
              }
            ]
          });

        } catch (searchError) {
          console.error('Search error:', searchError);
          res.status(500).json({ error: searchError.message });
        }
      } else {
        res.status(400).json({ error: `Unknown tool: ${name}` });
      }
    } else {
      res.status(400).json({ error: `Unknown method: ${method}` });
    }
  } catch (error) {
    console.error('MCP error:', error);
    res.status(500).json({ error: error.message });
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
app.listen(PORT, () => {
  console.log(`MCP Server running on port ${PORT}`);
  console.log(`Authentication: ${ALLOW_NO_AUTH ? 'DISABLED' : 'ENABLED'}`);
  console.log(`Debug mode: ${DEBUG_MCP ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
