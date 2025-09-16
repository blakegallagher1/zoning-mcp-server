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
1. In the Render dashboard select **New > Blueprint Deploy** and point it at this repository. Render will read `render.yaml` and create the Docker-based web service.
2. In the Render UI, set the following environment variables before the first deploy:
   - `OPENAI_API_KEY` – required; the key must have access to the Responses + File Search APIs.
   - (Optional) `MCP_AUTH_TOKEN` – set a Bearer token if you want to keep authentication enabled.
   - (Optional) `ALLOW_NO_AUTH=1` – keep this if you want unauthenticated access from ChatGPT. Remove it when using a custom token.
3. Click **Deploy**. Render will build the Docker image and start the service, binding to the port supplied in the `PORT` env var (managed automatically by Render).
4. After it goes live, verify the deployment with `curl https://<your-render-domain>/health` – it should return `{ "ok": true }`.
5. Use the public URL `https://<your-render-domain>/sse` as the MCP endpoint inside ChatGPT. Supply the `MCP_AUTH_TOKEN` you configured if auth is enabled.

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
- `HOST` - Interface to bind (default: 0.0.0.0; use 127.0.0.1 for local testing if needed)
- `ALLOW_NO_AUTH` - Disable authentication (default: false)
- `DEBUG_MCP` - Enable debug logging (default: false)
- `MCP_AUTH_TOKEN` - Bearer token for auth (default: mcp-zoning-token)
- `VECTOR_STORE_NAME` - OpenAI vector store name (default: zoning-codes-store)
