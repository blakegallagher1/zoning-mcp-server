# Zoning Code MCP Server

A Model Context Protocol (MCP) server for semantic search over zoning code PDFs, designed for ChatGPT integration.

## Features

- **PDF Ingestion**: Upload zoning code PDFs via multipart form-data
- **Semantic Search**: OpenAI-powered search with file_search tool
- **Structured Citations**: Returns filename, section, and text snippets
- **ChatGPT Compatible**: SSE endpoints for connector integration
- **Docker Ready**: Containerized for easy deployment
- **Render Deployment**: One-click deployment with render.yaml

## Quick Start

### Local Development
```bash
npm install
cp .env.example .env
# Add your OPENAI_API_KEY to .env
npm start
```

### Docker
```bash
docker build -t zoning-mcp-server .
docker run -p 3030:3030 -e OPENAI_API_KEY=your_key zoning-mcp-server
```

### Render Deployment
1. Connect GitHub repo to Render
2. Set environment variable: OPENAI_API_KEY
3. Deploy automatically via render.yaml

## API Endpoints

- `GET /health` - Health check
- `POST /ingest` - Upload PDF files
- `POST /mcp` - MCP JSON-RPC endpoint
- `GET /sse` - Server-Sent Events for ChatGPT
- `POST /sse` - Alternative MCP endpoint

## ChatGPT Integration

Use as MCP Server URL: `https://your-domain.com/sse`
Authentication: No authentication (ALLOW_NO_AUTH=1)

## Environment Variables

- `OPENAI_API_KEY` - Required: Your OpenAI API key
- `PORT` - Server port (default: 3030)
- `ALLOW_NO_AUTH` - Disable authentication (default: false)
- `DEBUG_MCP` - Enable debug logging (default: false)
- `MCP_AUTH_TOKEN` - Bearer token for auth (default: mcp-zoning-token)
- `VECTOR_STORE_NAME` - OpenAI vector store name (default: zoning-codes-store)